// Package the Windows desktop app, code-signed when signing is configured.
//
// Windows SmartScreen ("Windows protected your PC") and Smart App Control
// block unsigned installers. Signing is the only real fix; this picks the
// method from the environment (no secrets live in the repo):
//
//   Azure Trusted Signing  AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT,
//                          AZURE_SIGN_PROFILE, AZURE_SIGN_PUBLISHER
//                          (+ AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)
//   Certificate (.pfx)     WIN_CSC_LINK or CSC_LINK (+ WIN_CSC_KEY_PASSWORD / CSC_KEY_PASSWORD)
//   Certificate (token/    WIN_CERT_SHA1 — thumbprint of a cert in the Windows
//    cloud HSM, EV/OV)     store, e.g. a USB token or SSL.com eSigner / KeyLocker
//   Microsoft Store        --store: builds an .appx/.msix; the Store signs it.
//                          Needs APPX_IDENTITY_NAME, APPX_PUBLISHER (CN=…),
//                          APPX_PUBLISHER_DISPLAY_NAME from Partner Center.
//
// With none set it still builds, unsigned, and says so loudly.
// Usage: node scripts/package-win.mjs [--store] [--require-signing]
import { build } from 'electron-builder';

const env = process.env;
const args = new Set(process.argv.slice(2));
const store = args.has('--store');

/** Pick the signing setup from env. Returns [label, config overrides]. */
export function signingConfig(e = env, forStore = false) {
  if (forStore) {
    const missing = ['APPX_IDENTITY_NAME', 'APPX_PUBLISHER', 'APPX_PUBLISHER_DISPLAY_NAME'].filter((k) => !e[k]);
    if (missing.length) throw new Error(`--store needs ${missing.join(', ')} (from Partner Center → Product identity).`);
    return [
      'Microsoft Store package (signed by the Store on submission)',
      {
        appx: {
          identityName: e.APPX_IDENTITY_NAME,
          publisher: e.APPX_PUBLISHER,
          publisherDisplayName: e.APPX_PUBLISHER_DISPLAY_NAME,
          displayName: 'CodeConClave',
          applicationId: 'CodeConClave',
          backgroundColor: '#1b1a18',
        },
      },
    ];
  }
  if (e.AZURE_SIGN_ENDPOINT && e.AZURE_SIGN_ACCOUNT && e.AZURE_SIGN_PROFILE && e.AZURE_SIGN_PUBLISHER) {
    return [
      `Azure Trusted Signing (${e.AZURE_SIGN_ACCOUNT}/${e.AZURE_SIGN_PROFILE})`,
      {
        win: {
          azureSignOptions: {
            endpoint: e.AZURE_SIGN_ENDPOINT,
            codeSigningAccountName: e.AZURE_SIGN_ACCOUNT,
            certificateProfileName: e.AZURE_SIGN_PROFILE,
            publisherName: e.AZURE_SIGN_PUBLISHER,
          },
        },
      },
    ];
  }
  if (e.WIN_CERT_SHA1) {
    return [
      `certificate from the Windows store (${e.WIN_CERT_SHA1.slice(0, 8)}…)`,
      { win: { signtoolOptions: { certificateSha1: e.WIN_CERT_SHA1, signingHashAlgorithms: ['sha256'], rfc3161TimeStampServer: 'http://timestamp.digicert.com' } } },
    ];
  }
  if (e.WIN_CSC_LINK || e.CSC_LINK) {
    // electron-builder reads CSC_LINK / CSC_KEY_PASSWORD itself.
    return ['certificate file (CSC_LINK)', { win: { signtoolOptions: { signingHashAlgorithms: ['sha256'] } } }];
  }
  return [null, {}];
}

const [method, config] = signingConfig(env, store);
if (!method) {
  const msg = [
    '',
    '!! Building an UNSIGNED installer.',
    '!! Windows SmartScreen will show "Windows protected your PC" for it, and',
    '!! Smart App Control will block it. Set up signing first — see',
    '!! docs/DESKTOP_CODE_SIGNING.md — or use --store for the Microsoft Store.',
    '',
  ].join('\n');
  if (args.has('--require-signing')) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
} else {
  console.log(`Signing with: ${method}`);
}

await build({ win: [store ? 'appx' : 'nsis'], config });
