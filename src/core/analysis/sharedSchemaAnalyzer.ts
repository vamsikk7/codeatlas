/**
 * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — `sharedSchemaAnalyzer`.
 *
 * Same sparse-diff pattern as `sharedExternalAnalyzer`, keyed by
 * `(engine, tableName)` instead of `providerId`. Different engines
 * sharing a table name (`postgresql:users` vs `mongodb:users`) are
 * distinct rows — the engine is part of the primary key.
 */
import type { CrossRepoAnalyzer } from '../sync/crossRepoAnalyzer';
import type { RepoSummary, SummarySchema } from '../sync/repoSummary';
import type { IAggregatorStore } from '../storage/storeInterfaces';

function keyOf(s: { engine: string; tableName: string }): string {
    return `${s.engine}:${s.tableName}`;
}

export const sharedSchemaAnalyzer: CrossRepoAnalyzer = {
    id: 'sharedSchema',

    onSummaryApplied(
        repoId: string,
        newSummary: RepoSummary,
        priorSummary: RepoSummary | undefined,
        store: IAggregatorStore,
    ): void {
        const newByKey = indexByKey(newSummary.schemas);
        const priorByKey = indexByKey(priorSummary?.schemas ?? []);

        const touched = new Set<string>([...newByKey.keys(), ...priorByKey.keys()]);

        const existingByKey = new Map<string, { consumers: ReadonlyArray<string> }>();
        for (const sch of store.listSharedSchemas()) {
            const k = keyOf(sch);
            if (touched.has(k)) existingByKey.set(k, { consumers: sch.consumers });
        }

        for (const k of touched) {
            const inNew = newByKey.get(k);
            const inPrior = priorByKey.get(k);
            const existing = existingByKey.get(k);
            const consumers = new Set<string>(existing?.consumers ?? []);

            if (inNew && !inPrior) {
                consumers.add(repoId);
                store.upsertSharedSchema({
                    engine: inNew.engine,
                    tableName: inNew.tableName,
                    consumers: [...consumers].sort(),
                    diff: null,
                });
            } else if (!inNew && inPrior) {
                consumers.delete(repoId);
                if (consumers.size === 0) {
                    store.removeSharedSchema(inPrior.engine, inPrior.tableName);
                } else {
                    store.upsertSharedSchema({
                        engine: inPrior.engine,
                        tableName: inPrior.tableName,
                        consumers: [...consumers].sort(),
                        diff: null,
                    });
                }
            } else if (inNew && inPrior) {
                consumers.add(repoId);
                store.upsertSharedSchema({
                    engine: inNew.engine,
                    tableName: inNew.tableName,
                    consumers: [...consumers].sort(),
                    diff: null,
                });
            }
        }
    },

    onRepoRemoved(repoId: string, store: IAggregatorStore): void {
        for (const sch of store.listSharedSchemas()) {
            if (!sch.consumers.includes(repoId)) continue;
            const remaining = sch.consumers.filter((c) => c !== repoId);
            if (remaining.length === 0) {
                store.removeSharedSchema(sch.engine, sch.tableName);
            } else {
                store.upsertSharedSchema({ ...sch, consumers: remaining });
            }
        }
    },
};

function indexByKey(schemas: ReadonlyArray<SummarySchema>): Map<string, SummarySchema> {
    const m = new Map<string, SummarySchema>();
    for (const s of schemas) m.set(keyOf(s), s);
    return m;
}
