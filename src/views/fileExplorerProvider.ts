import * as vscode from 'vscode';
import type { FileRecord, DiffStatus } from '../core/graph/graphTypes';

/**
 * Tree view provider for the File Explorer sidebar panel.
 * Lists scanned workspace files — click to open file dependency diagram.
 * Shows diff color coding when baseline and working data differ.
 */
export class FileExplorerProvider implements vscode.TreeDataProvider<FileTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private workingFiles: FileRecord[] = [];
    private baselineByPath = new Map<string, FileRecord>();
    private filter = '';

    /** Update with baseline + working data so diff status can be computed */
    setData(baseline: FileRecord[], working: FileRecord[]): void {
        this.baselineByPath = new Map(baseline.map(f => [f.path, f]));
        this.workingFiles = working;
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

    getTreeItem(element: FileTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: FileTreeItem): FileTreeItem[] {
        if (!element && this.filter) {
            // Flat filtered list — skip directory grouping
            const q = this.filter;
            const allFiles = [...this.workingFiles];
            // Include deleted files from baseline
            const workingPaths = new Set(this.workingFiles.map(f => f.path));
            for (const [, baseFile] of this.baselineByPath.entries()) {
                if (!workingPaths.has(baseFile.path)) allFiles.push(baseFile);
            }
            return allFiles
                .filter(file => file.path.toLowerCase().includes(q))
                .map(file => {
                    const fileName = file.path.split('/').pop() || file.path;
                    const diff = this.fileDiff(file);
                    const isDeleted = diff === 'deleted';
                    const item = new FileTreeItem(
                        isDeleted ? `${fileName} (deleted)` : fileName,
                        vscode.TreeItemCollapsibleState.None,
                    );
                    item.description = file.path;
                    item.contextValue = isDeleted ? 'fileItemDeleted' : 'fileItem';
                    item.filePath = file.path;
                    item.iconPath = new vscode.ThemeIcon(
                        diffFileIcon(diff),
                        diff !== 'unchanged' ? new vscode.ThemeColor(diffThemeColor(diff)) : undefined,
                    );
                    item.tooltip = file.path;
                    if (!isDeleted) {
                        item.command = {
                            command: 'codeatlas.openFileDiagramForPath',
                            title: 'Open File Diagram',
                            arguments: [file.path],
                        };
                    }
                    return item;
                });
        }

        if (!element) {
            // Group files by directory
            const byDir = new Map<string, FileRecord[]>();
            for (const file of this.workingFiles) {
                const parts = file.path.split('/');
                const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
                if (!byDir.has(dir)) byDir.set(dir, []);
                byDir.get(dir)!.push(file);
            }

            // Also collect deleted files (in baseline but not in working)
            const workingPaths = new Set(this.workingFiles.map(f => f.path));
            const deletedByDir = new Map<string, FileRecord[]>();
            for (const [path, baseFile] of this.baselineByPath.entries()) {
                if (!workingPaths.has(path)) {
                    const parts = path.split('/');
                    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
                    if (!deletedByDir.has(dir)) deletedByDir.set(dir, []);
                    deletedByDir.get(dir)!.push(baseFile);
                }
            }

            // Merge all dirs
            for (const [dir, files] of deletedByDir.entries()) {
                if (!byDir.has(dir)) byDir.set(dir, []);
                byDir.get(dir)!.push(...files);
            }

            const sortedDirs = [...byDir.keys()].sort();

            return sortedDirs.map((dir) => {
                const dirFiles = byDir.get(dir)!;
                const dirDiff = this.dirDiffStatus(dir);
                const item = new FileTreeItem(dir, vscode.TreeItemCollapsibleState.Expanded);

                let prefix = '';
                if (dirDiff === 'added') prefix = '＋ ';
                else if (dirDiff === 'deleted') prefix = '－ ';
                else if (dirDiff === 'modified') prefix = '● ';

                item.description = `${prefix}${dirFiles.length} file(s)`;
                item.iconPath = new vscode.ThemeIcon(
                    diffFolderIcon(dirDiff),
                    dirDiff !== 'unchanged' ? new vscode.ThemeColor(diffThemeColor(dirDiff)) : undefined,
                );
                item.contextValue = 'fileDir';
                item.dirFiles = dirFiles;
                return item;
            });
        }

        if (element.dirFiles) {
            return element.dirFiles.map((file) => {
                const fileName = file.path.split('/').pop() || file.path;
                const fnCount = file.symbols?.functions?.length || 0;
                const diff = this.fileDiff(file);
                const isDeleted = diff === 'deleted';
                const item = new FileTreeItem(
                    isDeleted ? `${fileName} (deleted)` : fileName,
                    vscode.TreeItemCollapsibleState.None,
                );
                item.description = isDeleted
                    ? '－ removed'
                    : `${diffBadge(diff)} ${fnCount} fn · ${file.symbols?.imports?.length || 0} imports`.trim();
                item.contextValue = isDeleted ? 'fileItemDeleted' : 'fileItem';
                item.filePath = file.path;
                item.iconPath = new vscode.ThemeIcon(
                    diffFileIcon(diff),
                    diff !== 'unchanged' ? new vscode.ThemeColor(diffThemeColor(diff)) : undefined,
                );
                item.tooltip = `${file.path}${diff !== 'unchanged' ? ` [${diff}]` : ''}`;
                if (!isDeleted) {
                    item.command = {
                        command: 'codeatlas.openFileDiagramForPath',
                        title: 'Open File Diagram',
                        arguments: [file.path],
                    };
                }
                return item;
            });
        }

        return [];
    }

    private fileDiff(file: FileRecord): DiffStatus {
        const base = this.baselineByPath.get(file.path);
        if (!base) return 'added';
        return base.hash !== file.hash ? 'modified' : 'unchanged';
    }

    private dirDiffStatus(dir: string): DiffStatus {
        const prefix = dir === '.' ? '' : dir + '/';
        let hasAdded = false;
        let hasModified = false;
        let hasDeleted = false;

        // Check working paths for added/modified
        for (const file of this.workingFiles) {
            if (file.path.startsWith(prefix) || dir === '.') {
                const diff = this.fileDiff(file);
                if (diff === 'added') hasAdded = true;
                if (diff === 'modified') hasModified = true;
            }
        }

        // Check baseline for deleted (files present in baseline but not in working)
        const workingPaths = new Set(this.workingFiles.map(f => f.path));
        for (const [path] of this.baselineByPath.entries()) {
            if ((path.startsWith(prefix) || dir === '.') && !workingPaths.has(path)) {
                hasDeleted = true;
            }
        }

        if (hasModified || (hasAdded && hasDeleted)) return 'modified';
        if (hasAdded) return 'added';
        if (hasDeleted) return 'deleted';
        return 'unchanged';
    }
}

/** Reliable git-decoration theme colors for diff states */
function diffThemeColor(diff: DiffStatus): string {
    switch (diff) {
        case 'added': return 'gitDecoration.addedResourceForeground';    // green
        case 'deleted': return 'gitDecoration.deletedResourceForeground';  // red
        case 'modified': return 'gitDecoration.modifiedResourceForeground'; // orange/yellow
        default: return 'foreground';
    }
}

/** Distinct icons per diff state for files */
function diffFileIcon(diff: DiffStatus): string {
    switch (diff) {
        case 'added': return 'diff-added';      // ＋ green file
        case 'deleted': return 'diff-removed';    // － red file
        case 'modified': return 'diff-modified';   // ● orange file
        default: return 'file-code';
    }
}

/** Distinct icons per diff state for folders */
function diffFolderIcon(diff: DiffStatus): string {
    switch (diff) {
        case 'added': return 'folder-opened';   // brighter folder
        case 'deleted': return 'folder';          // normal (contents gone)
        case 'modified': return 'folder-opened';   // highlight open
        default: return 'folder';
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

export class FileTreeItem extends vscode.TreeItem {
    dirFiles?: FileRecord[];
    filePath?: string;
}
