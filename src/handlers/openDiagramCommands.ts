/**
 * openDiagramCommands.ts — Issue #358 Row 7d (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * ten "open diagram" command registrations:
 *
 *   - codeatlas.openApiExplorer          → focus the API tree view
 *   - codeatlas.openSequenceForApi       → L3 sequence for a route
 *   - codeatlas.openFileDiagram          → L4 for the active editor
 *   - codeatlas.openFileDiagramForPath   → L4 from a tree-click args
 *   - codeatlas.openFunctionFlow         → L5 quick-pick over a file
 *   - codeatlas.openFunctionFlowForPath  → L5 from a tree-click args
 *   - codeatlas.openFeatureDiagram       → L2a (optionally scoped to a service)
 *   - codeatlas.openApiListForCluster    → L2b for a cluster
 *   - codeatlas.openMicroserviceDiagram  → L1
 *   - codeatlas.openMapDiagram           → Knowledge Map
 *
 * The "open Xxx" helpers (openFileDiagramForPath / openFeatureDiagram /
 * etc.) live in `extension.ts` because they touch panelManager state and
 * the cluster registry that activate() owns. They're passed as deps so
 * each command can dispatch through them without us replicating that
 * coupling.
 *
 * Mechanical extraction — NO behavior change. Also opportunistically
 * migrates the L5 quick-pick at `openFunctionFlow` to use `parseGraphId`
 * (Issue #362 Phase B) — the old `.split(':').pop()` would have
 * mis-extracted function names containing colons, although in JS/TS
 * source those are exceedingly rare.
 */

import * as vscode from 'vscode';
import { analytics } from '../analytics/mixpanelService';
import { parseGraphId } from '../core/graph/graphIdBuilder';
import type { ApiRecord, FeatureCluster } from '../core/graph/graphTypes';
import type { SnapshotStore } from '../core/storage/snapshotStore';

export interface OpenDiagramCommandDeps {
    snapshotStore: SnapshotStore;
    workspaceRoot: string;
    routeDiagramToWelcome: (graphId: string, mode: string, graph: any, label: string) => void;
    openFileDiagramForPath: (filePath: string) => void;
    openFunctionFlowForPath: (filePath: string, functionName: string) => void;
    openFeatureDiagram: (serviceId?: string) => void;
    openApiListPanel: (clusterId: string, serviceId: string) => void;
    openMicroserviceDiagram: () => void;
    openMapDiagram: () => void;
    revealApiInSidebar: (apiId: string) => void;
    revealServiceInSidebar: (serviceId?: string) => void;
    revealClusterInSidebar: (clusterId: string) => void;
}

export function registerOpenDiagramCommands(deps: OpenDiagramCommandDeps): vscode.Disposable[] {
    const {
        snapshotStore,
        workspaceRoot,
        routeDiagramToWelcome,
        openFileDiagramForPath,
        openFunctionFlowForPath,
        openFeatureDiagram,
        openApiListPanel,
        openMicroserviceDiagram,
        openMapDiagram,
        revealApiInSidebar,
        revealServiceInSidebar,
        revealClusterInSidebar,
    } = deps;

    return [
        vscode.commands.registerCommand('codeatlas.openApiExplorer', () => {
            analytics.track('api_explorer_opened');
            vscode.commands.executeCommand('codeatlas.apiExplorer.focus');
        }),

        vscode.commands.registerCommand('codeatlas.openSequenceForApi', (api?: ApiRecord) => {
            if (!api) {
                vscode.window.showWarningMessage('CodeAtlas: No API selected.');
                return;
            }
            analytics.track('sequence_diagram_opened', { api_method: api.method, api_route: api.route, file_path: api.filePath });
            const graphId = `sequence:${api.filePath}:${api.handlerName}`;
            const graph = snapshotStore.getWorking().graphs[graphId];
            const label = `${api.method} ${api.route}`;
            routeDiagramToWelcome(graphId, 'sequence', graph, label);
            revealApiInSidebar(api.apiId);
        }),

        vscode.commands.registerCommand('codeatlas.openFileDiagram', () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const filePath = activeEditor.document.uri.fsPath.replace(workspaceRoot + '/', '');
                analytics.track('file_diagram_opened', { file_path: filePath, source: 'active_editor' });
                openFileDiagramForPath(filePath);
            }
        }),

        // Commands for tree item clicks from File Explorer and Function Explorer.
        vscode.commands.registerCommand('codeatlas.openFileDiagramForPath', (filePath: string) => {
            analytics.track('file_diagram_opened', { file_path: filePath, source: 'tree_click' });
            openFileDiagramForPath(filePath);
        }),

        vscode.commands.registerCommand('codeatlas.openFunctionFlowForPath', (filePath: string, functionName: string) => {
            analytics.track('function_flow_opened', { file_path: filePath, function_name: functionName, source: 'tree_click' });
            openFunctionFlowForPath(filePath, functionName);
        }),

        vscode.commands.registerCommand('codeatlas.openFunctionFlow', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) return;
            const filePath = activeEditor.document.uri.fsPath.replace(workspaceRoot + '/', '');

            // Get available function names from the working graph map.
            // Issue #362 Phase B (2026-06-07) — use `parseGraphId` so a
            // function name containing a colon (rare in JS/TS but possible
            // in other ecosystems) keeps its inner colons. The old
            // `.split(':').pop()` would have mis-extracted those.
            const fnNames: string[] = [];
            for (const k of Object.keys(snapshotStore.getWorking().graphs)) {
                const parsed = parseGraphId(k);
                if (parsed?.type !== 'flow' || parsed.parts[0] !== filePath) continue;
                if (parsed.parts[1]) fnNames.push(parsed.parts[1]);
            }
            if (fnNames.length === 0) {
                vscode.window.showWarningMessage('CodeAtlas: No functions found in this file.');
                return;
            }

            const selected = await vscode.window.showQuickPick(fnNames, { placeHolder: 'Select a function' });
            if (selected) {
                analytics.track('function_flow_opened', { file_path: filePath, function_name: selected, source: 'quick_pick' });
                openFunctionFlowForPath(filePath, selected);
            }
        }),

        vscode.commands.registerCommand('codeatlas.openFeatureDiagram', (arg?: FeatureCluster | { serviceId: string }) => {
            const serviceId = arg && 'serviceId' in arg ? arg.serviceId : undefined;
            analytics.track('feature_diagram_opened', { service_id: serviceId });
            openFeatureDiagram(serviceId);
            revealServiceInSidebar(serviceId);
        }),

        vscode.commands.registerCommand('codeatlas.openApiListForCluster', (arg: FeatureCluster | string, serviceId?: string) => {
            // arg may be a FeatureCluster object (from sidebar item) or a string clusterId (from message).
            const clusterId = typeof arg === 'string' ? arg : arg.id;
            const svcId = typeof arg === 'string' ? (serviceId ?? '') : (arg.serviceId ?? '');
            analytics.track('api_list_opened', { cluster_id: clusterId, service_id: svcId });
            openApiListPanel(clusterId, svcId);
            revealClusterInSidebar(clusterId);
        }),

        vscode.commands.registerCommand('codeatlas.openMicroserviceDiagram', () => {
            analytics.track('system_design_opened');
            openMicroserviceDiagram();
            vscode.commands.executeCommand('codeatlas.microserviceExplorer.focus');
        }),

        // Issue #700 / #731 — Knowledge Map: single-canvas unified view.
        vscode.commands.registerCommand('codeatlas.openMapDiagram', () => {
            analytics.track('map_diagram_opened');
            openMapDiagram();
        }),
    ];
}
