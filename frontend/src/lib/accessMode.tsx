/**
 * CodeConClave — temporary demo / early-access access mode, exposed to the UI.
 *
 * This is a pure *presentation* signal read from the server's authoritative
 * GET /api/v1/access reply (`mode.temporaryDemoMode`). It grants nothing and
 * gates nothing server-side: the backend remains the only authority over
 * entitlement, 402s and payment. Its only job is to let the client stop
 * rendering the commercial payment/upgrade surface while early access is open,
 * so that a customer-facing build never shows prices, checkout or plan CTAs
 * that are intentionally dormant for this period.
 *
 * When demo mode is switched off server-side, `temporaryDemoMode` becomes
 * false and the same components render their normal commercial surface again —
 * no payment code is deleted, only conditionally rendered.
 */
import { createContext, useContext, type ReactNode } from 'react';

const AccessModeContext = createContext<boolean>(false);

export function AccessModeProvider({ earlyAccess, children }: { earlyAccess: boolean; children: ReactNode }) {
  return <AccessModeContext.Provider value={earlyAccess}>{children}</AccessModeContext.Provider>;
}

/**
 * True while the server reports temporary demo / early-access mode.
 *
 * Defaults to `false` outside the provider so components render their normal
 * surface if the shell has not yet resolved an authoritative access reply.
 */
export function useEarlyAccess(): boolean {
  return useContext(AccessModeContext);
}
