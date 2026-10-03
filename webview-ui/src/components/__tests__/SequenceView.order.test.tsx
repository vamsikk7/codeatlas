import { describe, it, expect } from 'vitest';
import { orderSequenceParticipants } from '../SequenceView';

const actor = { id: 'a', label: 'API Client', subtitle: '«actor»' };
const mod = (id: string, label: string, filePath: string) => ({
    id, label, subtitle: '«module»', body: label, anchor: { filePath },
});

describe('orderSequenceParticipants — entry-point file is lane 2 (BUG-CONNECT-3)', () => {
    it('pins the entry file ahead of an alphabetically-earlier callee (polar GET /custom-fields)', () => {
        // Before the fix, the «module» alphabetical tiebreak put CustomFieldService before endpoints.py.
        const nodes = [
            actor,
            mod('cf', 'CustomFieldService', 'server/custom_field/service.py'),
            mod('ep', 'endpoints.py', 'server/custom_field/endpoints.py'),
        ];
        const ordered = orderSequenceParticipants(nodes, { filePath: 'server/custom_field/endpoints.py', fileName: 'endpoints.py' });
        expect(ordered.map((n) => n.label)).toEqual(['API Client', 'endpoints.py', 'CustomFieldService']);
    });

    it('js-express: the route file (entry) precedes the controller', () => {
        const nodes = [
            actor,
            mod('ctrl', 'auth.controller.js', 'src/auth/auth.controller.js'),
            mod('route', 'auth.route.js', 'src/auth/auth.route.js'),
        ];
        const ordered = orderSequenceParticipants(nodes, { filePath: 'src/auth/auth.route.js', fileName: 'auth.route.js' });
        expect(ordered[0].label).toBe('API Client');
        expect(ordered[1].label).toBe('auth.route.js');
    });

    it('no-op when the entry file already sorts first (GET /support-cases stays correct)', () => {
        const nodes = [
            actor,
            mod('ep', 'endpoints.py', 'server/support_case/endpoints.py'),
            mod('svc', 'SupportCaseService', 'server/support_case/service.py'),
        ];
        const ordered = orderSequenceParticipants(nodes, { filePath: 'server/support_case/endpoints.py', fileName: 'endpoints.py' });
        expect(ordered.map((n) => n.label)).toEqual(['API Client', 'endpoints.py', 'SupportCaseService']);
    });

    it('actor stays at lane 0 and external services stay after modules', () => {
        const nodes = [
            mod('ep', 'endpoints.py', 'server/x/endpoints.py'),
            actor,
            { id: 'db', label: 'postgres', subtitle: '«database»' },
        ];
        const ordered = orderSequenceParticipants(nodes, { filePath: 'server/x/endpoints.py', fileName: 'endpoints.py' });
        expect(ordered[0].label).toBe('API Client');
        expect(ordered[1].label).toBe('endpoints.py');
        expect(ordered[2].label).toBe('postgres');
    });

    it('pins the entry file even when a callee is anchored to the entry file itself (polar order.py:list)', () => {
        // CustomerOrderService is invoked FROM order.py, so its anchor.filePath IS the
        // entry file's path — identical to the entry participant. Before the body-first
        // match, the anchor branch of the OR matched this alphabetically-earlier callee
        // (floated to lane 1 by the sort) so the pin saw idx===1 and no-oped, leaving
        // CustomerOrderService ahead of order.py. Matching body===fileName fixes it.
        const entry = 'server/polar/customer_portal/endpoints/order.py';
        const nodes = [
            actor,
            mod('svc', 'CustomerOrderService', entry), // callee anchored to the entry file
            mod('ep', 'order.py', entry),              // the entry file participant
        ];
        const ordered = orderSequenceParticipants(nodes, { filePath: entry, fileName: 'order.py' });
        expect(ordered.map((n) => n.label)).toEqual(['API Client', 'order.py', 'CustomerOrderService']);
    });
});
