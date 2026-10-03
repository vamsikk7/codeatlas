/**
 * UX-67c (2026-06-09) — `ConsumedApiHashTracker`
 *
 * Cross-repo diff propagation hinge. Each "producer" API (an endpoint
 * exposed by one sub-repo) gets a stable surface hash (method, route,
 * handler-name, response shape). Consumer-side graphs in OTHER sub-
 * repos record the hash they were built against. When the producer
 * hash changes, the tracker surfaces the set of stale consumers so the
 * cross-repo cascade can re-annotate L1 "consumes" edges and L3
 * sequence participants as `~ modified` on the consumer side.
 *
 * This is the in-memory storage + diff layer. Wiring into the
 * `applySummary` flow is the follow-up.
 *
 * Tests at `__tests__/consumedApiHashTracker.test.ts`.
 */
export class ConsumedApiHashTracker {
    /** Producer-side: latest hash per apiId. */
    private producerHash: Map<string, string> = new Map();
    /** Consumer-side: { apiId → { consumerId → recorded hash } }. */
    private consumers: Map<string, Map<string, string>> = new Map();

    /** Record that the producer of `apiId` now exposes `hash`. */
    recordProducerHash(apiId: string, hash: string): void {
        this.producerHash.set(apiId, hash);
    }

    /** Record that `consumerId` consumed `apiId` at producer-hash `hash`. */
    recordConsumer(apiId: string, consumerId: string, hash: string): void {
        let bucket = this.consumers.get(apiId);
        if (!bucket) {
            bucket = new Map();
            this.consumers.set(apiId, bucket);
        }
        bucket.set(consumerId, hash);
    }

    /**
     * True if `recordedHash` is older than the producer's latest hash.
     * False when the API was never recorded, or the hashes match.
     */
    isStale(apiId: string, recordedHash: string): boolean {
        const latest = this.producerHash.get(apiId);
        if (latest === undefined) return false;
        return latest !== recordedHash;
    }

    /** Consumer ids whose recorded hash trails the latest producer hash. */
    getStaleConsumers(apiId: string): string[] {
        const latest = this.producerHash.get(apiId);
        if (latest === undefined) return [];
        const bucket = this.consumers.get(apiId);
        if (!bucket) return [];
        const stale: string[] = [];
        for (const [cid, h] of bucket.entries()) {
            if (h !== latest) stale.push(cid);
        }
        return stale;
    }

    /** Every apiId with at least one stale consumer. */
    listStaleApis(): string[] {
        const out: string[] = [];
        for (const [apiId, bucket] of this.consumers.entries()) {
            const latest = this.producerHash.get(apiId);
            if (latest === undefined) continue;
            for (const h of bucket.values()) {
                if (h !== latest) { out.push(apiId); break; }
            }
        }
        return out;
    }

    /** Drop all state for one apiId. */
    clear(apiId: string): void {
        this.producerHash.delete(apiId);
        this.consumers.delete(apiId);
    }

    /** Drop every entry. */
    clearAll(): void {
        this.producerHash.clear();
        this.consumers.clear();
    }
}
