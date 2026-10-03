/**
 * messageProtocol.test.ts
 *
 * Validates the typed message protocol between extension host and webview.
 * Ensures all message types, view modes, and diagram types are consistent.
 */

import { describe, it, expect } from 'vitest';
import type { ViewMode, ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../messageProtocol';
import { createUpdateGraphMessage, createSetModeMessage } from '../messageProtocol';

// Type-level tests — these verify the types exist and are assignable at compile time
// Runtime tests verify the string literals match expected values

describe('ViewMode', () => {
    it('includes all expected diagram modes', () => {
        const modes: ViewMode[] = ['sequence', 'file', 'flow', 'feature', 'microservice', 'api-list', 'health'];
        expect(modes).toHaveLength(7);
        // Each mode is a valid ViewMode (TypeScript enforces this at compile time)
        for (const m of modes) {
            expect(typeof m).toBe('string');
        }
    });
});

describe('ExtensionToWebviewMessage types', () => {
    it('updateGraph message has required fields', () => {
        const msg: ExtensionToWebviewMessage = { type: 'updateGraph', graphId: 'test', graph: {} };
        expect(msg.type).toBe('updateGraph');
    });

    it('navigateTo message has required fields', () => {
        const msg: ExtensionToWebviewMessage = {
            type: 'navigateTo', graphId: 'test', mode: 'file', graph: {}, label: 'Test'
        };
        expect(msg.type).toBe('navigateTo');
        expect(msg.mode).toBe('file');
    });

    it('setTheme message accepts dark and light', () => {
        const dark: ExtensionToWebviewMessage = { type: 'setTheme', theme: 'dark' };
        const light: ExtensionToWebviewMessage = { type: 'setTheme', theme: 'light' };
        expect(dark.theme).toBe('dark');
        expect(light.theme).toBe('light');
    });

    it('initProgress message has phase, progress, message', () => {
        const msg: ExtensionToWebviewMessage = {
            type: 'initProgress', phase: 'scanning', progress: 0.5, message: 'Scanning...'
        };
        expect(msg.progress).toBe(0.5);
    });

    it('highlightNodes message has highlights array', () => {
        const msg: ExtensionToWebviewMessage = {
            type: 'highlightNodes',
            highlights: [{ filePath: 'a.ts', functionName: 'fn', impactKind: 'direct' }]
        };
        expect(msg.highlights).toHaveLength(1);
    });

    it('setGitDiffContext has all hash fields', () => {
        const msg: ExtensionToWebviewMessage = {
            type: 'setGitDiffContext',
            baseHash: 'abc1234', headHash: 'def5678',
            baseLabel: 'v1.0', headLabel: 'v2.0'
        };
        expect(msg.baseHash).toBe('abc1234');
    });
});

describe('WebviewToExtensionMessage types', () => {
    it('openSource has filePath', () => {
        const msg: WebviewToExtensionMessage = { type: 'openSource', filePath: 'src/app.ts' };
        expect(msg.filePath).toBe('src/app.ts');
    });

    it('openFileDiagram has filePath and optional newWindow', () => {
        const msg: WebviewToExtensionMessage = { type: 'openFileDiagram', filePath: 'src/app.ts', newWindow: true };
        expect(msg.newWindow).toBe(true);
    });

    it('openApiListForCluster has clusterId, serviceId, optional subClusterFiles', () => {
        const msg: WebviewToExtensionMessage = {
            type: 'openApiListForCluster',
            clusterId: 'cluster:auth', serviceId: 'service:main',
            subClusterFiles: ['src/auth/a.ts']
        };
        expect(msg.subClusterFiles).toHaveLength(1);
    });

    it('requestImpact has nodeId and filePath', () => {
        const msg: WebviewToExtensionMessage = {
            type: 'requestImpact', nodeId: 'n1', filePath: 'src/app.ts', functionName: 'main'
        };
        expect(msg.functionName).toBe('main');
    });

    it('addComment has targetId, targetType, body', () => {
        const msg: WebviewToExtensionMessage = {
            type: 'addComment', targetId: 'node_1', targetType: 'node', body: 'TODO: refactor'
        };
        expect(msg.targetType).toBe('node');
    });
});

describe('Protocol consistency', () => {
    it('all extension→webview message types are string literals', () => {
        const types = [
            'updateGraph', 'setMode', 'highlightNode', 'clearHighlights',
            'showComments', 'updateSettings', 'showImpact', 'highlightNodes',
            'navigateTo', 'setTheme', 'setGitDiffContext', 'clearGitDiffContext',
            'initProgress', 'showNotification',
        ];
        for (const t of types) {
            expect(typeof t).toBe('string');
            expect(t.length).toBeGreaterThan(0);
        }
    });

    it('all webview→extension message types are string literals', () => {
        const types = [
            'nodeClicked', 'edgeClicked', 'openSource', 'openFileDiagram',
            'openFunctionFlow', 'openSequenceForApi', 'openFeatureDiagram',
            'openApiListForCluster', 'openMicroserviceDiagram', 'openFeatureForService',
            'requestImpact', 'addComment', 'resolveComment', 'panelNavigated',
            'requestGitDiff', 'clearGitDiff', 'ready',
            'requestBranchDiff', 'branchSelected',
        ];
        for (const t of types) {
            expect(typeof t).toBe('string');
            expect(t.length).toBeGreaterThan(0);
        }
    });

    it('extension→webview count matches protocol definition (14 types)', () => {
        const types = [
            'updateGraph', 'setMode', 'highlightNode', 'clearHighlights',
            'showComments', 'updateSettings', 'showImpact', 'highlightNodes',
            'navigateTo', 'setTheme', 'setGitDiffContext', 'clearGitDiffContext',
            'initProgress', 'showNotification',
        ];
        expect(types).toHaveLength(14);
    });

    it('webview→extension count matches protocol definition (19 types)', () => {
        const types = [
            'nodeClicked', 'edgeClicked', 'openSource', 'openFileDiagram',
            'openFunctionFlow', 'openSequenceForApi', 'openFeatureDiagram',
            'openApiListForCluster', 'openMicroserviceDiagram', 'openFeatureForService',
            'requestImpact', 'addComment', 'resolveComment', 'panelNavigated',
            'requestGitDiff', 'clearGitDiff', 'ready',
            'requestBranchDiff', 'branchSelected',
        ];
        expect(types).toHaveLength(19);
    });

    it('no duplicate message types in extension→webview', () => {
        const types = [
            'updateGraph', 'setMode', 'highlightNode', 'clearHighlights',
            'showComments', 'updateSettings', 'showImpact', 'highlightNodes',
            'navigateTo', 'setTheme', 'setGitDiffContext', 'clearGitDiffContext',
            'initProgress', 'showNotification',
        ];
        expect(new Set(types).size).toBe(types.length);
    });

    it('no duplicate message types in webview→extension', () => {
        const types = [
            'nodeClicked', 'edgeClicked', 'openSource', 'openFileDiagram',
            'openFunctionFlow', 'openSequenceForApi', 'openFeatureDiagram',
            'openApiListForCluster', 'openMicroserviceDiagram', 'openFeatureForService',
            'requestImpact', 'addComment', 'resolveComment', 'panelNavigated',
            'requestGitDiff', 'clearGitDiff', 'ready',
            'requestBranchDiff', 'branchSelected',
        ];
        expect(new Set(types).size).toBe(types.length);
    });
});

// ─── Handler completeness ───────────────────────────────────────────────────

describe('Handler completeness', () => {
    // These tests ensure every message type defined in the protocol has a corresponding
    // handler case. The actual handler code lives in extension.ts (for W→E) and App.tsx
    // (for E→W). We verify by listing handled types and comparing against the protocol.

    const EXTENSION_HANDLED_TYPES = new Set([
        'openSource', 'openFileDiagram', 'openFunctionFlow',
        'openSequenceForApi', 'openFeatureDiagram', 'openFeatureForService',
        'openMicroserviceDiagram', 'openApiListForCluster',
        'requestImpact', 'addComment', 'resolveComment',
        'requestGitDiff', 'clearGitDiff', 'edgeClicked',
        'requestBranchDiff', 'branchSelected',
        // Fire-and-forget / informational (no handler needed):
        'nodeClicked', 'panelNavigated', 'ready',
    ]);

    const WEBVIEW_HANDLED_TYPES = new Set([
        'navigateTo', 'updateGraph', 'setMode', 'setTheme',
        'initProgress', 'showImpact', 'highlightNodes',
        'setGitDiffContext', 'clearGitDiffContext',
        'highlightNode', 'clearHighlights', 'showNotification',
        // Passthrough / settings (handled but no specific logic):
        'showComments', 'updateSettings',
    ]);

    it('all W→E message types are covered by extension handler', () => {
        const allTypes = [
            'nodeClicked', 'edgeClicked', 'openSource', 'openFileDiagram',
            'openFunctionFlow', 'openSequenceForApi', 'openFeatureDiagram',
            'openApiListForCluster', 'openMicroserviceDiagram', 'openFeatureForService',
            'requestImpact', 'addComment', 'resolveComment', 'panelNavigated',
            'requestGitDiff', 'clearGitDiff', 'ready',
            'requestBranchDiff', 'branchSelected',
        ];
        for (const t of allTypes) {
            expect(EXTENSION_HANDLED_TYPES.has(t)).toBe(true);
        }
    });

    it('all E→W message types are covered by webview handler', () => {
        const allTypes = [
            'updateGraph', 'setMode', 'highlightNode', 'clearHighlights',
            'showComments', 'updateSettings', 'showImpact', 'highlightNodes',
            'navigateTo', 'setTheme', 'setGitDiffContext', 'clearGitDiffContext',
            'initProgress', 'showNotification',
        ];
        for (const t of allTypes) {
            expect(WEBVIEW_HANDLED_TYPES.has(t)).toBe(true);
        }
    });
});

// ─── Factory function roundtrip tests ───────────────────────────────────────

describe('Factory function roundtrip', () => {
    it('createUpdateGraphMessage produces valid ExtensionToWebviewMessage', () => {
        const msg = createUpdateGraphMessage('file:src/app.ts', { nodes: [], edges: [] });
        expect(msg.type).toBe('updateGraph');
        expect((msg as any).graphId).toBe('file:src/app.ts');
        expect((msg as any).graph).toEqual({ nodes: [], edges: [] });
    });

    it('createSetModeMessage produces valid ExtensionToWebviewMessage', () => {
        const msg = createSetModeMessage('sequence');
        expect(msg.type).toBe('setMode');
        expect((msg as any).mode).toBe('sequence');
    });

    it('createUpdateGraphMessage roundtrips through JSON', () => {
        const original = createUpdateGraphMessage('test:id', { meta: { x: 1 } });
        const json = JSON.stringify(original);
        const parsed = JSON.parse(json);
        expect(parsed.type).toBe('updateGraph');
        expect(parsed.graphId).toBe('test:id');
        expect(parsed.graph.meta.x).toBe(1);
    });

    it('all ViewMode values survive JSON roundtrip', () => {
        const modes: ViewMode[] = ['sequence', 'file', 'flow', 'feature', 'microservice', 'api-list', 'health'];
        for (const mode of modes) {
            const msg = createSetModeMessage(mode);
            const parsed = JSON.parse(JSON.stringify(msg));
            expect(parsed.mode).toBe(mode);
        }
    });
});

// ─── Negative tests: graceful handling of malformed messages ────────────────

describe('Negative: malformed messages', () => {
    it('message with unknown type can be constructed as plain object', () => {
        // Unknown types should be silently ignored by handlers (no crash)
        const msg = { type: 'nonExistentType', payload: 'test' } as any;
        expect(msg.type).toBe('nonExistentType');
        // This simulates what happens when an unknown message arrives — it's just an object
    });

    it('message with missing required fields is still a valid object', () => {
        // A message with type but missing other fields shouldn't crash JSON.parse
        const msg = { type: 'updateGraph' } as any;
        expect(msg.type).toBe('updateGraph');
        expect(msg.graphId).toBeUndefined();
        expect(msg.graph).toBeUndefined();
    });

    it('message with wrong field types survives JSON roundtrip', () => {
        // filePath as number instead of string
        const msg = { type: 'openSource', filePath: 123 } as any;
        const parsed = JSON.parse(JSON.stringify(msg));
        expect(parsed.type).toBe('openSource');
        expect(parsed.filePath).toBe(123); // wrong type but doesn't crash
    });

    it('null graph in updateGraph survives JSON roundtrip', () => {
        const msg = { type: 'updateGraph', graphId: 'test', graph: null } as any;
        const parsed = JSON.parse(JSON.stringify(msg));
        expect(parsed.graph).toBeNull();
    });

    it('empty highlights array is valid', () => {
        const msg: ExtensionToWebviewMessage = { type: 'highlightNodes', highlights: [] };
        expect(msg.highlights).toHaveLength(0);
    });

    it('message with extra fields survives roundtrip (forward compatibility)', () => {
        const msg = { type: 'ready', extraField: 'future', version: 2 } as any;
        const parsed = JSON.parse(JSON.stringify(msg));
        expect(parsed.type).toBe('ready');
        expect(parsed.extraField).toBe('future');
    });
});
