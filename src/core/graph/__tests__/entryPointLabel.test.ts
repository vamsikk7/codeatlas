import { describe, it, expect } from 'vitest';
import { entryPointsNoun, isFrontendCategory, categoryFromGraph, entryPointsNounForGraph } from '../entryPointLabel';

describe('entryPointsNoun', () => {
    it('frontend/mobile → "Entry Points"', () => {
        expect(entryPointsNoun('frontend')).toBe('Entry Points');
        expect(entryPointsNoun('mobile')).toBe('Entry Points');
    });
    it('backend/unknown/undefined → "APIs" (safe default)', () => {
        expect(entryPointsNoun('backend')).toBe('APIs');
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
    it('honors explicit meta.category / meta.serviceCategory', () => {
        expect(categoryFromGraph({ meta: { category: 'frontend' } })).toBe('frontend');
        expect(categoryFromGraph({ meta: { serviceCategory: 'mobile' } })).toBe('mobile');
        expect(categoryFromGraph({ meta: { category: 'backend' } })).toBe('backend');
    });
    it('detects FE from screen-content panel + buckets', () => {
        expect(categoryFromGraph({ graphId: 'screen-content:foo', meta: {} })).toBe('frontend');
        expect(categoryFromGraph({ meta: { screenItems: [{}] } })).toBe('frontend');
        expect(categoryFromGraph({ meta: { navRoutes: [{}] } })).toBe('frontend');
    });
    it('detects FE when every api record is a UI-kind method', () => {
        expect(categoryFromGraph({ meta: { apis: [{ method: 'SCREEN' }, { method: 'NETWORK' }] } })).toBe('frontend');
    });
    it('returns undefined (→ backend/"APIs") for HTTP + mixed clusters', () => {
        expect(categoryFromGraph({ meta: { apis: [{ method: 'GET' }, { method: 'POST' }] } })).toBeUndefined();
        expect(categoryFromGraph({ meta: { apis: [{ method: 'GET' }, { method: 'SCREEN' }] } })).toBeUndefined();
        expect(categoryFromGraph({ meta: {} })).toBeUndefined();
        expect(categoryFromGraph(null)).toBeUndefined();
    });
});

describe('entryPointsNounForGraph', () => {
    it('"Entry Points" for a frontend cluster, "APIs" for a backend one', () => {
        expect(entryPointsNounForGraph({ meta: { category: 'frontend' } })).toBe('Entry Points');
        expect(entryPointsNounForGraph({ meta: { apis: [{ method: 'SCREEN' }] } })).toBe('Entry Points');
        expect(entryPointsNounForGraph({ meta: { apis: [{ method: 'GET' }] } })).toBe('APIs');
        expect(entryPointsNounForGraph(null)).toBe('APIs');
    });
});
