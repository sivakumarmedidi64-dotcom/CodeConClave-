/**
 * Route · scout — lane, risk, complexity and a role shortlist (max 3) in
 * ≤ 300 tokens. Uses the resident scout model when it is reachable and its
 * output passes the strict JSON guard; otherwise a deterministic keyword
 * router decides, and the stage event says which one ran (never hidden).
 */
import { ROLE_CONTRACTS, contractFor, type Lane } from './contracts.js';

export interface ScoutDecision {
  lane: Lane;
  risk: 'low' | 'medium' | 'high';
  complexity: 1 | 2 | 3 | 4 | 5;
  shortlist: string[];
  by: 'scout-model' | 'heuristic';
}

const KEYWORDS: Record<string, RegExp[]> = {
  'Quantum Physics': [/\bqubits?\b/, /\bquantum\b/, /\bhamiltonian\b/, /\bunitar(y|ity)\b/, /\bsuperposition\b/, /\bentangle/, /\bbell state\b/, /\bschr(ö|o)dinger\b/, /\beigenstate/, /\bstate vector\b/],
  'Nuclear Physics': [/\breactor\b/, /\bneutron/, /\bfission\b/, /\bcriticality\b/, /\bk_?eff\b/, /\bhalf-?life\b/, /\bradioactiv/, /\bisotope/, /\bmoderator\b/, /\bneutronics\b/, /\bdecay constant\b/, /\bburnup\b/],
  'Computational Math': [/\bintegra(l|te)\b/, /\bderivative\b/, /\bdifferentiat/, /\bsimplify\b/, /\bfactori[sz]e\b/, /\bidentity\b/, /\bpolynomial\b/, /\bcalculus\b/, /\balgebra/, /\bprove that\b/, /\bexpand\b/, /\bsolve\b.*\bequation\b/],
  Statistics: [/\bp-?value\b/, /\bt-?test\b/, /\bconfidence interval\b/, /\bregression\b/, /\bstandard deviation\b/, /\bvariance\b/, /\bhypothesis\b/, /\bstatistic/, /\banova\b/, /\beffect size\b/, /\bbootstrap\b/, /\bsignifican/],
  Security: [/\bvulnerab/, /\bxss\b/, /\bsql injection\b/, /\bcsrf\b/, /\bsecurity\b/, /\bcve\b/, /\bsecrets?\b/, /\bauth(entication|orization)?\b/, /\bencrypt/],
  Reviewer: [/\breview\b/, /\bpull request\b/, /\bcritique\b/, /\bcode quality\b/],
  Tester: [/\btests?\b/, /\bunit test/, /\bvitest\b/, /\bjest\b/, /\bcoverage\b/, /\be2e\b/],
  Debugger: [/\bbug\b/, /\berror\b/, /\bexception\b/, /\bstack ?trace\b/, /\bcrash/, /\bnot working\b/, /\btraceback\b/, /\bdebug/, /\bfails?\b/],
  DevOps: [/\bdeploy/, /\bdocker/, /\bkubernetes\b/, /\bci\/?cd\b/, /\bgithub actions\b/, /\bterraform\b/, /\bnginx\b/, /\brailway\b/, /\brender\.yaml\b/, /\bvercel\b/],
  Architect: [/\barchitecture\b/, /\bsystem design\b/, /\bscal(e|able|ing)\b/, /\bmicroservice/, /\bschema\b/, /\bdesign (a|the) (system|service|api)\b/, /\bplan\b/],
  'UI/UX': [/\bui\b/, /\bux\b/, /\bcss\b/, /\blayout\b/, /\baccessib/, /\bresponsive\b/, /\bfigma\b/, /\bbutton\b/],
  Documentation: [/\bdocs?\b/, /\bdocumentation\b/, /\breadme\b/, /\bexplain\b/, /\btutorial\b/, /\bguide\b/, /\bwhat is\b/, /\bhow does\b/],
  Coder: [/\bcode\b/, /\bfunction\b/, /\bimplement/, /\bwrite (a|the|me)\b/, /\btypescript\b/, /\bpython\b/, /\bjavascript\b/, /\breact\b/, /\bapi\b/, /\bscript\b/, /\bclass\b/, /\bsql\b/, /```/],
};

const HIGH_RISK = /\b(deploy|production|prod\b|delete|drop (table|database)|rm -rf|payment|refund|send (an? )?(email|message)|publish|migrate (the )?database|wire money|transfer)\b/i;
const MEDIUM_RISK = /\b(edit|change|modify|refactor|write to|update|install|run)\b/i;

export function heuristicRoute(question: string): ScoutDecision {
  const q = question.toLowerCase();
  const scored = Object.entries(KEYWORDS)
    .map(([role, res]) => ({ role, score: res.reduce((s, re) => s + (re.test(q) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const shortlist = scored.slice(0, 3).map((x) => x.role);
  if (shortlist.length === 0) shortlist.push('Documentation'); // general questions → the explainer role
  const lane = contractFor(shortlist[0]!)!.lane;
  const risk = HIGH_RISK.test(question) ? 'high' : MEDIUM_RISK.test(question) ? 'medium' : 'low';
  const parts = question.split(/[?.!\n]+/).filter((s) => s.trim().length > 12).length;
  const complexity = Math.max(1, Math.min(5, Math.ceil(question.length / 400) + (parts > 3 ? 1 : 0))) as ScoutDecision['complexity'];
  return { lane, risk, complexity, shortlist, by: 'heuristic' };
}

/** Validate a scout model's JSON; null when it breaks the contract. */
export function parseScoutModelOutput(text: string): Omit<ScoutDecision, 'by'> | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const roles = Array.isArray(o.roles) ? (o.roles as unknown[]).filter((r): r is string => typeof r === 'string' && !!contractFor(r)) : [];
    const risk = o.risk === 'low' || o.risk === 'medium' || o.risk === 'high' ? o.risk : null;
    const complexity = Number(o.complexity);
    if (!roles.length || !risk || !Number.isInteger(complexity) || complexity < 1 || complexity > 5) return null;
    return { lane: contractFor(roles[0]!)!.lane, risk, complexity: complexity as ScoutDecision['complexity'], shortlist: roles.slice(0, 3) };
  } catch {
    return null;
  }
}

export function scoutPrompt(question: string): string {
  return [
    'Route this request. Reply with ONLY JSON: {"roles":[up to 3 of the roles below, best first],"risk":"low|medium|high","complexity":1-5}.',
    `Roles: ${ROLE_CONTRACTS.map((c) => c.role).join(', ')}.`,
    `Request: ${question.slice(0, 2000)}`,
  ].join('\n');
}
