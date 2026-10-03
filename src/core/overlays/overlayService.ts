/**
 * overlayService.ts — #826 transport glue (2026-06-11).
 *
 * One service both transports instantiate (extension handlers + the
 * standalone messageHandler + MCP tools) so panel state, fetch, join and
 * payload shapes stay identical by construction.
 */

import type { DiagramGraph, Snapshot } from '../graph/graphTypes';
import { OverlayRegistry } from './overlayRegistry';
import { registerBuiltinOverlays } from './adapters';
import { createFileOverlayPersistence } from './overlayStateStore';
import { joinOverlay } from './overlayJoin';
import type { OverlayDataPoint } from './overlayTypes';

export interface OverlayStateMessage {
    type: 'overlayState';
    overlays: Array<{
        id: string;
        displayName: string;
        enabled: boolean;
        paint: string;
        emptyHint?: string;
        /** True for descriptor-only rows whose render path is still bespoke (diff, comments). */
        renderManaged: boolean;
    }>;
}

export interface OverlayDataMessage {
    type: 'overlayData';
    overlayId: string;
    graphId: string;
    /** nodeId → { value, severity, pointCount } */
    values: Record<string, { value: number; severity?: string; pointCount: number }>;
    unresolvedCount: number;
    totalPoints: number;
    empty: boolean;
    emptyHint?: string;
}

/** Overlays whose painting is still owned by the legacy pipelines (R6). */
const RENDER_MANAGED = new Set(['diff', 'comments']);

export interface OverlayServiceDeps {
    workspaceRoot: string;
    storageDirName?: string;
    getWorking(): Snapshot;
    /** #911 — baseline for diff-style adapters (regression-scope). Optional so
     *  callers that only run pure-local overlays don't have to wire it. */
    getBaseline?(): Snapshot;
    getFileContent?(filePath: string): string | undefined;
    log?(msg: string): void;
}

export class OverlayService {
    readonly registry = new OverlayRegistry();
    private readonly log: (msg: string) => void;

    constructor(private readonly deps: OverlayServiceDeps) {
        this.log = deps.log ?? (() => { /* silent */ });
        registerBuiltinOverlays(this.registry);
        this.registry.attachPersistence(
            createFileOverlayPersistence(deps.workspaceRoot, deps.storageDirName, this.log),
        );
    }

    stateMessage(): OverlayStateMessage {
        return {
            type: 'overlayState',
            overlays: this.registry.list().map(({ descriptor, enabled }) => ({
                id: descriptor.id,
                displayName: descriptor.displayName,
                enabled,
                paint: descriptor.paint,
                emptyHint: descriptor.emptyHint,
                renderManaged: RENDER_MANAGED.has(descriptor.id),
            })),
        };
    }

    setEnabled(id: string, enabled: boolean): OverlayStateMessage {
        this.registry.setEnabled(id, enabled);
        return this.stateMessage();
    }

    /** Fetch + join one overlay against a served graph. */
    async dataMessage(overlayId: string, graphId: string, graph: DiagramGraph | undefined): Promise<OverlayDataMessage> {
        const descriptor = this.registry.get(overlayId);
        const base: OverlayDataMessage = {
            type: 'overlayData', overlayId, graphId,
            values: {}, unresolvedCount: 0, totalPoints: 0, empty: true,
            emptyHint: descriptor?.emptyHint,
        };
        if (!descriptor || !graph) return base;
        let points: OverlayDataPoint[] = [];
        try {
            points = await descriptor.fetch({
                workspaceRoot: this.deps.workspaceRoot,
                working: this.deps.getWorking(),
                baseline: this.deps.getBaseline?.(),
                getFileContent: this.deps.getFileContent,
            });
        } catch (err: any) {
            this.log(`[overlay:${overlayId}] fetch failed: ${err?.message ?? err}`);
            return base;
        }
        if (points.length === 0) return base;
        const joined = joinOverlay(descriptor, points, graph, this.deps.getWorking());
        const values: OverlayDataMessage['values'] = {};
        for (const [nodeId, v] of joined.values) {
            values[nodeId] = { value: v.value, severity: v.severity, pointCount: v.pointCount };
        }
        if (joined.unresolved.length > 0) {
            this.log(`[overlay:${overlayId}] ${joined.unresolved.length} of ${points.length} points couldn't be mapped onto ${graphId}`);
        }
        return {
            ...base,
            values,
            unresolvedCount: joined.unresolved.length,
            totalPoints: points.length,
            empty: false,
        };
    }

    /** Raw points for MCP `get_overlay` (R7) — UI toggles never gate data. */
    async rawPoints(overlayId: string): Promise<{ points: OverlayDataPoint[]; emptyHint?: string } | null> {
        const descriptor = this.registry.get(overlayId);
        if (!descriptor) return null;
        const points = await descriptor.fetch({
            workspaceRoot: this.deps.workspaceRoot,
            working: this.deps.getWorking(),
            baseline: this.deps.getBaseline?.(),
            getFileContent: this.deps.getFileContent,
        });
        return { points, emptyHint: descriptor.emptyHint };
    }
}
