/**
 * tier3.ts — Tier 3 advanced MCP features:
 *   T3.13 — state.db subscription / push notifications via fs.watch
 *   T3.14 — OpenAPI / JSON-Schema spec generator for all MCP tools
 *   T3.15 — cross-workspace structural comparison
 *   T3.16 — extractive summarisation (deterministic, no LLM)
 *
 * Per the user's directive "this MCP step should not require AI", #16 ships
 * as an extractive summariser (token-bounded brief) — not an LLM call. An
 * LLM-backed variant can be layered on later behind explicit consent.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Snapshot } from '../core/graph/graphTypes';
import { SnapshotStore } from '../core/storage/snapshotStore';
import { listEntryPoints, type EntryPointSummary } from './contextPack';

// ─── Tier 3.13: state.db file-watch subscription ───────────────────────────

export type SnapshotChangeListener = (event: { workspaceRoot: string; mtime: number }) => void;

export class SnapshotWatcher {
    private dbPath: string;
    private polling = false;
    private listeners = new Set<SnapshotChangeListener>();
    private debounceTimer: NodeJS.Timeout | null = null;
    constructor(private workspaceRoot: string) {
        this.dbPath = path.join(this.workspaceRoot, '.codeatlas', 'state.db');
    }

    start(): boolean {
        if (!fs.existsSync(this.dbPath)) return false;
        try {
            // fs.watchFile (polling) is more reliable on macOS than fs.watch
            // for tightly-coupled FSEvent semantics on small files. 100ms
            // polling interval is cheap and well below the debounce window.
            fs.watchFile(this.dbPath, { interval: 100, persistent: false }, (curr, prev) => {
                if (curr.mtimeMs !== prev.mtimeMs) this.scheduleNotify();
            });
            this.polling = true;
            return true;
        } catch {
            return false;
        }
    }

    stop(): void {
        if (this.polling) { fs.unwatchFile(this.dbPath); this.polling = false; }
        if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
        this.listeners.clear();
    }

    subscribe(listener: SnapshotChangeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Coalesce rapid filesystem events (SQLite WAL writes fire 2-3 times per
     *  save) into one notification per ~250ms. */
    private scheduleNotify(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            const evt = { workspaceRoot: this.workspaceRoot, mtime: Date.now() };
            for (const l of this.listeners) {
                try { l(evt); } catch { /* swallow listener errors */ }
            }
        }, 250);
    }
}

// ─── Tier 3.14: tool descriptor → OpenAPI / JSON Schema export ─────────────

export interface ToolDescriptor {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

/**
 * Convert MCP tool descriptors to:
 *   - OpenAPI 3.1 paths (POST /tools/{name} with the inputSchema as the body)
 *   - Anthropic / OpenAI function-calling tool list
 *
 * Useful when an LLM client doesn't speak MCP but does speak OpenAPI / native
 * function calling (custom GPTs, OpenAI assistants, Anthropic tool use).
 */
export function exportOpenApiSpec(tools: ToolDescriptor[], baseUrl = 'codeatlas://mcp'): Record<string, unknown> {
    const paths: Record<string, unknown> = {};
    for (const t of tools) {
        paths[`/tools/${t.name}`] = {
            post: {
                operationId: t.name,
                summary: t.description,
                requestBody: {
                    required: !!(t.inputSchema as any)?.required?.length,
                    content: {
                        'application/json': { schema: t.inputSchema },
                    },
                },
                responses: {
                    '200': {
                        description: 'Structured tool result',
                        content: { 'application/json': { schema: { type: 'object' } } },
                    },
                },
            },
        };
    }
    return {
        openapi: '3.1.0',
        info: { title: 'CodeAtlas MCP', version: '4.2.0', description: 'Snapshot query + context-pack tools for LLM use.' },
        servers: [{ url: baseUrl }],
        paths,
    };
}

export function exportFunctionCallingSpec(tools: ToolDescriptor[]): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
    }));
}

// ─── Tier 3.15: cross-workspace comparison ─────────────────────────────────

export interface WorkspaceCompareResult {
    leftWorkspace: string;
    rightWorkspace: string;
    onlyInLeft: EntryPointSummary[];
    onlyInRight: EntryPointSummary[];
    shared: number;
    leftServices: string[];
    rightServices: string[];
    sharedServices: string[];
    leftClusters: string[];
    rightClusters: string[];
    sharedClusters: string[];
}

export async function compareWorkspaces(leftRoot: string, rightRoot: string): Promise<WorkspaceCompareResult> {
    const open = async (root: string) => {
        const s = new SnapshotStore(root);
        await s.load();
        return s.getWorking();
    };
    const [left, right] = await Promise.all([open(leftRoot), open(rightRoot)]);

    const leftEps = listEntryPoints(left);
    const rightEps = listEntryPoints(right);
    const key = (ep: EntryPointSummary) => `${ep.method} ${ep.route}`;
    const leftKeys = new Set(leftEps.map(key));
    const rightKeys = new Set(rightEps.map(key));

    const onlyInLeft = leftEps.filter((ep) => !rightKeys.has(key(ep)));
    const onlyInRight = rightEps.filter((ep) => !leftKeys.has(key(ep)));
    const sharedCount = leftEps.length + rightEps.length - onlyInLeft.length - onlyInRight.length;

    const leftServices = Object.values(left.services ?? {}).map((s) => s.name);
    const rightServices = Object.values(right.services ?? {}).map((s) => s.name);
    const leftClusters = Object.values(left.clusters ?? {}).map((c) => c.name ?? c.label);
    const rightClusters = Object.values(right.clusters ?? {}).map((c) => c.name ?? c.label);

    return {
        leftWorkspace: leftRoot,
        rightWorkspace: rightRoot,
        onlyInLeft,
        onlyInRight,
        shared: Math.floor(sharedCount / 2),
        leftServices, rightServices,
        sharedServices: leftServices.filter((s) => rightServices.includes(s)),
        leftClusters, rightClusters,
        sharedClusters: leftClusters.filter((c) => rightClusters.includes(c)),
    };
}

