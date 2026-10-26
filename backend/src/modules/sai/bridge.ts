/**
 * Agent Sai → the brain. This is what makes CodeConClave answer WITH PROOF.
 *
 * Before the model answers a chat turn, we check whether the question needs
 * real-world data (weather, prices, a package, earthquakes, a satellite…). If
 * it does, we pull the REAL data from Agent Sai's live sources and hand it to
 * the model as verified context, with the source URL, so the answer is grounded
 * and cites where it came from. Detection is deterministic (keyword → source),
 * which is reliable even on a small tuned model — no fragile tool-calling.
 *
 * Honest by design: if nothing matches, or the source fails, we return null and
 * the model just answers normally — we never invent a "source".
 */
import { runConnector, type SaiEvidence } from './connectors.js';

/** Trim trailing time/filler words so a place query geocodes cleanly. */
function place(s: string): string {
  return s
    .trim()
    .replace(/\s+(?:today|now|right now|currently|please|for me|this (?:morning|evening|afternoon|week|weekend))\b.*$/i, '')
    .replace(/[?.!,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map a user's message to one Agent Sai source + query, or null if no data need. */
function detect(message: string): { sourceId: string; query: string } | null {
  const m = message.toLowerCase();
  let x: RegExpMatchArray | null;

  // Weather — both orders: "weather in Ongole" AND "Ongole weather".
  if (
    (x = m.match(/\b(?:weather|temperature|forecast|how hot|how cold|climate)\b[^.?!]*?\b(?:in|at|for|of)\s+([a-z][a-z .'-]{1,38})/)) ||
    (x = m.match(/\b([a-z][a-z .'-]{1,34}?)\s+(?:weather|temperature|forecast|climate)\b/))
  ) {
    return { sourceId: 'open-meteo', query: place(x[1]!) };
  }
  // Air quality — both orders.
  if (
    (x = m.match(/\b(?:air quality|aqi|pollution|pm ?2\.?5|pm ?10|smog)\b[^.?!]*?\b(?:in|at|for|of)\s+([a-z][a-z .'-]{1,38})/)) ||
    (x = m.match(/\b([a-z][a-z .'-]{1,34}?)\s+(?:air quality|aqi|pollution)\b/))
  ) {
    return { sourceId: 'open-meteo-air-quality', query: place(x[1]!) };
  }

  // Crypto
  if (/\b(bitcoin|btc|ethereum|eth|crypto price|coin price|price of .*(bitcoin|ethereum|crypto))\b/.test(m)) {
    const coins = (m.match(/\b(bitcoin|ethereum|solana|dogecoin|cardano|polkadot|litecoin)\b/g) ?? ['bitcoin']).join(' ');
    return { sourceId: 'coingecko', query: coins };
  }

  // Currency / exchange rate
  if ((x = m.match(/\b([a-z]{3})\s*(?:to|in|vs|->|→)\s*([a-z]{3})\b/)) && /\b(rate|convert|exchange|currency|worth|equals?)\b/.test(m)) {
    return { sourceId: 'frankfurter', query: `${x[1]!.toUpperCase()} ${x[2]!.toUpperCase()}` };
  }
  if (/\b(exchange rate|currency rate|forex|conversion rate)\b/.test(m)) return { sourceId: 'frankfurter', query: 'USD INR' };

  // India mandi prices
  if ((x = m.match(/\b(?:mandi|market)\s+price[^.?!]*?\b(?:of|for)\s+([a-z]{3,20})/)) || (x = m.match(/\bprice of\s+([a-z]{3,15})\b[^.?!]*\bmandi\b/))) {
    return { sourceId: 'data-gov-in', query: x[1]!.trim().replace(/^\w/, (c) => c.toUpperCase()) };
  }

  // Earthquakes
  if (/\b(earthquakes?|seismic|tremors?|magnitude .* quake)\b/.test(m)) return { sourceId: 'usgs-earthquakes', query: '' };

  // Indian bank IFSC
  if ((x = m.match(/\bifsc\b[^.?!]*?\b([a-z]{4}0[a-z0-9]{6})\b/i))) return { sourceId: 'ifsc-razorpay', query: x[1]! };

  // India PIN code
  if ((x = m.match(/\b(?:pin\s?code|pincode|postal code)\b[^.?!]*?\b(\d{6})\b/)) || (x = m.match(/\bwhich (?:place|area|city).*?\b(\d{6})\b/))) return { sourceId: 'india-post-pincode', query: x[1]! };

  // ISS / satellites
  if (/\b(where (is )?the )?(iss|space station)\b/.test(m) && /\b(where|location|position|now|over)\b/.test(m)) return { sourceId: 'satellite-position', query: '25544' };
  if (/\bhow many people (are )?in space\b/.test(m)) return { sourceId: 'people-in-space', query: '' };

  // Word meaning
  if ((x = m.match(/\b(?:meaning|definition|define)\s+(?:of\s+)?([a-z][a-z-]{1,20})\b/)) || (x = m.match(/\bwhat does\s+([a-z-]{2,20})\s+mean\b/))) return { sourceId: 'free-dictionary', query: x[1]! };

  // Package ecosystems
  if ((x = m.match(/\bnpm\s+(?:package\s+)?([a-z0-9@/._-]{2,40})/))) return { sourceId: 'npm-pypi-stats', query: x[1]! };
  if ((x = m.match(/\b(?:pypi|python package)\s+([a-z0-9._-]{2,40})/))) return { sourceId: 'pypi', query: x[1]! };

  // GitHub repos
  if ((x = m.match(/\bgithub\b[^.?!]*?\b(?:repos?|repositor(?:y|ies)|projects?)\b[^.?!]*?\b(?:for|about|on)\s+([a-z0-9 ._-]{2,40})/))) return { sourceId: 'github', query: x[1]!.trim() };

  // News
  if ((x = m.match(/\b(?:latest )?news\b[^.?!]*?\b(?:about|on|regarding)\s+([a-z0-9 ._-]{2,40})/))) return { sourceId: 'gdelt', query: x[1]!.trim() };

  return null;
}

/** Pull Agent Sai evidence for a chat message, or null (no data need / source down). */
export async function saiEvidenceForMessage(message: string): Promise<SaiEvidence | null> {
  const hit = detect(message);
  if (!hit) return null;
  try {
    return await runConnector(hit.sourceId, hit.query);
  } catch {
    return null; // honest: a failed source yields no proof, never a fake one
  }
}

/** Format evidence as a context block the model must answer from and cite. */
export function saiEvidenceBlock(ev: SaiEvidence): string {
  const details = (() => {
    try {
      return JSON.stringify(ev.data).slice(0, 700);
    } catch {
      return '';
    }
  })();
  return [
    '\n\n--- REAL-TIME DATA from Agent Sai (verified live; answer from THIS, do not contradict it) ---',
    ev.summary,
    details ? `Details: ${details}` : '',
    `Source: ${ev.source} — ${ev.sourceUrl} (fetched ${ev.fetchedAt})`,
    `When you use this data, finish your reply with a line: "📊 Source: ${ev.source}".`,
  ]
    .filter(Boolean)
    .join('\n');
}
