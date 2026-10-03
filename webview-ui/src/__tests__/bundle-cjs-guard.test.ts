/**
 * bundle-cjs-guard.test.ts (#532)
 *
 * Static check against the built webview bundle: no stray CommonJS
 * `require('./…')` or `require("./…")` calls. They blow up at runtime
 * with "require is not defined" because the bundle ships ESM only.
 *
 * Why this exists: unit tests run in Node where `require` is real, so
 * a stray `require('./SomeComponent')` inside a component body
 * resolves at test time but breaks in the browser. Issue #532 fix.
 *
 * Allowed exceptions: vendor libraries that gate the call behind an
 * `if (typeof require !== 'undefined' && require)` style runtime check —
 * these patterns look like `<ident>.require && <ident>.require("util")`
 * and are skipped by the regex below.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('webview bundle ESM purity', () => {
    const bundlePath = path.resolve(__dirname, '../../dist/assets/index.js');

    it('built bundle exists (run `npm run build` first)', () => {
        expect(fs.existsSync(bundlePath)).toBe(true);
    });

    it('built bundle has no unguarded require("./…") calls', () => {
        if (!fs.existsSync(bundlePath)) return;
        const src = fs.readFileSync(bundlePath, 'utf-8');
        // Find every `require("./*")` or `require('./*')` occurrence with a
        // few chars of leading context. We then drop the vendor-safe forms
        // (`x.require && x.require(...)`).
        const rx = /(.{0,30})\brequire\(["'](\.\/[^"']+)["']\)/g;
        const offenders: Array<{ ctx: string; spec: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = rx.exec(src)) !== null) {
            const ctx = m[1];
            const spec = m[2];
            // Skip vendor-internal `obj.require && obj.require("./...")` —
            // these short-circuit when `obj.require` is undefined.
            if (/\.\s*require\s*&&\s*$/.test(ctx)) continue;
            offenders.push({ ctx, spec });
        }
        if (offenders.length > 0) {
            const lines = offenders.map((o) => `  - ${o.spec} (ctx: ${o.ctx.trim()})`).join('\n');
            throw new Error(
                `Bundle contains unguarded require() calls — these break the browser with "require is not defined":\n${lines}\n` +
                `Convert them to ESM imports.`,
            );
        }
        expect(offenders.length).toBe(0);
    });
});
