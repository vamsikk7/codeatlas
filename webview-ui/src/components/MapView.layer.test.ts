import { describe, it, expect } from 'vitest';
import { mapNodeLayer } from './MapView';

describe('mapNodeLayer (BUG-POLAR-9 — layer counts fall back to node.type)', () => {
    it('uses explicit meta.layer when present', () => {
        expect(mapNodeLayer({ type: 'service', meta: { layer: 'infrastructure' } })).toBe('infrastructure');
        expect(mapNodeLayer({ type: 'cluster', meta: { layer: 'domain' } })).toBe('domain');
    });
    it('falls back to node.type when meta.layer is missing (multi-repo map:workspace)', () => {
        // polar: skeletal repo nodes are type:'service' with no meta.layer → must count as Services.
        expect(mapNodeLayer({ type: 'service', meta: null })).toBe('service');
        expect(mapNodeLayer({ type: 'cluster' })).toBe('cluster');
        expect(mapNodeLayer({ type: 'infra' })).toBe('infrastructure');
    });
    it('is undefined for unknown types (so it neither counts nor is hidden by a layer toggle)', () => {
        expect(mapNodeLayer({ type: 'file' })).toBeUndefined();
        expect(mapNodeLayer({})).toBeUndefined();
    });
    it('ignores an invalid meta.layer and falls back to type', () => {
        expect(mapNodeLayer({ type: 'service', meta: { layer: 'bogus' } })).toBe('service');
    });
});
