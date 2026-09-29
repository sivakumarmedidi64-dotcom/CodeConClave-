/**
 * CodeConClave — FOUNDER REVENUE REPORTING (server-authoritative).
 *
 * Revenue is computed server-side from REAL payment records only. The paid set
 * is `payment_intents.status IN ('ACTIVE','GRACE')` (the same set the founder
 * digest and reconciliation already use); refunds are `REFUNDED/CHARGEBACK`
 * rows; net = collected - refunded. Every intent is bucketed by its actual
 * payment time (payment_evidence.paid_at, falling back to activated_at then
 * created_at). Products come from `purchase_type` — NEVER from the amount
 * alone. No client input is trusted anywhere in this module.
 */
import { withSystem } from '../../../shared/db.js';

export interface ProductRevenue {
  collectedInr: number;
  refundedInr: number;
  netInr: number;
  paidCount: number;
}

export interface RevenuePeriod {
  period: string;
  collectedInr: number;
  refundedInr: number;
  netInr: number;
  paidCount: number;
  customerCount: number;
  products: Record<'solo' | 'team' | 'api', ProductRevenue>;
}

export interface MonthlyRevenue {
  month: string; // YYYY-MM
  soloInr: number;
  teamInr: number;
  apiInr: number;
  totalInr: number;
  refundedInr: number;
  netInr: number;
  paidCount: number;
  customerCount: number;
}

interface IntentsForRevenue {
  purchase_type: string;
  amount_inr: number;
  status: string;
  owner_id: string;
  paid_time: Date | null;
}

const PAID_STATUSES = ['ACTIVE', 'GRACE'];
const REFUNDED_STATUSES = ['REFUNDED', 'CHARGEBACK'];

function rowSet(r: IntentsForRevenue): 'collected' | 'refunded' | 'ignored' {
  if (PAID_STATUSES.includes(r.status)) return 'collected';
  if (REFUNDED_STATUSES.includes(r.status)) return 'refunded';
  return 'ignored';
}

/** Payment time for revenue bucketing: evidence.paid_at > activated_at > created_at. */
export function effectivePaidTime(r: IntentsForRevenue): Date {
  return r.paid_time ?? new Date(0);
}

function emptyProduct(): ProductRevenue {
  return { collectedInr: 0, refundedInr: 0, netInr: 0, paidCount: 0 };
}

function emptyPeriod(period: string): RevenuePeriod {
  return {
    period,
    collectedInr: 0,
    refundedInr: 0,
    netInr: 0,
    paidCount: 0,
    customerCount: 0,
    products: { solo: emptyProduct(), team: emptyProduct(), api: emptyProduct() },
  };
}

function addRow(p: RevenuePeriod, r: IntentsForRevenue): void {
  const key = (r.purchase_type === 'team' ? 'team' : r.purchase_type === 'api' ? 'api' : 'solo') as 'solo' | 'team' | 'api';
  const product = p.products[key];
  if (rowSet(r) === 'collected') {
    p.collectedInr += r.amount_inr;
    p.paidCount += 1;
    p.customerCount += 1; // distinct is enforced after grouping by owner below
    product.collectedInr += r.amount_inr;
    product.paidCount += 1;
  } else if (rowSet(r) === 'refunded') {
    p.refundedInr += r.amount_inr;
    product.refundedInr += r.amount_inr;
  }
}

async function fetchIntents(): Promise<IntentsForRevenue[]> {
  return withSystem<IntentsForRevenue[]>(async (q) =>
    (
      await q.query<IntentsForRevenue>(
      `SELECT i.purchase_type, i.amount_inr, i.status, i.owner_id,
            COALESCE(e.paid_at, i.activated_at, i.created_at) AS paid_time
     FROM payment_intents i
     LEFT JOIN LATERAL (
       SELECT paid_at FROM payment_evidence ev
       WHERE ev.intent_id = i.id ORDER BY ev.created_at DESC LIMIT 1
     ) e ON true
     WHERE i.status IN ('ACTIVE','GRACE','REFUNDED','CHARGEBACK')`,
      )
    ).rows,
  );
}

