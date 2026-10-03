import { describe, it, expect, vi, beforeEach } from 'vitest';

// The engine + config are mocked — we test runReviewOnSnapshot's orchestration:
// build deps → run the engine → reflect findings/toasts in the result.
vi.mock('../aiReview', () => ({ runFullReview: vi.fn(async () => { }) }));
vi.mock('../settings', () => ({ createSettingsResolver: () => ({ get: () => undefined, all: () => ({}) }) }));
vi.mock('../secrets', () => ({ createSecretsStore: () => ({ get: async () => 'k' }) }));

import { runReviewOnSnapshot } from '../runReviewOnSnapshot';
import { runFullReview } from '../aiReview';

describe('#954 runReviewOnSnapshot', () => {
    beforeEach(() => vi.clearAllMocks());

    it('runs the review engine and returns the finalized open findings', async () => {
        const findings = [{ id: 'f1', title: 'bug', status: 'open', anchor: { filePath: 'a.ts' } }];
        const store = { listAiReviewFindings: vi.fn().mockReturnValue(findings) } as any;
        const res = await runReviewOnSnapshot({ store, workspaceRoot: '/tmp/x', scope: 'changed' });
        expect(runFullReview).toHaveBeenCalled();
        expect(res.ok).toBe(true);
        expect(res.scope).toBe('changed');
        expect(res.findingsCount).toBe(1);
        expect(res.findings[0].title).toBe('bug');
    });

    it('reflects an engine error toast in ok/error (e.g. missing key)', async () => {
        (runFullReview as any).mockImplementationOnce(async (deps: any) => {
            deps.wsBridge.broadcast({ type: 'clientToast', level: 'error', text: 'no API key' });
        });
        const store = { listAiReviewFindings: vi.fn().mockReturnValue([]) } as any;
        const res = await runReviewOnSnapshot({ store, scope: 'all' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/no API key/);
        expect(res.scope).toBe('all');
    });

    it('defaults scope to "changed"', async () => {
        const store = { listAiReviewFindings: vi.fn().mockReturnValue([]) } as any;
        const res = await runReviewOnSnapshot({ store });
        expect(res.scope).toBe('changed');
    });
});
