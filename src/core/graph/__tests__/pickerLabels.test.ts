/**
 * BUG-CONNECT-4 — picker row labels. The scope picker showed "unknown · N APIs"
 * for every repo (technology sentinel where the category belongs + a hardcoded
 * noun). These helpers pick the semantic category + a category-aware noun.
 */
import { describe, it, expect } from 'vitest';
import { pickerCountNoun, pickerCategoryLabel, dominantCategory, repoCategoryFromServices, pickerSubtitle } from '../pickerLabels';

describe('pickerCountNoun', () => {
    it('frontend/mobile expose entry points; everything else exposes APIs', () => {
        expect(pickerCountNoun('frontend')).toBe('entry points');
        expect(pickerCountNoun('mobile')).toBe('entry points');
        expect(pickerCountNoun('backend')).toBe('APIs');
        expect(pickerCountNoun('unknown')).toBe('APIs');
        expect(pickerCountNoun(undefined)).toBe('APIs');
        expect(pickerCountNoun(null)).toBe('APIs');
    });
});

describe('pickerCategoryLabel', () => {
    it('prefers a real category', () => {
        expect(pickerCategoryLabel('frontend', 'nextjs')).toBe('frontend');
        expect(pickerCategoryLabel('backend', 'fastapi')).toBe('backend');
    });
    it('falls back to a meaningful technology when category is unknown', () => {
        expect(pickerCategoryLabel('unknown', 'fastapi')).toBe('fastapi');
    });
    it('never surfaces the "unknown" / "monorepo-parent" sentinels — falls back to "service"', () => {
        expect(pickerCategoryLabel('unknown', 'unknown')).toBe('service');
        expect(pickerCategoryLabel('unknown', undefined)).toBe('service');
        expect(pickerCategoryLabel('monorepo-parent', 'unknown')).toBe('service');
        expect(pickerCategoryLabel(undefined, undefined)).toBe('service');
    });
});

describe('dominantCategory', () => {
    it('returns the most frequent non-unknown category', () => {
        expect(dominantCategory([{ category: 'frontend' }, { category: 'frontend' }, { category: 'mobile' }])).toBe('frontend');
    });
    it('ignores unknown / monorepo-parent', () => {
        expect(dominantCategory([{ category: 'unknown' }, { category: 'monorepo-parent' }, { category: 'backend' }])).toBe('backend');
    });
    it('returns undefined when there is no recognisable category', () => {
        expect(dominantCategory([{ category: 'unknown' }, {}])).toBeUndefined();
        expect(dominantCategory([])).toBeUndefined();
    });
});

describe('repoCategoryFromServices', () => {
    it('backend when non-frontend services expose HTTP, even if categorized "unknown" and a stray frontend service exists (polar server)', () => {
        // polar/server: 2 FastAPI services (category 'unknown') exposing 504 routes
        // + 1 react-email service (category 'frontend', 0 routes). A plain frequency
        // vote wrongly picked 'frontend'; the API-weighted rule picks 'backend'.
        const server = [
            { category: 'unknown', exposedApiCount: 504 },
            { category: 'unknown', exposedApiCount: 0 },
            { category: 'frontend', exposedApiCount: 0 },
        ];
        expect(repoCategoryFromServices(server)).toBe('backend');
    });
    it('frontend when nothing exposes HTTP and FE/mobile dominate (polar clients)', () => {
        const clients = [
            ...Array.from({ length: 6 }, () => ({ category: 'frontend', exposedApiCount: 0 })),
            ...Array.from({ length: 4 }, () => ({ category: 'unknown', exposedApiCount: 0 })),
            ...Array.from({ length: 2 }, () => ({ category: 'mobile', exposedApiCount: 0 })),
        ];
        expect(repoCategoryFromServices(clients)).toBe('frontend');
    });
    it('undefined when a repo neither exposes HTTP nor has FE/mobile services (docs/handbook)', () => {
        expect(repoCategoryFromServices([{ category: 'unknown', exposedApiCount: 0 }])).toBeUndefined();
    });
    it('full-stack: an explicit backend service exposing routes wins over a frontend sibling', () => {
        expect(repoCategoryFromServices([{ category: 'frontend', exposedApiCount: 0 }, { category: 'backend', exposedApiCount: 50 }])).toBe('backend');
    });
});

describe('pickerSubtitle', () => {
    it('frontend repo → "frontend · N entry points" (BUG-CONNECT-4 — clients)', () => {
        expect(pickerSubtitle('frontend', 'nextjs', 553)).toBe('frontend · 553 entry points');
    });
    it('backend repo → "backend · N APIs" (server)', () => {
        expect(pickerSubtitle('backend', 'fastapi', 567)).toBe('backend · 567 APIs');
    });
    it('unknown category + unknown technology → "service · N APIs" (never "unknown")', () => {
        expect(pickerSubtitle('unknown', 'unknown', 0)).toBe('service · 0 APIs');
    });
});
