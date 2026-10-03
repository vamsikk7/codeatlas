/**
 * #850 — fetch-based GitHub PR client (mocked fetch).
 */
import { describe, it, expect, vi } from 'vitest';
import { postReview, upsertSummaryComment } from '../githubPrClient';
import { PR_REVIEW_MARKER } from '../prReviewPayload';

const target = { repoSlug: 'acme/widgets', prNumber: 7, token: 'tok' };

function res(status: number, body: any = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('postReview (#850)', () => {
    it('posts one review with summary body + inline comments', async () => {
        const calls: any[] = [];
        const f = vi.fn(async (url: string, init: any) => { calls.push({ url, init }); return res(201); });
        const out = await postReview(target, { body: 'sum', comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'x' }], commitSha: 'deadbeef' }, f as any);
        expect(out.ok).toBe(true);
        expect(calls[0].url).toBe('https://api.github.com/repos/acme/widgets/pulls/7/reviews');
        const sent = JSON.parse(calls[0].init.body);
        expect(sent.event).toBe('COMMENT');
        expect(sent.comments).toHaveLength(1);
        expect(sent.commit_id).toBe('deadbeef');
        expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    });

    it('on 422 retries once without inline comments so the summary still lands', async () => {
        const f = vi.fn()
            .mockResolvedValueOnce(res(422, { message: 'line not in diff' }))
            .mockResolvedValueOnce(res(201));
        const out = await postReview(target, { body: 'sum', comments: [{ path: 'a.ts', line: 999, side: 'RIGHT', body: 'x' }] }, f as any);
        expect(out.ok).toBe(true);
        expect(out.droppedInline).toBe(true);
        expect(f).toHaveBeenCalledTimes(2);
        const retry = JSON.parse(f.mock.calls[1][1].body);
        expect(retry.comments).toHaveLength(0);
    });

    it('surfaces hard failures with status + body excerpt', async () => {
        const f = vi.fn(async () => res(403, { message: 'forbidden' }));
        const out = await postReview(target, { body: 'sum', comments: [] }, f as any);
        expect(out.ok).toBe(false);
        expect(out.status).toBe(403);
        expect(out.error).toContain('forbidden');
    });
});

describe('upsertSummaryComment (#850)', () => {
    it('creates the summary comment when no marker comment exists', async () => {
        const f = vi.fn()
            .mockResolvedValueOnce(res(200, []))           // list
            .mockResolvedValueOnce(res(201));               // create
        const out = await upsertSummaryComment(target, PR_REVIEW_MARKER + '\nhello', f as any);
        expect(out.ok).toBe(true);
        expect(out.updated).toBe(false);
        expect(f.mock.calls[1][0]).toContain('/issues/7/comments');
        expect(f.mock.calls[1][1].method).toBe('POST');
    });

    it('PATCHes the existing marker comment on re-runs (no stacking)', async () => {
        const f = vi.fn()
            .mockResolvedValueOnce(res(200, [{ id: 42, body: 'old ' + PR_REVIEW_MARKER }]))
            .mockResolvedValueOnce(res(200));
        const out = await upsertSummaryComment(target, PR_REVIEW_MARKER + '\nv2', f as any);
        expect(out.ok).toBe(true);
        expect(out.updated).toBe(true);
        expect(f.mock.calls[1][0]).toContain('/issues/comments/42');
        expect(f.mock.calls[1][1].method).toBe('PATCH');
    });
});
