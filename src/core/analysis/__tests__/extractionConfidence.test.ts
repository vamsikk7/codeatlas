/**
 * extractionConfidence.test.ts — #917
 */
import { describe, it, expect } from 'vitest';
import { computeExtractionConfidence, renderExtractionGapBanner } from '../extractionConfidence';

function svc(name: string, technology: string, exposedApiCount: number): any {
    return { id: `service:${name}`, name, rootPath: name, technology, category: 'backend', exposedApiCount, consumedUrls: [], consumedServices: [] };
}

describe('#917 — extraction confidence', () => {
    it('flags a detected HTTP framework with 0 routes as a gap', () => {
        const snap = {
            apiIndex: {},
            services: { 'service:api': svc('api', 'rails', 0) },
        } as any;
        const conf = computeExtractionConfidence(snap);
        expect(conf.gaps).toEqual([{ service: 'api', technology: 'rails' }]);
        expect(conf.frameworkCount).toBe(1);
        expect(conf.totalEntryPoints).toBe(0);
    });

    it('does NOT flag a framework that DID yield routes', () => {
        const snap = {
            apiIndex: { 'GET:/x': {}, 'POST:/y': {} },
            services: { 'service:api': svc('api', 'express', 2) },
        } as any;
        const conf = computeExtractionConfidence(snap);
        expect(conf.gaps).toEqual([]);
        expect(conf.totalEntryPoints).toBe(2);
        expect(conf.frameworkCount).toBe(1);
    });

    it('does NOT flag a non-HTTP technology (e.g. unknown / mobile) with 0 routes', () => {
        const snap = {
            apiIndex: {},
            services: { 'a': svc('a', 'unknown', 0), 'b': svc('b', 'android', 0) },
        } as any;
        const conf = computeExtractionConfidence(snap);
        expect(conf.gaps).toEqual([]);
        expect(conf.frameworkCount).toBe(0);
    });

    it('multi-service: only the 0-route HTTP services are gaps; counts distinct frameworks', () => {
        const snap = {
            apiIndex: { 'GET:/u': {} },
            services: {
                a: svc('checkout', 'gin', 5),    // ok
                b: svc('frontend', 'gin', 0),    // gap (same framework)
                c: svc('legacy', 'rails', 0),    // gap (different framework)
                d: svc('mobile', 'react-native', 0), // not HTTP
            },
        } as any;
        const conf = computeExtractionConfidence(snap);
        expect(conf.gaps.map((g) => g.service).sort()).toEqual(['frontend', 'legacy']);
        expect(conf.frameworkCount).toBe(2); // gin + rails
    });

    it('renderExtractionGapBanner: null when no gaps, text with the framework list otherwise', () => {
        expect(renderExtractionGapBanner({ totalEntryPoints: 3, frameworkCount: 1, gaps: [] })).toBeNull();
        const banner = renderExtractionGapBanner({ totalEntryPoints: 0, frameworkCount: 1, gaps: [{ service: 'api', technology: 'rails' }] });
        expect(banner).toMatch(/found 0 routes/i);
        expect(banner).toContain('api (rails)');
        expect(banner).toMatch(/detection gap/i);
    });
});
