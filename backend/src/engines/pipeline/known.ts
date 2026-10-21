/**
 * Known answers — facts CodeConClave holds in its own configuration, answered
 * deterministically with 0 tokens (never guessed by a model). Today: how to
 * reach the founder / support / partnerships, and who built CodeConClave.
 */
import { env } from '../../config/env.js';

export interface KnownAnswer {
  topic: 'founder_contact' | 'who_built';
  text: string;
}

// The target must be CodeConClave or its people — "email my team" never matches.
const CONTACT: RegExp[] = [
  /\b(contact|reach|e-?mail|mail|talk to|speak (to|with)|get in touch( with)?|message|connect with|write to)\b[^.?!\n]{0,40}\b(the |your )?(co-?founder|founder|creator|owner|ceo|makers?|people behind|team behind)\b/i,
  /\b(contact|reach|e-?mail|talk to|speak (to|with)|get in touch( with)?|write to)\b[^.?!\n]{0,30}\b(code ?con ?clave|your (team|company|support|founder|developers?|creators?|makers?|people))\b/i,
  /\b(code ?con ?clave'?s?|your)\b[^.?!\n]{0,30}\b(support|contact|founder'?s?|help) (e-?mail|mail|address|contact|desk)\b/i,
  /\b(founder'?s?|support) (e-?mail|mail|contact)\b/i,
  /\b(partner(ship)?|invest(or|ment)?|press|media|business) (inquir(y|ies)|with)\b[^.?!\n]{0,30}\b(code ?con ?clave|you|your company)\b/i,
  /\bhow (can|do) i (reach|contact) (you|codeconclave|code con clave)\b/i,
];
const WHO_BUILT = /\bwho (made|built|created|founded|owns|developed|is behind)\b[^.?!\n]{0,20}\b(code ?con ?clave|you|this (app|ai|product|tool|assistant))\b/i;

export function knownAnswer(question: string): KnownAnswer | null {
  const email = env.FOUNDER_CONTACT_EMAIL;
  if (!email) return null;
  // "the founder of Stripe" is someone else's founder.
  const otherCompany = /\b(co-?founder|founder|creator|owner|ceo|makers?)\s+of\s+(?!code ?con ?clave\b|this\b|you\b)/i.test(question);
  if (!otherCompany && CONTACT.some((re) => re.test(question))) {
    return {
      topic: 'founder_contact',
      text: [
        `You can reach CodeConClave's founder directly at **${email}**.`,
        '',
        'That one address covers:',
        '- **Support:** bugs, account, billing and access questions',
        '- **Partnerships and business:** integrations, teams, enterprise, investment',
        '- **Feedback and press**',
        '',
        'For the fastest reply, include your account email, what you were trying to do, and any error message you saw.',
      ].join('\n'),
    };
  }
  if (WHO_BUILT.test(question)) {
    return {
      topic: 'who_built',
      text: `CodeConClave was built by its founder, as an AI coworker for software and knowledge work. You can reach the founder directly at **${email}**.`,
    };
  }
  return null;
}
