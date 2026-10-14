#!/usr/bin/env node

/**
 * Remove compiled output whose source is gone.
 *
 * `tsc` never deletes from dist/, and dist/ is ignored by git, so a source file deleted from src/ leaves its old
 * .js, .d.ts and maps behind in every checkout that builds in place — and `files: ["dist"]` would publish them. That is
 * how a removed hardcoded key survived in dist/scripts/wispr-transcribe.js. This runs after every build and removes
 * only those orphans; everything with a source stays, so a live dist/ is never emptied mid-build.
 */

import { existsSync, lstatSync, readdirSync, rmSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const src = join(root, 'src');
const EMITTED = /\.(js|d\.ts|js\.map|d\.ts\.map)$/;
// Every source tsc can emit from with resolveJsonModule and a possible allowJs, plus handwritten declarations.
const SOURCES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    // Never follow a symlink: a linked directory would walk outside dist/ and delete someone else's files.
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

if (existsSync(dist)) {
  for (const file of walk(dist)) {
    const rel = relative(dist, file);
    if (!EMITTED.test(rel)) continue; // VERSION and other non-compiled files are not ours to judge
    const base = rel.replace(EMITTED, '');
    if (SOURCES.some((ext) => existsSync(join(src, `${base}${ext}`)))) continue;
    rmSync(file);
    console.log(`removed stale build output: dist/${rel}`);
  }
}
