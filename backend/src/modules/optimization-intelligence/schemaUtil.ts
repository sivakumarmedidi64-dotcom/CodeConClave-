/**
 * CodeConClave — Optimization Intelligence SQL helper (PKG-16).
 * Pure, deterministic, defensive SQL parsing shared by the Database Query
 * Optimizer (#17). The parser is intentionally conservative: it only recognizes
 * simple, commonly-occurring patterns and never executes or interprets the SQL.
 * Anything ambiguous is treated as an index/rewrite signal only when a clear,
 * safe rule matches.
 */

/** Strip comments and collapse whitespace so pattern matches are robust. */
export function normalizeSql(sql: string): string {
  return (sql ?? '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the query selects every column (`SELECT *` or `SELECT t.*`). */
export function isSelectStar(sql: string): boolean {
  const norm = normalizeSql(sql);
  const m = /^select\s+(?:distinct\s+)?(?:[a-zA-Z0-9_"]+\s*\.\s*)?\*\s+from/i.exec(norm);
  return m !== null;
}

/**
 * Parse a SQL `FROM/JOIN` clause to extract, per joined table, whether the join
 * appears to be on a foreign key column that is NOT a primary-key/`id` column of
 * the joined table. Returns a column-name list for the RHS of equi-joins that
 * could warrant an index.
 */
export interface JoinIndexSignal {
  table: string;
  rhsColumn: string;
  reason: string;
}

export function findUnindexedJoinColumns(sql: string): JoinIndexSignal[] {
  const norm = normalizeSql(sql);
  const signals: JoinIndexSignal[] = [];
  const seen = new Set<string>();
  // `JOIN x ON lhs = rhs` — consider BOTH sides: a non-primary-key column
  // participating in an equi-join is a candidate for a foreign-key index.
  const joinRe = /\b(?:left|right|inner|outer|full|cross)?\s*join\s+([a-zA-Z0-9_."`]+)(?:\s+(?:as\s+)?[a-zA-Z0-9_]+)?\s+on\s+([a-zA-Z0-9_."`]+)\s*=\s*([a-zA-Z0-9_."`]+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = joinRe.exec(norm)) !== null) {
    const table = stripQuotes(m[1]);
    const lhs = m[2];
    const rhs = m[3];
    for (const side of [lhs, rhs]) {
      const { table: sideTable, col } = splitColumnIdentity(side);
      const ownerTable = sideTable ? stripQuotes(sideTable) : table;
      if (col.toLowerCase() === 'id') continue; // primary key side — already indexed
      const key = `${ownerTable}|${col}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({ table: ownerTable, rhsColumn: col, reason: `equi-join on non-primary column "${col}" of "${ownerTable}" may need a foreign-key index` });
    }
  }
  return signals;
}

function splitColumnIdentity(ident: string | undefined): { table: string | null; col: string } {
  const s = ident ?? '';
  if (s.includes('.')) {
    const [t, c] = s.split('.');
    return { table: stripQuotes(t), col: stripQuotes(c) };
  }
  return { table: null, col: stripQuotes(s) };
}

function stripQuotes(s: string | undefined): string {
  return (s ?? '').replace(/["`]/g, '');
}

/** True when a `LIKE` predicate uses a leading wildcard (`LIKE '%x'`). */
export function hasLeadingWildcardLike(sql: string): boolean {
  const norm = normalizeSql(sql);
  return /like\s+'%\S/.test(norm) || /ilike\s+'%\S/.test(norm);
}

/** True when the query uses `NOT IN (` on a subquery or list. */
export function hasNotInSubquery(sql: string): boolean {
  const norm = normalizeSql(sql).toLowerCase();
  return /\bnot\s+in\s*\(/.test(norm);
}

/**
 * Extract column names referenced in a `WHERE` predicate (roughly) so an index
 * recommendation can be built that matches the on-filter columns. Conservative:
 * only simple `col = value` / `col IN (...)`. Returns distinct column names.
 */
export function whereColumns(sql: string): string[] {
  const norm = normalizeSql(sql);
  const cols: string[] = [];
  const re = /(?:where|and)\s+([a-zA-Z0-9_."`]+)\s*(?:=|>|<|>=|<=|between|in)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    const col = stripQuotes(m[1]);
    if (col.toLowerCase() === 'id') continue;
    if (!cols.includes(col)) cols.push(col);
  }
  return cols;
}

/** Guess a table name from `FROM x` / `UPDATE x` / `INTO x`. */
export function primaryTable(sql: string): string | null {
  const norm = normalizeSql(sql);
  const m = /\bfrom\s+([a-zA-Z0-9_."`]+)/i.exec(norm) || /\bupdate\s+([a-zA-Z0-9_."`]+)/i.exec(norm) || /\binto\s+([a-zA-Z0-9_."`]+)/i.exec(norm);
  if (!m) return null;
  return stripQuotes(m[1]);
}

/** True when the query reads more columns than it filters (a rough large-result signal). */
export function hasBroadResult(sql: string): boolean {
  const cols = whereColumns(sql);
  const norm = normalizeSql(sql);
  // A `SELECT a,b,c FROM ...` with no LIMIT and no WHERE-condition on a joined set.
  const noLimit = !/\blimit\b/i.test(norm);
  const hasWhere = /\bwhere\b/i.test(norm);
  return noLimit && !hasWhere && !isSelectStar(sql);
}

/** True when a function/expression is applied to a column in WHERE (non-sargable). */
export function hasNonSargablePredicate(sql: string): boolean {
  const norm = normalizeSql(sql).toLowerCase();
  return /(?:lower|upper|ltrim|rtrim|cast|date_trunc|substring|coalesce)\s*\(\s*[a-zA-Z0-9_."`]+\s*\)\s*[=<]/.test(norm);
}