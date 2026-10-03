import { describe, it, expect } from 'vitest';
import { isAbsolutePath, baseName, resolveUnderRoot } from '../pathUtils';

/**
 * BUG-WIN-DOUBLED-PATH + BUG-WIN-PARTICIPANT-PATHNAME (2026-07-21) — Windows
 * path handling. The extension host runs cross-platform; paths coming from a
 * Windows workspace use `\` separators and `C:\…` absolute roots. The old
 * POSIX-only `startsWith('/')` guard and `split('/')` basename mishandled both.
 */
describe('pathUtils — cross-platform path handling', () => {
    describe('isAbsolutePath', () => {
        it('detects POSIX absolute paths', () => {
            expect(isAbsolutePath('/Users/x/repo/file.ts')).toBe(true);
        });
        it('detects Windows drive-letter absolute paths (both separators)', () => {
            expect(isAbsolutePath('c:\\Users\\x\\repo\\file.ts')).toBe(true);
            expect(isAbsolutePath('C:/Users/x/repo/file.ts')).toBe(true);
        });
        it('detects Windows UNC paths', () => {
            expect(isAbsolutePath('\\\\server\\share\\file.ts')).toBe(true);
        });
        it('treats relative paths as non-absolute', () => {
            expect(isAbsolutePath('src/app/file.ts')).toBe(false);
            expect(isAbsolutePath('src\\app\\file.ts')).toBe(false);
            expect(isAbsolutePath('./file.ts')).toBe(false);
            expect(isAbsolutePath('')).toBe(false);
        });
    });

    describe('baseName', () => {
        it('returns the basename of a POSIX path', () => {
            expect(baseName('src/app/routes/auth/auth.service.ts')).toBe('auth.service.ts');
        });
        it('returns the basename of a Windows path (BUG-WIN-PARTICIPANT-PATHNAME)', () => {
            expect(baseName('c:\\Users\\91962\\Downloads\\app\\src\\app\\routes\\auth\\auth.service.ts')).toBe('auth.service.ts');
            expect(baseName('src\\app\\routes\\auth\\auth.controller.ts')).toBe('auth.controller.ts');
        });
        it('returns a bare filename unchanged', () => {
            expect(baseName('auth.service.ts')).toBe('auth.service.ts');
        });
        it('handles mixed separators', () => {
            expect(baseName('c:/Users/x\\repo/file.ts')).toBe('file.ts');
        });
    });

    describe('resolveUnderRoot', () => {
        it('joins a relative path under the root', () => {
            expect(resolveUnderRoot('/Users/x/repo', 'src/app/file.ts')).toBe('/Users/x/repo/src/app/file.ts');
        });
        it('returns an ALREADY-ABSOLUTE POSIX path unchanged (no doubling)', () => {
            expect(resolveUnderRoot('/Users/x/repo', '/Users/x/repo/src/app/file.ts')).toBe('/Users/x/repo/src/app/file.ts');
        });
        it('returns an ALREADY-ABSOLUTE Windows path unchanged (BUG-WIN-DOUBLED-PATH)', () => {
            const root = 'c:\\Users\\91962\\Downloads\\node-express-realworld-example-app-master';
            const abs = 'c:\\Users\\91962\\Downloads\\node-express-realworld-example-app-master\\src\\app\\routes\\auth\\auth.service.ts';
            // The exact repro: root must NOT be prepended to the absolute path.
            expect(resolveUnderRoot(root, abs)).toBe(abs);
            expect(resolveUnderRoot(root, abs)).not.toContain('master\\c:');
        });
    });
});
