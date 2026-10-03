/**
 * githubReader.test.ts
 *
 * Unit tests for getGithubRemote, fetchGitHubPr, and ensureCommitAvailable.
 * child_process and https are fully mocked — no real network or git calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'child_process';
import * as https from 'https';

// Mock both modules before the module under test is imported
vi.mock('child_process', () => ({ execSync: vi.fn() }));
vi.mock('https', () => ({ get: vi.fn() }));

import {
    getGithubRemote,
    fetchGitHubPr,
    ensureCommitAvailable,
    type PrInfo,
} from '../githubReader';

const mockedExecSync = vi.mocked(child_process.execSync);
const mockedGet = vi.mocked(https.get);

beforeEach(() => {
    vi.resetAllMocks();
});

// ─── test helpers ─────────────────────────────────────────────────────────────

const BASE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** Minimal valid GitHub PR API response payload */
const VALID_PR_RESPONSE = {
    title: 'feat: add login',
    base: { sha: BASE_SHA, ref: 'main' },
    head: { sha: HEAD_SHA, ref: 'feat/login' },
};

/**
 * Simulate an https.get call returning a response with the given status code
 * and body.  Fires data/end handlers synchronously after the callback registers
 * them, so the Promise settles within the same microtask queue flush.
 */
function mockHttpsResponse(
    statusCode: number,
    body: object | string,
    headers: Record<string, string> = {},
): void {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

    mockedGet.mockImplementationOnce((_opts: unknown, callback: unknown) => {
        const cb = callback as (res: unknown) => void;
        let onData: ((chunk: string) => void) | null = null;
        let onEnd: (() => void) | null = null;

        const res = {
            statusCode,
            headers,
            on(event: string, handler: unknown) {
                if (event === 'data') onData = handler as (chunk: string) => void;
                if (event === 'end') onEnd = handler as () => void;
                return this;
            },
        };

        cb(res);           // registers the data/end handlers
        onData?.(bodyStr); // fire data
        onEnd?.();         // fire end

        return { on: vi.fn() }; // req object (error handler not triggered)
    });
}

/**
 * Simulate a network-level error (e.g. DNS failure, connection refused).
 */
function mockHttpsNetworkError(error: Error): void {
    mockedGet.mockImplementationOnce((_opts: unknown, _callback: unknown) => {
        let errorHandler: ((err: Error) => void) | null = null;
        const req = {
            on(event: string, handler: unknown) {
                if (event === 'error') errorHandler = handler as (err: Error) => void;
                return this;
            },
        };
        // Fire the error handler after the caller has registered it
        process.nextTick(() => errorHandler?.(error));
        return req;
    });
}

// ─── getGithubRemote ──────────────────────────────────────────────────────────

describe('getGithubRemote', () => {
    it('parses an HTTPS remote with .git suffix', () => {
        mockedExecSync.mockReturnValueOnce('https://github.com/acme/my-repo.git\n');
        expect(getGithubRemote('/workspace')).toEqual({ owner: 'acme', repo: 'my-repo' });
    });

    it('parses an HTTPS remote without .git suffix', () => {
        mockedExecSync.mockReturnValueOnce('https://github.com/acme/my-repo\n');
        expect(getGithubRemote('/workspace')).toEqual({ owner: 'acme', repo: 'my-repo' });
    });

    it('parses an SSH remote (git@github.com:owner/repo.git)', () => {
        mockedExecSync.mockReturnValueOnce('git@github.com:acme/my-repo.git\n');
        expect(getGithubRemote('/workspace')).toEqual({ owner: 'acme', repo: 'my-repo' });
    });

    it('parses an SSH remote without .git suffix', () => {
        mockedExecSync.mockReturnValueOnce('git@github.com:acme/my-repo\n');
        expect(getGithubRemote('/workspace')).toEqual({ owner: 'acme', repo: 'my-repo' });
    });

    it('handles org names that contain dots', () => {
        mockedExecSync.mockReturnValueOnce('https://github.com/my.org/my-repo.git\n');
        expect(getGithubRemote('/workspace')).toEqual({ owner: 'my.org', repo: 'my-repo' });
    });

    it('returns null for a non-GitHub remote (GitLab)', () => {
        mockedExecSync.mockReturnValueOnce('https://gitlab.com/acme/my-repo.git\n');
        expect(getGithubRemote('/workspace')).toBeNull();
    });

    it('returns null for a Bitbucket remote', () => {
        mockedExecSync.mockReturnValueOnce('https://bitbucket.org/acme/my-repo.git\n');
        expect(getGithubRemote('/workspace')).toBeNull();
    });

    it('returns null when there is no origin remote (execSync throws)', () => {
        mockedExecSync.mockImplementationOnce(() => {
            throw new Error("fatal: No such remote 'origin'");
        });
        expect(getGithubRemote('/workspace')).toBeNull();
    });

    it('returns null when the working directory is not a git repo', () => {
        mockedExecSync.mockImplementationOnce(() => {
            throw new Error('fatal: not a git repository');
        });
        expect(getGithubRemote('/not-a-repo')).toBeNull();
    });

    it('trims trailing whitespace/newlines from the remote URL', () => {
        mockedExecSync.mockReturnValueOnce('https://github.com/acme/my-repo.git\r\n');
        expect(getGithubRemote('/workspace')).toEqual({ owner: 'acme', repo: 'my-repo' });
    });
});

