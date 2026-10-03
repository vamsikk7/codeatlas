import * as vscode from 'vscode';
import type { Comment, DiagramType } from '../core/graph/graphTypes';

/**
 * Tree view provider for Comments sidebar panel.
 * Groups comments by layer and file.
 */
export class CommentsProvider implements vscode.TreeDataProvider<CommentTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<CommentTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private comments: Comment[] = [];
    private showResolved: boolean = false;

    setComments(comments: Comment[]): void {
        this.comments = comments;
        this._onDidChangeTreeData.fire(undefined);
    }

    toggleShowResolved(): void {
        this.showResolved = !this.showResolved;
        this._onDidChangeTreeData.fire(undefined);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: CommentTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: CommentTreeItem): CommentTreeItem[] {
        const filtered = this.showResolved
            ? this.comments
            : this.comments.filter((c) => c.status === 'open');

        if (!element) {
            // Group by layer
            const layers: DiagramType[] = ['sequence', 'file', 'flow'];
            const result = layers
                .map((layer) => {
                    const layerComments = filtered.filter((c) => c.layer === layer);
                    if (layerComments.length === 0) return null;

                    const item = new CommentTreeItem(
                        `${layer.charAt(0).toUpperCase() + layer.slice(1)} Layer`,
                        vscode.TreeItemCollapsibleState.Expanded,
                    );
                    item.description = `${layerComments.length} comment(s)`;
                    item.iconPath = new vscode.ThemeIcon('comment');
                    item.layer = layer;
                    return item;
                })
                .filter(Boolean) as CommentTreeItem[];
            if (result.length === 0) {
                const empty = new CommentTreeItem('No comments', vscode.TreeItemCollapsibleState.None);
                empty.description = 'Right-click a node to add one';
                empty.iconPath = new vscode.ThemeIcon('comment');
                return [empty];
            }
            return result;
        }

        if (element.layer) {
            return filtered
                .filter((c) => c.layer === element.layer)
                .map((c) => {
                    const preview = c.body.length > 50 ? c.body.substring(0, 50) + '...' : c.body;
                    const item = new CommentTreeItem(preview, vscode.TreeItemCollapsibleState.None);
                    item.description = c.status === 'resolved' ? '✓ resolved' : '';
                    item.iconPath = new vscode.ThemeIcon(c.status === 'resolved' ? 'check' : 'comment-discussion');
                    item.tooltip = `${c.body}\n\nTarget: ${c.targetId}\nAuthor: ${c.author}\nCreated: ${c.createdAt}`;
                    item.comment = c;
                    item.command = {
                        command: 'codeatlas.showCommentsForSelection',
                        title: 'Show Comment',
                        arguments: [c],
                    };
                    return item;
                });
        }

        return [];
    }
}

export class CommentTreeItem extends vscode.TreeItem {
    layer?: DiagramType;
    comment?: Comment;
}