// ─── Tier 3.16: extractive summarisation (deterministic, no LLM) ───────────

export interface BriefSummary {
    title: string;
    bullets: string[];
    /** Approx token count of the produced summary. */
    approximateTokens: number;
}

/**
 * Compress a heavy MCP payload into a 3-7 bullet brief. Pure extractive logic
 * — picks the highest-signal facts from the input shape. No LLM call.
 *
 * Tuned for:
 *   - EntryPointPack: "what does this route do?" → top callsInto + auth + diff
 *   - DiffSummary: "what changed?" → counts + sample names
 *   - ImpactOfChange: "what's affected?" → entry-point list with deltas
 */
export function summarisePayload(input: unknown, maxBullets = 6): BriefSummary {
    const obj = input as any;
    const bullets: string[] = [];
    let title = 'Summary';

    if (obj?.entryPoint && obj?.callsInto !== undefined) {
        const ep = obj.entryPoint;
        title = `${ep.method} ${ep.route}`;
        if (ep.auth) bullets.push(`Auth: ${ep.auth}${ep.middlewares?.length ? ` (${ep.middlewares.join(', ')})` : ''}`);
        if (ep.clusterLabel) bullets.push(`Cluster: ${ep.clusterLabel}${ep.serviceId ? ` · ${ep.serviceId}` : ''}`);
        if (obj.callsInto.length > 0) {
            const sample = obj.callsInto.slice(0, 4).map((c: any) => c.participant).join(', ');
            bullets.push(`Calls into: ${sample}${obj.callsInto.length > 4 ? ` (+${obj.callsInto.length - 4} more)` : ''}`);
        }
        if (obj.flowNodes?.length > 0) bullets.push(`Flow: ${obj.flowNodes.length} nodes`);
        if (obj.siblings?.length > 0) bullets.push(`Siblings in cluster: ${obj.siblings.length}`);
        if (obj.diff) {
            const mods = obj.diff.modifiedFunctions?.length ?? 0;
            const msgs = obj.diff.modifiedMessages?.length ?? 0;
            bullets.push(`Diff: ${mods} fn, ${msgs} msgs, ${obj.diff.modifiedFlowNodes ?? 0} flow nodes modified`);
        }
    } else if (Array.isArray(obj?.changedFiles)) {
        title = 'Diff Summary';
        bullets.push(`${obj.changedFiles.length} file${obj.changedFiles.length === 1 ? '' : 's'} changed`);
        if (obj.addedEntryPoints?.length > 0) bullets.push(`${obj.addedEntryPoints.length} entry point${obj.addedEntryPoints.length === 1 ? '' : 's'} added`);
        if (obj.deletedEntryPoints?.length > 0) bullets.push(`${obj.deletedEntryPoints.length} deleted`);
        if (obj.modifiedEntryPoints?.length > 0) bullets.push(`${obj.modifiedEntryPoints.length} modified`);
        if (obj.modifiedClusters?.length > 0) bullets.push(`Clusters touched: ${obj.modifiedClusters.map((c: any) => c.label).join(', ')}`);
        if (obj.changedFiles.length > 0) {
            const sample = obj.changedFiles.slice(0, 3).join(', ');
            bullets.push(`Sample files: ${sample}${obj.changedFiles.length > 3 ? '…' : ''}`);
        }
    } else if (Array.isArray(obj?.entryPoints)) {
        title = 'Impact Of Change';
        bullets.push(`${obj.entryPoints.length} entry point${obj.entryPoints.length === 1 ? '' : 's'} reach this code`);
        const byMethod = obj.entryPoints.reduce((acc: Record<string, number>, ep: any) => {
            acc[ep.method] = (acc[ep.method] ?? 0) + 1; return acc;
        }, {});
        bullets.push(`Methods: ${Object.entries(byMethod).map(([m, n]) => `${n} ${m}`).join(', ')}`);
        const auth = obj.entryPoints.filter((ep: any) => ep.auth === 'required').length;
        if (auth > 0) bullets.push(`Auth-protected: ${auth}/${obj.entryPoints.length}`);
        const sample = obj.entryPoints.slice(0, 3).map((ep: any) => `${ep.method} ${ep.route}`).join(', ');
        if (sample) bullets.push(`Sample: ${sample}`);
    } else if (obj?.deadFunctions !== undefined) {
        title = 'Health Report';
        bullets.push(`Dead functions: ${obj.deadFunctions.length}`);
        bullets.push(`God files: ${obj.godFiles?.length ?? 0}`);
        bullets.push(`High-coupling files: ${obj.highCouplingFiles?.length ?? 0}`);
        bullets.push(`Cyclic dependencies: ${obj.cyclicDependencies?.length ?? 0}`);
        bullets.push(`Orphaned clusters: ${obj.orphanedClusters?.length ?? 0}`);
    } else {
        // Fallback: report shape only.
        bullets.push(`Object with keys: ${Object.keys(obj ?? {}).slice(0, 5).join(', ')}`);
    }

    const truncated = bullets.slice(0, maxBullets);
    const text = `${title}\n${truncated.map((b) => `• ${b}`).join('\n')}`;
    return { title, bullets: truncated, approximateTokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 4) };
}

/** Used by Snapshot type tests — silence unused-import warning. */
export type _SnapshotUsed = Snapshot;
