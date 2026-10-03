import { describe, it, expect } from 'vitest';
import { graphIdToHash, graphIdToScopedHash } from '../hashRoutes';

/**
 * BUG-AIREVIEW-BLOCKS-L2NAV (2026-07-21) — these helpers run inside render maps
 * (AI-review finding links). A finding/binding without a graphId used to make
 * `graphId.startsWith(...)` throw, and because it's mid-render the whole diagram
 * crashed to the error boundary — which is what broke L1→L2 navigation while an
 * AI review was active. They must degrade to a safe route, never throw.
 */
describe('hashRoutes — undefined-safe', () => {
    it('graphIdToHash does not throw on undefined/empty', () => {
        expect(() => graphIdToHash(undefined as never)).not.toThrow();
        expect(() => graphIdToHash('' as never)).not.toThrow();
        expect(graphIdToHash(undefined as never)).toBe('#/system-design');
    });
    it('graphIdToScopedHash does not throw on undefined/empty', () => {
        expect(() => graphIdToScopedHash(undefined as never)).not.toThrow();
        expect(() => graphIdToScopedHash('' as never, { meta: { scopedRepo: 'r' } })).not.toThrow();
        expect(graphIdToScopedHash(undefined as never)).toBe('#/system-design');
    });
    it('still maps well-formed ids correctly', () => {
        expect(graphIdToHash('microservice:workspace')).toBe('#/system-design');
        expect(graphIdToHash('feature:service:main')).toBe('#/features/service:main');
    });
});
