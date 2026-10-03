/**
 * UX-67c (2026-06-09) — `ConsumedApiHashTracker`
 *
 * Cross-repo diff propagation hinge. Today the per-repo cascade flags
 * the OWNING repo's API as `modified`, but consumer repos' graphs
 * (sequence diagrams that call that API, L1 "consumes" edges) still
 * render the participant as `unchanged`. The tracker stores a stable
 * hash of each producer-side API's salient surface (method, route,
 * handler-name, response shape) and exposes a `recordProducerHash` /
 * `getStaleConsumers` API so the workspace cascade can surface a
 * "consumers stale" set the SPA / AI Review can act on.
 *
 * This iteration is the storage + diff layer only. Wiring into the
 * cross-repo summary path is UX-67c follow-up.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ConsumedApiHashTracker } from '../consumedApiHashTracker';

describe('ConsumedApiHashTracker', () => {
    let t: ConsumedApiHashTracker;

    beforeEach(() => { t = new ConsumedApiHashTracker(); });

    describe('recordProducerHash + isStale', () => {
        it('returns false for an API never recorded', () => {
            expect(t.isStale('apiX', 'h1')).toBe(false);
        });

        it('returns false when the consumer-side hash matches the latest producer hash', () => {
            t.recordProducerHash('apiA', 'h1');
            expect(t.isStale('apiA', 'h1')).toBe(false);
        });

        it('returns true when the consumer-side hash is older than the latest producer hash', () => {
            t.recordProducerHash('apiA', 'h1');
            t.recordProducerHash('apiA', 'h2');
            expect(t.isStale('apiA', 'h1')).toBe(true);
        });

        it('returns false when the consumer caught up to the latest producer hash', () => {
            t.recordProducerHash('apiA', 'h1');
            t.recordProducerHash('apiA', 'h2');
            expect(t.isStale('apiA', 'h2')).toBe(false);
        });
    });

    describe('recordConsumer + getStaleConsumers', () => {
        it('returns no stale consumers when nothing has been recorded', () => {
            expect(t.getStaleConsumers('apiA')).toEqual([]);
        });

        it('returns no stale consumers when consumer hash matches producer hash', () => {
            t.recordProducerHash('apiA', 'h1');
            t.recordConsumer('apiA', 'consumer-svc', 'h1');
            expect(t.getStaleConsumers('apiA')).toEqual([]);
        });

        it('returns the consumer ids whose recorded hash is older than producer', () => {
            t.recordProducerHash('apiA', 'h1');
            t.recordConsumer('apiA', 'consumer-1', 'h1');
            t.recordConsumer('apiA', 'consumer-2', 'h1');
            t.recordProducerHash('apiA', 'h2');
            const stale = t.getStaleConsumers('apiA').sort();
            expect(stale).toEqual(['consumer-1', 'consumer-2']);
        });

        it('a consumer that catches up is no longer stale', () => {
            t.recordProducerHash('apiA', 'h1');
            t.recordConsumer('apiA', 'consumer-1', 'h1');
            t.recordProducerHash('apiA', 'h2');
            expect(t.getStaleConsumers('apiA')).toEqual(['consumer-1']);
            t.recordConsumer('apiA', 'consumer-1', 'h2');
            expect(t.getStaleConsumers('apiA')).toEqual([]);
        });
    });

    describe('listStaleApis', () => {
        it('returns every apiId with at least one stale consumer', () => {
            t.recordProducerHash('apiA', 'h1');
            t.recordConsumer('apiA', 'c1', 'h1');
            t.recordProducerHash('apiB', 'h1');
            t.recordConsumer('apiB', 'c2', 'h1');
            t.recordProducerHash('apiA', 'h2'); // apiA c1 now stale
            const stale = t.listStaleApis();
            expect(stale.sort()).toEqual(['apiA']);
        });

        it('excludes APIs whose producer hash never changed', () => {
            t.recordProducerHash('apiA', 'h1');
            t.recordConsumer('apiA', 'c1', 'h1');
            expect(t.listStaleApis()).toEqual([]);
        });
    });

    describe('clear', () => {
        it('clear(apiId) removes one API and its consumers', () => {
            t.recordProducerHash('apiA', 'h1');
            t.recordConsumer('apiA', 'c1', 'h1');
            t.recordProducerHash('apiB', 'h1');
            t.recordConsumer('apiB', 'c2', 'h1');
            t.clear('apiA');
            expect(t.getStaleConsumers('apiA')).toEqual([]);
            expect(t.isStale('apiA', 'anything')).toBe(false);
            // apiB intact
            t.recordProducerHash('apiB', 'h2');
            expect(t.getStaleConsumers('apiB')).toEqual(['c2']);
        });

        it('clearAll wipes everything', () => {
            t.recordProducerHash('apiA', 'h1');
            t.recordConsumer('apiA', 'c1', 'h1');
            t.clearAll();
            expect(t.listStaleApis()).toEqual([]);
        });
    });
});
