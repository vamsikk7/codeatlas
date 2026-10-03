/**
 * syntheticSequence.test.ts — #824 (2026-06-11)
 *
 * IaC-extracted routes (Serverless Framework / SAM / CDK) whose handlers
 * the sequence builder skips get NO L3 graph — the L2b click then falls
 * back to flow/file (#839) and the "appears everywhere your HTTP routes
 * do" promise breaks. The synthetic builder produces the minimal honest
 * sequence: API Client → handler module with one message edge.
 */
import { describe, it, expect } from 'vitest';
import { buildSyntheticSequenceGraph } from '../sequenceGraphBuilder';
import type { ApiRecord } from '../graphTypes';

function api(over: Partial<ApiRecord> = {}): ApiRecord {
    return {
        apiId: 'sls:fixture:create:POST:/todos:0',
        method: 'POST',
        route: '/todos',
        filePath: 'todos/create.ts',
        handlerName: 'create',
        ...over,
    } as ApiRecord;
}

describe('buildSyntheticSequenceGraph (#824)', () => {
    it('produces the canonical graphId and a 2-participant, 1-message shape', () => {
        const g = buildSyntheticSequenceGraph(api());
        expect(g.graphId).toBe('sequence:todos/create.ts:create');
        expect(g.type).toBe('sequence');
        expect(g.nodes).toHaveLength(2);
        expect(g.edges).toHaveLength(1);
        expect(g.meta?.synthetic).toBe(true);
    });

    it('participants follow the renderer/weaver subtitle conventions («actor» / «module»)', () => {
        const g = buildSyntheticSequenceGraph(api());
        const [client, mod] = g.nodes;
        expect(client.type).toBe('participant');
        expect(client.label).toBe('API Client');
        expect(client.subtitle).toBe('«actor»');
        expect(mod.type).toBe('participant');
        expect(mod.label).toBe('create.ts');
        expect(mod.subtitle).toBe('«module»');
        expect(mod.anchor).toEqual({ filePath: 'todos/create.ts', symbol: 'create' });
    });

    it('the message edge carries the route label and message styling', () => {
        const g = buildSyntheticSequenceGraph(api());
        const e: any = g.edges[0];
        expect(e.label).toBe('POST /todos');
        expect(e.edgeType).toBe('message');
        expect(e.source).toBe(g.nodes[0].id);
        expect(e.target).toBe(g.nodes[1].id);
    });

    it('all nodes start unchanged (diff badges flow from L4/L5, not the synthetic shell)', () => {
        const g = buildSyntheticSequenceGraph(api());
        expect(g.nodes.every(n => n.diff === 'unchanged')).toBe(true);
    });
});
