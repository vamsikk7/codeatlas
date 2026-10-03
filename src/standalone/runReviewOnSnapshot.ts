/**
 * runReviewOnSnapshot.ts — #954 / ADR-044.
 *
 * The MCP `run_review` tool runs the full review engine over the already-indexed
 * snapshot. The engine (perEntryReviewer / projectLevelReviewer) uses zod (#704),
 * and bundling that into `mcp-server.js` reorders zod's init and crashes the MCP
 * SDK at load. So — exactly like `reviewPrCli.ts` — this is built as its OWN esbuild
 * bundle (`dist/run-review.js`, no MCP SDK inside) and loaded by the tool handler via
 * a runtime `require(__dirname + '/run-review.js')`. The live SnapshotStore is passed
 * in (same process), so there's no re-index / checkout dance.
 */
import { runFullReview, type AiReviewDeps } from './aiReview';
import { createSettingsResolver } from './settings';
import { createSecretsStore } from './secrets';
import type { SnapshotStore } from '../core/storage/snapshotStore';
import type { AiReviewFinding } from '../core/graph/graphTypes';

export interface RunReviewOnSnapshotArgs {
    store: SnapshotStore;
    workspaceRoot?: string;
    scope?: 'all' | 'changed';
}

export interface RunReviewOnSnapshotResult {
    ok: boolean;
    error?: string;
    scope: 'all' | 'changed';
    findingsCount: number;
    findings: AiReviewFinding[];
}

/**
 * Run the full review engine over `args.store`'s current snapshot and return the
 * finalized (dedup + FP-filtered, via runFullReview's #948–#953 finalization)
 * open findings. The LLM (model + provider + key) is whatever the USER configured
 * for this workspace — resolved by createSettingsResolver/createSecretsStore from
 * the standalone config file + OS keychain + env (the same resolver the extension
 * settings UI and MCP setup write to). No key is passed in. On a missing config /
 * no changes the engine surfaces an error/warning toast, reflected in `ok`/`error`.
 */
export async function runReviewOnSnapshot(args: RunReviewOnSnapshotArgs): Promise<RunReviewOnSnapshotResult> {
    const { store, workspaceRoot } = args;
    const scope: 'all' | 'changed' = args.scope === 'all' ? 'all' : 'changed';

    const messages: { type?: string; level?: string; text?: string }[] = [];
    const wsBridge = {
        broadcast: (m: { type?: string; level?: string; text?: string }) => messages.push(m),
        sendTo: () => { },
        hasClients: () => false,
    } as unknown as AiReviewDeps['wsBridge'];

    const deps: AiReviewDeps = {
        snapshotStore: store,
        wsBridge,
        settings: createSettingsResolver({ workspaceRoot: workspaceRoot || process.cwd() }),
        secrets: createSecretsStore({}),
        log: (m: string) => process.stderr.write(`[run_review] ${m}\n`),
        workspaceRoot,
    };

    await runFullReview(deps, { kind: scope });

    const errToast = messages.find((m) => m?.type === 'clientToast' && m.level === 'error');
    const findings = store.listAiReviewFindings({ status: 'open' } as never) as AiReviewFinding[];
    return { ok: !errToast, error: errToast?.text, scope, findingsCount: findings.length, findings };
}
