/**
 * applyEditOp.test.ts
 *
 * Unit-level tests for `applyEditOp` — the pure string-transform helper used
 * by every cascade scenario. The probe-driver tests (perRepoCascadeProbe) had
 * been silently mis-targeting one-line arrow functions (#420) and failing on
 * Ruby `def name … end` (#421). These tests pin the correct behaviour so the
 * harness fails loudly rather than corrupting an unrelated function body.
 */

import { describe, it, expect } from 'vitest';
import { applyEditOp } from './cascadeHarness';

describe('applyEditOp — addLinesToFunction body-opener strategies', () => {
    // ─── Issue #420 — arrow-expression bodies ────────────────────────────────
    it('throws a recognizable error on a one-line arrow expression (no `{}` block)', () => {
        // `stringify` is bodyless; the next `{` belongs to `middleware`.
        // Pre-fix: the walker silently inserted into `middleware`'s body.
        // Post-fix: must throw with `bodyless` in the message so probes can skip.
        const src = `const stringify = contents => JSON.stringify(contents, null, 2)\n` +
            `function middleware(req) {\n  return req;\n}\n`;
        expect(() => applyEditOp(src, {
            op: 'addLinesToFunction', fnName: 'stringify', lines: ['// added'],
        })).toThrow(/bodyless|arrow|expression body/i);
    });

    it('throws when arrow expression body is wrapped in parens (object-return shorthand)', () => {
        // `make = x => ({ a: x })` — still an expression body.
        const src = `const make = x => ({ a: x })\n` +
            `function other() {\n  return 42;\n}\n`;
        expect(() => applyEditOp(src, {
            op: 'addLinesToFunction', fnName: 'make', lines: ['// added'],
        })).toThrow(/bodyless|arrow|expression body/i);
    });

    it('still handles arrow functions with explicit `{}` block bodies', () => {
        const src = `const handler = (req) => {\n  return req;\n};\n`;
        const out = applyEditOp(src, {
            op: 'addLinesToFunction', fnName: 'handler', lines: ['const _probe = 1;'],
        });
        // The inserted line should appear ABOVE the existing return.
        const probeIdx = out.indexOf('const _probe = 1;');
        const returnIdx = out.indexOf('return req;');
        expect(probeIdx).toBeGreaterThan(0);
        expect(probeIdx).toBeLessThan(returnIdx);
    });

    it('still handles `function` declarations (sanity)', () => {
        const src = `function pageNotFound(ctx) {\n  ctx.status = 404;\n}\n`;
        const out = applyEditOp(src, {
            op: 'addLinesToFunction', fnName: 'pageNotFound', lines: ['ctx.foo = 1;'],
        });
        expect(out).toContain('ctx.foo = 1;');
        expect(out.indexOf('ctx.foo')).toBeLessThan(out.indexOf('ctx.status'));
    });

    // ─── Issue #421 — Ruby def … end ─────────────────────────────────────────
    it('inserts into a Ruby `def name(args)` body (no `{` or `:`)', () => {
        const src = `class User\n  def favorite(article)\n    favorites << article\n  end\nend\n`;
        const out = applyEditOp(src, {
            op: 'addLinesToFunction', fnName: 'favorite', lines: ['# added'],
        });
        expect(out).toContain('# added');
        // The comment lands AFTER `def favorite(article)` and BEFORE the body.
        const defIdx = out.indexOf('def favorite');
        const addedIdx = out.indexOf('# added');
        const bodyIdx = out.indexOf('favorites << article');
        expect(addedIdx).toBeGreaterThan(defIdx);
        expect(addedIdx).toBeLessThan(bodyIdx);
    });

    it('handles Ruby `def name` with no parentheses', () => {
        const src = `class Foo\n  def hello\n    puts 'hi'\n  end\nend\n`;
        const out = applyEditOp(src, {
            op: 'addLinesToFunction', fnName: 'hello', lines: ['# added'],
        });
        const addedIdx = out.indexOf('# added');
        const putsIdx = out.indexOf("puts 'hi'");
        expect(addedIdx).toBeGreaterThan(0);
        expect(addedIdx).toBeLessThan(putsIdx);
    });

    // ─── Issue #425 — Kotlin / Swift return-type annotations ─────────────────
    it('handles Kotlin `fun foo(): ReturnType { ... }` (return type before brace)', () => {
        const src = `class App {\n    fun receivedMessage(msg: String): Boolean {\n        return true\n    }\n}\n`;
        const out = applyEditOp(src, {
            op: 'addLinesToFunction', fnName: 'receivedMessage', lines: ['val x = 1'],
        });
        const addedIdx = out.indexOf('val x = 1');
        const returnIdx = out.indexOf('return true');
        expect(addedIdx).toBeGreaterThan(0);
        expect(addedIdx).toBeLessThan(returnIdx);
    });

    it('handles Swift `func foo() -> ReturnType { ... }`', () => {
        const src = `struct AccountView {\n    func signIn(email: String) -> Bool {\n        return true\n    }\n}\n`;
        const out = applyEditOp(src, {
            op: 'addLinesToFunction', fnName: 'signIn', lines: ['let x = 1'],
        });
        const addedIdx = out.indexOf('let x = 1');
        const returnIdx = out.indexOf('return true');
        expect(addedIdx).toBeGreaterThan(0);
        expect(addedIdx).toBeLessThan(returnIdx);
    });
});
