/**
 * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — sharedExternalAnalyzer tests.
 *
 * Uses a fresh in-memory AggregatorStore + a fresh registry per test
 * (default registry is left untouched).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AggregatorStore } from '../../storage/aggregatorStore';
import { CrossRepoAnalyzerRegistry } from '../../sync/crossRepoAnalyzer';
import { sharedExternalAnalyzer } from '../sharedExternalAnalyzer';
import { emptyRepoSummary, type RepoSummary } from '../../sync/repoSummary';

const tmpDirs: string[] = [];

async function makeAggregator(): Promise<AggregatorStore> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-test-'));
    tmpDirs.push(dir);
    const agg = new AggregatorStore(dir, { inMemoryOnly: true });
    const reg = new CrossRepoAnalyzerRegistry();
    reg.register(sharedExternalAnalyzer);
    agg.setAnalyzerRegistry(reg);
    await agg.init();
    return agg;
}

afterEach(() => {
    while (tmpDirs.length) {
        try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

function summary(repoId: string, sdkIds: ReadonlyArray<string>): RepoSummary {
    const s = emptyRepoSummary(repoId);
    return {
        ...s,
        sdks: sdkIds.map((id) => ({ sdkId: id, name: cap(id), category: 'ai' as const })),
    };
}

function cap(id: string): string { return id[0].toUpperCase() + id.slice(1); }

describe('sharedExternalAnalyzer — first-time apply', () => {
    it('repo with one SDK → row with [repoId] as consumers', async () => {
        const agg = await makeAggregator();
        agg.applySummary('repo-a', summary('repo-a', ['openai']));
        const externals = agg.listSharedExternals();
        expect(externals).toHaveLength(1);
        expect(externals[0].providerId).toBe('openai');
        expect(externals[0].name).toBe('Openai');
        expect(externals[0].consumers).toEqual(['repo-a']);
        agg.close();
    });

    it('two repos add same SDK → row.consumers has both, sorted', async () => {
        const agg = await makeAggregator();
        agg.applySummary('repo-c', summary('repo-c', ['openai']));
        agg.applySummary('repo-a', summary('repo-a', ['openai']));
        const externals = agg.listSharedExternals();
        expect(externals[0].consumers).toEqual(['repo-a', 'repo-c']);   // sorted
        agg.close();
    });

    it('three repos, three different SDKs → three rows, each one consumer', async () => {
        const agg = await makeAggregator();
        agg.applySummary('repo-a', summary('repo-a', ['openai']));
        agg.applySummary('repo-b', summary('repo-b', ['stripe']));
        agg.applySummary('repo-c', summary('repo-c', ['twilio']));
        const externals = [...agg.listSharedExternals()].sort((a, b) => a.providerId.localeCompare(b.providerId));
        expect(externals.map((e) => e.providerId)).toEqual(['openai', 'stripe', 'twilio']);
        for (const e of externals) expect(e.consumers).toHaveLength(1);
        agg.close();
    });
});

describe('sharedExternalAnalyzer — diff on reapply', () => {
    it('repo removes an SDK → consumer dropped from row', async () => {
        const agg = await makeAggregator();
        agg.applySummary('repo-a', summary('repo-a', ['openai', 'stripe']));
        agg.applySummary('repo-b', summary('repo-b', ['openai']));
        // repo-a re-applies without stripe — singleton row should be deleted
        agg.applySummary('repo-a', summary('repo-a', ['openai']));
        const externals = agg.listSharedExternals();
        expect(externals.map((e) => e.providerId).sort()).toEqual(['openai']);
        expect(externals.find((e) => e.providerId === 'openai')!.consumers).toEqual(['repo-a', 'repo-b']);
        agg.close();
    });

    it('repo drops sole SDK → row deleted entirely', async () => {
        const agg = await makeAggregator();
        agg.applySummary('repo-a', summary('repo-a', ['openai']));
        agg.applySummary('repo-a', summary('repo-a', []));   // dropped
        expect(agg.listSharedExternals()).toHaveLength(0);
        agg.close();
    });

    it('repo adds a brand-new SDK → new row appears, others untouched', async () => {
        const agg = await makeAggregator();
        agg.applySummary('repo-a', summary('repo-a', ['openai']));
        agg.applySummary('repo-b', summary('repo-b', ['openai']));
        agg.applySummary('repo-a', summary('repo-a', ['openai', 'stripe']));
        const externals = agg.listSharedExternals();
        const openai = externals.find((e) => e.providerId === 'openai');
        const stripe = externals.find((e) => e.providerId === 'stripe');
        expect(openai!.consumers).toEqual(['repo-a', 'repo-b']);
        expect(stripe!.consumers).toEqual(['repo-a']);
        agg.close();
    });

    it('identical reapply is a no-op (rows unchanged)', async () => {
        const agg = await makeAggregator();
        agg.applySummary('repo-a', summary('repo-a', ['openai']));
        agg.applySummary('repo-b', summary('repo-b', ['openai']));
        const before = JSON.stringify(agg.listSharedExternals());
        agg.applySummary('repo-a', summary('repo-a', ['openai']));
        const after = JSON.stringify(agg.listSharedExternals());
        expect(after).toBe(before);
        agg.close();
    });
});

describe('sharedExternalAnalyzer — onRepoRemoved', () => {
    it('removes the repo from every row; deletes singletons', async () => {
        const agg = await makeAggregator();
        agg.applySummary('repo-a', summary('repo-a', ['openai', 'stripe']));
        agg.applySummary('repo-b', summary('repo-b', ['openai']));
        sharedExternalAnalyzer.onRepoRemoved!('repo-a', agg);
        const externals = agg.listSharedExternals();
        expect(externals.map((e) => e.providerId).sort()).toEqual(['openai']);
        expect(externals.find((e) => e.providerId === 'openai')!.consumers).toEqual(['repo-b']);
        agg.close();
    });

    it('removing the only consumer drops the row', async () => {
        const agg = await makeAggregator();
        agg.applySummary('repo-a', summary('repo-a', ['openai']));
        sharedExternalAnalyzer.onRepoRemoved!('repo-a', agg);
        expect(agg.listSharedExternals()).toHaveLength(0);
        agg.close();
    });
});

describe('sharedExternalAnalyzer — multi-repo OpenAI (matches user sandbox)', () => {
    it('svc-alpha + svc-gamma use OpenAI; svc-beta does not → row consumers=[alpha,gamma]', async () => {
        const agg = await makeAggregator();
        agg.applySummary('svc-alpha', summary('svc-alpha', ['openai']));
        agg.applySummary('svc-beta',  summary('svc-beta',  []));
        agg.applySummary('svc-gamma', summary('svc-gamma', ['openai']));
        const externals = agg.listSharedExternals();
        expect(externals).toHaveLength(1);
        expect(externals[0].providerId).toBe('openai');
        expect(externals[0].consumers).toEqual(['svc-alpha', 'svc-gamma']);
        agg.close();
    });
});
