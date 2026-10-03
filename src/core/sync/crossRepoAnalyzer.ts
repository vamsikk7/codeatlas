/**
 * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — `CrossRepoAnalyzer` interface + registry.
 *
 * The pluggable seam for cross-repo analysis. Each registered analyzer
 * runs once per `aggregator.applySummary(repoId, summary)` call, with the
 * current + prior summary for that repo. Analyzers perform sparse updates
 * on the aggregator's cross-repo tables — only the keys this repo touched.
 *
 * Today three analyzers ship (shared externals, shared schemas, cross-repo
 * HTTP edges). Future phases (queues, S3 buckets, event-bus topics) plug
 * in new analyzers without touching the aggregator core or the existing
 * analyzers.
 *
 * Analyzer ordering: insertion order. Today's three are independent so
 * order doesn't matter, but the registry preserves it so future plugs
 * that DO depend on prior analyzer output can declare their position.
 */
import type { IAggregatorStore } from '../storage/storeInterfaces';
import type { RepoSummary } from './repoSummary';

export interface CrossRepoAnalyzer {
    /** Stable identifier — used for logging + introspection. */
    readonly id: string;

    /**
     * Fires once per repo summary apply. The prior summary is `undefined`
     * on the FIRST apply for this repo (e.g. after a fresh init); analyzers
     * use it to compute deltas vs the new summary and update cross-repo
     * tables sparsely.
     *
     * Implementations MUST be idempotent — calling with `prior === current`
     * (same content) must be a no-op.
     *
     * Implementations MUST handle their own errors. The registry runs
     * each analyzer in a try/catch wrapper so one throw doesn't poison
     * the rest, but a robust analyzer logs + degrades gracefully.
     */
    onSummaryApplied(
        repoId: string,
        newSummary: RepoSummary,
        priorSummary: RepoSummary | undefined,
        store: IAggregatorStore,
    ): void;

    /**
     * Optional — fires when a repo is removed from the workspace.
     * Cleans up all consumer references in the analyzer's tables.
     */
    onRepoRemoved?(repoId: string, store: IAggregatorStore): void;
}

export class CrossRepoAnalyzerRegistry {
    private analyzers: CrossRepoAnalyzer[] = [];

    register(analyzer: CrossRepoAnalyzer): void {
        const ix = this.analyzers.findIndex((a) => a.id === analyzer.id);
        if (ix >= 0) {
            // Replace — supports late re-registration for tests.
            this.analyzers[ix] = analyzer;
        } else {
            this.analyzers.push(analyzer);
        }
    }

    unregister(id: string): void {
        const ix = this.analyzers.findIndex((a) => a.id === id);
        if (ix >= 0) this.analyzers.splice(ix, 1);
    }

    list(): ReadonlyArray<CrossRepoAnalyzer> {
        return [...this.analyzers];
    }

    /**
     * Run every registered analyzer once. Errors in one analyzer are caught
     * + logged via the optional `log` callback — the chain continues.
     * Returns the count of analyzers that ran successfully.
     */
    runAll(
        repoId: string,
        newSummary: RepoSummary,
        priorSummary: RepoSummary | undefined,
        store: IAggregatorStore,
        log?: (msg: string) => void,
    ): number {
        let ok = 0;
        for (const a of this.analyzers) {
            try {
                a.onSummaryApplied(repoId, newSummary, priorSummary, store);
                ok += 1;
            } catch (err: any) {
                if (log) log(`[CrossRepoAnalyzer:${a.id}] failed on ${repoId}: ${err?.message ?? err}`);
            }
        }
        return ok;
    }

    runRepoRemoved(
        repoId: string,
        store: IAggregatorStore,
        log?: (msg: string) => void,
    ): void {
        for (const a of this.analyzers) {
            if (!a.onRepoRemoved) continue;
            try {
                a.onRepoRemoved(repoId, store);
            } catch (err: any) {
                if (log) log(`[CrossRepoAnalyzer:${a.id}] removal cleanup failed for ${repoId}: ${err?.message ?? err}`);
            }
        }
    }
}

/**
 * Process-wide default registry. Phase C's three analyzers register
 * themselves at module load via `defaultCrossRepoRegistry.register(...)`
 * in their own files. Tests construct fresh registries via
 * `new CrossRepoAnalyzerRegistry()` to isolate.
 */
export const defaultCrossRepoRegistry = new CrossRepoAnalyzerRegistry();
