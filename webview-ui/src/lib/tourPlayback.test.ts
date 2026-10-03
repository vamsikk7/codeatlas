import { describe, it, expect } from 'vitest';
import { shouldStopTourOnNavigate } from './tourPlayback';

describe('shouldStopTourOnNavigate (BUG-EXPLORE-6)', () => {
    it('does NOT stop when no tour is playing', () => {
        expect(shouldStopTourOnNavigate(null, 'microservice:workspace')).toBe(false);
    });
    it('does NOT stop when the arriving graph is the tour\'s own pending advance', () => {
        expect(shouldStopTourOnNavigate({ pendingGraphId: 'sequence:a.ts:foo' }, 'sequence:a.ts:foo')).toBe(false);
    });
    it('STOPS when the user navigates to a different graph than the tour requested', () => {
        expect(shouldStopTourOnNavigate({ pendingGraphId: 'sequence:a.ts:foo' }, 'microservice:workspace')).toBe(true);
    });
    it('STOPS when the tour is mid-step (no pending nav) and the user navigates', () => {
        expect(shouldStopTourOnNavigate({ pendingGraphId: null }, 'feature:workspace')).toBe(true);
    });
});
