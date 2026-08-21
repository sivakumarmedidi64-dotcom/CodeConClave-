/**
 * CodeConClave — schedule recurrence engine (Stage 26C).
 * Wall-clock semantics: every next-run instant is computed IN THE SCHEDULE'S
 * IANA TIMEZONE, never in the server's local zone. DST transitions are handled
 * by converting wall-clock components back to UTC with a two-pass offset
 * correction (the standard Intl-based technique). Ambiguous/nonexistent wall
 * times (spring-forward gaps, fall-back overlaps) resolve to the closest valid
 * instant — documented, deterministic, and unit-tested.
 *
 * Recurrence syntax:
 *   ONCE    runAt = 'YYYY-MM-DDTHH:MM' (absolute wall clock in the timezone)
 *   HOURLY  runAt = 'MM' minutes past the hour (00..59)
 *   DAILY   runAt = 'HH:MM' time of day
 *   WEEKLY  runAt = 'HH:MM' + runOnDays = ['MON'..'SUN']
 *   MONTHLY runAt = 'HH:MM' + runOnDays = day-of-month numbers ['1'..'31']
 *   CRON    cronExpression = 5 fields: minute hour day-of-month month day-of-week
 *           (`*`, numbers, `a-b` ranges and `a,b,c` lists are supported)
 */
export type ScheduleRecurrence = 'ONCE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CRON';

export interface ScheduleAnchor {
  recurrence: ScheduleRecurrence;
  runAt: string;
  runOnDays: string[];
  timezone: string;
  cronExpression?: string | null;
}

const WEEKDAY_INDEX: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};
export const WEEKDAYS = Object.keys(WEEKDAY_INDEX);

/** Offset (ms) of an IANA zone at a given instant. */
export function tzOffsetMs(timezone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const m: Record<string, string> = {};
    for (const p of parts) m[p.type] = p.value;
    const hour = Number(m.hour) % 24;
    const asUtc = Date.UTC(Number(m.year), Number(m.month) - 1, Number(m.day), hour, Number(m.minute), Number(m.second));
    return asUtc - at.getTime();
  } catch {
    return 0;
  }
}

/** Convert wall-clock parts in a timezone to a UTC Date (two-pass DST correction). */
export function zonedToUtc(timezone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const off1 = tzOffsetMs(timezone, new Date(guess));
  const cand = new Date(guess - off1);
  const off2 = tzOffsetMs(timezone, cand);
  if (off1 === off2) return new Date(guess - off2);
  return new Date(guess - off2);
}

interface ZoneParts { year: number; month: number; day: number; hour: number; minute: number; }

/** Wall-clock components of a Date inside a timezone. */
function partsInZone(timezone: string, at: Date): ZoneParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(at);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour: Number(m.hour) % 24,
    minute: Number(m.minute),
  };
}

function timeOfDay(runAt: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(runAt.trim());
  if (!m) return { hour: 9, minute: 0 };
  return { hour: Number(m[1]) % 24, minute: Math.min(Number(m[2]), 59) };
}

function parseMinutes(runAt: string): number {
  const n = Number(runAt.trim());
  return Number.isFinite(n) ? Math.max(0, Math.min(Math.floor(n), 59)) : 0;
}

function dateKey(p: ZoneParts): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ---------------------------------------------------------------- cron (5 fields)

export interface CronFields {
  minute: Set<number> | 'all';
  hour: Set<number> | 'all';
  dayOfMonth: Set<number> | 'all';
  month: Set<number> | 'all';
  dayOfWeek: Set<number> | 'all';
}

/** Parse a single cron field into a Set or 'all'. Returns null on invalid input. */
export function parseCronField(field: string, min: number, max: number): Set<number> | 'all' | null {
  const trimmed = field.trim();
  if (trimmed === '*') return 'all';
  const out = new Set<number>();
  for (const part of trimmed.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (start < min || end > max || end < start) return null;
    for (let i = start; i <= end; i++) out.add(i);
  }
  return out;
}

