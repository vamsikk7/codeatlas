/**
 * moduleExportsFlowDiff.test.ts — #837 (2026-06-11)
 *
 * Live-verify repro (build 116/117, js-serverless-examples): editing a
 * Serverless-Framework handler written as `module.exports.create = (…) => {…}`
 * rebuilt the L5 flow graph WITH the new statement but stamped every node
 * `diff: 'unchanged'` — the badge never appeared. Unit-level cause #1 was
 * parseFirstFunction rejecting AssignmentExpression-parent arrows; this T3
 * pins the WHOLE orchestrator path (scan → baseline symbols → rebuildFile →
 * oldFnCode reconstruction → buildFlowGraph diff) against a real store.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runScenario, type ScenarioResult } from './cascadeHarness';
import { SnapshotStore } from '../../src/core/storage/snapshotStore';
import { CommentStore } from '../../src/core/storage/commentStore';
import { SyncOrchestrator } from '../../src/core/sync/syncOrchestrator';

const CREATE_TS = `'use strict'

import * as uuid from 'uuid'

import { DynamoDB } from 'aws-sdk'

const dynamoDb = new DynamoDB.DocumentClient()

module.exports.create = (event, context, callback) => {
  const timestamp = new Date().getTime()
  const data = JSON.parse(event.body)
  if (typeof data.text !== 'string') {
    console.error('Validation Failed')
    callback(new Error('Could not create the todo item.'))
    return
  }

  const params = {
    TableName: process.env.DYNAMODB_TABLE,
    Item: { id: uuid.v1(), text: data.text },
  }

  dynamoDb.put(params, (error) => {
    callback(null, { statusCode: 200 })
  })
}
`;

describe('#837 — module.exports handler edits stamp the L5 flow diff', () => {
    let fixtureDir: string;
    let scenario: ScenarioResult;

    beforeAll(async () => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modexports-flow-'));
        fs.mkdirSync(path.join(fixtureDir, 'todos'));
        fs.writeFileSync(path.join(fixtureDir, 'todos', 'create.ts'), CREATE_TS, 'utf-8');
        fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({
            name: 'modexports-fixture', version: '1.0.0', dependencies: { 'aws-sdk': '^2.0.0' },
        }), 'utf-8');
        // The live repro's handler is an IaC route (Serverless Framework) —
        // the api-record path is part of what's under test.
        fs.writeFileSync(path.join(fixtureDir, 'serverless.yml'), [
            'service: modexports-fixture',
            'provider:',
            '  name: aws',
            '  runtime: nodejs18.x',
            'functions:',
            '  create:',
            '    handler: todos/create.create',
            '    events:',
            '      - http:',
            '          path: todos',
            '          method: post',
        ].join('\n'), 'utf-8');
        scenario = await runScenario({ repoPath: fixtureDir, edits: [] });
    }, 60_000);

    afterAll(() => {
        scenario?.dispose();
        try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('adding a statement inside the module.exports arrow marks the flow node added/modified', async () => {
        const abs = path.join(scenario.repoCopyDir, 'todos', 'create.ts');
        fs.writeFileSync(abs, CREATE_TS.replace(
            'const timestamp = new Date().getTime()',
            'const _probe837 = 117\n  const timestamp = new Date().getTime()',
        ), 'utf-8');
        await scenario.sync.rebuildFile(abs);

        const flow: any = scenario.store.getWorking().graphs['flow:todos/create.ts:create'];
        expect(flow, 'flow graph must exist after rebuild').toBeTruthy();
        const labels = flow.nodes.map((n: any) => `${n.diff}|${String(n.label).slice(0, 40)}`);
        const probeNode = flow.nodes.find((n: any) => String(n.label).includes('_probe837'));
        expect(probeNode, `probe statement must render. nodes=${labels.join(' ;; ')}`).toBeTruthy();
        const dirty = flow.nodes.filter((n: any) => n.diff === 'added' || n.diff === 'modified');
        expect(dirty.length, `expected ≥1 added/modified flow node. nodes=${labels.join(' ;; ')}`).toBeGreaterThanOrEqual(1);

        // The live serving path runs the on-route cascade before every
        // requestRoute (ADR-023 cascade_on_route). The badge must SURVIVE it
        // — the live repro stamped correctly at rebuild time and read
        // `unchanged` by the time the browser asked.
        (scenario.sync as any).applyDiffCascadeToLiveGraphs?.();
        const after: any = scenario.store.getWorking().graphs['flow:todos/create.ts:create'];
        const afterLabels = after.nodes.map((n: any) => `${n.diff}|${String(n.label).slice(0, 40)}`);
        const afterDirty = after.nodes.filter((n: any) => n.diff === 'added' || n.diff === 'modified');
        expect(afterDirty.length, `flow badge must survive the on-route cascade. nodes=${afterLabels.join(' ;; ')}`).toBeGreaterThanOrEqual(1);
    });
});

// The live multi-repo construction (extension.ts productionRepoRunner /
// tier2PostInit): orchestrator scoped to a SUB-REPO of a wider workspace —
// `new SyncOrchestrator(<monorepoRoot>, store, comments, undefined,
// undefined, <repoAbs>)`. Graph ids and file keys carry the repo prefix.
describe('#837 — production-shaped per-repo orchestrator (repoScope set)', () => {
    let wsDir: string;
    let repoAbs: string;
    let store: SnapshotStore;
    let sync: SyncOrchestrator;

    beforeAll(async () => {
        wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modexports-ws-'));
        repoAbs = path.join(wsDir, 'aws-node-ts-rest-api');
        fs.mkdirSync(path.join(repoAbs, 'todos'), { recursive: true });
        fs.writeFileSync(path.join(repoAbs, 'todos', 'create.ts'), CREATE_TS, 'utf-8');
        fs.writeFileSync(path.join(repoAbs, 'package.json'), JSON.stringify({
            name: 'modexports-sub', version: '1.0.0', dependencies: { 'aws-sdk': '^2.0.0' },
        }), 'utf-8');
        fs.writeFileSync(path.join(repoAbs, 'serverless.yml'), [
            'service: modexports-sub',
            'provider:', '  name: aws', '  runtime: nodejs18.x',
            'functions:', '  create:', '    handler: todos/create.create',
            '    events:', '      - http:', '          path: todos', '          method: post',
        ].join('\n'), 'utf-8');

        store = new SnapshotStore(repoAbs);
        await store.load();
        sync = new SyncOrchestrator(wsDir, store, new CommentStore([]), undefined, undefined, repoAbs);
        await sync.initialize();
        store.save();
    }, 120_000);

    afterAll(() => {
        try { store.close(); } catch { /* ignore */ }
        try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // #824 — IaC routes must land on SOME L3 sequence. The sls-extracted
    // record (`sls:` apiId) historically had none, so the L2b click
    // rerouted to L5 (single-repo) or hung (#839, monorepo).
    it('#824 — the serverless route gets a synthetic one-participant sequence at init', () => {
        const w = store.getWorking();
        const slsApi: any = Object.values(w.apiIndex ?? {}).find((a: any) => String(a.apiId).startsWith('sls:'));
        expect(slsApi, `an sls api record must exist. apiIds=${Object.keys(w.apiIndex ?? {}).join(',')}`).toBeTruthy();
        const gid = `sequence:${slsApi.filePath}:${slsApi.handlerName}`;
        const seq: any = w.graphs[gid];
        expect(seq, `sequence graph ${gid} must exist`).toBeTruthy();
        expect(seq.nodes.length).toBeGreaterThanOrEqual(2);
        expect(seq.edges.length).toBeGreaterThanOrEqual(1);
        // Either a real builder produced it or the synthetic shell did —
        // both satisfy the umbrella contract; the synthetic carries the marker.
        if (seq.meta?.synthetic) {
            expect(seq.nodes[0].subtitle).toBe('«actor»');
        }
        // And it exists in baseline too (built before rotation).
        expect((store.getBaseline().graphs as any)[gid]).toBeTruthy();
    });

    it('rebuildFile stamps the flow diff with repo-prefixed paths (the live multi-repo shape)', async () => {
        const abs = path.join(repoAbs, 'todos', 'create.ts');
        fs.writeFileSync(abs, CREATE_TS.replace(
            'const timestamp = new Date().getTime()',
            'const _probe837 = 117\n  const timestamp = new Date().getTime()',
        ), 'utf-8');
        await sync.rebuildFile(abs);

        const graphs = store.getWorking().graphs;
        const flowId = Object.keys(graphs).find(k => k.startsWith('flow:') && k.endsWith(':create'));
        expect(flowId, `flow graph for create must exist. flow keys=${Object.keys(graphs).filter(k=>k.startsWith('flow:')).join(',')}`).toBeTruthy();
        const flow: any = graphs[flowId!];
        const labels = flow.nodes.map((n: any) => `${n.diff}|${String(n.label).slice(0, 40)}`);
        expect(flow.nodes.some((n: any) => String(n.label).includes('_probe837')),
            `probe must render. nodes=${labels.join(' ;; ')}`).toBe(true);
        const dirty = flow.nodes.filter((n: any) => n.diff === 'added' || n.diff === 'modified');
        expect(dirty.length, `expected ≥1 added/modified node. nodes=${labels.join(' ;; ')}`).toBeGreaterThanOrEqual(1);
    });
});
