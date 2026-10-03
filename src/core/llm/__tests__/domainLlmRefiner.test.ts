/**
 * domainLlmRefiner.test.ts — Issue #733 tests.
 *
 * Pins the complementary-not-replacement contract: every test must
 * produce a result that is the heuristic input plus delta. Errors,
 * malformed responses, and unknown ids never degrade the output.
 */

import { describe, it, expect, vi } from 'vitest';
import { refineDomainsWithLlm, mergeRefinedDomainNames, type DomainLlmCall } from '../domainLlmRefiner';
import type { DomainCluster, Snapshot, ApiRecord } from '../../graph/graphTypes';

function api(id: string, route: string, filePath: string): ApiRecord {
    return {
        apiId: id,
        method: 'GET',
        route,
        handlerName: 'h',
        filePath,
        anchor: { filePath, span: { start: 0, end: 1 } },
    };
}

function domain(id: string, name: string, overrides: Partial<DomainCluster> = {}): DomainCluster {
    return {
        id,
        name,
        verb: 'verb',
        routes: [],
        files: [],
        confidence: 0.5,
        source: 'heuristic',
        ...overrides,
    };
}

function emptySnapshot(): Snapshot {
    return { files: {}, apiIndex: {}, graphs: {} };
}

describe('refineDomainsWithLlm — graceful fallback', () => {
    it('returns input unchanged when LLM throws', async () => {
        const heuristic = { 'd1': domain('d1', 'Original') };
        const llm: DomainLlmCall = async () => { throw new Error('boom'); };
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out).toEqual(heuristic);
    });

    it('returns input unchanged when LLM response is unparseable', async () => {
        const heuristic = { 'd1': domain('d1', 'Original') };
        const llm: DomainLlmCall = async () => 'just prose, no JSON whatsoever';
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out).toEqual(heuristic);
    });

    it('returns input unchanged when LLM response is empty JSON', async () => {
        const heuristic = { 'd1': domain('d1', 'Original') };
        const llm: DomainLlmCall = async () => '{}';
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        // No refinements applied, but the routes/files arrays are cloned so
        // identity differs while content is equal.
        expect(out['d1'].name).toBe('Original');
        expect(out['d1'].source).toBe('heuristic');
    });

    it('returns empty object unchanged (no API calls when input is empty)', async () => {
        const llm: DomainLlmCall = vi.fn();
        const out = await refineDomainsWithLlm({}, emptySnapshot(), llm);
        expect(out).toEqual({});
        expect(llm).not.toHaveBeenCalled();
    });
});

describe('refineDomainsWithLlm — renames', () => {
    it('applies a rename and flips source to llm-refined', async () => {
        const heuristic = { 'd1': domain('d1', 'Authenticate users') };
        const llm: DomainLlmCall = async () => JSON.stringify({
            renames: [{ id: 'd1', newName: 'User authentication', reason: 'more idiomatic' }],
        });
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out['d1'].name).toBe('User authentication');
        expect(out['d1'].source).toBe('llm-refined');
    });

    it('silently skips renames for unknown ids', async () => {
        const heuristic = { 'd1': domain('d1', 'Real') };
        const llm: DomainLlmCall = async () => JSON.stringify({
            renames: [{ id: 'made-up', newName: 'Fake' }],
        });
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out['d1'].name).toBe('Real');
        expect(out['d1'].source).toBe('heuristic');
    });

    it('leaves untouched domains with source=heuristic when only some are renamed', async () => {
        const heuristic = {
            'd1': domain('d1', 'First'),
            'd2': domain('d2', 'Second'),
        };
        const llm: DomainLlmCall = async () => JSON.stringify({
            renames: [{ id: 'd1', newName: 'Renamed' }],
        });
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out['d1'].source).toBe('llm-refined');
        expect(out['d2'].source).toBe('heuristic');
    });
});

describe('refineDomainsWithLlm — confidence calibration', () => {
    it('boosts confidence up to the +0.3 ceiling', async () => {
        const heuristic = { 'd1': domain('d1', 'X', { confidence: 0.4 }) };
        const llm: DomainLlmCall = async () => JSON.stringify({
            confidenceAdjustments: [{ id: 'd1', confidence: 0.95 }],
        });
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        // 0.4 + 0.3 ceiling = 0.7, even though LLM asked for 0.95.
        expect(out['d1'].confidence).toBeCloseTo(0.7, 2);
    });

    it('respects an LLM value below the ceiling', async () => {
        const heuristic = { 'd1': domain('d1', 'X', { confidence: 0.4 }) };
        const llm: DomainLlmCall = async () => JSON.stringify({
            confidenceAdjustments: [{ id: 'd1', confidence: 0.55 }],
        });
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out['d1'].confidence).toBeCloseTo(0.55, 2);
    });

    it('rejects out-of-range confidence (>1 or <0) via the schema', async () => {
        const heuristic = { 'd1': domain('d1', 'X', { confidence: 0.4 }) };
        // Confidence > 1 is schema-invalid, so the parse fails and the
        // whole response is rejected → heuristic unchanged.
        const llm: DomainLlmCall = async () => JSON.stringify({
            confidenceAdjustments: [{ id: 'd1', confidence: 1.5 }],
        });
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out['d1'].confidence).toBeCloseTo(0.4, 2);
    });
});

