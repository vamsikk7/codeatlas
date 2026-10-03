import { describe, it, expect } from 'vitest';
import { resolveFeatureRenderDefault, DENSE_FEATURE_CLUSTER_THRESHOLD } from '../featureRender';

describe('resolveFeatureRenderDefault (BUG-POLAR-16 — dense feature graphs open in List)', () => {
    it('forces List on initial render of a dense feature graph even if map was persisted', () => {
        expect(resolveFeatureRenderDefault('map', 137)).toBe('list');
    });

    it('honours a persisted map for a small, readable graph', () => {
        expect(resolveFeatureRenderDefault('map', 12)).toBe('map');
    });

    it('never overrides a persisted list preference', () => {
        expect(resolveFeatureRenderDefault('list', 137)).toBe('list');
        expect(resolveFeatureRenderDefault('list', 5)).toBe('list');
    });

    it('uses the exported threshold as the boundary (inclusive stays map)', () => {
        expect(resolveFeatureRenderDefault('map', DENSE_FEATURE_CLUSTER_THRESHOLD)).toBe('map');
        expect(resolveFeatureRenderDefault('map', DENSE_FEATURE_CLUSTER_THRESHOLD + 1)).toBe('list');
    });
});
