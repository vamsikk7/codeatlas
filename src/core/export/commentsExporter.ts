/**
 * commentsExporter.ts
 *
 * Exports diagram comments to comments.md in the workspace root.
 * Format is optimized for LLM agent readability — each comment includes
 * full layer context (service, cluster, API, file, function).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Comment, Snapshot } from '../graph/graphTypes';
import { markdownAttributionFooter } from '../../lib/attribution';

const LAYER_LABELS: Record<string, string> = {
    flow: 'L5 Flow',
    file: 'L4 File',
    sequence: 'L3 Sequence',
    'api-list': 'L2b API List',
    feature: 'L2a Feature',
    microservice: 'L1 System Design',
    health: 'Health Dashboard',
};

/**
 * Generate comments.md content from comments + snapshot context.
 */
export function generateCommentsMd(comments: Comment[], snapshot: Snapshot): string {
    if (comments.length === 0) {
        return '# CodeAtlas Comments\n\nNo comments yet. Right-click any node in a diagram to add one.\n'
            + markdownAttributionFooter();
    }

    let md = '# CodeAtlas Comments\n\n';
    md += `> ${comments.filter(c => c.status === 'open').length} open, ${comments.filter(c => c.status === 'resolved').length} resolved\n\n`;

    for (const comment of comments) {
        const fp = comment.anchor?.filePath;
        const symbol = comment.anchor?.symbol;
        const layer = LAYER_LABELS[comment.layer] ?? comment.layer;
        const label = symbol || comment.targetId;
        const statusIcon = comment.status === 'open' ? 'OPEN' : 'RESOLVED';

        md += `## [${statusIcon}] ${label}\n`;
        md += `- **Layer:** ${layer}\n`;

        if (fp) {
            md += `- **File:** ${fp}\n`;
        }
        if (symbol) {
            md += `- **Function:** ${symbol}\n`;
        }

        // Resolve API context
        if (fp && snapshot.apiIndex) {
            for (const api of Object.values(snapshot.apiIndex)) {
                if (api.filePath === fp && (!symbol || api.handlerName === symbol)) {
                    md += `- **API:** ${api.method} ${api.route}\n`;
                    break;
                }
            }
        }

        // Resolve cluster context
        if (fp && snapshot.clusters) {
            for (const cluster of Object.values(snapshot.clusters)) {
                if (cluster.files.includes(fp)) {
                    md += `- **Cluster:** ${cluster.name ?? cluster.label}\n`;
                    if (cluster.serviceId) {
                        const service = snapshot.services?.[cluster.serviceId];
                        if (service) {
                            md += `- **Service:** ${service.name}\n`;
                        }
                    }
                    break;
                }
            }
        }

        md += `> ${comment.body}\n`;
        md += `- **Status:** ${comment.status}\n`;
        md += `- **Date:** ${comment.createdAt.split('T')[0]}\n`;
        md += '\n---\n\n';
    }

    md += markdownAttributionFooter();

    return md;
}

/**
 * Write comments.md to the workspace root.
 */
export function writeCommentsMd(workspaceRoot: string, comments: Comment[], snapshot: Snapshot): void {
    const content = generateCommentsMd(comments, snapshot);
    const filePath = path.join(workspaceRoot, 'comments.md');
    fs.writeFileSync(filePath, content, 'utf-8');
}
