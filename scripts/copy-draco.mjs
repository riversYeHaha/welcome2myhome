#!/usr/bin/env node
/**
 * Copy the self-hosted Draco decoder into Vite's publicDir.
 *
 * Vite's root is `src/web`, so `src/web/public/draco/*` is published as
 * `/draco/*` in dev and copied to `dist/web/draco/` on build. The viewer then
 * calls `DRACOLoader.setDecoderPath('/draco/')` — no CDN, works offline on the
 * LAN, as required by tech design §5.8 / §7.4.
 *
 * Run after bumping three: `node scripts/copy-draco.mjs`
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const threeDir = join(root, 'node_modules/three');
const sourceDir = join(threeDir, 'examples/jsm/libs/draco/gltf');
const targetDir = join(root, 'src/web/public/draco');

const FILES = ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'];

const version = JSON.parse(readFileSync(join(threeDir, 'package.json'), 'utf8')).version;
mkdirSync(targetDir, { recursive: true });
for (const file of FILES) {
  copyFileSync(join(sourceDir, file), join(targetDir, file));
  console.log(`copied ${file}`);
}
console.log(`draco decoder (three ${version}) → ${targetDir}`);
