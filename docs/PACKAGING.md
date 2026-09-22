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

## What's NOT packaged

`renderer/src` and `renderer/node_modules` are excluded — only the built
`renderer/dist` output ships. Re-run `npm run build:renderer` after any
renderer source change, before `npm run dist`.