describe('refineDomainsWithLlm — merges', () => {
    it('collapses two domains into one keyed by the higher-confidence parent', async () => {
        const heuristic = {
            'd1': domain('d1', 'Place orders', { routes: ['r1'], files: ['f1'], confidence: 0.6 }),
            'd2': domain('d2', 'Fulfill orders', { routes: ['r2'], files: ['f2'], confidence: 0.4 }),
        };
        const llm: DomainLlmCall = async () => JSON.stringify({
            merges: [{ ids: ['d1', 'd2'], intoName: 'Order lifecycle', verb: 'manage' }],
        });
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out['d1']).toBeDefined();
        expect(out['d2']).toBeUndefined();
        expect(out['d1'].name).toBe('Order lifecycle');
        expect(out['d1'].verb).toBe('manage');
        expect(out['d1'].routes).toEqual(expect.arrayContaining(['r1', 'r2']));
        expect(out['d1'].files).toEqual(expect.arrayContaining(['f1', 'f2']));
        expect(out['d1'].source).toBe('llm-refined');
    });

    it('skips a merge that references unknown ids (<2 known parents)', async () => {
        const heuristic = { 'd1': domain('d1', 'Only') };
        const llm: DomainLlmCall = async () => JSON.stringify({
            merges: [{ ids: ['d1', 'made-up'], intoName: 'X' }],
        });
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out['d1'].name).toBe('Only');
        expect(out['d1'].source).toBe('heuristic');
    });
});

describe('refineDomainsWithLlm — robustness', () => {
    it('parses LLM responses wrapped in markdown fences', async () => {
        const heuristic = { 'd1': domain('d1', 'Original') };
        const llm: DomainLlmCall = async () => '```json\n{ "renames": [{ "id": "d1", "newName": "Refined" }] }\n```';
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out['d1'].name).toBe('Refined');
    });

    it('parses LLM responses prefixed with prose', async () => {
        const heuristic = { 'd1': domain('d1', 'Original') };
        const llm: DomainLlmCall = async () => 'Here is the refinement: { "renames": [{ "id": "d1", "newName": "Refined" }] } End.';
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out['d1'].name).toBe('Refined');
    });

    it('tolerates trailing commas in the JSON body', async () => {
        const heuristic = { 'd1': domain('d1', 'Original') };
        const llm: DomainLlmCall = async () => '{ "renames": [{ "id": "d1", "newName": "Refined", },], }';
        const out = await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(out['d1'].name).toBe('Refined');
    });

    it('does not mutate the input heuristic set', async () => {
        const heuristic = { 'd1': domain('d1', 'Original', { routes: ['r1'] }) };
        const beforeName = heuristic['d1'].name;
        const beforeRoutes = [...heuristic['d1'].routes];
        const llm: DomainLlmCall = async () => JSON.stringify({
            renames: [{ id: 'd1', newName: 'Refined' }],
        });
        await refineDomainsWithLlm(heuristic, emptySnapshot(), llm);
        expect(heuristic['d1'].name).toBe(beforeName);
        expect(heuristic['d1'].routes).toEqual(beforeRoutes);
    });

    it('includes sample routes in the LLM prompt for evidence', async () => {
        const heuristic = { 'd1': domain('d1', 'Auth', { routes: ['a1', 'a2'] }) };
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a1: api('a1', '/login', 'src/login.ts'),
                a2: api('a2', '/logout', 'src/logout.ts'),
            },
        };
        const llm = vi.fn(async (prompt: { system: string; user: string }) => {
            expect(prompt.user).toContain('/login');
            expect(prompt.user).toContain('/logout');
            return '{}';
        });
        await refineDomainsWithLlm(heuristic, snapshot, llm);
        expect(llm).toHaveBeenCalled();
    });
});

describe('#913 — mergeRefinedDomainNames (cascade preserves refined names)', () => {
    it('carries forward an LLM-refined name/verb/confidence onto the fresh heuristic (by id)', () => {
        const previous = {
            'domain:auth': domain('domain:auth', 'Authenticate users', { verb: 'authenticate', confidence: 0.9, source: 'llm-refined' }),
        };
        // Fresh heuristic re-derived the SAME id but with the default heuristic name + structure.
        const fresh = {
            'domain:auth': domain('domain:auth', 'auth-domain', { verb: 'auth', confidence: 0.5, routes: ['GET:/login'], files: ['auth.ts'] }),
        };
        const merged = mergeRefinedDomainNames(fresh, previous);
        // Refined NAME/verb/confidence survive; fresh STRUCTURE (routes/files) is taken.
        expect(merged['domain:auth'].name).toBe('Authenticate users');
        expect(merged['domain:auth'].verb).toBe('authenticate');
        expect(merged['domain:auth'].confidence).toBe(0.9);
        expect(merged['domain:auth'].source).toBe('llm-refined');
        expect(merged['domain:auth'].routes).toEqual(['GET:/login']);
        expect(merged['domain:auth'].files).toEqual(['auth.ts']);
    });

    it('does NOT touch a heuristic-only previous domain (no refinement to preserve)', () => {
        const previous = { 'domain:x': domain('domain:x', 'old-name', { source: 'heuristic' }) };
        const fresh = { 'domain:x': domain('domain:x', 'new-heuristic-name') };
        const merged = mergeRefinedDomainNames(fresh, previous);
        expect(merged['domain:x'].name).toBe('new-heuristic-name'); // fresh wins
    });

    it('a NEW heuristic domain with no previous match passes through unchanged', () => {
        const merged = mergeRefinedDomainNames({ 'domain:new': domain('domain:new', 'fresh') }, { 'domain:gone': domain('domain:gone', 'old', { source: 'llm-refined' }) });
        expect(merged['domain:new'].name).toBe('fresh');
        expect(merged['domain:gone']).toBeUndefined(); // dropped domains don't resurrect
    });

    it('no previous set → returns fresh untouched', () => {
        const fresh = { 'domain:a': domain('domain:a', 'a') };
        expect(mergeRefinedDomainNames(fresh, undefined)).toBe(fresh);
    });
});
