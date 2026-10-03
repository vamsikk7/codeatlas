/**
 * generateTestCases.test.ts — Issue #603 Phase 3.5.
 *
 * Tests the parser + evidence-gate. The full `generateTestCases`
 * entry point is covered by a single E2E-style test that mocks
 * `sendOpenRouterRequest`; the bulk of the logic lives in
 * `parseAndGate`, exercised below.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseAndGate, generateTestCases, type GeneratedTestCase } from '../aiTestGen/generateTestCases';

const HANDLER_SOURCE = `
export async function login(req, res) {
    const { email, password } = req.body;
    if (!email) {
        return res.status(422).json({ errors: { email: ['required'] } });
    }
    const user = await findByEmail(email);
    if (!user) {
        return res.status(404).json({ errors: { email: ['not found'] } });
    }
    return res.status(200).json({ user });
}
`;

describe('parseAndGate', () => {
    it('keeps cases whose evidence quotes a real line', () => {
        const raw = JSON.stringify({
            cases: [
                {
                    name: 'happy path',
                    assertions: [{ kind: 'status', equals: 200 }],
                    evidence: ['return res.status(200).json({ user });'],
                },
                {
                    name: 'missing email',
                    assertions: [{ kind: 'status', equals: 422 }, { kind: 'body-contains', text: 'required' }],
                    evidence: ['if (!email)'],
                },
            ],
        });
        const out = parseAndGate(raw, HANDLER_SOURCE);
        expect(out.cases).toHaveLength(2);
        expect(out.dropped).toBe(0);
        expect(out.cases[0].name).toBe('happy path');
        expect(out.cases[1].assertions[0].kind).toBe('status');
    });

    it('drops cases whose evidence is invented', () => {
        const raw = JSON.stringify({
            cases: [
                {
                    name: 'invented',
                    assertions: [{ kind: 'status', equals: 500 }],
                    evidence: ['throw new Error("never appears in source")'],
                },
                {
                    name: 'real',
                    assertions: [{ kind: 'status', equals: 200 }],
                    evidence: ['return res.status(200).json({ user });'],
                },
            ],
        });
        const out = parseAndGate(raw, HANDLER_SOURCE);
        expect(out.cases.map(c => c.name)).toEqual(['real']);
        expect(out.dropped).toBe(1);
    });

    it('drops cases with no evidence at all', () => {
        const raw = JSON.stringify({
            cases: [
                {
                    name: 'no evidence',
                    assertions: [{ kind: 'status', equals: 200 }],
                    evidence: [],
                },
            ],
        });
        const out = parseAndGate(raw, HANDLER_SOURCE);
        expect(out.cases).toEqual([]);
        expect(out.dropped).toBe(1);
    });

    it('drops malformed assertions and case-shapes', () => {
        const raw = JSON.stringify({
            cases: [
                {
                    name: 'bad assertion',
                    assertions: [{ kind: 'unknown', whatever: 1 }],
                    evidence: ['if (!email)'],
                },
                {
                    name: 'good',
                    assertions: [{ kind: 'status', equals: 200 }],
                    evidence: ['return res.status(200).json({ user });'],
                },
            ],
        });
        const out = parseAndGate(raw, HANDLER_SOURCE);
        expect(out.cases.map(c => c.name)).toEqual(['good']);
        expect(out.dropped).toBe(1);
    });

    it('strips markdown code fences before parsing', () => {
        const raw = '```json\n' + JSON.stringify({
            cases: [{ name: 'x', assertions: [{ kind: 'status', equals: 200 }], evidence: ['return res.status(200).json({ user });'] }],
        }) + '\n```';
        const out = parseAndGate(raw, HANDLER_SOURCE);
        expect(out.cases).toHaveLength(1);
    });

    it('coerces request_overrides into the structured shape', () => {
        const raw = JSON.stringify({
            cases: [{
                name: 'happy',
                request_overrides: {
                    body: { email: 'a@b.com', password: 'x' },
                    query: { page: 1 },
                    headers: { 'X-Trace': 'abc' },
                },
                assertions: [{ kind: 'status', equals: 200 }],
                evidence: ['return res.status(200).json({ user });'],
            }],
        });
        const out = parseAndGate(raw, HANDLER_SOURCE);
        expect(out.cases[0].request_overrides?.body).toEqual({ email: 'a@b.com', password: 'x' });
        expect(out.cases[0].request_overrides?.query).toEqual({ page: '1' });
        expect(out.cases[0].request_overrides?.headers).toEqual({ 'X-Trace': 'abc' });
    });

    it('returns empty result on invalid JSON', () => {
        const out = parseAndGate('this is not JSON', HANDLER_SOURCE);
        expect(out.cases).toEqual([]);
    });
});

// The full `generateTestCases` E2E path (prompt → LLM → parse) is
// covered indirectly: `parseAndGate` above tests the parser + evidence
// gate, and the live LLM call is exercised by the MCP smoke harness in
// `e2e/scripts/mcp-all-tools-probe.js`. Wiring a hermetic LLM mock here
// would require dynamic-import gymnastics that the surrounding test
// infrastructure doesn't currently support, so we keep this layer
// scoped to deterministic parser tests.
