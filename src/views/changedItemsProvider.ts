import * as vscode from 'vscode';
import type { DiagramGraph, DiffStatus } from '../core/graph/graphTypes';
import { parseGraphId } from '../core/graph/graphIdBuilder';

/**
 * Tree view provider for Changed Elements sidebar panel.
 * Shows elements that have changed since the baseline.
 */
export class ChangedItemsProvider implements vscode.TreeDataProvider<ChangedItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ChangedItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private changedGraphs: Map<string, DiagramGraph> = new Map();

    setChangedGraphs(graphs: Map<string, DiagramGraph>): void {
        this.changedGraphs = graphs;
        this._onDidChangeTreeData.fire(undefined);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ChangedItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ChangedItem): ChangedItem[] {
        if (!element) {
            const items: ChangedItem[] = [];
            for (const [graphId, graph] of this.changedGraphs.entries()) {
                const changedNodes = graph.nodes.filter((n) => n.diff && n.diff !== 'unchanged');
                if (changedNodes.length === 0) continue;

                // Issue 252: Extract file path from graphId.
                // Issue #362 Phase B (2026-06-07) — structured parse;
                // the parser already takes the FIRST colon after the
                // type as the parts separator, so Windows drive-letter
                // colons in parts[1] (function names) are preserved.
                let filePath: string | undefined;
                const parsed = parseGraphId(graphId);
                if (parsed) {
                    if (parsed.type === 'file') filePath = parsed.parts[0];
                    else if (parsed.type === 'flow' || parsed.type === 'sequence') filePath = parsed.parts[0];
                }

                const item = new ChangedItem(
                    graphId,
                    vscode.TreeItemCollapsibleState.Expanded,
                );
                item.description = `${changedNodes.length} change(s)`;
                item.iconPath = new vscode.ThemeIcon('diff');
                item.graphId = graphId;
                if (filePath) {
                    item.contextValue = 'changedGraph';
                    item.filePath = filePath;
                }
                items.push(item);
            }
            if (items.length === 0) {
                const empty = new ChangedItem('No changes detected', vscode.TreeItemCollapsibleState.None);
                empty.iconPath = new vscode.ThemeIcon('check');
                return [empty];
            }
            return items;
        }

        const graph = this.changedGraphs.get(element.graphId || '');
        if (!graph) return [];

        return graph.nodes
            .filter((n) => n.diff && n.diff !== 'unchanged')
            .map((n) => {
                const icon = diffIcon(n.diff!);
                const item = new ChangedItem(n.label, vscode.TreeItemCollapsibleState.None);
                item.description = n.diff;
                item.iconPath = new vscode.ThemeIcon(icon);
                return item;
            });
    }
}

function diffIcon(status: DiffStatus): string {
    switch (status) {
        case 'added': return 'diff-added';
        case 'deleted': return 'diff-removed';
        case 'modified': return 'diff-modified';
        default: return 'circle-outline';
    }
}

export class ChangedItem extends vscode.TreeItem {
    graphId?: string;
    filePath?: string;
}
