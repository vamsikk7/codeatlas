/**
 * prWatcher.test.ts — #851 (2026-06-12)
 *
 * PR watcher scheduling + dedupe: tick reviews each PR once per head sha,
 * disabled watcher never polls, missing prerequisites idle with a reason,
 * ledger persistence survives reload, GitHub lister parsing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrWatcher, createFileLedger, listOpenPrsGithub, type PrWatcherDeps, type PrSummary } from '../prWatcher';

function pr(n: number, sha = `sha-${n}`): PrSummary {
    return { number: n, title: `PR ${n}`, headSha: sha, baseSha: 'base', baseRef: 'main' };
}

function memLedger() {
    const m = new Map<number, string>();
    return { get: (n: number) => m.get(n), set: (n: number, s: string) => { m.set(n, s); }, size: () => m.size };
}

function makeDeps(over: Partial<PrWatcherDeps> = {}): PrWatcherDeps & { reviews: PrSummary[]; statuses: any[] } {
    const reviews: PrSummary[] = [];
    const statuses: any[] = [];
    return {
        reviews, statuses,
        repoSlug: () => 'acme/widgets',
        getToken: async () => 'tok',
        hasLlmKey: async () => true,
        listOpenPrs: async () => [pr(1), pr(2)],
        reviewPr: async (p: PrSummary) => { reviews.push(p); return { ok: true }; },
        ledger: memLedger(),
        log: () => {},
        onStatus: (s: any) => { statuses.push(s); },
        now: () => 1000,
        timer: { set: vi.fn(() => 'h'), clear: vi.fn() },
        ...over,
    };
}

describe('PrWatcher (#851)', () => {
    it('tick reviews every open PR once and records it in the ledger', async () => {
        const deps = makeDeps();
        const w = new PrWatcher(deps);
        await w.tick();
        expect(deps.reviews.map((p) => p.number)).toEqual([1, 2]);
        expect(deps.ledger.get(1)).toBe('sha-1');
        const s = w.getStatus();
        expect(s.lastResult).toContain('2 open PRs');
        expect(s.lastResult).toContain('#1');
        expect(s.reviewedCount).toBe(2);
        expect(s.lastError).toBeNull();
    });

    it('second tick with unchanged heads reviews nothing; a pushed head re-reviews', async () => {
        const deps = makeDeps();
        const w = new PrWatcher(deps);
        await w.tick();
        deps.reviews.length = 0;
        await w.tick();
        expect(deps.reviews).toHaveLength(0);
        expect(w.getStatus().lastResult).toContain('nothing new');
        // PR 2 gets a new push
        deps.listOpenPrs = async () => [pr(1), pr(2, 'sha-2-v2')];
        await w.tick();
        expect(deps.reviews.map((p) => p.number)).toEqual([2]);
        expect(deps.ledger.get(2)).toBe('sha-2-v2');
    });

    it('failed reviews are NOT ledgered (retried next tick) and surface in lastError', async () => {
        const deps = makeDeps({ reviewPr: async () => ({ ok: false, error: 'boom' }) });
        const w = new PrWatcher(deps);
        await w.tick();
        expect(deps.ledger.size()).toBe(0);
        expect(w.getStatus().lastError).toContain('#1');
    });

    it('missing slug / token / LLM key idle with a reason instead of polling', async () => {
        const noSlug = makeDeps({ repoSlug: () => null });
        const w1 = new PrWatcher(noSlug);
        await w1.tick();
        expect(w1.getStatus().lastError).toContain('remote');
        expect(noSlug.reviews).toHaveLength(0);

        const noTok = makeDeps({ getToken: async () => undefined });
        const w2 = new PrWatcher(noTok);
        await w2.tick();
        expect(w2.getStatus().lastError).toContain('token');

        const noKey = makeDeps({ hasLlmKey: async () => false });
        const w3 = new PrWatcher(noKey);
        await w3.tick();
        expect(w3.getStatus().lastError).toContain('LLM');
    });

    it('start is idempotent, schedules on the (clamped) interval, stop clears the timer', () => {
        const deps = makeDeps({ intervalMs: 5 }); // below the 60s floor
        const w = new PrWatcher(deps);
        w.start();
        w.start();
        expect(w.isEnabled()).toBe(true);
        expect((deps.timer!.set as any).mock.calls).toHaveLength(1);
        expect((deps.timer!.set as any).mock.calls[0][1]).toBe(60_000);
        w.stop();
        expect(w.isEnabled()).toBe(false);
        expect((deps.timer!.clear as any).mock.calls).toHaveLength(1);
        // statuses emitted for start + tick begin/end + stop
        expect(deps.statuses.length).toBeGreaterThanOrEqual(3);
    });

    it('listOpenPrs failure lands in lastError, watcher keeps running', async () => {
        const deps = makeDeps({ listOpenPrs: async () => { throw new Error('rate limited'); } });
        const w = new PrWatcher(deps);
        w.start();
        await w.tick(); // start() already ticked once; guard makes this a no-op or re-tick
        await new Promise((r) => setTimeout(r, 0));
        expect(w.getStatus().lastError).toContain('rate limited');
        expect(w.isEnabled()).toBe(true);
    });

    it('re-entrancy guard: overlapping tick is a no-op', async () => {
        let resolveList: (v: PrSummary[]) => void;
        const deps = makeDeps({
            listOpenPrs: () => new Promise<PrSummary[]>((r) => { resolveList = r; }),
        });
        const w = new PrWatcher(deps);
        const t1 = w.tick();
        const t2 = w.tick(); // overlaps — must not double-poll
        await new Promise((r) => setTimeout(r, 0)); // let tick reach listOpenPrs
        resolveList!([pr(1)]);
        await Promise.all([t1, t2]);
        expect(deps.reviews).toHaveLength(1);
    });

    it('refreshPrereqs reports token/key presence without reviewing anything', async () => {
        const deps = makeDeps();
        const w = new PrWatcher(deps);
        const s = await w.refreshPrereqs();
        expect(s.tokenPresent).toBe(true);
        expect(s.llmKeyPresent).toBe(true);
        expect(deps.reviews).toHaveLength(0);
    });
});

describe('createFileLedger (#851)', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ledger-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('persists across reloads and ignores corrupt content', () => {
        const f = path.join(dir, 'pr-watcher.json');
        const a = createFileLedger(f);
        a.set(12, 'abc');
        const b = createFileLedger(f);
        expect(b.get(12)).toBe('abc');
        expect(b.size()).toBe(1);
        fs.writeFileSync(f, '{not json');
        const c = createFileLedger(f);
        expect(c.size()).toBe(0);
    });
});

describe('listOpenPrsGithub (#851)', () => {
    it('maps the REST shape and filters malformed rows', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true, status: 200,
            json: async () => [
                { number: 7, title: 'Fix', head: { sha: 'h7' }, base: { sha: 'b7', ref: 'main' } },
                { number: 0, title: 'bad', head: {}, base: {} },
            ],
        }));
        const prs = await listOpenPrsGithub('a/b', 't', fetchImpl as any);
        expect(prs).toHaveLength(1);
        expect(prs[0]).toMatchObject({ number: 7, headSha: 'h7', baseRef: 'main' });
        expect(fetchImpl.mock.calls[0][0]).toContain('/repos/a/b/pulls?state=open');
    });

    it('throws on non-2xx so the watcher surfaces it as lastError', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
        await expect(listOpenPrsGithub('a/b', 't', fetchImpl as any)).rejects.toThrow('403');
    });
});
