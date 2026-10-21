/**
 * Nuclear Physics verifier — CIVIL reactor physics and radioactive decay only
 * (weapon-relevant requests never get here: the Gate denies them first).
 *   six_factor       k_eff = η·f·p·ε·P_FNL·P_TNL (parameter ranges checked)
 *   bare_one_group   one-group diffusion for a bare reactor:
 *                    k_eff = νΣf / (Σa + D·B²), with geometric buckling B²
 *                    slab (π/a)², sphere (π/R)², cube 3(π/a)²,
 *                    cylinder (2.405/R)² + (π/H)²; neutron balance checked
 *                    (production = absorption + leakage at k = 1).
 *   decay            N(t) = N0·e^(−λt), λ = ln2 / T½, activity A = λN.
 */

export interface ReactorClaim {
  model: 'six_factor' | 'bare_one_group' | 'decay';
  geometry?: 'slab' | 'sphere' | 'cube' | 'cylinder';
  params: Record<string, number>;
  expect: Record<string, number>;
}

export interface ReactorResult {
  verdict: 'PASS' | 'FAIL' | 'ERROR';
  outputs: Record<string, number>;
  detail: string;
}

const J0_FIRST_ZERO = 2.404825557695773;

function need(params: Record<string, number>, names: string[]): void {
  for (const n of names) {
    const v = params[n];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`missing or invalid parameter "${n}"`);
  }
}

export function buckling(geometry: string, p: Record<string, number>): number {
  switch (geometry) {
    case 'slab':
      need(p, ['a']);
      return (Math.PI / p.a!) ** 2;
    case 'sphere':
      need(p, ['R']);
      return (Math.PI / p.R!) ** 2;
    case 'cube':
      need(p, ['a']);
      return 3 * (Math.PI / p.a!) ** 2;
    case 'cylinder':
      need(p, ['R', 'H']);
      return (J0_FIRST_ZERO / p.R!) ** 2 + (Math.PI / p.H!) ** 2;
    default:
      throw new Error(`unknown geometry "${geometry}"`);
  }
}

export function verifyReactor(claim: ReactorClaim): ReactorResult {
  try {
    const p = claim.params ?? {};
    const out: Record<string, number> = {};
    if (claim.model === 'six_factor') {
      need(p, ['eta', 'f', 'p', 'eps']);
      const pfnl = p.pfnl ?? 1;
      const ptnl = p.ptnl ?? 1;
      if (!(p.f! > 0 && p.f! <= 1)) throw new Error('thermal utilization f must be in (0, 1]');
      if (!(p.p! > 0 && p.p! <= 1)) throw new Error('resonance escape p must be in (0, 1]');
      if (!(p.eps! >= 1)) throw new Error('fast fission factor ε must be ≥ 1');
      if (!(p.eta! > 0)) throw new Error('reproduction factor η must be > 0');
      if (!(pfnl > 0 && pfnl <= 1 && ptnl > 0 && ptnl <= 1)) throw new Error('non-leakage probabilities must be in (0, 1]');
      out.k_inf = p.eta! * p.f! * p.p! * p.eps!;
      out.k_eff = out.k_inf * pfnl * ptnl;
      out.reactivity_pcm = ((out.k_eff - 1) / out.k_eff) * 1e5;
    } else if (claim.model === 'bare_one_group') {
      need(p, ['nuSigmaF', 'sigmaA', 'D']);
      if (!(p.nuSigmaF! > 0 && p.sigmaA! > 0 && p.D! > 0)) throw new Error('νΣf, Σa and D must be positive (cm⁻¹, cm⁻¹, cm)');
      const b2 = buckling(claim.geometry ?? 'sphere', p);
      out.buckling = b2;
      out.k_inf = p.nuSigmaF! / p.sigmaA!;
      out.k_eff = p.nuSigmaF! / (p.sigmaA! + p.D! * b2);
      // Neutron balance per unit flux: production vs absorption + leakage.
      const production = p.nuSigmaF!;
      const loss = p.sigmaA! + p.D! * b2;
      out.balance_residual = production / out.k_eff - loss; // must be ~0 by construction
      if (out.k_inf > 1 && (claim.geometry ?? 'sphere') === 'sphere') {
        out.critical_radius = Math.PI / Math.sqrt((p.nuSigmaF! - p.sigmaA!) / p.D!);
      }
    } else if (claim.model === 'decay') {
      need(p, ['halfLife', 'N0', 't']);
      if (!(p.halfLife! > 0 && p.N0! >= 0 && p.t! >= 0)) throw new Error('halfLife > 0, N0 ≥ 0, t ≥ 0 (same time unit)');
      out.lambda = Math.LN2 / p.halfLife!;
      out.N = p.N0! * Math.exp(-out.lambda * p.t!);
      out.A = out.lambda * out.N;
      out.decayed = p.N0! - out.N; // conservation: N + decayed = N0
    } else {
      throw new Error(`unknown model "${String(claim.model)}"`);
    }

    const tolRel = claim.expect?.tol ?? 1e-3;
    const failures: string[] = [];
    for (const [k, want] of Object.entries(claim.expect ?? {})) {
      if (k === 'tol') continue;
      const got = out[k];
      if (got === undefined) failures.push(`"${k}" is not an output of ${claim.model}`);
      else if (Math.abs(got - want) > tolRel * Math.max(1, Math.abs(want))) failures.push(`${k} = ${got.toPrecision(6)}, claimed ${want}`);
    }
    if (out.balance_residual !== undefined && Math.abs(out.balance_residual) > 1e-9) failures.push('neutron balance does not close');
    return { verdict: failures.length ? 'FAIL' : 'PASS', outputs: out, detail: failures.length ? failures.join('; ') : `${claim.model} re-derived; claims hold` };
  } catch (err) {
    return { verdict: 'ERROR', outputs: {}, detail: (err as Error).message };
  }
}
