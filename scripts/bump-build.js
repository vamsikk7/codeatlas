#!/usr/bin/env node
/**
 * bump-build.js
 *
 * Increments `buildNumber` in package.json by 1 before each package step so
 * every VSIX has a unique build identifier. The semver `version` field stays
 * untouched (3-part as required by vsce); `buildNumber` is a sibling field
 * that surfaces as the 4th identifier in the UI: "v4.0.1.5".
 *
 * Run via npm: `npm run package` is wired to invoke this first.
 */

const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const raw = fs.readFileSync(pkgPath, 'utf-8');
const pkg = JSON.parse(raw);

const current = typeof pkg.buildNumber === 'number' ? pkg.buildNumber : 0;
const next = current + 1;
pkg.buildNumber = next;

// Preserve the original formatting (trailing newline, key order) — package.json
// uses 2-space indent throughout.
const out = JSON.stringify(pkg, null, 2) + (raw.endsWith('\n') ? '\n' : '');
fs.writeFileSync(pkgPath, out);

// eslint-disable-next-line no-console
console.log(`[bump-build] buildNumber ${current} → ${next} (v${pkg.version}.${next})`);
