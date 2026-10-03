import * as vscode from 'vscode';
import type { ApiRecord, DiffStatus, FileRecord } from '../core/graph/graphTypes';

/**
 * Tree view provider for the API Explorer sidebar panel.
 * Lists detected API routes with method, path, and handler info.
 * Shows diff color coding when baseline and working data differ.
 */
export class ApiExplorerProvider implements vscode.TreeDataProvider<ApiTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ApiTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private workingApis: ApiRecord[] = [];
    private baselineApiIds = new Set<string>();
    private baselineFiles = new Map<string, FileRecord>();
    private workingFiles = new Map<string, FileRecord>();
    private itemCache = new Map<string, ApiTreeItem>(); // apiId → leaf tree item
    private filter = '';

    /** Update with baseline + working data so diff status can be computed */
    setData(baseline: ApiRecord[], working: ApiRecord[], baseFiles?: FileRecord[], workFiles?: FileRecord[]): void {
        this.baselineApiIds = new Set(baseline.map(a => a.apiId));
        this.workingApis = working;
        if (baseFiles) this.baselineFiles = new Map(baseFiles.map(f => [f.path, f]));
        if (workFiles) this.workingFiles = new Map(workFiles.map(f => [f.path, f]));
        this.itemCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    /** Legacy setter for compatibility — no diff info */
    setApis(apis: ApiRecord[]): void {
        this.workingApis = apis;
        this.itemCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    refresh(): void {
        this.itemCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    setFilter(query: string): void {
        this.filter = query.toLowerCase().trim();
        this.itemCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    getFilter(): string { return this.filter; }

    /** Find a leaf ApiTreeItem by its apiId (populated after getChildren is called) */
    findItemByApiId(apiId: string): ApiTreeItem | undefined {
        return this.itemCache.get(apiId);
    }

    getTreeItem(element: ApiTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ApiTreeItem): ApiTreeItem[] {
        if (!element && this.filter) {
            // Flat filtered list — skip file grouping
            const q = this.filter;
            return this.workingApis
                .filter(api =>
                    `${api.method} ${api.route}`.toLowerCase().includes(q) ||
                    api.handlerName.toLowerCase().includes(q) ||
                    api.filePath.toLowerCase().includes(q)
                )
                .map(api => this.buildRouteItem(api));
        }

        if (!element) {
            // Group by file
            const byFile = new Map<string, ApiRecord[]>();
            for (const api of this.workingApis) {
                const file = api.filePath;
                if (!byFile.has(file)) byFile.set(file, []);
                byFile.get(file)!.push(api);
            }

            return [...byFile.entries()].map(([file, apis]) => {
                // File-level diff check:
                let fileDiff: DiffStatus = 'unchanged';
                const workingFileRecord = this.workingFiles.get(file);
                const baseFileRecord = this.baselineFiles.get(file);

                if (apis.some(a => !this.baselineApiIds.has(a.apiId))) {
                    // New APIs added
                    fileDiff = 'added';
                } else if (workingFileRecord && baseFileRecord && workingFileRecord.hash !== baseFileRecord.hash) {
                    // Existing APIs, but file content changed
                    fileDiff = 'modified';
                }

                const item = new ApiTreeItem(
                    file.split('/').pop() || file,
                    vscode.TreeItemCollapsibleState.Expanded,
                );
                item.contextValue = 'apiFile';

                const iconName = fileDiff === 'added' ? 'diff-added' : fileDiff === 'modified' ? 'diff-modified' : 'file-code';
                item.iconPath = new vscode.ThemeIcon(
                    iconName,
                    fileDiff !== 'unchanged' ? new vscode.ThemeColor(diffThemeColor(fileDiff)) : undefined,
                );

                // Show badge on file name if changed
                if (fileDiff !== 'unchanged') {
                    item.description = diffBadge(fileDiff);
                }

                item.apis = apis;
                return item;
            });
        }

        if (element.apis) {
            return element.apis.map(api => this.buildRouteItem(api));
        }

        return [];
    }

    private buildRouteItem(api: ApiRecord): ApiTreeItem {
        const isNew = !this.baselineApiIds.has(api.apiId);
        let diff: DiffStatus = 'unchanged';

        if (isNew) {
            diff = 'added';
        } else {
            const workingFileRecord = this.workingFiles.get(api.filePath);
            const baseFileRecord = this.baselineFiles.get(api.filePath);
            if (workingFileRecord && baseFileRecord && workingFileRecord.hash !== baseFileRecord.hash) {
                diff = 'modified';
            }
        }

        const label = `${api.method} ${api.route}`;
        const item = new ApiTreeItem(label, vscode.TreeItemCollapsibleState.None);

        let prefix = '';
        if (diff === 'added') prefix = '＋ ';
        else if (diff === 'modified') prefix = '● ';

        // In filtered mode, show file name as part of the description
        const fileSuffix = this.filter ? ` · ${api.filePath.split('/').pop()}` : '';
        item.description = `${prefix}→ ${api.handlerName}${fileSuffix}`;
        item.contextValue = 'apiRoute';
        item.apiRecord = api;
        item.iconPath = new vscode.ThemeIcon(
            diff === 'added' ? 'diff-added' : diff === 'modified' ? 'diff-modified' : methodIcon(api.method),
            diff !== 'unchanged' ? new vscode.ThemeColor(diffThemeColor(diff)) : undefined,
        );
        item.tooltip = diff !== 'unchanged'
            ? `[${diff}] ${api.method} ${api.route} → ${api.handlerName}`
            : `${api.method} ${api.route} → ${api.handlerName}`;
        item.command = {
            command: 'codeatlas.openSequenceForApi',
            title: 'Open Sequence Diagram',
            arguments: [api],
        };
        this.itemCache.set(api.apiId, item);
        return item;
    }
}

function methodIcon(method: string): string {
    switch (method.toUpperCase()) {
        case 'GET': return 'arrow-down';
        case 'POST': return 'add';
        case 'PUT': return 'edit';
        case 'PATCH': return 'edit';
        case 'DELETE': return 'trash';
        // Issue 239: Icons for extended method types
        case 'SIGNAL': return 'broadcast';
        case 'EVENT_LISTENER': return 'bell';
        case 'EVENT_EMIT': return 'megaphone';
        case 'AOP_ASPECT': return 'layers';
        case 'AOP_AROUND': case 'AOP_BEFORE': case 'AOP_AFTER':
        case 'AOP_AFTERRETURNING': case 'AOP_AFTERTHROWING': return 'symbol-event';
        case 'MIDDLEWARE': return 'filter';
        case 'SERVLET_FILTER': case 'HANDLER_INTERCEPTOR': return 'shield';
        case 'DI_DEPENDENCY': return 'plug';
        case 'SERVER_ACTION': return 'zap';
        case 'DATA_FETCH': case 'STATIC_PATHS': return 'database';
        case 'SCREEN': return 'device-mobile';
        case 'NAV_ROUTE': return 'compass';
        case 'NETWORK': return 'globe';
        case 'DI_BINDING': return 'link';
        case 'WS': return 'radio-tower';
        default: return 'symbol-method';
    }
}

/** Reliable git-decoration theme colors for diff states */
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

export class ApiTreeItem extends vscode.TreeItem {
    apis?: ApiRecord[];
    apiRecord?: ApiRecord;
}
