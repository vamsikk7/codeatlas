/**
 * #845 — scoped feature drills keep the repo in the URL.
 */
import { describe, it, expect } from 'vitest';
import { graphIdToScopedHash, graphIdToHash, expectedGraphIdForRoute } from './hashRoutes';

describe('expectedGraphIdForRoute (BUG-VERIFY-4 — inverse of graphIdToHash)', () => {
    it('maps workspace-root routes to their graphIds', () => {
        expect(expectedGraphIdForRoute({ route: 'system-design' })).toBe('microservice:workspace');
        expect(expectedGraphIdForRoute({ route: 'features' })).toBe('feature:workspace');
        expect(expectedGraphIdForRoute({ route: 'map' })).toBe('map:workspace');
        expect(expectedGraphIdForRoute({ route: 'health' })).toBe('health:report');
    });
    it('maps scoped feature routes to feature:<param>', () => {
        expect(expectedGraphIdForRoute({ route: 'features', param: 'service:examples' })).toBe('feature:service:examples');
    });
    it('maps specific routes (sequence/file/flow/apis) to their graphIds', () => {
        expect(expectedGraphIdForRoute({ route: 'sequence', param: 'src/a.ts:h' })).toBe('sequence:src/a.ts:h');
        expect(expectedGraphIdForRoute({ route: 'file', param: 'src/a.ts' })).toBe('file:src/a.ts');
        expect(expectedGraphIdForRoute({ route: 'flow', param: 'src/a.ts', param2: 'fn' })).toBe('flow:src/a.ts:fn');
        expect(expectedGraphIdForRoute({ route: 'apis', param: 'cluster:auth' })).toBe('api-list:cluster:auth');
    });
    it('returns null for null route or param-less specific routes', () => {
        expect(expectedGraphIdForRoute(null)).toBeNull();
        expect(expectedGraphIdForRoute({ route: 'sequence' })).toBeNull();
        expect(expectedGraphIdForRoute({ route: 'unknown-route' })).toBeNull();
    });
    it('the cold-load guard case: a #/features tab must NOT match microservice:workspace', () => {
        expect(expectedGraphIdForRoute({ route: 'features' })).not.toBe('microservice:workspace');
        expect(expectedGraphIdForRoute({ route: 'features', param: 'service:examples' })).not.toBe('microservice:workspace');
    });
});

describe('graphIdToScopedHash (#845)', () => {
    it('feature graphs with meta.scopedRepo keep the repo in the hash — even the per-repo feature:workspace key', () => {
        const g = { meta: { scopedRepo: 'aws-node-typescript-rest-api-with-dynamodb' } };
        expect(graphIdToScopedHash('feature:workspace', g))
            .toBe('#/features/aws-node-typescript-rest-api-with-dynamodb');
        expect(graphIdToScopedHash('feature:service:api', g))
            .toBe('#/features/aws-node-typescript-rest-api-with-dynamodb');
    });

    it('unscoped feature graphs keep the legacy mapping', () => {
        expect(graphIdToScopedHash('feature:workspace')).toBe('#/features');
        expect(graphIdToScopedHash('feature:service:api')).toBe('#/features/service:api');
    });

    it('existing scoped routes are unchanged (system-design/map/domain/tour)', () => {
        const g = { meta: { scopedRepo: 'api' } };
        expect(graphIdToScopedHash('microservice:workspace', g)).toBe('#/system-design/api');
        expect(graphIdToScopedHash('map:workspace', g)).toBe('#/map/api');
        expect(graphIdToScopedHash('domain:workspace', g)).toBe('#/domain/api');
        expect(graphIdToScopedHash('tour:workspace', g)).toBe('#/tour/api');
    });

    it('graphIdToHash base mappings hold (regression net for the extraction)', () => {
        expect(graphIdToHash('microservice:workspace')).toBe('#/system-design');
        expect(graphIdToHash('api-list:cluster:auth')).toBe('#/apis/cluster:auth');
        expect(graphIdToHash('sequence:src/a.ts:h')).toBe('#/sequence/src/a.ts:h');
        expect(graphIdToHash('file:src/a.ts')).toBe('#/file/src/a.ts');
        expect(graphIdToHash('flow:src/a.ts:fn')).toBe('#/flow/src/a.ts:fn');
        expect(graphIdToHash('health:report')).toBe('#/health');
        expect(graphIdToHash('tour:abc123')).toBe('#/tour/abc123');
        expect(graphIdToHash('screen-content:s1')).toBe('#/screen/s1');
    });
});
