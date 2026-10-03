/**
 * ADR-034 Phase G (#792 — Phase G: AI Code Review per repo + workspace guidelines (ADR-034)) — AggregatorStore workspace guidelines +
 * workspace-scope findings tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AggregatorStore } from '../aggregatorStore';

const tmpDirs: string[] = [];

async function makeAggregator(): Promise<AggregatorStore> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phaseG-'));
    tmpDirs.push(dir);
    const agg = new AggregatorStore(dir, { inMemoryOnly: true });
    await agg.init();
    return agg;
}

afterEach(() => {
    while (tmpDirs.length) {
        try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

describe('AggregatorStore — workspace_review_guidelines', () => {
    it('getWorkspaceReviewGuidelines returns empty defaults before any write', async () => {
        const agg = await makeAggregator();
        const r = agg.getWorkspaceReviewGuidelines();
        expect(r.text).toBe('');
        expect(r.hash).toBe('');
        expect(r.updatedAt).toBe(0);
        agg.close();
    });

    it('setWorkspaceReviewGuidelines persists text + hash + timestamp', async () => {
        const agg = await makeAggregator();
        const t = 'all POST routes require auth\nlog all errors';
        const written = agg.setWorkspaceReviewGuidelines(t);
        expect(written.text).toBe(t);
        expect(written.hash.length).toBeGreaterThan(0);
        expect(written.updatedAt).toBeGreaterThan(0);

        const round = agg.getWorkspaceReviewGuidelines();
        expect(round).toEqual(written);
        agg.close();
    });

    it('setWorkspaceReviewGuidelines("") clears hash + leaves empty text', async () => {
        const agg = await makeAggregator();
        agg.setWorkspaceReviewGuidelines('initial rules');
        const cleared = agg.setWorkspaceReviewGuidelines('');
        expect(cleared.text).toBe('');
        expect(cleared.hash).toBe('');
        agg.close();
    });

    it('overwrites in place (singleton row, no row count growth)', async () => {
        const agg = await makeAggregator();
        agg.setWorkspaceReviewGuidelines('first');
        agg.setWorkspaceReviewGuidelines('second');
        const r = agg.getWorkspaceReviewGuidelines();
        expect(r.text).toBe('second');
        agg.close();
    });
});

describe('AggregatorStore — workspace_ai_review_findings', () => {
    it('empty by default', async () => {
        const agg = await makeAggregator();
        expect(agg.listWorkspaceFindings()).toEqual([]);
        agg.close();
    });

    it('upsertWorkspaceFinding adds + listWorkspaceFindings returns it', async () => {
        const agg = await makeAggregator();
        agg.upsertWorkspaceFinding({
            findingId: 'f-1',
            graphId: 'microservice:workspace',
            finding: { rule: 'no-orphan-services', severity: 'warn', anchor: { nodeId: 'service:repo-a' } },
            status: 'open',
        });
        const all = agg.listWorkspaceFindings();
        expect(all).toHaveLength(1);
        expect(all[0].findingId).toBe('f-1');
        expect(all[0].graphId).toBe('microservice:workspace');
        expect(all[0].finding.rule).toBe('no-orphan-services');
        expect(all[0].status).toBe('open');
        agg.close();
    });

    it('upsert by same findingId is replace-in-place', async () => {
        const agg = await makeAggregator();
        agg.upsertWorkspaceFinding({
            findingId: 'f-1', graphId: 'microservice:workspace',
            finding: { v: 1 }, status: 'open',
        });
        agg.upsertWorkspaceFinding({
            findingId: 'f-1', graphId: 'microservice:workspace',
            finding: { v: 2 }, status: 'resolved',
        });
        const all = agg.listWorkspaceFindings();
        expect(all).toHaveLength(1);
        expect(all[0].finding.v).toBe(2);
        expect(all[0].status).toBe('resolved');
        // updatedAt should be >= createdAt
        expect(all[0].updatedAt).toBeGreaterThanOrEqual(all[0].createdAt);
        agg.close();
    });

    it('removeWorkspaceFinding drops the row', async () => {
        const agg = await makeAggregator();
        agg.upsertWorkspaceFinding({
            findingId: 'f-1', graphId: 'map:workspace',
            finding: {}, status: 'open',
        });
        agg.removeWorkspaceFinding('f-1');
        expect(agg.listWorkspaceFindings()).toHaveLength(0);
        agg.close();
    });

    it('multiple findings persisted; createdAt preserved per row on upsert', async () => {
        const agg = await makeAggregator();
        agg.upsertWorkspaceFinding({
            findingId: 'a', graphId: 'g1', finding: {}, status: 'open', createdAt: 1000,
        });
        agg.upsertWorkspaceFinding({
            findingId: 'b', graphId: 'g2', finding: {}, status: 'open', createdAt: 2000,
        });
        const all = agg.listWorkspaceFindings();
        expect(all.map((f) => f.findingId).sort()).toEqual(['a', 'b']);
        expect(all.find((f) => f.findingId === 'a')!.createdAt).toBe(1000);
        expect(all.find((f) => f.findingId === 'b')!.createdAt).toBe(2000);
        agg.close();
    });
});
