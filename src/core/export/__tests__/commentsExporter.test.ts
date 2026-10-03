import { describe, it, expect } from 'vitest';
import { generateCommentsMd } from '../commentsExporter';
import type { Comment, Snapshot } from '../../graph/graphTypes';

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
    return {
        files: {},
        apiIndex: {
            'api:login': { apiId: 'api:login', method: 'POST', route: '/auth/login', handlerName: 'login', filePath: 'src/auth.ts', anchor: { filePath: 'src/auth.ts' } },
        },
        graphs: {},
        clusters: {
            'cluster:auth': { id: 'cluster:auth', label: 'auth', name: 'Authentication', files: ['src/auth.ts'], entryPoints: [], internalCallCount: 0, externalCallCount: 0, serviceId: 'service:backend' },
        },
        services: {
            'service:backend': { id: 'service:backend', name: 'Backend', rootPath: 'src/', technology: 'express', exposedApiCount: 2, consumedUrls: [], consumedServices: [] },
        },
        ...overrides,
    };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
    return {
        id: 'c_1', status: 'open', layer: 'sequence',
        targetType: 'node', targetId: 'p_1',
        anchor: { filePath: 'src/auth.ts', symbol: 'login' },
        body: 'Needs error handling for expired tokens',
        author: 'local', createdAt: '2026-04-19T16:50:00Z',
        ...overrides,
    };
}

describe('generateCommentsMd', () => {
    it('produces correct markdown for a single open comment', () => {
        const md = generateCommentsMd([makeComment()], makeSnapshot());
        expect(md).toContain('# CodeAtlas Comments');
        expect(md).toContain('[OPEN] login');
        expect(md).toContain('**Layer:** L3 Sequence');
        expect(md).toContain('**File:** src/auth.ts');
        expect(md).toContain('**Function:** login');
        expect(md).toContain('**API:** POST /auth/login');
        expect(md).toContain('**Cluster:** Authentication');
        expect(md).toContain('**Service:** Backend');
        expect(md).toContain('Needs error handling');
    });

    it('shows RESOLVED status for resolved comments', () => {
        const md = generateCommentsMd([makeComment({ status: 'resolved' })], makeSnapshot());
        expect(md).toContain('[RESOLVED] login');
    });

    it('handles comments with no anchor gracefully', () => {
        const md = generateCommentsMd([makeComment({ anchor: { filePath: '' } })], makeSnapshot());
        expect(md).toContain('[OPEN]');
        expect(md).not.toContain('**Cluster:**');
    });

    it('returns placeholder for empty comments array', () => {
        const md = generateCommentsMd([], makeSnapshot());
        expect(md).toContain('No comments yet');
    });

    it('maps layer names correctly', () => {
        const md = generateCommentsMd([makeComment({ layer: 'flow' })], makeSnapshot());
        expect(md).toContain('L5 Flow');
    });

    it('shows counts in header', () => {
        const comments = [makeComment(), makeComment({ id: 'c_2', status: 'resolved' })];
        const md = generateCommentsMd(comments, makeSnapshot());
        expect(md).toContain('1 open');
        expect(md).toContain('1 resolved');
    });
});
