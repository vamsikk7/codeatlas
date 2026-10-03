import { describe, it, expect } from 'vitest';
import { outsideRouteTitle } from '../outsideRouteTitle';

describe('outsideRouteTitle - Bug A', () => {
    it('returns "Architecture Violations" for the violations route', () => {
        expect(outsideRouteTitle('violations')).toBe('Architecture Violations');
    });

    it('returns "Tour" for the tour route', () => {
        expect(outsideRouteTitle('tour')).toBe('Tour');
    });

    it('returns "API Testing" for the api-testing route', () => {
        expect(outsideRouteTitle('api-testing')).toBe('API Testing');
    });

    it('returns null for unknown / null / empty routes', () => {
        expect(outsideRouteTitle(null)).toBe(null);
        expect(outsideRouteTitle(undefined)).toBe(null);
        expect(outsideRouteTitle('')).toBe(null);
        expect(outsideRouteTitle('domain')).toBe(null);
        expect(outsideRouteTitle('features')).toBe(null);
    });
});
