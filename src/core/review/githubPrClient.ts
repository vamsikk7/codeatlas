/**
 * githubPrClient.ts — #850 (2026-06-11).
 *
 * Minimal fetch-based GitHub REST client for the PR review commenter.
 * No SDK dependency; `fetchImpl` is injectable for tests. Two operations:
 *   - postReview: one PR review carrying the summary body + inline comments
 *     (falls back to comment-less review when GitHub rejects an anchor);
 *   - upsertSummaryComment: marker-tagged issue comment created or updated
 *     so re-runs don't stack summaries.
 */
import { PR_REVIEW_MARKER, type PrInlineComment } from './prReviewPayload';

export interface GithubPrTarget {
    /** "owner/repo" */
    repoSlug: string;
    prNumber: number;
    token: string;
    apiBase?: string;
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

function headers(token: string) {
    return {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'codeatlas-pr-review',
    };
}

export async function postReview(
    target: GithubPrTarget,
    payload: { body: string; comments: PrInlineComment[]; commitSha?: string },
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ ok: boolean; status: number; droppedInline?: boolean; error?: string }> {
    const base = target.apiBase ?? 'https://api.github.com';
    const url = `${base}/repos/${target.repoSlug}/pulls/${target.prNumber}/reviews`;
    const body = {
        event: 'COMMENT',
        body: payload.body,
        ...(payload.commitSha ? { commit_id: payload.commitSha } : {}),
        comments: payload.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
    };
    let res = await fetchImpl(url, { method: 'POST', headers: headers(target.token), body: JSON.stringify(body) });
    if (res.ok) return { ok: true, status: res.status };
    // GitHub 422s when ANY inline anchor is invalid (e.g. line drifted off
    // the diff). Retry once with the summary only so the review still lands.
    if (res.status === 422 && payload.comments.length > 0) {
        const retry = { event: 'COMMENT', body: payload.body + '\n\n_(inline anchors rejected by GitHub — findings folded into this summary)_', comments: [] };
        res = await fetchImpl(url, { method: 'POST', headers: headers(target.token), body: JSON.stringify(retry) });
        if (res.ok) return { ok: true, status: res.status, droppedInline: true };
    }
    return { ok: false, status: res.status, error: (await res.text()).slice(0, 500) };
}

export async function upsertSummaryComment(
    target: GithubPrTarget,
    body: string,
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ ok: boolean; status: number; updated: boolean; error?: string }> {
    const base = target.apiBase ?? 'https://api.github.com';
    const listUrl = `${base}/repos/${target.repoSlug}/issues/${target.prNumber}/comments?per_page=100`;
    const listRes = await fetchImpl(listUrl, { headers: headers(target.token) });
    let existingId: number | undefined;
    if (listRes.ok) {
        const comments = await listRes.json();
        const mine = (Array.isArray(comments) ? comments : []).find((c: any) => typeof c?.body === 'string' && c.body.includes(PR_REVIEW_MARKER));
        existingId = mine?.id;
    }
    const url = existingId
        ? `${base}/repos/${target.repoSlug}/issues/comments/${existingId}`
        : `${base}/repos/${target.repoSlug}/issues/${target.prNumber}/comments`;
    const res = await fetchImpl(url, {
        method: existingId ? 'PATCH' : 'POST',
        headers: headers(target.token),
        body: JSON.stringify({ body }),
    });
    if (res.ok) return { ok: true, status: res.status, updated: !!existingId };
    return { ok: false, status: res.status, updated: false, error: (await res.text()).slice(0, 500) };
}
