import * as vscode from 'vscode';

/**
 * Getting Started tree view — shown to first-time users before initialization.
 * Auto-hides after first successful initialization via `codeatlas:initialized` context.
 *
 * Shows:
 * 1. Quick-start steps (Open in Browser → Re-initialize)
 * 2. Diagram layer overview (L1-L5)
 * 3. Key commands with keyboard shortcuts
 *
 * 3.3.2: auth row was removed — sign-in is no longer required for any feature.
 */
export class WelcomeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /**
     * No-op kept for backward compat with extension.ts call sites that
     * still invoke `welcomeProvider.setAuthStatus(...)` post-3.3.2.
     */
    setAuthStatus(_email: string | null): void { /* noop */ }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        if (!element) return this.getRootItems();
        if (element.label === 'Diagram Layers') return this.getLayerItems();
        if (element.label === 'Commands') return this.getCommandItems();
        return [];
    }

    private getRootItems(): vscode.TreeItem[] {
        const items: vscode.TreeItem[] = [];

        // ── Header ──
        const intro = new vscode.TreeItem('Welcome to CodeAtlas', vscode.TreeItemCollapsibleState.None);
        intro.description = '6-layer architecture diagrams with live diff';
        intro.iconPath = new vscode.ThemeIcon('symbol-structure');
        items.push(intro);

        // ── Quick-start steps ──
        const step1 = new vscode.TreeItem('Open in Browser', vscode.TreeItemCollapsibleState.None);
        step1.description = 'View diagrams in your browser';
        step1.iconPath = new vscode.ThemeIcon('globe');
        step1.command = { command: 'codeatlas.openInBrowser', title: 'Open in Browser' };
        items.push(step1);

        const step3 = new vscode.TreeItem('Re-initialize', vscode.TreeItemCollapsibleState.None);
        step3.description = 'Rebuild all diagrams from scratch';
        step3.iconPath = new vscode.ThemeIcon('refresh');
        step3.command = { command: 'codeatlas.initializeWorkspaceVisuals', title: 'Initialize' };
        items.push(step3);

        // ── Collapsible sections ──
        const layers = new vscode.TreeItem('Diagram Layers', vscode.TreeItemCollapsibleState.Collapsed);
        layers.iconPath = new vscode.ThemeIcon('layers');
        layers.description = '6 zoom levels from system to function';
        items.push(layers);

        const commands = new vscode.TreeItem('Commands', vscode.TreeItemCollapsibleState.Collapsed);
        commands.iconPath = new vscode.ThemeIcon('terminal');
        commands.description = 'Key shortcuts and actions';
        items.push(commands);

        return items;
    }

    private getLayerItems(): vscode.TreeItem[] {
        const layers = [
            { label: 'L1 System Design', desc: 'Services, databases, queues, inter-service edges', icon: 'server', cmd: 'codeatlas.openMicroserviceDiagram' },
            { label: 'L2a Feature Areas', desc: 'Endpoints grouped by feature (screens for frontends)', icon: 'group-by-ref-type', cmd: 'codeatlas.openFeatureDiagram' },
            { label: 'L2b API / Screen List', desc: 'REST APIs, screens, navigation, network, DI', icon: 'list-unordered', cmd: 'codeatlas.openApiExplorer' },
            { label: 'L3 Sequence Diagrams', desc: 'Data flow: classes/files as participants, functions as messages', icon: 'git-pull-request', cmd: 'codeatlas.openSequenceForApi' },
            { label: 'L4 File / Class Diagrams', desc: 'Imports, classes, functions, variables per file', icon: 'file-code', cmd: 'codeatlas.openFileDiagram' },
            { label: 'L5 Function Flow', desc: 'Control flow: if/else, loops, returns as flowchart', icon: 'type-hierarchy', cmd: 'codeatlas.openFunctionFlow' },
        ];

        return layers.map(l => {
            const item = new vscode.TreeItem(l.label, vscode.TreeItemCollapsibleState.None);
            item.description = l.desc;
            item.iconPath = new vscode.ThemeIcon(l.icon);
            item.command = { command: l.cmd, title: l.label };
            return item;
        });
    }

    private getCommandItems(): vscode.TreeItem[] {
        const cmds = [
            { label: 'Initialize Workspace', desc: 'Cmd+Shift+I', icon: 'play', cmd: 'codeatlas.initializeWorkspaceVisuals' },
            { label: 'Open System Design', desc: 'Cmd+Shift+D', icon: 'graph', cmd: 'codeatlas.openMicroserviceDiagram' },
            { label: 'Search APIs', desc: 'Cmd+Shift+A', icon: 'search', cmd: 'codeatlas.searchApiExplorer' },
            { label: 'Global Search', desc: 'Cmd+Shift+F5', icon: 'search', cmd: 'codeatlas.search' },
            { label: 'Compare Commits', desc: 'Git diff mode', icon: 'git-compare', cmd: 'codeatlas.openGitDiff' },
            { label: 'Export Architecture Docs', desc: 'Markdown + Mermaid', icon: 'markdown', cmd: 'codeatlas.exportArchitectureDocs' },
            { label: 'Health Report', desc: 'Dead code, coupling, cycles', icon: 'heart', cmd: 'codeatlas.showHealthReport' },
            { label: 'Load Coverage', desc: 'LCOV / Istanbul overlay', icon: 'beaker', cmd: 'codeatlas.loadCoverage' },
        ];

        return cmds.map(c => {
            const item = new vscode.TreeItem(c.label, vscode.TreeItemCollapsibleState.None);
            item.description = c.desc;
            item.iconPath = new vscode.ThemeIcon(c.icon);
            item.command = { command: c.cmd, title: c.label };
            return item;
        });
    }
}
