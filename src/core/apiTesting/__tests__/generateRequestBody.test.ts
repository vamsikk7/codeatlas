/**
 * generateRequestBody.test.ts — Issue #603 Phase 3.5.
 */

import { describe, it, expect } from 'vitest';
import { parseAndGate } from '../aiTestGen/generateRequestBody';

const HANDLER_SOURCE = `
export async function createUser(req, res) {
    const { email, password, name } = req.body;
    if (!email) return res.status(422).json({ error: 'email required' });
    const user = await prisma.user.create({ data: { email, password, name } });
    return res.status(201).json({ user });
}
`;

describe('parseAndGate (request-body)', () => {
    it('keeps fields whose evidence quotes the handler', () => {
        const raw = JSON.stringify({
            body: {
                email: 'a@b.com',
                password: 'secret',
                name: 'Alice',
            },
            evidence: {
                email:    'const { email, password, name } = req.body;',
                password: 'const { email, password, name } = req.body;',
                name:     'const { email, password, name } = req.body;',
            },
        });
        const out = parseAndGate(raw, HANDLER_SOURCE);
        expect(out.body).toEqual({ email: 'a@b.com', password: 'secret', name: 'Alice' });
        expect(out.dropped).toBe(0);
    });

    it('drops invented fields', () => {
        const raw = JSON.stringify({
            body: {
                email:    'a@b.com',
                bio:      'invented',
                avatar:   'http://x.png',
            },
            evidence: {
                email:  'const { email, password, name } = req.body;',
                bio:    'unrelated text',
                avatar: 'also fake',
            },
        });
        const out = parseAndGate(raw, HANDLER_SOURCE);
        expect(Object.keys(out.body)).toEqual(['email']);
        expect(out.dropped).toBe(2);
    });

    it('drops fields with no evidence at all', () => {
        const raw = JSON.stringify({
            body: { email: 'a@b.com' },
            evidence: {},
        });
        const out = parseAndGate(raw, HANDLER_SOURCE);
        expect(out.body).toEqual({});
        expect(out.dropped).toBe(1);
    });

    it('returns empty when JSON is invalid', () => {
        expect(parseAndGate('not json', HANDLER_SOURCE)).toEqual({ body: {}, dropped: 0 });
    });

    it('strips markdown fences', () => {
        const raw = '```json\n' + JSON.stringify({
            body: { email: 'a@b.com' },
            evidence: { email: 'const { email, password, name } = req.body;' },
        }) + '\n```';
        const out = parseAndGate(raw, HANDLER_SOURCE);
        expect(out.body.email).toBe('a@b.com');
    });
});
