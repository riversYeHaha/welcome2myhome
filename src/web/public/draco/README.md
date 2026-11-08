# Draco decoder (self-hosted)

These files are copied from `node_modules/three/examples/jsm/libs/draco/gltf/`
(three r187) so that `DRACOLoader` can decode `KHR_draco_mesh_compression` GLBs
without any CDN or internet access — the LAN party must work offline.

- Public URL: `/draco/` (Vite `publicDir` = `src/web/public` → `dist/web/draco`)
- Viewer: `src/web/guest/viewer.ts` calls `dracoLoader.setDecoderPath('/draco/')`
- Regenerate after a three upgrade: `node scripts/copy-draco.mjs`

CSP notes (for the security baseline task): `DRACOLoader` builds a Blob-backed
Web Worker and compiles the WASM decoder inside it, so a future CSP needs
`worker-src 'self' blob:` and `script-src` must allow `'wasm-unsafe-eval'`
(WebAssembly compilation); no `unsafe-eval` is required by this code.
