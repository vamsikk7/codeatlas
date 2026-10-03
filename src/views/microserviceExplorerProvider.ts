/**
 * microserviceExplorerProvider.ts
 *
 * Tree view provider for the Microservice Explorer sidebar.
 * Lists detected services with API counts, technology badges, and diff indicators.
 * Clicking a service opens the full L1 System Design diagram (all services + infra).
 * Expanding a service shows its APIs; clicking an API opens its sequence diagram.
 */

import * as vscode from 'vscode';
import type { ServiceRecord, ApiRecord, DiffStatus } from '../core/graph/graphTypes';

export class MicroserviceExplorerProvider implements vscode.TreeDataProvider<ServiceTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ServiceTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private workingServices: ServiceRecord[] = [];
    private baselineServiceIds = new Set<string>();
    private workingApis: ApiRecord[] = [];
    private itemCache = new Map<string, ServiceTreeItem>();

    setData(
        baseline: ServiceRecord[],
        working: ServiceRecord[],
        apis: ApiRecord[]
    ): void {
        this.baselineServiceIds = new Set(baseline.map((s) => s.id));
        this.workingServices = working;
        this.workingApis = apis;
        this.itemCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    private activeServiceId?: string;

    /** Mark a service as the active/selected one so the sidebar can reveal it */
    setActiveService(serviceId?: string): void {
        this.activeServiceId = serviceId;
        this._onDidChangeTreeData.fire(undefined);
    }

    /** Find the ServiceTreeItem for a given serviceId (used by TreeView.reveal) */
    findItemByServiceId(serviceId: string): ServiceTreeItem | undefined {
        return this.itemCache.get(serviceId);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ServiceTreeItem): vscode.TreeItem {
        return element;
    }

    getParent(_element: ServiceTreeItem): undefined {
        return undefined;
    }

    getChildren(element?: ServiceTreeItem): ServiceTreeItem[] {
        if (!element) {
            return this.workingServices.map((service) => {
                const isNew = !this.baselineServiceIds.has(service.id);
                const diff: DiffStatus = service.diff ?? (isNew ? 'added' : 'unchanged');

                const item = new ServiceTreeItem(
                    service.name,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.service = service;
                item.contextValue = 'microservice';
                item.description = `${diffBadge(diff)} ${service.technology} · ${service.exposedApiCount} APIs`.trim();
                item.tooltip = [
                    `Service: ${service.name}`,
                    `Technology: ${service.technology}`,
                    `Root: ${service.rootPath || '.'}`,
                    `APIs: ${service.exposedApiCount}`,
                    service.consumedServices.length > 0
                        ? `Calls: ${service.consumedServices.map((s) => s.replace('service:', '')).join(', ')}`
                        : null,
                ].filter(Boolean).join('\n');
                item.iconPath = new vscode.ThemeIcon(
                    diff === 'added' ? 'diff-added' :
                        diff === 'deleted' ? 'diff-removed' :
                            diff === 'modified' ? 'diff-modified' : 'server',
                    diff !== 'unchanged' ? new vscode.ThemeColor(diffThemeColor(diff)) : undefined
                );
                item.command = {
                    command: 'codeatlas.openMicroserviceDiagram',
                    title: 'Open System Design',
                    arguments: [],
                };
                this.itemCache.set(service.id, item);
                return item;
            });
        }

        if (element.service) {
            // Show APIs belonging to this service
            const serviceApis = this.workingApis.filter(
                (a) =>
                    element.service!.rootPath === '' ||
                    a.filePath.startsWith(element.service!.rootPath + '/')
            );

            if (serviceApis.length === 0) {
                const empty = new ServiceTreeItem('No APIs detected', vscode.TreeItemCollapsibleState.None);
                empty.iconPath = new vscode.ThemeIcon('dash');
                return [empty];
            }

            return serviceApis.map((api) => {
                const item = new ServiceTreeItem(
                    `${api.method} ${api.route}`,
                    vscode.TreeItemCollapsibleState.None
                );
                item.description = `→ ${api.handlerName}`;
                item.tooltip = `${api.method} ${api.route} → ${api.handlerName}\n${api.filePath}`;
                item.iconPath = new vscode.ThemeIcon(methodIcon(api.method));
                item.command = {
                    command: 'codeatlas.openSequenceForApi',
                    title: 'Open Sequence Diagram',
                    arguments: [api],
                };
                return item;
            });
        }

        return [];
    }
}

function methodIcon(method: string): string {
    switch (method.toUpperCase()) {
        case 'GET': return 'arrow-down';
        case 'POST': return 'add';
        case 'PUT': return 'edit';
        case 'PATCH': return 'edit';
        case 'DELETE': return 'trash';
        default: return 'symbol-method';
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

export class ServiceTreeItem extends vscode.TreeItem {
    service?: ServiceRecord;
}
