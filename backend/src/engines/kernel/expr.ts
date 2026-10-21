/**
 * Safe math expression parser + evaluator for the verification kernel.
 * No eval, bounded size and depth. Grammar:
 *   expr   := term (('+'|'-') term)*
 *   term   := unary (('*'|'/') unary | implicit-mult)*
 *   unary  := '-' unary | '+' unary | power
 *   power  := atom ('^' unary)?            (right-associative)
 *   atom   := number | name | name '(' args ')' | '(' expr ')'
 * Implicit multiplication: "2x", "3(x+1)", "(a)(b)", "x y" are products.
 */

export type Node =
  | { t: 'num'; v: string }
  | { t: 'var'; name: string }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; l: Node; r: Node }
  | { t: 'call'; fn: string; args: Node[] };

export const FUNCTIONS: Record<string, (...x: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  abs: Math.abs,
};

export const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const MAX_LEN = 4000;
const MAX_DEPTH = 200;

type Tok = { k: 'num' | 'name' | 'op' | 'lp' | 'rp' | 'comma'; v: string };

function tokenize(src: string): Tok[] {
  if (src.length > MAX_LEN) throw new Error('expression too long');
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ k: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) {
      out.push({ k: 'name', v: name[0] });
      i += name[0].length;
      continue;
    }
    if (c === '*' && src[i + 1] === '*') {
      out.push({ k: 'op', v: '^' });
      i += 2;
      continue;
    }
    if ('+-*/^'.includes(c)) out.push({ k: 'op', v: c });
    else if (c === '(') out.push({ k: 'lp', v: c });
    else if (c === ')') out.push({ k: 'rp', v: c });
    else if (c === ',') out.push({ k: 'comma', v: c });
    else throw new Error(`unexpected character "${c}"`);
    i += 1;
  }
  return out;
}

export function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const enter = () => {
    depth += 1;
    if (depth > MAX_DEPTH) throw new Error('expression too deep');
  };

  const expr = (): Node => {
    enter();
    let node = term();
    while (peek()?.k === 'op' && (peek()!.v === '+' || peek()!.v === '-')) {
      const op = toks[p++]!.v as '+' | '-';
      node = { t: 'bin', op, l: node, r: term() };
    }
    depth -= 1;
    return node;
  };
  const startsAtom = (t: Tok | undefined) => t !== undefined && (t.k === 'num' || t.k === 'name' || t.k === 'lp');
  const term = (): Node => {
    let node = unary();
    for (;;) {
      const t = peek();
      if (t?.k === 'op' && (t.v === '*' || t.v === '/')) {
        p += 1;
        node = { t: 'bin', op: t.v as '*' | '/', l: node, r: unary() };
      } else if (startsAtom(t)) {
        node = { t: 'bin', op: '*', l: node, r: unary() }; // implicit multiplication
      } else return node;
    }
  };
  const unary = (): Node => {
    const t = peek();
    if (t?.k === 'op' && t.v === '-') {
      p += 1;
      enter();
      const a = unary();
      depth -= 1;
      return { t: 'neg', a };
    }
    if (t?.k === 'op' && t.v === '+') {
      p += 1;
      return unary();
    }
    return power();
  };
  const power = (): Node => {
    const base = atom();
    if (peek()?.k === 'op' && peek()!.v === '^') {
      p += 1;
      enter();
      const exp = unary();
      depth -= 1;
      return { t: 'bin', op: '^', l: base, r: exp };
    }
    return base;
  };
  const atom = (): Node => {
    const t = toks[p++];
    if (!t) throw new Error('unexpected end of expression');
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'lp') {
      const inner = expr();
      if (toks[p++]?.k !== 'rp') throw new Error('missing )');
      return inner;
    }
    if (t.k === 'name') {
      if (peek()?.k === 'lp' && FUNCTIONS[t.v.toLowerCase()]) {
        p += 1;
        const args: Node[] = [];
        if (peek()?.k !== 'rp') {
          args.push(expr());
          while (peek()?.k === 'comma') {
            p += 1;
            args.push(expr());
          }
        }
        if (toks[p++]?.k !== 'rp') throw new Error('missing ) after arguments');
        return { t: 'call', fn: t.v.toLowerCase(), args };
      }
      return { t: 'var', name: t.v };
    }
    throw new Error(`unexpected "${t.v}"`);
  };

  const root = expr();
  if (p !== toks.length) throw new Error(`unexpected "${toks[p]!.v}"`);
  return root;
}

/** Free variables (excludes function names and the constants pi, e). */
export function variables(node: Node, out = new Set<string>()): Set<string> {
  switch (node.t) {
    case 'var':
      if (!(node.name in CONSTANTS)) out.add(node.name);
      break;
    case 'neg':
      variables(node.a, out);
      break;
    case 'bin':
      variables(node.l, out);
      variables(node.r, out);
      break;
    case 'call':
      node.args.forEach((a) => variables(a, out));
      break;
  }
  return out;
}

export function evaluate(node: Node, env: Record<string, number>): number {
  switch (node.t) {
    case 'num':
      return Number(node.v);
    case 'var':
      if (node.name in env) return env[node.name]!;
      if (node.name in CONSTANTS) return CONSTANTS[node.name]!;
      throw new Error(`unknown variable "${node.name}"`);
    case 'neg':
      return -evaluate(node.a, env);
    case 'bin': {
      const l = evaluate(node.l, env);
      const r = evaluate(node.r, env);
      switch (node.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return l / r;
        case '^':
          return Math.pow(l, r);
      }
      break;
    }
    case 'call': {
      const f = FUNCTIONS[node.fn];
      if (!f) throw new Error(`unknown function "${node.fn}"`);
      return f(...node.args.map((a) => evaluate(a, env)));
    }
  }
  throw new Error('bad node');
}

/** Compact text form (for receipts). */
export function show(node: Node): string {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'var':
      return node.name;
    case 'neg':
      return `-(${show(node.a)})`;
    case 'bin':
      return `(${show(node.l)} ${node.op} ${show(node.r)})`;
    case 'call':
      return `${node.fn}(${node.args.map(show).join(', ')})`;
  }
}
