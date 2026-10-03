/**
 * commentCommands.ts — Issue #358 Row 7b (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * three comment-CRUD command registrations that all dispatch into the
 * `CommentStore` + `CommentsProvider` pair:
 *
 *   - codeatlas.addComment                → free-form comment via input box
 *   - codeatlas.showCommentsForSelection → focus the comments tree view
 *   - codeatlas.resolveComment            → mark a comment resolved
 *
 * Mechanical extraction — NO behavior change.
 */

import * as vscode from 'vscode';
import { analytics } from '../analytics/mixpanelService';
import type { CommentStore } from '../core/storage/commentStore';
import type { CommentsProvider } from '../views/commentsProvider';
import type { SnapshotStore } from '../core/storage/snapshotStore';

export interface CommentCommandDeps {
    commentStore: CommentStore;
    commentsProvider: CommentsProvider;
    snapshotStore: SnapshotStore;
}

export function registerCommentCommands(deps: CommentCommandDeps): vscode.Disposable[] {
    const { commentStore, commentsProvider, snapshotStore } = deps;

    const persist = (): void => {
        commentsProvider.setComments(commentStore.getAll());
        snapshotStore.setComments(commentStore.toJSON());
        snapshotStore.save();
    };

    return [
        vscode.commands.registerCommand('codeatlas.addComment', async () => {
            const body = await vscode.window.showInputBox({ prompt: 'Enter comment', placeHolder: 'Your comment...' });
            if (body) {
                analytics.track('comment_added');
                commentStore.add({
                    layer: 'file',
                    targetType: 'node',
                    targetId: 'manual',
                    anchor: { filePath: '' },
                    body,
                });
                persist();
            }
        }),

        vscode.commands.registerCommand('codeatlas.showCommentsForSelection', () => {
            analytics.track('comments_panel_opened');
            vscode.commands.executeCommand('codeatlas.comments.focus');
        }),

        vscode.commands.registerCommand('codeatlas.resolveComment', (comment: any) => {
            if (comment?.id) {
                analytics.track('comment_resolved');
                commentStore.resolve(comment.id);
                persist();
            }
        }),
    ];
}
