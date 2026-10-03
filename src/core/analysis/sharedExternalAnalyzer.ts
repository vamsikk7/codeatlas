/**
 * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — `sharedExternalAnalyzer`.
 *
 * Diffs the SDK set between the prior and new summary for ONE repo.
 * For each SDK the repo added → upsert / extend the workspace's
 * `shared_externals` row with this repoId in `consumers_json`. For each
 * SDK the repo removed → drop this repoId from the consumers list (or
 * delete the row if it becomes empty).
 *
 * Sparse update — only the SDKs that changed between prior and current
 * are touched. Other rows are left alone, so a repo's apply doesn't
 * rewrite the entire `shared_externals` table.
 *
 * The `consumers.length >= 2` filter is applied at L1 BUILD time, not
 * here — every consumer (including singletons) is recorded so the data
 * is available for renderers that want the full list.
 */
import type { CrossRepoAnalyzer } from '../sync/crossRepoAnalyzer';
import type { RepoSummary, SummarySdk } from '../sync/repoSummary';
import type { IAggregatorStore } from '../storage/storeInterfaces';

export const sharedExternalAnalyzer: CrossRepoAnalyzer = {
    id: 'sharedExternal',

    onSummaryApplied(
        repoId: string,
        newSummary: RepoSummary,
        priorSummary: RepoSummary | undefined,
        store: IAggregatorStore,
    ): void {
        const newByid = indexBySdkId(newSummary.sdks);
        const priorById = indexBySdkId(priorSummary?.sdks ?? []);

        // Union of all sdkIds across prior + new — these are the only
        // rows we need to touch. Everything else stays.
        const touched = new Set<string>([...newByid.keys(), ...priorById.keys()]);

        // Snapshot existing rows in one read so we don't N+1.
        const existingByid = new Map<string, { name: string; category: string; consumers: ReadonlyArray<string> }>();
        for (const ext of store.listSharedExternals()) {
            if (touched.has(ext.providerId)) {
                existingByid.set(ext.providerId, {
                    name: ext.name,
                    category: ext.category,
                    consumers: ext.consumers,
                });
            }
        }

        for (const sdkId of touched) {
            const inNew = newByid.get(sdkId);
            const inPrior = priorById.get(sdkId);
            const existing = existingByid.get(sdkId);

            const priorConsumers = new Set<string>(existing?.consumers ?? []);

            if (inNew && !inPrior) {
                // Repo just started consuming this SDK.
                priorConsumers.add(repoId);
                store.upsertSharedExternal({
                    providerId: sdkId,
                    name: inNew.name,
                    category: inNew.category,
                    consumers: [...priorConsumers].sort(),
                    diff: null,
                });
            } else if (!inNew && inPrior) {
                // Repo stopped consuming this SDK.
                priorConsumers.delete(repoId);
                if (priorConsumers.size === 0) {
                    store.removeSharedExternal(sdkId);
                } else if (existing) {
                    store.upsertSharedExternal({
                        providerId: sdkId,
                        name: existing.name,
                        category: existing.category,
                        consumers: [...priorConsumers].sort(),
                        diff: null,
                    });
                }
            } else if (inNew && inPrior) {
                // Both consume — still ensure this repoId is recorded
                // (handles the very-first apply where prior summary exists
                // but the row doesn't yet) and refresh name/category.
                priorConsumers.add(repoId);
                store.upsertSharedExternal({
                    providerId: sdkId,
                    name: inNew.name,
                    category: inNew.category,
                    consumers: [...priorConsumers].sort(),
                    diff: null,
                });
            }
        }
    },

    onRepoRemoved(repoId: string, store: IAggregatorStore): void {
        for (const ext of store.listSharedExternals()) {
            if (!ext.consumers.includes(repoId)) continue;
            const remaining = ext.consumers.filter((c) => c !== repoId);
            if (remaining.length === 0) {
                store.removeSharedExternal(ext.providerId);
            } else {
                store.upsertSharedExternal({ ...ext, consumers: remaining });
            }
        }
    },
};

function indexBySdkId(sdks: ReadonlyArray<SummarySdk>): Map<string, SummarySdk> {
    const m = new Map<string, SummarySdk>();
    for (const s of sdks) m.set(s.sdkId, s);
    return m;
}
