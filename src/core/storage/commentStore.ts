import type { Comment, Anchor, DiagramType } from '../graph/graphTypes';

let commentIdCounter = 0;

function generateCommentId(): string {
    // Issue 222: Add random suffix for uniqueness across concurrent calls
    return `c_${++commentIdCounter}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Manages comments attached to diagram elements.
 * Supports CRUD operations and re-anchoring on rebuild.
 */
export class CommentStore {
    private comments: Comment[] = [];

    constructor(initialComments: Comment[] = []) {
        this.comments = [...initialComments];
    }

    /**
     * Get all comments
     */
    getAll(): Comment[] {
        return [...this.comments];
    }

    /**
     * Get comments filtered by layer
     */
    getByLayer(layer: DiagramType): Comment[] {
        return this.comments.filter((c) => c.layer === layer);
    }

    /**
     * Get comments for a specific target element
     */
    getForTarget(targetId: string): Comment[] {
        return this.comments.filter((c) => c.targetId === targetId);
    }

    /**
     * Get open comments only
     */
    getOpen(): Comment[] {
        return this.comments.filter((c) => c.status === 'open');
    }

    /**
     * Get resolved comments only
     */
    getResolved(): Comment[] {
        return this.comments.filter((c) => c.status === 'resolved');
    }

    /**
     * Add a new comment
     */
    add(params: {
        layer: DiagramType;
        targetType: 'node' | 'edge';
        targetId: string;
        anchor: Anchor;
        body: string;
        author?: string;
        /** #539 — tag user comments authored from the AI Review popover. */
        source?: 'user' | 'ai';
    }): Comment {
        const comment: Comment = {
            id: generateCommentId(),
            status: 'open',
            layer: params.layer,
            targetType: params.targetType,
            targetId: params.targetId,
            anchor: params.anchor,
            body: params.body,
            author: params.author || 'local',
            createdAt: new Date().toISOString(),
            ...(params.source ? { source: params.source } : {}),
        };
        this.comments.push(comment);
        return comment;
    }

    /**
     * Resolve a comment by ID
     */
    resolve(id: string): boolean {
        const comment = this.comments.find((c) => c.id === id);
        if (!comment) return false;
        comment.status = 'resolved';
        return true;
    }

    /**
     * Reopen a resolved comment
     */
    reopen(id: string): boolean {
        const comment = this.comments.find((c) => c.id === id);
        if (!comment) return false;
        comment.status = 'open';
        return true;
    }

    /**
     * Delete a comment by ID
     */
    delete(id: string): boolean {
        const idx = this.comments.findIndex((c) => c.id === id);
        if (idx === -1) return false;
        this.comments.splice(idx, 1);
        return true;
    }

    /**
     * Re-anchor comments after a rebuild.
     * Tries to match comments to new graph elements using the anchor resolution strategy:
     * 1. Exact source span match
     * 2. Same stable key + nearby span
     * 3. Same symbol name in file
     * 4. Mark as orphaned if unresolved
     * 
     * @param availableAnchors Map of targetId -> Anchor from the new graph
     * @returns Array of orphaned comment IDs
     */
    reanchor(availableAnchors: Map<string, Anchor>): string[] {
        const orphaned: string[] = [];

        // #223: append the previous anchor to anchor_history before mutating
        // so callers can later inspect where a comment used to live.
        const recordHistory = (comment: any, reason: string) => {
            const history = Array.isArray(comment.anchor_history) ? comment.anchor_history : [];
            history.push({
                anchor: comment.anchor,
                capturedAt: Date.now(),
                reason,
            });
            // Cap at 10 entries to keep the JSON small.
            comment.anchor_history = history.slice(-10);
        };

        // Issue #403: callers may namespace map keys as `${graphId}::${nodeId}`
        // so cross-graph node-ID collisions can't silently clobber L4 entries
        // with L3/L5 ones. Strip the namespace before assigning to
        // `comment.targetId` — downstream code expects the raw node id.
        const rawTargetId = (key: string): string => {
            const idx = key.lastIndexOf('::');
            return idx >= 0 ? key.slice(idx + 2) : key;
        };

        for (const comment of this.comments) {
            if (!comment.anchor) {
                orphaned.push(comment.id);
                continue;
            }

            // Strategy 1: Exact span match.
            // Issue #402: when both the comment and the candidate carry a
            // `stableKey`, require those to ALSO agree. Without this guard,
            // adding lines to one function shifts neighbouring functions onto
            // the original function's old span coordinates and another node
            // wins via span-match alone — silently re-anchoring the comment
            // to the wrong function.
            // Additional guard: require both anchors to actually HAVE a span.
            // `undefined === undefined` would otherwise match every anchor on
            // file root / cluster / service nodes (which carry no span) to
            // every other span-less anchor — including comments whose
            // original anchor never carried a span.
            let matched = false;
            for (const [targetId, anchor] of availableAnchors.entries()) {
                if (
                    anchor.filePath === comment.anchor.filePath &&
                    anchor.span && comment.anchor.span &&
                    anchor.span.start === comment.anchor.span.start &&
                    anchor.span.end === comment.anchor.span.end
                ) {
                    if (
                        comment.anchor.stableKey &&
                        anchor.stableKey &&
                        comment.anchor.stableKey !== anchor.stableKey
                    ) {
                        continue;
                    }
                    const newId = rawTargetId(targetId);
                    if (comment.targetId !== newId) recordHistory(comment, 'span-match');
                    comment.targetId = newId;
                    comment.anchor = { ...anchor };
                    matched = true;
                    break;
                }
            }
            if (matched) continue;

            // Strategy 2: Same stable key (exact match)
            if (comment.anchor.stableKey) {
                for (const [targetId, anchor] of availableAnchors.entries()) {
                    if (anchor.stableKey === comment.anchor.stableKey) {
                        comment.targetId = rawTargetId(targetId);
                        comment.anchor = { ...anchor };
                        matched = true;
                        break;
                    }
                }
            }
            if (matched) continue;

            // Strategy 2b: Content-based key (filePath:symbol) — survives counter resets
            if (comment.anchor.filePath && comment.anchor.symbol) {
                const contentKey = `${comment.anchor.filePath}:${comment.anchor.symbol}`;
                for (const [targetId, anchor] of availableAnchors.entries()) {
                    if (anchor.filePath && anchor.symbol && `${anchor.filePath}:${anchor.symbol}` === contentKey) {
                        comment.targetId = rawTargetId(targetId);
                        comment.anchor = { ...anchor };
                        matched = true;
                        break;
                    }
                }
            }
            if (matched) continue;

            // Strategy 3: Same symbol in same file
            if (comment.anchor.symbol) {
                for (const [targetId, anchor] of availableAnchors.entries()) {
                    if (
                        anchor.filePath === comment.anchor.filePath &&
                        anchor.symbol === comment.anchor.symbol
                    ) {
                        comment.targetId = rawTargetId(targetId);
                        comment.anchor = { ...anchor };
                        matched = true;
                        break;
                    }
                }
            }
            if (matched) continue;

            // Strategy 4: Orphaned
            orphaned.push(comment.id);
        }

        return orphaned;
    }

    /**
     * Remove all comments
     */
    clear(): void {
        this.comments = [];
    }

    /**
     * Export comments as serializable array
     */
    toJSON(): Comment[] {
        return this.comments;
    }
}
