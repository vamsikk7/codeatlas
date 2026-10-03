/**
 * UX-71 (2026-06-09) — per-repo `.gitignore` patterns merged into the
 * WorkspaceWatcher ignore list.
 *
 * Today the WorkspaceWatcher uses a fixed ignore list at workspaceRoot
 * (`**\/.git/**`, `**\/node_modules/**`, etc). Each sub-repo may have
 * its own `.gitignore` (build artifacts, `vendor/`, language-specific
 * dirs), but those aren't consulted. The helper here reads every
 * detected sub-repo's `.gitignore` (if present), normalises the patterns
 * to chokidar-compatible globs scoped under the sub-repo's `rootPath`,
 * and returns them ready to merge into the watcher's ignore array.
 */
import { describe, it, expect } from 'vitest';
import {
    parseGitignoreLines,
    perRepoGitignoreToGlobs,
    type GitignoreSource,
} from '../perRepoGitignore';

describe('parseGitignoreLines', () => {
    it('returns an empty array for null/empty input', () => {
        expect(parseGitignoreLines(null)).toEqual([]);
        expect(parseGitignoreLines('')).toEqual([]);
        expect(parseGitignoreLines(undefined)).toEqual([]);
    });

    it('strips comments and blank lines', () => {
        const out = parseGitignoreLines(`
# This is a comment
node_modules

# Another comment
dist
        `);
        expect(out).toEqual(['node_modules', 'dist']);
    });

    it('strips inline whitespace + trailing slash', () => {
        const out = parseGitignoreLines('  build/  \n  vendor/  ');
        expect(out).toEqual(['build', 'vendor']);
    });

    it('ignores negations (we never want to UN-ignore a file the user said to ignore)', () => {
        const out = parseGitignoreLines('node_modules\n!important.log\n.cache');
        expect(out).toEqual(['node_modules', '.cache']);
    });

    it('passes nested patterns through', () => {
        const out = parseGitignoreLines('src/generated/\n*.tmp\nfoo/bar/baz.txt');
        expect(out).toEqual(['src/generated', '*.tmp', 'foo/bar/baz.txt']);
    });
});

describe('perRepoGitignoreToGlobs', () => {
    it('returns an empty array for empty input', () => {
        expect(perRepoGitignoreToGlobs([])).toEqual([]);
    });

    it('scopes each pattern under the sub-repo rootPath', () => {
        const sources: GitignoreSource[] = [
            { rootPath: 'service-a', text: 'build\nvendor' },
        ];
        const out = perRepoGitignoreToGlobs(sources);
        expect(out).toEqual([
            'service-a/**/build/**',
            'service-a/**/vendor/**',
        ]);
    });

    it('handles glob patterns ending in /', () => {
        const sources: GitignoreSource[] = [
            { rootPath: 'svc', text: 'dist/\n.cache/' },
        ];
        const out = perRepoGitignoreToGlobs(sources);
        expect(out).toEqual([
            'svc/**/dist/**',
            'svc/**/.cache/**',
        ]);
    });

    it('expands wildcard file patterns to **/<pattern>', () => {
        const sources: GitignoreSource[] = [
            { rootPath: 'svc', text: '*.tmp\n*.log' },
        ];
        const out = perRepoGitignoreToGlobs(sources);
        expect(out).toEqual([
            'svc/**/*.tmp',
            'svc/**/*.log',
        ]);
    });

    it('preserves nested paths', () => {
        const sources: GitignoreSource[] = [
            { rootPath: 'svc', text: 'src/generated' },
        ];
        const out = perRepoGitignoreToGlobs(sources);
        expect(out).toEqual(['svc/**/src/generated/**']);
    });

    it('merges multiple sub-repos', () => {
        const sources: GitignoreSource[] = [
            { rootPath: 'svc-a', text: 'build' },
            { rootPath: 'svc-b', text: 'dist' },
        ];
        const out = perRepoGitignoreToGlobs(sources);
        expect(out).toEqual([
            'svc-a/**/build/**',
            'svc-b/**/dist/**',
        ]);
    });

    it('skips empty / undefined text', () => {
        const sources: GitignoreSource[] = [
            { rootPath: 'svc-a', text: null },
            { rootPath: 'svc-b', text: '' },
            { rootPath: 'svc-c', text: 'dist' },
        ];
        const out = perRepoGitignoreToGlobs(sources);
        expect(out).toEqual(['svc-c/**/dist/**']);
    });

    it('skips sources with empty rootPath (workspace-root .gitignore is handled separately)', () => {
        const sources: GitignoreSource[] = [
            { rootPath: '', text: 'this-should-not-appear' },
            { rootPath: 'svc', text: 'dist' },
        ];
        const out = perRepoGitignoreToGlobs(sources);
        expect(out).toEqual(['svc/**/dist/**']);
    });
});
