# CodeConClave Desktop — Windows code signing (SmartScreen fix)

## Why Windows says "Windows protected your PC"

`desktop/release/CodeConClave Setup 0.1.1.exe` is **not digitally signed**
(`Get-AuthenticodeSignature` → `NotSigned`). Windows SmartScreen warns on any
unsigned download, and Smart App Control (Windows 11) blocks unsigned apps
outright. No code change can remove the warning. The installer has to be
signed with a certificate Windows trusts, or shipped through the Microsoft Store.

## Options (pick one)

| Option | Cost (approx.) | Who can get it | SmartScreen result |
| --- | --- | --- | --- |
| **Microsoft Store** (`npm run package:desktop:store`) | Free individual developer account | Anyone | No warning. The Store signs the package. |
| **Azure Trusted Signing** | ~US$10 / month | Organizations and individuals in [supported regions](https://learn.microsoft.com/azure/trusted-signing/) | Signed by Microsoft's CA, and reputation builds quickly |
| **OV / EV code-signing certificate** (Sectigo, DigiCert, SSL.com, Certum) | ~US$200–600 / year | Registered business (OV/EV); Certum also sells to individuals | Signed. Reputation builds as people download it. EV no longer skips the reputation step. |

Since 2023, CAs only issue code-signing keys on hardware (USB token) or a
cloud HSM (SSL.com eSigner, DigiCert KeyLocker), so plan for that.

## How the build picks a method

`npm run package:desktop` runs `desktop/scripts/package-win.mjs`, which reads
the environment (no secrets in the repo):

```powershell
# Azure Trusted Signing
$env:AZURE_SIGN_ENDPOINT  = "https://eus.codesigning.azure.net/"
$env:AZURE_SIGN_ACCOUNT   = "<code signing account>"
$env:AZURE_SIGN_PROFILE   = "<certificate profile>"
$env:AZURE_SIGN_PUBLISHER = "<publisher name exactly as on the certificate>"
$env:AZURE_TENANT_ID = "..."; $env:AZURE_CLIENT_ID = "..."; $env:AZURE_CLIENT_SECRET = "..."

# OR a .pfx certificate file
$env:WIN_CSC_LINK = "C:\secure\codeconclave.pfx"; $env:WIN_CSC_KEY_PASSWORD = "..."

# OR a certificate on a USB token / cloud HSM (installed in the Windows cert store)
$env:WIN_CERT_SHA1 = "<certificate thumbprint>"

npm run package:desktop:signed --workspace @codeconclave/desktop   # fails if nothing is configured
```

Microsoft Store: reserve the app name in Partner Center, then copy the values
from **Product identity**:

```powershell
$env:APPX_IDENTITY_NAME = "12345CodeConClave.CodeConClave"
$env:APPX_PUBLISHER = "CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
$env:APPX_PUBLISHER_DISPLAY_NAME = "CodeConClave"
npm run package:desktop:store --workspace @codeconclave/desktop
```

With nothing configured, `npm run package:desktop` still builds, prints a loud
**UNSIGNED** warning, and Windows will keep showing the prompt.

## Verify before publishing

```powershell
Get-AuthenticodeSignature "desktop\release\CodeConClave Setup 0.1.1.exe" | Format-List Status, SignerCertificate
```

`Status` must be `Valid`. Re-record the SHA256 after signing, because signing
changes the file.

## Until it's signed (your own machine only)

- SmartScreen: click **More info → Run anyway**.
- A downloaded file: right-click → **Properties** → tick **Unblock**.

Don't ask customers to do this. Ship a signed build.
