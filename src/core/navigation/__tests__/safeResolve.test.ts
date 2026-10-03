/**
 * safeResolve.test.ts
 *
 * Tests for workspace path boundary validation.
 * Product Manager use case: A graph node's filePath must never
 * open files outside the workspace root (security boundary).
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { safeResolve } from '../pathValidator';

const WORKSPACE = '/Users/test/project';

// ─── Positive scenarios ──────────────────────────────────────────────────

describe('safeResolve — positive', () => {
    it('resolves relative path within workspace', () => {
        const result = safeResolve(WORKSPACE, 'src/app.ts');
        expect(result).toBe(path.join(WORKSPACE, 'src/app.ts'));
    });

    it('resolves nested relative path', () => {
        const result = safeResolve(WORKSPACE, 'src/features/auth/controller.ts');
        expect(result).toBe(path.join(WORKSPACE, 'src/features/auth/controller.ts'));
    });

    it('resolves absolute path within workspace', () => {
        const result = safeResolve(WORKSPACE, path.join(WORKSPACE, 'src/app.ts'));
        expect(result).toBe(path.join(WORKSPACE, 'src/app.ts'));
    });

    it('resolves path with redundant ./ prefix', () => {
        const result = safeResolve(WORKSPACE, './src/app.ts');
        expect(result).toBe(path.join(WORKSPACE, 'src/app.ts'));
    });

    it('resolves path with internal ../ that stays in workspace', () => {
        const result = safeResolve(WORKSPACE, 'src/features/../utils/helper.ts');
        expect(result).toBe(path.join(WORKSPACE, 'src/utils/helper.ts'));
    });
});

// ─── Negative scenarios (path traversal blocked) ─────────────────────────

describe('safeResolve — negative', () => {
    it('rejects ../ that escapes workspace', () => {
        expect(safeResolve(WORKSPACE, '../../etc/passwd')).toBeNull();
    });

    it('rejects absolute path outside workspace', () => {
        expect(safeResolve(WORKSPACE, '/etc/passwd')).toBeNull();
    });

    it('rejects path to parent directory', () => {
        expect(safeResolve(WORKSPACE, '..')).toBeNull();
    });

    it('rejects path to sibling directory', () => {
        expect(safeResolve(WORKSPACE, '../other-project/secret.ts')).toBeNull();
    });

    it('rejects absolute path to home directory', () => {
        expect(safeResolve(WORKSPACE, '/Users/test/.ssh/id_rsa')).toBeNull();
    });

    it('rejects path with prefix overlap (/project-evil vs /project)', () => {
        expect(safeResolve(WORKSPACE, '/Users/test/project-evil/steal.ts')).toBeNull();
    });
});
