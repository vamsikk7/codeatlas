/**
 * apiTesting/buildFromApiRecord.ts — Issue #601 Phase 1.
 *
 * Transforms the workspace's `Snapshot.apiIndex` into the
 * `ApiTestingPayload` shape the webview consumes. One endpoint per
 * `ApiRecord`. Collections group endpoints by L2a cluster — falling
 * back to the file path's basename when no cluster matches.
 *
 * The build is pure (data-in / data-out). Cost is bounded by
 * `services × clusters × apis` which is small in practice (<1k
 * endpoints in even the largest fixtures we test against).
 */

import type { Snapshot, ApiRecord, FeatureCluster } from '../graph/graphTypes';
import type { ApiTestingPayload, ApiTestingEndpoint, ApiTestingCollection } from './types';

export function buildApiTestingPayload(snapshot: Snapshot): ApiTestingPayload {
    const apis = Object.values(snapshot.apiIndex ?? {});
    const clusters = Object.values(snapshot.clusters ?? {}) as FeatureCluster[];

    // Build a fast `filePath → clusterId` index from each cluster's
    // member files. Clusters with `files: []` (e.g. infra-only) just
    // don't contribute mappings, so unmatched APIs fall to the "Other"
    // bucket below.
    const fileToCluster = new Map<string, FeatureCluster>();
    for (const cluster of clusters) {
        for (const fp of cluster.files ?? []) {
            fileToCluster.set(fp, cluster);
        }
    }

    const grouped = new Map<string, ApiTestingCollection>();
    for (const api of apis) {
        const cluster = fileToCluster.get(api.filePath);
        const collectionId = cluster?.id ?? 'collection:other';
        const collectionLabel = cluster?.name ?? cluster?.id ?? 'Other';
        if (!grouped.has(collectionId)) {
            grouped.set(collectionId, {
                id: collectionId,
                label: collectionLabel,
                source: 'l2a-cluster',
                endpoints: [],
            });
        }
        grouped.get(collectionId)!.endpoints.push(toEndpoint(api));
    }

    // Sort each collection's endpoints by `method` then `route` so the
    // tree is stable across rebuilds.
    for (const c of grouped.values()) {
        c.endpoints.sort((a, b) =>
            (a.method + a.route).localeCompare(b.method + b.route, undefined, { sensitivity: 'base' }),
        );
    }

    // Collections themselves sort by endpoint-count DESC, then label
    // for ties. "Other" always lands last regardless of count to avoid
    // overshadowing the structured groups.
    const collections = [...grouped.values()].sort((a, b) => {
        if (a.id === 'collection:other') return 1;
        if (b.id === 'collection:other') return -1;
        if (b.endpoints.length !== a.endpoints.length) return b.endpoints.length - a.endpoints.length;
        return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });

    return {
        totalEndpoints: apis.length,
        collections,
    };
}

export function toEndpoint(api: ApiRecord): ApiTestingEndpoint {
    return {
        id: api.apiId,
        method: api.method,
        route: api.route,
        handlerName: api.handlerName,
        filePath: api.filePath,
        auth: api.meta?.auth,
        webhook: api.meta?.webhook,
        webhookProvider: api.meta?.webhookProvider,
        pathParams: api.meta?.pathParams,
        queryParams: api.meta?.queryParams,
        requestSchema: api.meta?.requestSchema,
        responseSchema: api.meta?.responseSchema,
        middlewares: api.meta?.middlewares,
    };
}