export function parseCron(expression: string): CronFields | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCronField(fields[0]!, 0, 59);
  const hour = parseCronField(fields[1]!, 0, 23);
  const dayOfMonth = parseCronField(fields[2]!, 1, 31);
  const month = parseCronField(fields[3]!, 1, 12);
  const dayOfWeek = parseCronField(fields[4]!, 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function cronMatches(fields: CronFields, p: ZoneParts, weekday: number): boolean {
  const dom = p.day;
  const inSet = (s: Set<number> | 'all', v: number) => s === 'all' || s.has(v);
  if (fields.dayOfMonth !== 'all' && fields.dayOfWeek !== 'all') {
    // Standard OR semantics when both dom and dow are restricted.
    if (!inSet(fields.dayOfMonth, dom) && !inSet(fields.dayOfWeek, weekday)) return false;
  } else {
    if (!inSet(fields.dayOfMonth, dom)) return false;
    if (!inSet(fields.dayOfWeek, weekday)) return false;
  }
  return inSet(fields.month, p.month) && inSet(fields.hour, p.hour) && inSet(fields.minute, p.minute);
}

// ---------------------------------------------------------------- next-run

function onNextCron(anchor: ScheduleAnchor, after: Date): Date | null {
  if (!anchor.cronExpression) return null;
  const fields = parseCron(anchor.cronExpression);
  if (!fields) return null;
  // Step minute-by-minute in wall-clock space, capped at 366 days.
  const cursor = new Date(after.getTime() + 60_000);
  const cap = new Date(cursor.getTime() + 366 * 24 * 3600 * 1000);
  while (cursor.getTime() < cap.getTime()) {
    const p = partsInZone(anchor.timezone, cursor);
    const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    if (cronMatches(fields, p, dow)) return new Date(cursor.getTime());
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return null;
}

/** Compute the next run instant strictly after `after`, or null when none exists. */
export function nextRunAt(anchor: ScheduleAnchor, after: Date): Date | null {
  const tz = anchor.timezone;
  if (anchor.recurrence === 'CRON') return onNextCron(anchor, after);

  if (anchor.recurrence === 'ONCE') {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(anchor.runAt.trim());
    if (!m) return null;
    const candidate = zonedToUtc(tz, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
    return candidate.getTime() > after.getTime() ? candidate : null;
  }

  const { hour, minute } = timeOfDay(anchor.runAt);

  if (anchor.recurrence === 'HOURLY') {
    const minutes = parseMinutes(anchor.runAt);
    const now = partsInZone(tz, after);
    const h = now.minute < minutes ? now.hour : now.hour + 1;
    return zonedToUtc(tz, now.year, now.month, now.day, h, minutes);
  }

  if (anchor.recurrence === 'DAILY') {
    const today = partsInZone(tz, after);
    const candidate = zonedToUtc(tz, today.year, today.month, today.day, hour, minute);
    return candidate.getTime() > after.getTime() ? candidate : zonedToUtc(tz, today.year, today.month, today.day + 1, hour, minute);
  }

  if (anchor.recurrence === 'WEEKLY') {
    const days = anchor.runOnDays.map((d) => WEEKDAY_INDEX[d.toUpperCase()] ?? -1).filter((d) => d >= 0).sort((a, b) => a - b);
    if (days.length === 0) return null;
    const cursor = partsInZone(tz, after);
    const dow = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day)).getUTCDay();
    const today = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day));
    for (let offset = 0; offset <= 7; offset++) {
      const dayOffset = (dow + offset) % 7;
      if (days.includes(dayOffset)) {
        const candidate = zonedToUtc(tz, cursor.year, cursor.month, cursor.day + offset, hour, minute);
        if (candidate.getTime() > after.getTime()) return candidate;
      }
    }
    return null;
  }

  if (anchor.recurrence === 'MONTHLY') {
    const days = anchor.runOnDays.map((d) => Number(d)).filter((n) => Number.isFinite(n) && n >= 1 && n <= 31).sort((a, b) => a - b);
    if (days.length === 0) return null;
    const cursor = partsInZone(tz, after);
    for (let m = 0; m <= 12; m++) {
      const year = cursor.month + m > 12 ? cursor.year + 1 : cursor.year;
      const month = ((cursor.month - 1 + m) % 12) + 1;
      const dim = daysInMonth(year, month);
      for (const day of days) {
        if (day > dim) continue;
        const candidate = zonedToUtc(tz, year, month, day, hour, minute);
        if (candidate.getTime() > after.getTime()) return candidate;
      }
    }
    return null;
  }

  return null;
}

/** Strictly-increasing scan of all occurrences in [after, before]. */
export function occurrencesBetween(anchor: ScheduleAnchor, after: Date, before: Date, limit = 10): Date[] {
  const out: Date[] = [];
  let cursor = nextRunAt(anchor, after);
  while (cursor && cursor.getTime() <= before.getTime() && out.length < limit) {
    out.push(cursor);
    cursor = nextRunAt(anchor, cursor);
  }
  return out;
}

/** Human description used for the server-authoritative next-run preview. */
export function describeAnchor(anchor: ScheduleAnchor): string {
  switch (anchor.recurrence) {
    case 'ONCE': return `Once on ${anchor.runAt} (${anchor.timezone})`;
    case 'HOURLY': return `Hourly at :${String(parseMinutes(anchor.runAt)).padStart(2, '0')} (${anchor.timezone})`;
    case 'DAILY': return `Daily at ${anchor.runAt} (${anchor.timezone})`;
    case 'WEEKLY': return `Weekly on ${anchor.runOnDays.join(', ') || 'every day'} at ${anchor.runAt} (${anchor.timezone})`;
    case 'MONTHLY': return `Monthly on day${anchor.runOnDays.length === 1 ? '' : 's'} ${anchor.runOnDays.join(', ')} at ${anchor.runAt} (${anchor.timezone})`;
    case 'CRON': return `Cron "${anchor.cronExpression}" (${anchor.timezone})`;
    default: return anchor.recurrence;
  }
}