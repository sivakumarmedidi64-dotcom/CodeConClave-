/**
 * Exact rational numbers on BigInt — the arithmetic under the symbolic
 * (CAS) residual check. Always normalized: gcd(n, d) = 1 and d > 0.
 */
export class Q {
  readonly n: bigint;
  readonly d: bigint;

  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new Error('division by zero');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n < 0n ? -n : n, d);
    this.n = g > 1n ? n / g : n;
    this.d = g > 1n ? d / g : d;
  }

  static readonly ZERO = new Q(0n);
  static readonly ONE = new Q(1n);

  static int(v: number | bigint): Q {
    return new Q(BigInt(v));
  }

  /** Exact value of a decimal literal like "1.25" or "3e-2". */
  static parse(literal: string): Q {
    const m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(literal.trim());
    if (!m || (m[1] === '' && (m[2] ?? '') === '')) throw new Error(`not a number: ${literal}`);
    const whole = m[1] || '0';
    const frac = m[2] ?? '';
    const exp = Number(m[3] ?? 0);
    if (Math.abs(exp) > 300) throw new Error('exponent too large');
    let n = BigInt(whole + frac);
    let d = 10n ** BigInt(frac.length);
    if (exp > 0) n *= 10n ** BigInt(exp);
    if (exp < 0) d *= 10n ** BigInt(-exp);
    return new Q(n, d);
  }

  isZero(): boolean {
    return this.n === 0n;
  }
  isInteger(): boolean {
    return this.d === 1n;
  }
  add(o: Q): Q {
    return new Q(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Q): Q {
    return new Q(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Q): Q {
    return new Q(this.n * o.n, this.d * o.d);
  }
  div(o: Q): Q {
    if (o.n === 0n) throw new Error('division by zero');
    return new Q(this.n * o.d, this.d * o.n);
  }
  neg(): Q {
    return new Q(-this.n, this.d);
  }
  pow(k: number): Q {
    if (!Number.isInteger(k)) throw new Error('non-integer power');
    if (k < 0) return Q.ONE.div(this.pow(-k));
    return new Q(this.n ** BigInt(k), this.d ** BigInt(k));
  }
  equals(o: Q): boolean {
    return this.n === o.n && this.d === o.d;
  }
  toNumber(): number {
    return Number(this.n) / Number(this.d);
  }
  toString(): string {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}
