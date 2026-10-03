/**
 * featureExplorerProvider.ts
 *
 * Tree view provider for the Feature/Domain Explorer sidebar.
 * Lists detected feature clusters with file counts and diff badges.
 * Clicking a cluster opens the feature diagram zoomed to that cluster.
 */

import * as vscode from 'vscode';
import type { FeatureCluster, DiffStatus } from '../core/graph/graphTypes';

export class FeatureExplorerProvider implements vscode.TreeDataProvider<FeatureTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FeatureTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private workingClusters: FeatureCluster[] = [];
    private baselineClusterIds = new Set<string>();
    private itemCache = new Map<string, FeatureTreeItem>();
    private filter = '';

    setData(baseline: FeatureCluster[], working: FeatureCluster[]): void {
        this.baselineClusterIds = new Set(baseline.map((c) => c.id));
        this.workingClusters = working;
        this.itemCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    private activeClusterId?: string;

    /** Mark a cluster as the active/selected one so the sidebar can reveal it */
    setActiveCluster(clusterId?: string): void {
        this.activeClusterId = clusterId;
        this._onDidChangeTreeData.fire(undefined);
    }

    /** Find the FeatureTreeItem for a given clusterId (used by TreeView.reveal) */
    findItemByClusterId(clusterId: string): FeatureTreeItem | undefined {
        return this.itemCache.get(clusterId);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    setFilter(query: string): void {
        this.filter = query.toLowerCase().trim();
        this.itemCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    getFilter(): string { return this.filter; }

    getTreeItem(element: FeatureTreeItem): vscode.TreeItem {
        return element;
    }

    getParent(_element: FeatureTreeItem): undefined {
        return undefined;
    }

    getChildren(element?: FeatureTreeItem): FeatureTreeItem[] {
        if (!element && this.filter) {
            const q = this.filter;
            const matched = this.workingClusters.filter(c =>
                c.label.toLowerCase().includes(q) ||
                c.files.some(f => f.toLowerCase().includes(q))
            );
            return matched.map(cluster => this.buildClusterItem(cluster));
        }

        if (!element) {
            if (this.workingClusters.length === 0) {
                const empty = new FeatureTreeItem('No clusters detected', vscode.TreeItemCollapsibleState.None);
                empty.description = 'Run Initialize to analyze codebase';
                empty.iconPath = new vscode.ThemeIcon('info');
                return [empty];
            }
            return this.workingClusters.map(cluster => this.buildClusterItem(cluster));
        }

        if (element.cluster) {
            // Expand cluster to show member files
            return element.cluster.files.map((fp) => {
                const fileName = fp.split('/').pop() ?? fp;
                const fileItem = new FeatureTreeItem(fileName, vscode.TreeItemCollapsibleState.None);
                fileItem.description = fp;
                fileItem.tooltip = fp;
                fileItem.iconPath = new vscode.ThemeIcon('file-code');
                fileItem.command = {
                    command: 'codeatlas.openFileDiagramForPath',
                    title: 'Open File Diagram',
                    arguments: [fp],
                };
                return fileItem;
            });
        }

        return [];
    }

    private buildClusterItem(cluster: FeatureCluster): FeatureTreeItem {
        const isNew = !this.baselineClusterIds.has(cluster.id);
        // Issue 245: Use !== undefined to respect explicitly set 'unchanged' diff
        const diff: DiffStatus = cluster.diff !== undefined ? cluster.diff : (isNew ? 'added' : 'unchanged');

        const item = new FeatureTreeItem(cluster.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.cluster = cluster;
        item.contextValue = 'featureCluster';
        item.description = diffBadge(diff)
            ? `${diffBadge(diff)} ${cluster.files.length} files`
            : `${cluster.files.length} files`;
        item.tooltip = `Feature: ${cluster.label}\n${cluster.files.length} files · ${cluster.entryPoints.length} APIs\nCohesion: ${cluster.internalCallCount}/${cluster.internalCallCount + cluster.externalCallCount} internal calls`;
        item.iconPath = new vscode.ThemeIcon(
            diff === 'added' ? 'diff-added' :
                diff === 'deleted' ? 'diff-removed' :
                    diff === 'modified' ? 'diff-modified' : 'symbol-namespace',
            diff !== 'unchanged' ? new vscode.ThemeColor(diffThemeColor(diff)) : undefined
        );
        item.command = {
            command: 'codeatlas.openApiListForCluster',
            title: 'Open API List',
            arguments: [cluster],
        };
        this.itemCache.set(cluster.id, item);
        return item;
    }
}

function diffThemeColor(diff: DiffStatus): string {
    switch (diff) {
        case 'added': return 'gitDecoration.addedResourceForeground';
        case 'deleted': return 'gitDecoration.deletedResourceForeground';
        case 'modified': return 'gitDecoration.modifiedResourceForeground';
        default: return 'foreground';
    }
}

function diffBadge(diff: DiffStatus): string {
    switch (diff) {
        case 'added': return '＋';
        case 'deleted': return '－';
        case 'modified': return '●';
        default: return '';
    }
}

export class FeatureTreeItem extends vscode.TreeItem {
    cluster?: FeatureCluster;
}
