import { describe, it, expect } from 'vitest';
import { entryPointsNoun, isFrontendCategory, categoryFromGraph } from '../entryPointLabel';

describe('entryPointsNoun', () => {
    it('frontend/mobile → "Entry Points"', () => {
        expect(entryPointsNoun('frontend')).toBe('Entry Points');
        expect(entryPointsNoun('mobile')).toBe('Entry Points');
    });
    it('backend/unknown/undefined → "APIs" (safe default)', () => {
        expect(entryPointsNoun('backend')).toBe('APIs');
        expect(entryPointsNoun('monorepo-parent')).toBe('APIs');
        expect(entryPointsNoun('unknown')).toBe('APIs');
        expect(entryPointsNoun(undefined)).toBe('APIs');
        expect(entryPointsNoun(null)).toBe('APIs');
    });
});

describe('isFrontendCategory', () => {
    it('true only for frontend/mobile', () => {
        expect(isFrontendCategory('frontend')).toBe(true);
        expect(isFrontendCategory('mobile')).toBe(true);
        expect(isFrontendCategory('backend')).toBe(false);
        expect(isFrontendCategory(undefined)).toBe(false);
    });
});

describe('categoryFromGraph', () => {
    it('honors explicit meta.category', () => {
        expect(categoryFromGraph({ meta: { category: 'frontend' } })).toBe('frontend');
        expect(categoryFromGraph({ meta: { category: 'mobile' } })).toBe('mobile');
        expect(categoryFromGraph({ meta: { category: 'backend' } })).toBe('backend');
    });
    it('honors meta.serviceCategory (feature graph field)', () => {
        expect(categoryFromGraph({ meta: { serviceCategory: 'mobile' } })).toBe('mobile');
    });
    it('detects FE from screen-content panel', () => {
        expect(categoryFromGraph({ graphId: 'screen-content:foo', meta: {} })).toBe('frontend');
        expect(categoryFromGraph({ meta: { screenItems: [{ itemId: 'x' }] } })).toBe('frontend');
    });
    it('detects FE from populated screen/nav/network buckets', () => {
        expect(categoryFromGraph({ meta: { screens: [{}], apis: [] } })).toBe('frontend');
        expect(categoryFromGraph({ meta: { navRoutes: [{}] } })).toBe('frontend');
        expect(categoryFromGraph({ meta: { networkCalls: [{}] } })).toBe('frontend');
    });
    it('detects FE when every api record is a UI-kind method', () => {
        const g = { meta: { apis: [{ method: 'SCREEN' }, { method: 'NAV_ROUTE' }, { method: 'NETWORK' }] } };
        expect(categoryFromGraph(g)).toBe('frontend');
    });
    it('returns undefined (→ backend/"APIs") for HTTP api clusters', () => {
        const g = { meta: { apis: [{ method: 'GET' }, { method: 'POST' }] } };
        expect(categoryFromGraph(g)).toBeUndefined();
    });
    it('returns undefined for a mixed cluster (safe default = APIs)', () => {
        const g = { meta: { apis: [{ method: 'GET' }, { method: 'SCREEN' }] } };
        expect(categoryFromGraph(g)).toBeUndefined();
    });
    it('returns undefined for empty/absent meta', () => {
        expect(categoryFromGraph({ meta: {} })).toBeUndefined();
        expect(categoryFromGraph({})).toBeUndefined();
        expect(categoryFromGraph(null)).toBeUndefined();
        expect(categoryFromGraph(undefined)).toBeUndefined();
    });
});
