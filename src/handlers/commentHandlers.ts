/**
 * commentHandlers.ts
 *
 * Issues #173, #174, #194: Comment message handlers extracted from extension.ts.
 * Handles addComment and resolveComment.
 *
 * addComment adds a comment to the comment store, updates comment counts on all
 * relevant graph nodes (including parent clusters/services via Issue 133 — Comment count bubbled up to parent layers),
 * persists to state.json and .codeatlas/comments.md, and broadcasts the updated
 * comment list to all panels and browser clients.
 */

import type { HandlerContext, MessageHandler } from './handlerContext';
import { withErrorHandling } from './handlerContext';
import { writeCommentsMd } from '../core/export/commentsExporter';
import { forEachGraph } from '../core/storage/lazyGraphMap';

/**
 * Register all comment-related message handlers with the message router.
 *
 * @param register - Function to register a (messageType, handler, module) triple
 * @param ctx - Shared handler context
 */
export function registerCommentHandlers(
    register: (messageType: string, handler: MessageHandler, module: string) => void,
    ctx: HandlerContext,
): void {
    const MODULE = 'CommentHandlers';

    // #547: Use the platform adapter for cross-runtime broadcast; sidebar
    // refresh (`commentsProvider.setComments`) is optional-chained because
    // standalone has no sidebar tree view — the call is a silent no-op there.

    // ── addComment ────────────────────────────────────────────────────────────
    register('addComment', (message) => {
        withErrorHandling(ctx, 'addComment', async () => {
            ctx.commentStore.add({
                layer: (message.layer as any) ?? 'file',
                targetType: message.targetType,
                targetId: message.targetId,
                anchor: message.anchor
                    ? { filePath: message.anchor.filePath ?? '', symbol: message.anchor.symbol }
                    : { filePath: '' },
                body: message.body,
                source: message.source === 'ai' ? 'ai' : undefined,
            });
            ctx.commentsProvider?.setComments(ctx.commentStore.getAll());
            ctx.snapshotStore.setComments(ctx.commentStore.toJSON());
            writeCommentsMd(ctx.workspaceRoot, ctx.commentStore.getAll(), ctx.snapshotStore.getWorking());

            // Recompute commentCount across every graph in a single streaming
            // pass (#355: avoids realizing all graphs in memory at once on
            // huge workspaces). Mutated graphs are written back via
            // updateWorkingGraph so they're persisted in the save() below
            // and broadcast in the second pass.
            const allComments = ctx.commentStore.getAll();
            const working = ctx.snapshotStore.getWorking();
            const clusters = working.clusters ?? {};
            const services = working.services ?? {};
            const updatedGraphIds: string[] = [];
            forEachGraph(working.graphs, (gid, graph) => {
                let mutated = false;
                for (const node of graph.nodes) {
                    let count: number | undefined;
                    if (node.type === 'cluster' && node.id && clusters[node.id]) {
                        const clusterFiles = new Set(clusters[node.id].files);
                        count = allComments.filter(c => c.anchor?.filePath && clusterFiles.has(c.anchor.filePath)).length;
                    } else if (node.type === 'service' && node.meta && (node.meta as any).serviceId && services[(node.meta as any).serviceId]) {
                        const svc = services[(node.meta as any).serviceId];
                        const prefix = svc.rootPath.endsWith('/') ? svc.rootPath : svc.rootPath + '/';
                        count = allComments.filter(c => c.anchor?.filePath && (c.anchor.filePath.startsWith(prefix) || c.anchor.filePath === svc.rootPath)).length;
                    } else {
                        count = allComments.filter(
                            c =>
                                c.targetId === node.id ||
                                (c.anchor?.filePath && c.anchor?.symbol &&
                                    node.anchor?.filePath === c.anchor.filePath &&
                                    node.anchor?.symbol === c.anchor.symbol),
                        ).length;
                    }
                    if (count !== undefined && count > 0) {
                        if (!node.meta) node.meta = {};
                        (node.meta as any).commentCount = count;
                        mutated = true;
                    }
                }
                if (mutated) {
                    ctx.snapshotStore.updateWorkingGraph(gid, graph);
                    updatedGraphIds.push(gid);
                }
            });
            ctx.snapshotStore.save();

            // Broadcast only the graphs that gained commentCount badges.
            for (const gid of updatedGraphIds) {
                const graph = working.graphs[gid];
                if (!graph) continue;
                ctx.platform.updateGraph(gid, graph);
            }
            // Broadcast full comment list for browser comments panel
            const commentsList = ctx.commentStore.getAll();
            ctx.platform.broadcast({ type: 'showComments', comments: commentsList });
        });
    }, MODULE);

    // ── resolveComment ────────────────────────────────────────────────────────
    register('resolveComment', (message) => {
        withErrorHandling(ctx, 'resolveComment', async () => {
            ctx.commentStore.resolve(message.commentId);
            ctx.commentsProvider?.setComments(ctx.commentStore.getAll());
            ctx.snapshotStore.setComments(ctx.commentStore.toJSON());
            ctx.snapshotStore.save();
            writeCommentsMd(ctx.workspaceRoot, ctx.commentStore.getAll(), ctx.snapshotStore.getWorking());
            // Broadcast updated comment list
            ctx.platform.broadcast({ type: 'showComments', comments: ctx.commentStore.getAll() });
        });
    }, MODULE);
}