// ─── fetchGitHubPr — success ──────────────────────────────────────────────────

describe('fetchGitHubPr — success', () => {
    it('resolves with correct PrInfo on a 200 response', async () => {
        mockHttpsResponse(200, VALID_PR_RESPONSE);
        const info = await fetchGitHubPr('acme', 'my-repo', 42);

        expect(info.prNumber).toBe(42);
        expect(info.prTitle).toBe('feat: add login');
        expect(info.baseHash).toBe(BASE_SHA);
        expect(info.headHash).toBe(HEAD_SHA);
        expect(info.baseRef).toBe('main');
        expect(info.headRef).toBe('feat/login');
    });

    it('sends the Authorization header when a token is provided', async () => {
        mockHttpsResponse(200, VALID_PR_RESPONSE);
        await fetchGitHubPr('acme', 'my-repo', 42, 'ghp_test_token');

        const callOptions = mockedGet.mock.calls[0][0] as https.RequestOptions;
        expect((callOptions.headers as Record<string, string>)['Authorization']).toBe('Bearer ghp_test_token');
    });

    it('does NOT send an Authorization header when no token is provided', async () => {
        mockHttpsResponse(200, VALID_PR_RESPONSE);
        await fetchGitHubPr('acme', 'my-repo', 42);

        const callOptions = mockedGet.mock.calls[0][0] as https.RequestOptions;
        expect((callOptions.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });

    it('sends the correct path to the GitHub API', async () => {
        mockHttpsResponse(200, VALID_PR_RESPONSE);
        await fetchGitHubPr('my-org', 'cool-repo', 99);

        const callOptions = mockedGet.mock.calls[0][0] as https.RequestOptions;
        expect(callOptions.hostname).toBe('api.github.com');
        expect(callOptions.path).toBe('/repos/my-org/cool-repo/pulls/99');
    });

    it('includes the required User-Agent header', async () => {
        mockHttpsResponse(200, VALID_PR_RESPONSE);
        await fetchGitHubPr('acme', 'my-repo', 1);

        const callOptions = mockedGet.mock.calls[0][0] as https.RequestOptions;
        expect((callOptions.headers as Record<string, string>)['User-Agent']).toBe('codeatlas-vscode');
    });

    it('works for a PR on a private repo when a valid token is supplied', async () => {
        // Private repo with auth: GitHub returns 200 exactly like a public repo
        mockHttpsResponse(200, VALID_PR_RESPONSE);
        const info = await fetchGitHubPr('acme', 'private-repo', 7, 'ghp_valid_token');
        expect(info.baseHash).toBe(BASE_SHA);
        expect(info.headHash).toBe(HEAD_SHA);
    });
});

// ─── fetchGitHubPr — 404 (not found / private repo) ──────────────────────────

describe('fetchGitHubPr — 404 errors', () => {
    it('rejects with a "not found" message on 404', async () => {
        mockHttpsResponse(404, { message: 'Not Found' }, {});
        await expect(fetchGitHubPr('acme', 'my-repo', 999))
            .rejects.toThrow('PR #999 not found in acme/my-repo');
    });

    it('includes a private-repo hint in the 404 error when no token was supplied', async () => {
        mockHttpsResponse(404, { message: 'Not Found' });
        await expect(fetchGitHubPr('acme', 'private-repo', 5))
            .rejects.toThrow(/private repository.*sign in/i);
    });

    it('does NOT include the private-repo hint when a token was supplied', async () => {
        // With a token the 404 is unambiguous — the PR really does not exist
        mockHttpsResponse(404, { message: 'Not Found' });
        const err = await fetchGitHubPr('acme', 'my-repo', 5, 'ghp_token').catch(e => e as Error);
        expect(err.message).not.toMatch(/private repository/i);
        expect(err.message).not.toMatch(/sign in/i);
    });
});

// ─── fetchGitHubPr — 401 (authentication failure) ────────────────────────────

describe('fetchGitHubPr — 401 authentication failure', () => {
    it('rejects with an authentication error message on 401', async () => {
        mockHttpsResponse(401, { message: 'Bad credentials' });
        await expect(fetchGitHubPr('acme', 'my-repo', 1, 'ghp_bad_token'))
            .rejects.toThrow(/authentication failed \(401\)/i);
    });

    it('mentions re-signing in when a token is rejected (401)', async () => {
        mockHttpsResponse(401, { message: 'Bad credentials' });
        await expect(fetchGitHubPr('acme', 'my-repo', 1, 'ghp_expired'))
            .rejects.toThrow(/re-sign in/i);
    });
});

// ─── fetchGitHubPr — 403 (rate limit / insufficient scope) ───────────────────

describe('fetchGitHubPr — 403 errors', () => {
    it('rejects with a rate-limit message when the body says "rate limit"', async () => {
        mockHttpsResponse(403, { message: 'API rate limit exceeded for ...' });
        await expect(fetchGitHubPr('acme', 'my-repo', 1))
            .rejects.toThrow(/rate limit exceeded/i);
    });

    it('mentions signing in to get a higher rate limit', async () => {
        mockHttpsResponse(403, { message: 'API rate limit exceeded' });
        await expect(fetchGitHubPr('acme', 'my-repo', 1))
            .rejects.toThrow(/sign in/i);
    });

    it('rejects with an access-denied message for non-rate-limit 403s', async () => {
        mockHttpsResponse(403, { message: 'Resource not accessible by integration' });
        await expect(fetchGitHubPr('acme', 'my-repo', 1, 'ghp_limited'))
            .rejects.toThrow(/access denied \(403\)/i);
    });

    it('mentions repo scope in the access-denied message when body message is absent', async () => {
        mockHttpsResponse(403, {});
        await expect(fetchGitHubPr('acme', 'my-repo', 1, 'ghp_limited'))
            .rejects.toThrow(/repo.*scope/i);
    });
});

// ─── fetchGitHubPr — other non-200 statuses ──────────────────────────────────

describe('fetchGitHubPr — other HTTP errors', () => {
    it('rejects with the status code and body message on 422', async () => {
        mockHttpsResponse(422, { message: 'Validation Failed' });
        await expect(fetchGitHubPr('acme', 'my-repo', 1))
            .rejects.toThrow(/422/);
    });

    it('rejects with the status code on 500', async () => {
        mockHttpsResponse(500, 'Internal Server Error');
        await expect(fetchGitHubPr('acme', 'my-repo', 1))
            .rejects.toThrow(/500/);
    });

    it('falls back to raw body slice when response has no JSON message field', async () => {
        mockHttpsResponse(503, 'Service Unavailable');
        const err = await fetchGitHubPr('acme', 'my-repo', 1).catch(e => e as Error);
        expect(err.message).toMatch(/503/);
    });
});

// ─── fetchGitHubPr — malformed response bodies ───────────────────────────────

describe('fetchGitHubPr — malformed response body', () => {
    it('rejects when the 200 response body is not valid JSON', async () => {
        mockHttpsResponse(200, 'not-json-at-all');
        await expect(fetchGitHubPr('acme', 'my-repo', 1))
            .rejects.toThrow(/failed to parse/i);
    });

    it('rejects when base.sha is missing from the 200 response', async () => {
        mockHttpsResponse(200, {
            title: 'PR title',
            base: { ref: 'main' },            // sha missing
            head: { sha: HEAD_SHA, ref: 'feat' },
        });
        await expect(fetchGitHubPr('acme', 'my-repo', 1))
            .rejects.toThrow(/missing base or head commit SHA/i);
    });

    it('rejects when head.sha is missing from the 200 response', async () => {
        mockHttpsResponse(200, {
            title: 'PR title',
            base: { sha: BASE_SHA, ref: 'main' },
            head: { ref: 'feat' },             // sha missing
        });
        await expect(fetchGitHubPr('acme', 'my-repo', 1))
            .rejects.toThrow(/missing base or head commit SHA/i);
    });

    it('rejects when the response body is an empty object', async () => {
        mockHttpsResponse(200, {});
        await expect(fetchGitHubPr('acme', 'my-repo', 1))
            .rejects.toThrow(/missing base or head commit SHA/i);
    });

    it('uses a fallback title when "title" field is absent but SHAs are present', async () => {
        mockHttpsResponse(200, {
            // title omitted
            base: { sha: BASE_SHA, ref: 'main' },
            head: { sha: HEAD_SHA, ref: 'feat' },
        });
        const info = await fetchGitHubPr('acme', 'my-repo', 7);
        expect(info.prTitle).toBe('PR #7');
    });
});

// ─── fetchGitHubPr — network errors ──────────────────────────────────────────

describe('fetchGitHubPr — network errors', () => {
    it('rejects with a network error message when the request itself fails', async () => {
        mockHttpsNetworkError(new Error('getaddrinfo ENOTFOUND api.github.com'));
        await expect(fetchGitHubPr('acme', 'my-repo', 1))
            .rejects.toThrow(/network error/i);
    });

    it('includes the underlying error message in the network error', async () => {
        mockHttpsNetworkError(new Error('ECONNREFUSED 127.0.0.1:443'));
        await expect(fetchGitHubPr('acme', 'my-repo', 1))
            .rejects.toThrow('ECONNREFUSED 127.0.0.1:443');
    });
});

// ─── ensureCommitAvailable ────────────────────────────────────────────────────

describe('ensureCommitAvailable', () => {
    it('does not call git fetch when the commit already exists locally', () => {
        // First call (cat-file) succeeds — commit is present
        mockedExecSync.mockReturnValueOnce('');

        ensureCommitAvailable('/workspace', BASE_SHA);

        expect(mockedExecSync).toHaveBeenCalledTimes(1);
        expect(mockedExecSync).toHaveBeenCalledWith(
            expect.stringContaining('cat-file'),
            expect.any(Object),
        );
    });

    it('runs git fetch when the commit is not present locally', () => {
        // cat-file throws → commit missing
        mockedExecSync.mockImplementationOnce(() => { throw new Error('fatal: Not a valid object name'); });
        // fetch succeeds
        mockedExecSync.mockReturnValueOnce('');

        ensureCommitAvailable('/workspace', BASE_SHA);

        expect(mockedExecSync).toHaveBeenCalledTimes(2);
        expect(mockedExecSync).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('fetch origin'),
            expect.any(Object),
        );
    });

    it('includes the hash in the cat-file command', () => {
        mockedExecSync.mockReturnValueOnce('');

        ensureCommitAvailable('/workspace', BASE_SHA);

        const cmd = mockedExecSync.mock.calls[0][0] as string;
        expect(cmd).toContain(BASE_SHA);
    });

    it('does not throw when both cat-file and fetch fail', () => {
        mockedExecSync.mockImplementationOnce(() => { throw new Error('not a valid object'); });
        mockedExecSync.mockImplementationOnce(() => { throw new Error('fatal: unable to connect'); });

        // Must not propagate an error
        expect(() => ensureCommitAvailable('/workspace', BASE_SHA)).not.toThrow();
    });

    it('calls fetch exactly once even if the commit remains missing after fetch', () => {
        mockedExecSync.mockImplementationOnce(() => { throw new Error('not a valid object'); });
        mockedExecSync.mockImplementationOnce(() => { throw new Error('network error'); });

        ensureCommitAvailable('/workspace', BASE_SHA);

        expect(mockedExecSync).toHaveBeenCalledTimes(2);
    });
});
