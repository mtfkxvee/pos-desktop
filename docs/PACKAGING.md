# Packaging

## Build installer (default identity)

```bash
npm run dist
```

Produces an NSIS installer (`dist-installer/*.exe`) with `appId: id.nursa.pos.desktop`,
`productName: POS Desktop` (from `electron-builder.yml`).

## Per-outlet builds (different name/identity)

Windows treats apps with a different `productName`/`appId` as fully separate
installs (own Start Menu entry, own userData folder — so device config/API
keys never collide between outlets built from the same source):

```bash
npm run build:renderer
npx electron-builder --win -c.appId=id.nursa.pos.jkt01 -c.productName="POS Kasir - Toko Jakarta"
```

Repeat with a different `appId`/`productName` per outlet as needed.

## Before shipping to a real outlet

- Add a real `build/icon.ico` (256x256) and uncomment `icon:` under `win:` in
  `electron-builder.yml` — currently unset, so electron-builder uses its own
  placeholder icon.
- Deploy the `generate_device_api_key` backend change (see
  `C:\Users\User\pos\pos_next\api\utilities.py`) to the target Frappe server
  first — device setup (Tahap 3) depends on it.
- Set `printerInterface` via `POST /print/config` (or ahead of time in
  the device's userData `config.json`):
  - Network printer: `"tcp://<ip>:9100"`.
  - USB/Windows printer: `"printer:<Exact Name As Shown In Windows>"` —
    sent via the Win32 RAW print spooler (`main/print-raw.ps1`), **no
    native npm module or build tools needed on the outlet machine** at
    all (PowerShell/.NET ship with every Windows install). An earlier
    attempt used the `printer` npm package for this, but its C++ source
    doesn't compile against modern MSVC — abandoned in favor of the
    PowerShell route, which is both simpler and needs zero native
    compilation anywhere, including on this dev machine.

## Releasing an update (auto-update)

The default-identity build (`npm run dist`, no per-outlet override — see
above) auto-updates itself via `electron-updater`, checking this repo's
GitHub Releases on every app start (`main/index.js`'s `initAutoUpdate()`).
It downloads a newer version in the background and installs it the next
time the app quits — never mid-shift, no cashier action needed.

**Requires this repo to be public** (or `GH_TOKEN` set at publish/runtime
for a private one — deliberately not done here: baking a token into an
app handed out to outlets means anyone with the installer can extract and
reuse it).

To ship an update:

1. Bump `version` in `package.json` **and** `renderer/package.json` (both —
   `renderer/package.json`'s isn't read by electron-builder, but keeping
   them in lockstep avoids confusion about which build a given renderer
   bundle came from).
2. `npm run dist` — besides the installer, this also produces
   `dist-installer/latest.yml`, which is what tells already-installed
   copies of the app a new version exists.
3. Publish a GitHub Release tagged `v<version>` (matching `package.json`)
   and upload **both** the `.exe` and `latest.yml` from `dist-installer/`
   as release assets. `electron-builder`'s own `--publish always` flag can
   do steps 2–3 in one go if a `GH_TOKEN` with `repo` scope is set in the
   *build* environment (never shipped in the app itself):
   ```bash
   GH_TOKEN=<token with repo scope> npm run dist -- --publish always
   ```
4. Outlets already running the app pick it up on their next check
   (app start) and install it on their next quit — nothing to send them
   manually.

Per-outlet custom builds (different `appId`/`productName`) do **not** go
through this feed as-is — they'd need their own release channel
(`publish.channel` per build, or a separate repo) since GitHub Releases has
one feed per repo, not per `appId`.

## What's NOT packaged

`renderer/src` and `renderer/node_modules` are excluded — only the built
`renderer/dist` output ships. Re-run `npm run build:renderer` after any
renderer source change, before `npm run dist`.
