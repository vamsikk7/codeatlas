/**
 * microserviceLabel.test.ts — UX-20 (2026-06-03 v2)
 *
 * The L1 panel label was historically built as
 *   `System Design: ${meta.repoName ?? 'System Design'}`
 * which produced the duplicated breadcrumb "System Design: System
 * Design" in multi-repo skeletal mode (where `meta.repoName` was
 * undefined). Pin the new behaviour:
 *
 *   - bare "System Design" when no repo name is available
 *   - `System Design: <repo>` when a meaningful repo name is provided
 *   - bare "System Design" when the repo name is the literal layer title
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
    window: { showWarningMessage: vi.fn(), showErrorMessage: vi.fn(), showInformationMessage: vi.fn() },
    workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [{ uri: { fsPath: '/test' } }] },
    commands: { executeCommand: vi.fn() },
    env: { machineId: 't', sessionId: 't', appName: 'Code', uriScheme: 'vscode' },
    version: '1.0.0',
}));

import { microserviceLabel } from '../navigationHandlers';
import type { DiagramGraph } from '../../core/graph/graphTypes';

function g(meta: any): DiagramGraph {
    return {
        graphId: 'microservice:workspace',
        type: 'microservice',
        nodes: [],
        edges: [],
        anchors: {},
        meta,
    } as DiagramGraph;
}

describe('microserviceLabel — UX-20', () => {
    it('returns bare "System Design" when meta.repoName is missing (skeletal multi-repo)', () => {
        expect(microserviceLabel(g({ skeletal: true, repoCount: 3 }))).toBe('System Design');
    });

    it('returns bare "System Design" when meta is undefined', () => {
        expect(microserviceLabel(g(undefined as any))).toBe('System Design');
    });

    it('returns bare "System Design" when meta.repoName is empty / whitespace', () => {
        expect(microserviceLabel(g({ repoName: '' }))).toBe('System Design');
        expect(microserviceLabel(g({ repoName: '   ' }))).toBe('System Design');
    });

    it('returns "System Design: <repo>" when a meaningful repo name is present', () => {
        expect(microserviceLabel(g({ repoName: 'node-express-realworld-example-app' })))
            .toBe('System Design: node-express-realworld-example-app');
    });

    it('avoids the "System Design: System Design" duplicate when repoName matches the layer title', () => {
        expect(microserviceLabel(g({ repoName: 'System Design' }))).toBe('System Design');
        expect(microserviceLabel(g({ repoName: 'system design' }))).toBe('System Design');
    });
});
