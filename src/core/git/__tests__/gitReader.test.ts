/**
 * gitReader.test.ts
 *
 * Unit tests for the git reader utilities.  All calls to execSync are intercepted
 * via vi.mock so these tests never touch a real git repository.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'child_process';

// Mock child_process before importing gitReader so the module picks up the mock.
// #522 — switched from execSync to spawnSync; the mock surface mirrors that.
vi.mock('child_process', () => ({
    execSync: vi.fn(),
    spawnSync: vi.fn(),
}));

import {
    listCommits,
    getFileListAtCommit,
    getFileContentAtCommit,
    getChangedFilesBetweenCommits,
    isReviewNoiseFile,
    type CommitInfo,
} from '../gitReader';

describe('isReviewNoiseFile — review changed-file noise filter', () => {
    it('drops CodeAtlas state dirs + OS noise (self-inflicted review noise)', () => {
        for (const p of [
            '.codeatlas/state.db', '.codeatlas/.mcp-owner', '.codeatlas-sa/state.db',
            '.codeatlas-sa-probe/x', 'sub/.codeatlas/y', '.DS_Store', 'a/b/.DS_Store', 'Thumbs.db',
        ]) {
            expect(isReviewNoiseFile(p), `${p} is noise`).toBe(true);
        }
    });
    it('keeps real source + config files', () => {
        for (const p of [
            'src/main/java/Owner.java', 'app.py', 'README.md', 'package.json',
            'codeatlas.config.ts', 'src/codeatlasHelper.ts',
        ]) {
            expect(isReviewNoiseFile(p), `${p} is not noise`).toBe(false);
        }
    });
});

const mockedSpawnSync = vi.mocked(child_process.spawnSync);

// Helper shim: tests pre-#522 mocked `execSync(cmd, opts)` and asserted on
// `mockedExecSync.mock.calls[0][0]` (the shell-style command string). After
// the switch to `spawnSync(bin, args, opts)`, this shim reconstructs the
// legacy command string and exposes a compatible `.mock.calls` so the
// existing assertions still apply.
const mockedExecSync = {
    mockReturnValueOnce: (stdout: string) => mockedSpawnSync.mockReturnValueOnce({
        pid: 0, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null,
    } as any),
    mockReturnValue: (stdout: string) => mockedSpawnSync.mockReturnValue({
        pid: 0, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null,
    } as any),
    mockImplementationOnce: (fn: () => any) => mockedSpawnSync.mockImplementationOnce(() => {
        try { fn(); return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: 0, signal: null } as any; }
        catch (err) { return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: 1, signal: null, error: err as Error } as any; }
    }),
    get mock() {
        return {
            // [legacyCmdString, opts][] reconstructed from [bin, argsArray, opts][].
            calls: mockedSpawnSync.mock.calls.map((c: any) => {
                const bin = c[0];
                const args = Array.isArray(c[1]) ? c[1] : [];
                const opts = c[2] ?? {};
                return [`${bin} ${args.join(' ')}`, opts];
            }),
        };
    },
};

beforeEach(() => {
    vi.resetAllMocks();
});

// ─── listCommits ──────────────────────────────────────────────────────────────

describe('listCommits', () => {
    it('parses standard commit log output', () => {
        mockedExecSync.mockReturnValueOnce(
            'abcdef1234567890abcdef1234567890abcdef12\x00fix: initial commit\x0012 minutes ago\x00Alice\n' +
            '1111111111111111111111111111111111111111\x00feat: add routes\x002 hours ago\x00Bob\n'
        );

        const commits = listCommits('/workspace');

        expect(commits).toHaveLength(2);

        expect(commits[0].hash).toBe('abcdef1234567890abcdef1234567890abcdef12');
        expect(commits[0].shortHash).toBe('abcdef1');
        expect(commits[0].subject).toBe('fix: initial commit');
        expect(commits[0].relativeDate).toBe('12 minutes ago');
        expect(commits[0].author).toBe('Alice');

        expect(commits[1].hash).toBe('1111111111111111111111111111111111111111');
        expect(commits[1].shortHash).toBe('1111111');
        expect(commits[1].subject).toBe('feat: add routes');
        expect(commits[1].relativeDate).toBe('2 hours ago');
        expect(commits[1].author).toBe('Bob');
    });

    it('handles commit subjects that contain pipe characters without corrupting fields', () => {
        // The subject "feat: A|B|C" must not split into extra fields.
        mockedExecSync.mockReturnValueOnce(
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x00feat: A|B|C\x005 days ago\x00Charlie\n'
        );

        const commits = listCommits('/workspace');

        expect(commits).toHaveLength(1);
        expect(commits[0].subject).toBe('feat: A|B|C');
        expect(commits[0].relativeDate).toBe('5 days ago');
        expect(commits[0].author).toBe('Charlie');
    });

    it('handles commit subjects that contain special characters', () => {
        mockedExecSync.mockReturnValueOnce(
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x00fix: resolve "issue #42" (urgent)\x003 weeks ago\x00Dave\n'
        );

        const commits = listCommits('/workspace');

        expect(commits[0].subject).toBe('fix: resolve "issue #42" (urgent)');
    });

    it('filters blank lines from output', () => {
        mockedExecSync.mockReturnValueOnce(
            'cccccccccccccccccccccccccccccccccccccccc\x00some fix\x001 day ago\x00Eve\n\n\n'
        );

        const commits = listCommits('/workspace');

        expect(commits).toHaveLength(1);
    });

    it('returns empty array when git is not found (execSync throws)', () => {
        mockedExecSync.mockImplementationOnce(() => {
            throw new Error('git: command not found');
        });

        const commits = listCommits('/not-a-repo');

        expect(commits).toEqual([]);
    });

    it('returns empty array for empty repository (no commits)', () => {
        mockedExecSync.mockReturnValueOnce('');

        const commits = listCommits('/empty-repo');

        expect(commits).toEqual([]);
    });

    it('passes the correct limit to git log', () => {
        mockedExecSync.mockReturnValueOnce('');

        listCommits('/workspace', 42);

        const cmd = mockedExecSync.mock.calls[0][0];
        expect(cmd).toContain('-42');
    });

    it('uses NUL (%x00) as field separator in the git format string', () => {
        mockedExecSync.mockReturnValueOnce('');

        listCommits('/workspace');

        const cmdArg = mockedExecSync.mock.calls[0][0] as string;
        expect(cmdArg).toContain('%x00');
        // Must NOT use pipe as separator
        expect(cmdArg).not.toMatch(/%H\|%s/);
    });
});

// ─── getFileListAtCommit ──────────────────────────────────────────────────────

describe('getFileListAtCommit', () => {
    it('returns only supported source files', () => {
        mockedExecSync.mockReturnValueOnce(
            'src/index.ts\n' +
            'src/app.js\n' +
            'src/main.py\n' +
            'README.md\n' +           // not supported → excluded
            'assets/logo.png\n' +    // not supported → excluded
            'src/App.java\n'
        );

        const files = getFileListAtCommit('/workspace', 'abc1234');

        expect(files).toContain('src/index.ts');
        expect(files).toContain('src/app.js');
        expect(files).toContain('src/main.py');
        expect(files).toContain('src/App.java');
        expect(files).not.toContain('README.md');
        expect(files).not.toContain('assets/logo.png');
    });

    it('handles TypeScript variants (.mts, .cts, .tsx)', () => {
        mockedExecSync.mockReturnValueOnce('a.mts\nb.cts\nc.tsx\n');

        const files = getFileListAtCommit('/workspace', 'abc1234');

        expect(files).toEqual(['a.mts', 'b.cts', 'c.tsx']);
    });

    it('returns empty array when execSync throws', () => {
        mockedExecSync.mockImplementationOnce(() => {
            throw new Error('fatal: not a git repo');
        });

        const files = getFileListAtCommit('/workspace', 'abc1234');

        expect(files).toEqual([]);
    });

    it('filters out empty lines', () => {
        mockedExecSync.mockReturnValueOnce('\nsrc/index.ts\n\n');

        const files = getFileListAtCommit('/workspace', 'abc1234');

        expect(files).toEqual(['src/index.ts']);
    });

    it('is case-insensitive for extensions', () => {
        mockedExecSync.mockReturnValueOnce('FILE.TS\nfile.JS\n');

        const files = getFileListAtCommit('/workspace', 'abc1234');

        expect(files).toHaveLength(2);
    });
});

// ─── getFileContentAtCommit ───────────────────────────────────────────────────

describe('getFileContentAtCommit', () => {
    it('returns file content on success', () => {
        mockedExecSync.mockReturnValueOnce('const x = 1;\n');

        const content = getFileContentAtCommit('/workspace', 'abc1234', 'src/index.ts');

        expect(content).toBe('const x = 1;\n');
    });

    it('returns null when the file does not exist at the given commit', () => {
        mockedExecSync.mockImplementationOnce(() => {
            throw new Error("fatal: Path 'deleted.ts' does not exist in 'abc1234'");
        });

        const content = getFileContentAtCommit('/workspace', 'abc1234', 'deleted.ts');

        expect(content).toBeNull();
    });

    it('returns null for invalid hash (contains non-hex chars)', () => {
        // Should not call execSync at all — validation rejects it.
        const content = getFileContentAtCommit('/workspace', 'not-a-hash', 'src/index.ts');

        expect(content).toBeNull();
        expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it('returns null for empty hash', () => {
        const content = getFileContentAtCommit('/workspace', '', 'src/index.ts');

        expect(content).toBeNull();
        expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it('accepts a 7-character short hash', () => {
        mockedExecSync.mockReturnValueOnce('export default {};');

        const content = getFileContentAtCommit('/workspace', 'abc1234', 'src/index.ts');

        expect(content).toBe('export default {};');
    });

    it('handles binary files by returning the raw buffer as a string', () => {
        // execSync returns a string because encoding:'utf-8' is set, even for binary.
        // The caller receives it; null is only returned on error/rejection.
        mockedExecSync.mockReturnValueOnce('\x89PNG\r\n');

        const content = getFileContentAtCommit('/workspace', 'abc1234', 'image.ts');

        // ts extension is syntactically valid but content is binary — still returned
        expect(content).not.toBeNull();
    });

    it('rejects file paths with shell metacharacters (Issue 168)', () => {
        // Paths with quotes, $, backticks etc. are rejected before reaching execSync
        const result = getFileContentAtCommit('/workspace', 'abc1234', 'src/"quoted"/index.ts');
        expect(result).toBeNull();
        expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it('accepts safe file paths with common characters', () => {
        mockedExecSync.mockReturnValueOnce('file content');
        const result = getFileContentAtCommit('/workspace', 'abc1234', 'src/my-file_v2.ts');
        expect(result).toBe('file content');
    });
});

// ─── getChangedFilesBetweenCommits ────────────────────────────────────────────

describe('getChangedFilesBetweenCommits', () => {
    it('returns files that changed between two commits', () => {
        mockedExecSync.mockReturnValueOnce('src/a.ts\nsrc/b.py\n');

        const files = getChangedFilesBetweenCommits('/workspace', 'abcdef1', 'abcdef2');

        expect(files).toEqual(['src/a.ts', 'src/b.py']);
    });

    it('filters unsupported file types from diff output', () => {
        mockedExecSync.mockReturnValueOnce('src/a.ts\npackage.json\nassets/logo.png\n');

        const files = getChangedFilesBetweenCommits('/workspace', 'abcdef1', 'abcdef2');

        expect(files).toEqual(['src/a.ts']);
    });

    it('returns empty array on error', () => {
        mockedExecSync.mockImplementationOnce(() => {
            throw new Error('git: bad revision');
        });

        const files = getChangedFilesBetweenCommits('/workspace', 'abc1234', 'def5678');

        expect(files).toEqual([]);
    });

    it('returns empty array for non-hex hash (injection prevention)', () => {
        const files = getChangedFilesBetweenCommits('/workspace', 'base; rm -rf /', 'head456');

        expect(files).toEqual([]);
        expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it('returns empty array for getFileListAtCommit with non-hex hash', () => {
        const files = getFileListAtCommit('/workspace', '`malicious`');

        expect(files).toEqual([]);
        expect(mockedSpawnSync).not.toHaveBeenCalled();
    });
});

describe('getChangedFilesBetweenCommits — merge-base 3-dot diff (Issue #228)', () => {
    it('uses `base...head` (3-dot) so merge commits compare against merge-base', () => {
        mockedExecSync.mockReturnValueOnce('src/a.ts\n');
        getChangedFilesBetweenCommits('/workspace', 'abcdef1', 'abcdef2');
        const cmd = mockedExecSync.mock.calls[0][0] as string;
        expect(cmd).toContain('abcdef1...abcdef2');
    });
});

describe('GitOutputTooLargeError (Issue #226)', () => {
    it('exists as a named error class with the expected name and message', async () => {
        const { GitOutputTooLargeError } = await import('../../git/gitReader');
        const err = new GitOutputTooLargeError('git show abc');
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('GitOutputTooLargeError');
        expect(err.message).toContain('git show abc');
        expect(err.message).toContain('100MB');
    });
});
