import { execSync } from 'child_process';
import * as https from 'https';

export interface PrInfo {
    prNumber: number;
    prTitle: string;
    baseHash: string;
    headHash: string;
    baseRef: string;
    headRef: string;
}

function run(cmd: string, cwd: string): string {
    return execSync(cmd, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
}

/**
 * Extract owner and repo name from the origin remote URL.
 * Handles both HTTPS (https://github.com/owner/repo.git) and
 * SSH (git@github.com:owner/repo.git) formats.
 */
export function getGithubRemote(workspaceRoot: string): { owner: string; repo: string } | null {
    try {
        const url = run('git remote get-url origin', workspaceRoot).trim();
        const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
        if (m) return { owner: m[1], repo: m[2] };
        return null;
    } catch {
        return null;
    }
}

export interface PrListItem {
    number: number;
    title: string;
    author: string;
    branch: string;
    updatedAt: string;
    isDraft: boolean;
}

/**
 * Fetch a list of open pull requests from the GitHub API.
 * Returns up to 30 most recently updated PRs.
 * Falls back to empty array on any error (non-blocking).
 */
export function listGitHubPrs(
    owner: string,
    repo: string,
    token?: string,
): Promise<PrListItem[]> {
    return new Promise((resolve) => {
        const options: https.RequestOptions = {
            hostname: 'api.github.com',
            path: `/repos/${owner}/${repo}/pulls?state=open&per_page=30&sort=updated&direction=desc`,
            headers: {
                'User-Agent': 'codeatlas-vscode',
                'Accept': 'application/vnd.github+json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
            },
        };

        const req = https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) { resolve([]); return; }
                try {
                    const prs = JSON.parse(data) as any[];
                    resolve(prs.map(pr => ({
                        number: pr.number,
                        title: pr.title ?? `PR #${pr.number}`,
                        author: pr.user?.login ?? 'unknown',
                        branch: pr.head?.ref ?? '',
                        updatedAt: pr.updated_at ?? '',
                        isDraft: pr.draft === true,
                    })));
                } catch { resolve([]); }
            });
        });

        req.on('error', () => resolve([]));
        // Timeout after 8s — don't block UX if GitHub is slow
        req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    });
}

/**
 * Fetch pull request info (base + head SHAs) from the GitHub API.
 *
 * Authentication notes:
 * - Public repos: works without a token (60 unauthenticated req/hr).
 * - Private repos: GitHub returns 404 (not 401) when unauthenticated to avoid
 *   leaking whether the repo exists.  Pass a token with `repo` scope to access
 *   private repos (5000 req/hr).  The VS Code GitHub auth provider supplies
 *   this automatically when the user has signed in.
 * - 401: token is invalid or expired.
 * - 403: either the token lacks `repo` scope, or the unauthenticated rate
 *   limit (60/hr) has been hit.
 */
export function fetchGitHubPr(
    owner: string,
    repo: string,
    prNumber: number,
    token?: string,
): Promise<PrInfo> {
    return new Promise((resolve, reject) => {
        const options: https.RequestOptions = {
            hostname: 'api.github.com',
            path: `/repos/${owner}/${repo}/pulls/${prNumber}`,
            headers: {
                'User-Agent': 'codeatlas-vscode',
                'Accept': 'application/vnd.github+json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
            },
        };

        const req = https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => {
                const status = res.statusCode ?? 0;

                if (status === 401) {
                    reject(new Error(
                        'GitHub authentication failed (401). Your token may be invalid or expired — re-sign in via VS Code\'s GitHub extension.',
                    ));
                    return;
                }

                if (status === 403) {
                    let msg = '';
                    try { msg = (JSON.parse(data).message as string) ?? ''; } catch { /* ignore */ }
                    if (msg.toLowerCase().includes('rate limit')) {
                        reject(new Error(
                            'GitHub API rate limit exceeded (403). Sign in to GitHub via VS Code for a higher limit (5000 req/hr).',
                        ));
                    } else {
                        reject(new Error(
                            `GitHub access denied (403): ${msg || 'token may lack the "repo" scope needed for private repositories.'}`,
                        ));
                    }
                    return;
                }

                if (status === 404) {
                    const privateHint = !token
                        ? ' If this is a private repository, sign in to GitHub via VS Code\'s GitHub extension first.'
                        : '';
                    reject(new Error(`PR #${prNumber} not found in ${owner}/${repo}.${privateHint}`));
                    return;
                }

                if (status !== 200) {
                    let msg = '';
                    try { msg = (JSON.parse(data).message as string) ?? ''; } catch { /* ignore */ }
                    reject(new Error(`GitHub API error ${status}: ${msg || data.slice(0, 200)}`));
                    return;
                }

                let pr: any;
                try {
                    pr = JSON.parse(data);
                } catch {
                    reject(new Error('Failed to parse GitHub API response — unexpected non-JSON body.'));
                    return;
                }

                const baseHash = pr?.base?.sha;
                const headHash = pr?.head?.sha;
                if (typeof baseHash !== 'string' || typeof headHash !== 'string') {
                    reject(new Error('GitHub API response is missing base or head commit SHA.'));
                    return;
                }

                resolve({
                    prNumber,
                    prTitle: (pr.title as string) ?? `PR #${prNumber}`,
                    baseHash,
                    headHash,
                    baseRef: (pr.base.ref as string) ?? '',
                    headRef: (pr.head.ref as string) ?? '',
                });
            });
        });

        req.on('error', (err: Error) => {
            reject(new Error(`Network error contacting GitHub API: ${err.message}`));
        });
    });
}

/**
 * Ensure a commit SHA exists in the local clone.
 * Runs `git fetch origin` if the object is missing (e.g. PR branch not yet fetched).
 */
export function ensureCommitAvailable(workspaceRoot: string, hash: string): void {
    try {
        run(`git cat-file -e ${hash}^{commit}`, workspaceRoot);
    } catch {
        try {
            run('git fetch origin', workspaceRoot);
        } catch {
            // Ignore — buildCommitDiffGraphs will surface a clear error if the hash is still missing
        }
    }
}
