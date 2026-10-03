/**
 * generateChain.test.ts — Issue #603 Phase 3.5.
 */

import { describe, it, expect } from 'vitest';
import { parseAndGate } from '../aiTestGen/generateChain';
import type { ApiTestingEndpoint } from '../types';

const ENDPOINTS: ApiTestingEndpoint[] = [
    { id: 'a1', method: 'POST', route: '/api/users/login', handlerName: 'login', filePath: 'src/auth.ts' },
    { id: 'a2', method: 'GET',  route: '/api/user',        handlerName: 'me',    filePath: 'src/auth.ts' },
    { id: 'a3', method: 'POST', route: '/api/articles',    handlerName: 'create', filePath: 'src/articles.ts' },
];

describe('parseAndGate (chain)', () => {
    it('builds steps from endpoint ids the LLM proposes', () => {
        const raw = JSON.stringify({
            name: 'login flow',
            steps: [
                { id: 'a1', method: 'POST', url: '/api/users/login' },
                { id: 'a2', method: 'GET',  url: '/api/user' },
            ],
        });
        const out = parseAndGate(raw, ENDPOINTS);
        expect(out.chain.name).toBe('login flow');
        expect(out.chain.steps.map(s => s.id)).toEqual(['a1', 'a2']);
        expect(out.droppedExtracts).toBe(0);
    });

    it('drops steps that reference unknown endpoint ids', () => {
        const raw = JSON.stringify({
            name: 'partial',
            steps: [
                { id: 'a1' },
                { id: 'unknown' },
                { id: 'a3' },
            ],
        });
        const out = parseAndGate(raw, ENDPOINTS);
        expect(out.chain.steps.map(s => s.id)).toEqual(['a1', 'a3']);
    });

    it('keeps extract recipes with valid scope + path + evidence', () => {
        const raw = JSON.stringify({
            name: 'auth',
            steps: [
                {
                    id: 'a1',
                    extract: {
                        token: { scope: 'json', path: '$.user.token', evidence: 'res.json({ user })' },
                    },
                },
                { id: 'a2' },
            ],
        });
        const out = parseAndGate(raw, ENDPOINTS);
        expect(out.chain.steps[0].extract?.token).toEqual({ scope: 'json', path: '$.user.token' });
    });

    it('drops extract recipes with missing evidence', () => {
        const raw = JSON.stringify({
            name: 'auth',
            steps: [
                {
                    id: 'a1',
                    extract: {
                        token:  { scope: 'json', path: '$.user.token' }, // no evidence
                        sessId: { scope: 'json', path: '$.sessionId', evidence: 'something' },
                    },
                },
            ],
        });
        const out = parseAndGate(raw, ENDPOINTS);
        expect(out.chain.steps[0].extract?.token).toBeUndefined();
        expect(out.chain.steps[0].extract?.sessId).toEqual({ scope: 'json', path: '$.sessionId' });
        expect(out.droppedExtracts).toBe(1);
    });

    it('returns empty chain on invalid JSON', () => {
        const out = parseAndGate('not json', ENDPOINTS);
        expect(out.chain.steps).toEqual([]);
    });
});
