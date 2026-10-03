/**
 * editorOpener.test.ts — covers the standalone "click-to-source" fallback
 * chain. Pre-PR: `vscode.window.showTextDocument` was the only way to open a
 * file from the browser. In the standalone npm package, we spawn `$EDITOR`
 * (or one of the fallbacks) instead. These tests pin the resolution order
 * and the per-editor argv shape so a future refactor can't silently change
 * which editor opens.
 */
import { describe, it, expect } from 'vitest';
import { openInEditor, buildEditorArgs } from '../editorOpener';

describe('editorOpener — argv shape per editor', () => {
    it('code → `-g path:line` with line', () => {
        expect(buildEditorArgs('code', '/src/a.ts', 42)).toEqual(['-g', '/src/a.ts:42']);
    });
    it('code → path only without line', () => {
        expect(buildEditorArgs('code', '/src/a.ts', undefined)).toEqual(['/src/a.ts']);
    });
    it('cursor and subl share the code convention', () => {
        expect(buildEditorArgs('cursor', '/src/a.ts', 5)).toEqual(['-g', '/src/a.ts:5']);
        expect(buildEditorArgs('subl', '/src/a.ts', 5)).toEqual(['-g', '/src/a.ts:5']);
    });
    it('vim/nvim → `+line path`', () => {
        expect(buildEditorArgs('vim', '/src/a.ts', 10)).toEqual(['+10', '/src/a.ts']);
        expect(buildEditorArgs('nvim', '/src/a.ts', 10)).toEqual(['+10', '/src/a.ts']);
    });
    it('unknown editor → path only', () => {
        expect(buildEditorArgs('emacs', '/src/a.ts', 5)).toEqual(['/src/a.ts']);
    });
});

describe('editorOpener — resolution order', () => {
    it('honors CODEATLAS_EDITOR before EDITOR', async () => {
        const tried: string[] = [];
        const result = await openInEditor('/x.ts', 3, {
            env: { CODEATLAS_EDITOR: 'cursor', EDITOR: 'vim' },
            spawner: async (cmd) => { tried.push(cmd); return cmd === 'cursor'; },
        });
        expect(result.spawned).toBe(true);
        expect(result.editor).toBe('cursor');
        expect(tried[0]).toBe('cursor');
    });

    it('honors EDITOR when CODEATLAS_EDITOR unset', async () => {
        const tried: string[] = [];
        const result = await openInEditor('/x.ts', 3, {
            env: { EDITOR: 'nvim' },
            spawner: async (cmd) => { tried.push(cmd); return cmd === 'nvim'; },
        });
        expect(result.editor).toBe('nvim');
        expect(tried[0]).toBe('nvim');
    });

    it('falls through to `code` when neither env var is set', async () => {
        const tried: string[] = [];
        const result = await openInEditor('/x.ts', 3, {
            env: {},
            spawner: async (cmd) => { tried.push(cmd); return cmd === 'code'; },
        });
        expect(result.editor).toBe('code');
        expect(tried).toEqual(['code']);
    });

    it('keeps trying the fallback chain when earlier candidates fail', async () => {
        const tried: string[] = [];
        const result = await openInEditor('/x.ts', 3, {
            env: {},
            // Simulate `code` + `cursor` not installed, `subl` works.
            spawner: async (cmd) => { tried.push(cmd); return cmd === 'subl'; },
        });
        expect(result.spawned).toBe(true);
        expect(result.editor).toBe('subl');
        expect(tried).toEqual(['code', 'cursor', 'subl']);
    });

    it('returns spawned=false + fallbackPath when no editor is available', async () => {
        const result = await openInEditor('/src/a.ts', 7, {
            env: {},
            spawner: async () => false, // nothing installed
        });
        expect(result.spawned).toBe(false);
        expect(result.fallbackPath).toBe('/src/a.ts:7');
        expect(result.toast).toContain('/src/a.ts:7');
    });

    it('fallbackPath omits :line when line is undefined', async () => {
        const result = await openInEditor('/src/a.ts', undefined, {
            env: {},
            spawner: async () => false,
        });
        expect(result.fallbackPath).toBe('/src/a.ts');
    });

    it('does not retry the same command from CODEATLAS_EDITOR when it also appears in fallbacks', async () => {
        const tried: string[] = [];
        const result = await openInEditor('/x.ts', 1, {
            env: { CODEATLAS_EDITOR: 'code' }, // also in fallback chain
            spawner: async (cmd) => { tried.push(cmd); return false; }, // all fail
        });
        const codeCount = tried.filter(c => c === 'code').length;
        expect(codeCount, 'code should appear in the resolution order exactly once').toBe(1);
        expect(result.spawned).toBe(false);
    });
});
