import * as vscode from 'vscode';
import type { FileRecord, SymbolRecord, DiffStatus } from '../core/graph/graphTypes';

interface FunctionInfo {
    name: string;
    filePath: string;
    kind: string;
    signature: string;
    stableKey: string;
    diff: DiffStatus;
}

/**
 * Tree view provider for the Function Explorer sidebar panel.
 * Lists functions grouped by file — click to open function flow diagram.
 * Shows diff color coding when baseline and working data differ.
 */
export class FunctionExplorerProvider implements vscode.TreeDataProvider<FunctionTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FunctionTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private workingFiles: FileRecord[] = [];
    private baselineFilesByPath = new Map<string, FileRecord>();
    private baselineFnByKey = new Map<string, SymbolRecord>();
    private filter = '';
    private workingApiIndex: Record<string, any> = {};

    /** Update with baseline + working data so per-function diff status can be computed */
    setData(baseline: FileRecord[], working: FileRecord[], apiIndex?: Record<string, any>): void {
        this.baselineFilesByPath = new Map(baseline.map(f => [f.path, f]));
        this.baselineFnByKey = new Map(
            baseline.flatMap(f => f.symbols?.functions || []).map(fn => [fn.stableKey, fn])
        );
        this.workingFiles = working;
        if (apiIndex) this.workingApiIndex = apiIndex;
        this._onDidChangeTreeData.fire(undefined);
    }

    /** Legacy setter for compatibility — no diff info */
    setFiles(files: FileRecord[]): void {
        this.workingFiles = files;
        this._onDidChangeTreeData.fire(undefined);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    setFilter(query: string): void {
        this.filter = query.toLowerCase().trim();
        this._onDidChangeTreeData.fire(undefined);
    }

    getFilter(): string { return this.filter; }

    getTreeItem(element: FunctionTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: FunctionTreeItem): FunctionTreeItem[] {
        if (!element && this.filter) {
            // Flat filtered list across all files
            const q = this.filter;
            const results: FunctionTreeItem[] = [];
            for (const file of this.workingFiles) {
                const infos = this.buildFunctionInfos(file);
                for (const fn of infos) {
                    if (fn.name.toLowerCase().includes(q) || fn.filePath.toLowerCase().includes(q)) {
                        const item = new FunctionTreeItem(fn.name, vscode.TreeItemCollapsibleState.None);
                        item.description = `${fn.diff !== 'unchanged' ? diffBadge(fn.diff) + ' ' : ''}${file.path.split('/').pop()}`;
                        item.contextValue = fn.diff === 'deleted' ? 'fnItemDeleted' : 'fnItem';
                        item.iconPath = new vscode.ThemeIcon(
                            diffFunctionIcon(fn.diff, fn.kind),
                            fn.diff !== 'unchanged' ? new vscode.ThemeColor(diffThemeColor(fn.diff)) : undefined,
                        );
                        item.tooltip = fn.signature;
                        if (fn.diff !== 'deleted') {
                            item.command = {
                                command: 'codeatlas.openFunctionFlowForPath',
                                title: 'Open Function Flow',
                                arguments: [fn.filePath, fn.name],
                            };
                        }
                        results.push(item);
                    }
                }
            }
            return results;
        }

        if (!element) {
            // Show files that have functions (working)
            const filesWithFns = this.workingFiles.filter(
                (f) => f.symbols?.functions && f.symbols.functions.length > 0
            );

            if (filesWithFns.length === 0) {
                const empty = new FunctionTreeItem('No functions found', vscode.TreeItemCollapsibleState.None);
                empty.description = this.workingFiles.length === 0 ? 'Run Initialize to scan workspace' : 'No functions in scanned files';
                empty.iconPath = new vscode.ThemeIcon('info');
                return [empty];
            }

            return filesWithFns.map((file) => {
                const fileName = file.path.split('/').pop() || file.path;
                const fnInfos = this.buildFunctionInfos(file);
                const fnCount = fnInfos.length;
                const hasChanges = fnInfos.some(f => f.diff !== 'unchanged');
                const worstDiff: DiffStatus = fnInfos.some(f => f.diff === 'added') ? 'added'
                    : fnInfos.some(f => f.diff === 'deleted') ? 'deleted'
                        : fnInfos.some(f => f.diff === 'modified') ? 'modified'
                            : 'unchanged';
                const label = hasChanges ? `${diffBadge(worstDiff)} ${fileName}` : fileName;
                const item = new FunctionTreeItem(
                    label,
                    vscode.TreeItemCollapsibleState.Collapsed,
                );
                item.description = `${fnCount} function(s)`;
                item.iconPath = new vscode.ThemeIcon(
                    hasChanges ? diffFileIcon(worstDiff) : 'file-code',
                    hasChanges ? new vscode.ThemeColor(diffThemeColor(worstDiff)) : undefined,
                );
                item.contextValue = 'fnFile';
                item.tooltip = file.path;
                item.functions = fnInfos;
                return item;
            });
        }

        if (element.functions) {
            return element.functions.map((fn) => {
                const item = new FunctionTreeItem(fn.name, vscode.TreeItemCollapsibleState.None);
                item.description = `${fn.diff !== 'unchanged' ? diffBadge(fn.diff) + ' ' : ''}${truncateSig(fn.signature)}`;
                item.contextValue = fn.diff === 'deleted' ? 'fnItemDeleted' : 'fnItem';
                item.iconPath = new vscode.ThemeIcon(
                    diffFunctionIcon(fn.diff, fn.kind),
                    fn.diff !== 'unchanged' ? new vscode.ThemeColor(diffThemeColor(fn.diff)) : undefined,
                );
                item.tooltip = fn.diff !== 'unchanged'
                    ? `[${fn.diff}] ${fn.signature}`
                    : fn.signature;
                if (fn.diff !== 'deleted') {
                    item.command = {
                        command: 'codeatlas.openFunctionFlowForPath',
                        title: 'Open Function Flow',
                        arguments: [fn.filePath, fn.name],
                    };
                }
                return item;
            });
        }

        return [];
    }

    private buildFunctionInfos(file: FileRecord): FunctionInfo[] {
        const infos: FunctionInfo[] = [];

        for (const fn of (file.symbols?.functions || [])) {
            const baseFn = this.baselineFnByKey.get(fn.stableKey);
            let diff: DiffStatus;
            if (!baseFn) {
                diff = 'added';
            } else if (baseFn.signature !== fn.signature || baseFn.bodyText !== fn.bodyText) {
                diff = 'modified';
            } else {
                diff = 'unchanged';
            }
            infos.push({
                name: fn.name,
                filePath: file.path,
                kind: fn.kind,
                signature: fn.signature,
                stableKey: fn.stableKey,
                diff,
            });
        }

        // Issue 253: Add anonymous route handlers from apiIndex (not in symbols.functions)
        const existingNames = new Set(infos.map(f => f.name));
        if (this.workingApiIndex) {
            for (const api of Object.values(this.workingApiIndex)) {
                if (api.filePath === file.path && api.handlerName.startsWith('anonymous@') && !existingNames.has(api.handlerName)) {
                    infos.push({
                        name: api.handlerName,
                        filePath: file.path,
                        kind: 'function',
                        signature: `${api.method} ${api.route}`,
                        stableKey: `function:${api.handlerName}`,
                        diff: 'unchanged',
                    });
                    existingNames.add(api.handlerName);
                }
            }
        }

        // Add deleted functions (in baseline for this file's functions, but not in working)
        const workingKeys = new Set(infos.map(f => f.stableKey));
        const baseFile = this.baselineFilesByPath.get(file.path);
        if (baseFile) {
            for (const baseFn of (baseFile.symbols?.functions || [])) {
                const key = baseFn.stableKey;
                // Issue 244: Accept any key format for deleted detection, not just 'function:' prefix
                if (!workingKeys.has(key) && (key.startsWith('function:') || key.startsWith('method:') || key.startsWith('fn:'))) {
                    infos.push({
                        name: `${baseFn.name} (deleted)`,
                        filePath: file.path,
                        kind: baseFn.kind,
                        signature: baseFn.signature,
                        stableKey: key,
                        diff: 'deleted',
                    });
                }
            }
        }

        return infos;
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

/** Distinct icons per diff state for files in function explorer */
function diffFileIcon(diff: DiffStatus): string {
    switch (diff) {
        case 'added': return 'diff-added';
        case 'deleted': return 'diff-removed';
        case 'modified': return 'diff-modified';
        default: return 'file-code';
    }
}

/** Distinct icons per diff state for function items */
function diffFunctionIcon(diff: DiffStatus, kind: string): string {
    if (diff === 'added') return 'diff-added';
    if (diff === 'deleted') return 'diff-removed';
    if (diff === 'modified') return 'diff-modified';
    return kind === 'class' ? 'symbol-class' : 'symbol-method';
}

function diffBadge(diff: DiffStatus): string {
    switch (diff) {
        case 'added': return '＋';
        case 'deleted': return '－';
        case 'modified': return '●';
        default: return '';
    }
}

function truncateSig(sig: string): string {
    if (sig.length > 50) return sig.substring(0, 47) + '...';
    return sig;
}

export class FunctionTreeItem extends vscode.TreeItem {
    functions?: FunctionInfo[];
}
