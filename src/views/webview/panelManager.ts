import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { createUpdateGraphMessage } from './messageProtocol';
import type { ViewMode, MessageHandler } from './messageProtocol';
import type { DiagramGraph } from '../../core/graph/graphTypes';
import type { WebviewToExtensionMessage } from './messageProtocol';

interface PanelState {
    panel: vscode.WebviewPanel;
    mode: ViewMode;
    graph?: DiagramGraph;
    label: string;
    ready: boolean;
    /** The graphId currently shown in the panel (may differ from the map key after navigation) */
    currentGraphId?: string;
    /** Issue 110: Parent context for seeding nav stack in new windows */
    parentContext?: { graphId: string; mode: ViewMode; graph: DiagramGraph; label: string };
}

/**
 * Manages webview panels for diagram rendering.
 * Creates/restores panels for each diagram type and handles messaging.
 * Stores pending data per panel and re-sends when webview signals 'ready'.
 */
export class PanelManager {
    private panelStates: Map<string, PanelState> = new Map();
    private extensionUri: vscode.Uri;
    private messageHandlers: MessageHandler[] = [];
    private navigatedHandlers: Array<(panelId: string, graphId: string) => void> = [];
    private readyHandlers: Array<(panelId: string) => void> = [];
    /** The panelId that most recently had focus or sent a message */
    private activePanelId: string | null = null;
    /** Current theme — sent to all panels on open and on theme change */
    private currentTheme: 'dark' | 'light' = 'dark';
    /** External navigation handler for non-panel targets (e.g., WebSocket browser clients) */
    private externalNavigateHandler: ((sourcePanelId: string, graphId: string, mode: ViewMode, graph: DiagramGraph, label: string) => boolean) | null = null;

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
    }

    /**
     * Register a handler for messages from webviews.
     * Handler receives (message, sourcePanelId).
     */
    onMessage(handler: MessageHandler): void {
        this.messageHandlers.push(handler);
    }

    /**
     * Route a message through all registered handlers (for external sources like WebSocket).
     */
    routeMessage(message: WebviewToExtensionMessage, sourcePanelId: string): void {
        for (const handler of this.messageHandlers) {
            handler(message, sourcePanelId);
        }
    }

    /**
     * Register a handler called when the webview navigates to a different graph
     * (e.g. user hits the Back button). Handler receives (panelId, newGraphId).
     */
    onNavigated(handler: (panelId: string, graphId: string) => void): void {
        this.navigatedHandlers.push(handler);
    }

    /**
     * Register a handler called when a webview panel becomes ready.
     * Used to push git diff context to newly opened panels.
     */
    onPanelReady(handler: (panelId: string) => void): void {
        this.readyHandlers.push(handler);
    }

    /**
     * Register an external navigation handler for non-panel targets (e.g., WebSocket clients).
     * Handler returns true if it handled the navigation, false to fall through.
     */
    onExternalNavigate(handler: (sourcePanelId: string, graphId: string, mode: ViewMode, graph: DiagramGraph, label: string) => boolean): void {
        this.externalNavigateHandler = handler;
    }

    /**
     * Install a hook that intercepts `openPanel(...)` and prevents a VS Code
     * webview from being created. Used by the extension host to enforce the
     * "diagrams only render in the localhost browser" directive — when the
     * interceptor is installed, every code path that would have spawned a
     * webview panel is routed through it instead, typically to surface the
     * welcome page (which has the "Open in Browser" CTA).
     *
     * Pass `undefined` to remove the interceptor and restore default
     * panel-creating behavior.
     */
    setOpenPanelInterceptor(
        fn: ((panelId: string, mode: ViewMode, graph: DiagramGraph | undefined, label: string) => void) | undefined,
    ): void {
        this.openPanelInterceptor = fn;
    }
    private openPanelInterceptor:
        | ((panelId: string, mode: ViewMode, graph: DiagramGraph | undefined, label: string) => void)
        | undefined = undefined;

    /**
     * Open or focus a diagram panel.
     * Issue 110: parentContext seeds the nav stack so "Back" works in the new panel.
     */
    openPanel(
        panelId: string,
        title: string,
        mode: ViewMode,
        graph?: DiagramGraph,
        label?: string,
        parentContext?: { graphId: string; mode: ViewMode; graph: DiagramGraph; label: string },
    ): vscode.WebviewPanel | undefined {
        const resolvedLabel = label ?? title;

        // Interceptor short-circuits panel creation — see setOpenPanelInterceptor.
        // The interceptor takes ownership of the request (typically routes the
        // user to the welcome page so they can launch the localhost browser
        // view). No webview is created and no panel state is registered.
        if (this.openPanelInterceptor) {
            this.openPanelInterceptor(panelId, mode, graph, resolvedLabel);
            return undefined;
        }

        let state = this.panelStates.get(panelId);

        if (state) {
            state.panel.reveal(vscode.ViewColumn.Beside);
            state.mode = mode;
            state.graph = graph;
            state.label = resolvedLabel;
            state.currentGraphId = panelId;
            this.activePanelId = panelId;

            if (state.ready) {
                this.sendPanelData(state);
            }
            return state.panel;
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            `codeatlas.${mode}`,
            title,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist'),
                ],
            },
        );

        panel.webview.html = this.getWebviewHtml(panel.webview, mode);

        state = { panel, mode, graph, label: resolvedLabel, ready: false, currentGraphId: panelId, parentContext };
        this.panelStates.set(panelId, state);
        this.activePanelId = panelId;

        panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
            this.activePanelId = panelId;

            // Handle 'ready' — webview React app has mounted
            if (message.type === 'ready') {
                const s = this.findStateForPanel(panel);
                if (s) {
                    s.ready = true;
                    this.sendPanelData(s);
                    // Send current theme if not dark (dark is the default CSS)
                    if (this.currentTheme !== 'dark') {
                        s.panel.webview.postMessage({ type: 'setTheme', theme: this.currentTheme });
                    }
                    // Notify extension so it can push git diff context if active
                    for (const handler of this.readyHandlers) {
                        handler(panelId);
                    }
                }
                return;
            }

            // Handle 'panelNavigated' — webview tells us what graphId is shown now
            if (message.type === 'panelNavigated') {
                const s = this.findStateForPanel(panel);
                if (s) {
                    s.currentGraphId = message.graphId;
                    for (const handler of this.navigatedHandlers) {
                        handler(panelId, message.graphId);
                    }
                }
                return;
            }

            for (const handler of this.messageHandlers) {
                handler(message, panelId);
            }
        });

        panel.onDidChangeViewState((e) => {
            if (e.webviewPanel.active) {
                this.activePanelId = panelId;
            }
        });

        panel.onDidDispose(() => {
            this.panelStates.delete(panelId);
            if (this.activePanelId === panelId) {
                this.activePanelId = null;
            }
        });

        return panel;
    }

    /**
     * Navigate in-place in a specific panel (push onto its history stack).
     */
    navigatePanel(sourcePanelId: string, graphId: string, mode: ViewMode, graph: DiagramGraph, label: string): void {
        const state = this.panelStates.get(sourcePanelId);
        if (state?.ready) {
            state.mode = mode;
            state.graph = graph;
            state.label = label;
            state.currentGraphId = graphId;
            state.panel.webview.postMessage({ type: 'navigateTo', graphId, mode, graph, label });
            return;
        }
        // Fallback: try external handler (e.g., WebSocket browser clients)
        if (this.externalNavigateHandler) {
            this.externalNavigateHandler(sourcePanelId, graphId, mode, graph, label);
        }
    }

    /**
     * Navigate in the currently active panel (for commands/sidebar without a sourcePanelId).
     * Returns true if a panel was found and navigated, false if no active panel exists.
     */
    navigateActive(graphId: string, mode: ViewMode, graph: DiagramGraph, label: string): boolean {
        if (!this.activePanelId) return false;
        const state = this.panelStates.get(this.activePanelId);
        if (!state?.ready) return false;
        this.navigatePanel(this.activePanelId, graphId, mode, graph, label);
        return true;
    }

    /**
     * Broadcast a theme change to all open panels and remember it for new panels.
     */
    setTheme(theme: 'dark' | 'light'): void {
        this.currentTheme = theme;
        for (const state of this.panelStates.values()) {
            if (state.ready) {
                state.panel.webview.postMessage({ type: 'setTheme', theme });
            }
        }
    }

    /**
     * Return the ID of the most recently active panel, or null.
     */
    getActivePanelId(): string | null {
        return this.activePanelId;
    }

    /**
     * Issue 110: Get the current graph context of a panel (for seeding new windows).
     */
    getPanelContext(panelId: string): { graphId: string; mode: ViewMode; graph: DiagramGraph; label: string } | undefined {
        const state = this.panelStates.get(panelId);
        if (!state?.graph) return undefined;
        return { graphId: state.currentGraphId ?? panelId, mode: state.mode, graph: state.graph, label: state.label };
    }

    /**
     * Send an arbitrary message to all currently open and ready panels.
     */
    broadcastMessage(message: any): void {
        for (const state of this.panelStates.values()) {
            if (state.ready) {
                state.panel.webview.postMessage(message);
            }
        }
    }

    /**
     * Send an arbitrary typed message to the panel that most recently received
     * the node with the given nodeId. Falls back to broadcasting to all panels.
     */
    sendToPanel(nodeId: string, message: any): void {
        for (const state of this.panelStates.values()) {
            if (state.ready && state.graph?.nodes.some((n: any) => n.id === nodeId)) {
                state.panel.webview.postMessage(message);
                return;
            }
        }
        // Fallback: send to the most recently created ready panel
        for (const state of [...this.panelStates.values()].reverse()) {
            if (state.ready) {
                state.panel.webview.postMessage(message);
                return;
            }
        }
    }

    /**
     * Update graph data in an existing panel.
     * Also scans panels by currentGraphId for panels that have navigated away from their original graphId.
     */
    updatePanel(panelId: string, graph: DiagramGraph): void {
        let state = this.panelStates.get(panelId);
        if (!state) {
            // Panel may have navigated in-place — find by currentGraphId
            state = [...this.panelStates.values()].find(s => s.currentGraphId === panelId);
        }
        if (!state?.ready) return;
        state.graph = graph;
        state.panel.webview.postMessage(createUpdateGraphMessage(graph.graphId, graph));
    }

    /**
     * Close a specific panel by panelId.
     */
    closePanel(panelId: string): void {
        const state = this.panelStates.get(panelId);
        if (state) {
            state.panel.dispose();
            this.panelStates.delete(panelId);
        }
    }

    /**
     * Close all panels
     */
    disposeAll(): void {
        for (const state of this.panelStates.values()) {
            state.panel.dispose();
        }
        this.panelStates.clear();
    }

    /**
     * Send a navigateTo message to initialize the panel with its first diagram.
     */
    private sendPanelData(state: PanelState): void {
        // Issue 110: Push parent context first so "Back" works in new windows
        if (state.parentContext) {
            state.panel.webview.postMessage({
                type: 'navigateTo',
                graphId: state.parentContext.graphId,
                mode: state.parentContext.mode,
                graph: state.parentContext.graph,
                label: state.parentContext.label,
            });
            state.parentContext = undefined; // Only seed once
        }
        if (state.graph) {
            state.panel.webview.postMessage({
                type: 'navigateTo',
                graphId: state.graph.graphId,
                mode: state.mode,
                graph: state.graph,
                label: state.label,
            });
        }
    }

    /**
     * Find which panel state corresponds to a given panel instance
     */
    private findStateForPanel(panel: vscode.WebviewPanel): PanelState | undefined {
        for (const state of this.panelStates.values()) {
            if (state.panel === panel) return state;
        }
        return undefined;
    }

    private getWebviewHtml(webview: vscode.Webview, mode: string): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.css')
        );
        const nonce = crypto.randomBytes(16).toString('hex');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- Issue 44: script-src uses nonce + strict-dynamic — NO 'unsafe-inline' for scripts.
       Issue 102: style-src retains 'unsafe-inline' as a deliberate accepted risk:
       React Flow and other React-ecosystem libraries inject runtime inline style
       attributes for layout / transforms; removing 'unsafe-inline' from style-src
       would require a full migration off those libraries. The CSS-injection
       attack surface is qualitatively smaller than script-src — no JS execution,
       no token exfiltration via fetch, only style-based exfiltration which is
       already restricted by the connect-src + img-src allowlists below. -->
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    script-src 'nonce-${nonce}' 'strict-dynamic' https:;
    style-src ${webview.cspSource} 'unsafe-inline' https:;
    img-src ${webview.cspSource} data: https:;
    font-src ${webview.cspSource} https:;
    connect-src ${webview.cspSource} https://*.accounts.dev https://js.clerk.com https://clerk.shared.lcl.dev wss://*.accounts.dev;
    frame-src https://*.accounts.dev;
    worker-src blob:;
  ">
  <title>CodeAtlas - ${mode}</title>
  <link rel="stylesheet" href="${styleUri}">
  <style>
    body { margin: 0; padding: 0; overflow: hidden; background: #fff; }
    #root { width: 100vw; height: 100vh; }
    .ca-loading { display: flex; align-items: center; justify-content: center; height: 100vh; font-family: Inter, system-ui, sans-serif; color: #64748b; }
  </style>
</head>
<body>
  <div id="root"><div class="ca-loading">Loading CodeAtlas ${mode} view...</div></div>
  <script nonce="${nonce}">
    window.vscodeApi = acquireVsCodeApi();
    window.initialMode = '${mode}';
  </script>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