function startOfDay(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/**
 * Today / this week (7 days incl. today) / this month / previous month / all-time,
 * each with the Solo/Team/API product split. Refunds are subtracted for net;
 * gross (collected) and refunded are reported separately.
 */
export async function founderRevenueOverview(now = new Date()): Promise<{ periods: RevenuePeriod[]; allTime: RevenuePeriod }> {
  const rows = await fetchIntents();
  const todayStart = startOfDay(new Date(now));
  const weekStart = new Date(new Date(now).getTime() - 6 * 24 * 60 * 60 * 1000);
  weekStart.setHours(0, 0, 0, 0);
  const monthStart = startOfMonth(new Date(now));
  const prevMonthEnd = new Date(monthStart.getTime() - 1);
  const prevMonthStart = startOfMonth(prevMonthEnd);

  const today = emptyPeriod('today');
  const week = emptyPeriod('this_week');
  const month = emptyPeriod('this_month');
  const prev = emptyPeriod('prev_month');
  const allTime = emptyPeriod('all_time');

  const seenOwners = new Set<string>();
  const weekOwners = new Set<string>();
  const monthOwners = new Set<string>();
  const prevOwners = new Set<string>();

  for (const r of rows) {
    const t = effectivePaidTime(r);
    const isPaid = rowSet(r) === 'collected';

    if (t >= todayStart) {
      addRow(today, r);
      if (isPaid && r.owner_id) seenOwners.add(r.owner_id);
    }
    if (t >= weekStart) {
      addRow(week, r);
      if (isPaid && r.owner_id) weekOwners.add(r.owner_id);
    }
    if (t >= monthStart) {
      addRow(month, r);
      if (isPaid && r.owner_id) monthOwners.add(r.owner_id);
    }
    if (t >= prevMonthStart && t < monthStart) {
      addRow(prev, r);
      if (isPaid && r.owner_id) prevOwners.add(r.owner_id);
    }
    addRow(allTime, r);
  }

  // Distinct customers per period (per-product paidCount duplicates are not
  // deduped across products, so recompute customerCount at period level).
  for (const [p, set] of [
    [today, seenOwners],
    [week, weekOwners],
    [month, monthOwners],
    [prev, prevOwners],
  ] as const) {
    p.customerCount = set.size;
  }
  allTime.customerCount = new Set(rows.filter((r) => rowSet(r) === 'collected').map((r) => r.owner_id)).size;

  for (const p of [today, week, month, prev, allTime]) {
    for (const k of ['solo', 'team', 'api'] as const) {
      p.products[k].netInr = p.products[k].collectedInr - p.products[k].refundedInr;
    }
    p.netInr = p.collectedInr - p.refundedInr;
  }

  return { periods: [today, week, month, prev], allTime };
}

/**
 * Last `months` calendar months (oldest..newest), one row per month with the
 * Solo/Team/API split plus refunded and customer counts — the founder's monthly
 * revenue table.
 */
export async function founderMonthlyRevenue(months = 12, now = new Date()): Promise<MonthlyRevenue[]> {
  const rows = await fetchIntents();
  const bucket = new Map<string, MonthlyRevenue>();
  const firstForMonth = new Map<string, Set<string>>();

  const start = startOfMonth(new Date(now));
  start.setMonth(start.getMonth() - (months - 1));
  const labels: string[] = [];
  for (let i = 0; i < months; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    labels.push(key);
    bucket.set(key, {
      month: key,
      soloInr: 0,
      teamInr: 0,
      apiInr: 0,
      totalInr: 0,
      refundedInr: 0,
      netInr: 0,
      paidCount: 0,
      customerCount: 0,
    });
    firstForMonth.set(key, new Set<string>());
  }

  for (const r of rows) {
    const t = effectivePaidTime(r);
    if (t < start) continue;
    const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
    const m = bucket.get(key);
    if (!m) continue;
    const set = rowSet(r);
    const product = r.purchase_type === 'team' ? 'teamInr' : r.purchase_type === 'api' ? 'apiInr' : 'soloInr';
    if (set === 'collected') {
      m[product] += r.amount_inr;
      m.totalInr += r.amount_inr;
      m.paidCount += 1;
      firstForMonth.get(key)!.add(r.owner_id);
    } else if (set === 'refunded') {
      m.refundedInr += r.amount_inr;
    }
  }

  for (const key of labels) {
    const m = bucket.get(key)!;
    m.netInr = m.totalInr - m.refundedInr;
    m.customerCount = firstForMonth.get(key)!.size;
  }

  return labels.map((k) => bucket.get(k)!);
}