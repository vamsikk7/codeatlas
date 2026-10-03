/**
 * diffPropagation.test.ts
 *
 * Comprehensive test suite for diff propagation across all 5 diagram layers (L1–L5).
 * Tests both JS/TS (Babel) and Java (tree-sitter) code paths, covering:
 *   - Add / Modify / Delete scenarios at each layer
 *   - Ghost nodes/edges for deleted elements (diff:'deleted' with red color)
 *   - Correct 'added' (green) / 'modified' (orange) / 'deleted' (red) / 'unchanged' statuses
 *   - Propagation: a change at a deeper layer bubbles up as 'modified' at ancestor layers
 *   - SyncOrchestrator integration: rebuildFile() + removeFile() ghost graph behavior
 *
 * Test project structure mirrors test-drift-java:
 *   backend/src/main/java/com/todo/
 *     features/todos/TodoController.java  (Spring @RestController with @RequestMapping)
 *     features/todos/TodoService.java
 *     features/auth/AuthController.java
 *     features/auth/AuthService.java
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Layer builders
import { buildFileGraph, buildFileGraphFromAnalysis, type BaselineSymbols } from '../graph/fileGraphBuilder';
import { buildFlowGraph, buildFlowGraphFromNode } from '../graph/flowGraphBuilder';
import { diffGraphs } from '../diff/graphDiff';
import { diffClusters } from '../analysis/communityDetector';
import { diffServices } from '../analysis/serviceDetector';
import { buildFeatureGraph } from '../graph/featureGraphBuilder';
import { buildMicroserviceGraph } from '../graph/microserviceGraphBuilder';

// SyncOrchestrator + Store
import { SyncOrchestrator } from '../sync/syncOrchestrator';
import { SnapshotStore } from '../storage/snapshotStore';
import { CommentStore } from '../storage/commentStore';

import type {
    DiagramGraph,
    GraphNode,
    Snapshot,
    FileRecord,
    FeatureCluster,
    ServiceRecord,
    DiffStatus,
} from '../graph/graphTypes';

// ─── Helper Factories ────────────────────────────────────────────────────────

function makeFileRecord(
    fp: string,
    hash: string,
    funcs: Array<{ name: string; bodyText: string; stableKey: string }> = [],
    content = '',
): FileRecord {
    return {
        path: fp,
        hash,
        mtime: 0,
        content,
        symbols: {
            functions: funcs.map(f => ({
                name: f.name,
                kind: 'function' as const,
                span: { start: 0, end: 0 },
                signature: `void ${f.name}()`,
                bodyText: f.bodyText,
                stableKey: f.stableKey,
            })),
            variables: [],
            imports: [],
        },
    };
}

function makeSnapshot(files: Record<string, FileRecord>): Snapshot {
    return { files, apiIndex: {}, graphs: {} };
}

function makeServiceRecord(id: string, rootPath: string, fileCount = 1): ServiceRecord {
    return {
        id,
        name: id.replace('service:', ''),
        rootPath,
        technology: 'spring',
        exposedApiCount: fileCount,
        consumedUrls: [],
        consumedServices: [],
        diff: 'unchanged',
    };
}

/** Wait for the SyncOrchestrator debounce to flush */
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Java source snippets (mimicking test-drift-java) ────────────────────────

const TODO_CONTROLLER_V1 = `
package com.todo.features.todos;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api/todos")
@RequiredArgsConstructor
public class TodoController {
    private final TodoService todoService;

    @PostMapping
    public ResponseEntity<?> addTodo(@RequestBody Map<String, String> body) {
        String title = body.get("title");
        if (title == null || title.trim().isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "Title is required"));
        }
        return ResponseEntity.ok(todoService.createTodo(title));
    }

    @GetMapping
    public ResponseEntity<?> listTodos() {
        return ResponseEntity.ok(todoService.listTodos());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> deleteTodo(@PathVariable Long id) {
        todoService.deleteTodo(id);
        return ResponseEntity.ok(Map.of("message", "Deleted"));
    }
}
`;

/** V2: adds a new endpoint, removes deleteTodo, modifies addTodo body */
const TODO_CONTROLLER_V2 = `
package com.todo.features.todos;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api/todos")
@RequiredArgsConstructor
public class TodoController {
    private final TodoService todoService;

    @PostMapping
    public ResponseEntity<?> addTodo(@RequestBody Map<String, String> body) {
        String title = body.get("title");
        if (title == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "Title required"));
        }
        // Added logging
        System.out.println("Creating todo: " + title);
        return ResponseEntity.ok(todoService.createTodo(title));
    }

    @GetMapping
    public ResponseEntity<?> listTodos() {
        return ResponseEntity.ok(todoService.listTodos());
    }

    @GetMapping("/favorites")
    public ResponseEntity<?> listFavorites() {
        return ResponseEntity.ok(todoService.listFavorites());
    }
}
`;

const TODO_SERVICE_V1 = `
package com.todo.features.todos;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class TodoService {
    private final TodoRepository todoRepository;

    public Object createTodo(String title) {
        return todoRepository.save(title);
    }

    public Object listTodos() {
        return todoRepository.findAll();
    }

    public void deleteTodo(Long id) {
        todoRepository.deleteById(id);
    }
}
`;

const TODO_SERVICE_V2 = `
package com.todo.features.todos;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class TodoService {
    private final TodoRepository todoRepository;

    public Object createTodo(String title) {
        // Validation added
        if (title == null) throw new IllegalArgumentException("Title required");
        return todoRepository.save(title.trim());
    }

    public Object listTodos() {
        return todoRepository.findAll();
    }

    public Object listFavorites() {
        return todoRepository.findByFavoriteTrue();
    }
}
`;

// ─── L5: Flow Graph Diff Tests ───────────────────────────────────────────────

describe('L5 Flow Graph — JS diff', () => {
    const baseCode = `
function processOrder(order) {
    if (!order.id) return null;
    const result = saveOrder(order);
    return result;
}`;

    it('unchanged: no diff when code is identical', () => {
        const graph = buildFlowGraph(baseCode, 'orders.js', 'processOrder', baseCode);
        const nodes = graph.nodes.filter(n => n.type !== 'terminal');
        expect(nodes.every(n => n.diff === 'unchanged' || !n.diff)).toBe(true);
    });

    it('added: new statement gets diff:added (green)', () => {
        const newCode = `
function processOrder(order) {
    if (!order.id) return null;
    const result = saveOrder(order);
    sendNotification(order);
    return result;
}`;
        const graph = buildFlowGraph(newCode, 'orders.js', 'processOrder', baseCode);
        // After consolidation, the added statement may be inside a merged block node.
        // Check both top-level nodes and per-line statements within consolidated blocks.
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        const addedInBlocks = graph.nodes
            .filter(n => n.meta?.statements)
            .flatMap(n => (n.meta!.statements as any[]).filter((s: any) => s.diff === 'added'));
        const allAdded = [...addedNodes, ...addedInBlocks];
        expect(allAdded.length).toBeGreaterThanOrEqual(1);
        expect(allAdded.some((n: any) => (n.label ?? '').includes('sendNotification'))).toBe(true);
    });

    it('deleted: removed statement gets diff:deleted ghost node (red)', () => {
        const newCode = `
function processOrder(order) {
    if (!order.id) return null;
    return null;
}`;
        const graph = buildFlowGraph(newCode, 'orders.js', 'processOrder', baseCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('no ghost nodes when no baseline provided', () => {
        const graph = buildFlowGraph(baseCode, 'orders.js');
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes).toHaveLength(0);
    });
});

// ─── L4: File Graph Diff Tests (JS) ──────────────────────────────────────────

describe('L4 File Graph — JS diff', () => {
    const baseCode = `
import express from 'express';
const config = { timeout: 5000 };

function createOrder(req, res) {
    const id = req.body.id;
    return res.json({ id });
}

function cancelOrder(req, res) {
    res.json({ cancelled: true });
}
`;

    it('added function: diff:added node appears (green)', () => {
        const newCode = `
import express from 'express';
const config = { timeout: 5000 };

function createOrder(req, res) {
    const id = req.body.id;
    return res.json({ id });
}

function cancelOrder(req, res) {
    res.json({ cancelled: true });
}

function listOrders(req, res) {
    return res.json([]);
}
`;
        const graph = buildFileGraph(newCode, 'orders.js', baseCode);
        const addedFuncs = graph.nodes.filter(n => n.diff === 'added' && n.type === 'function');
        expect(addedFuncs.some(n => n.label === 'listOrders')).toBe(true);
    });

    it('deleted function: ghost node with diff:deleted (red)', () => {
        const newCode = `
import express from 'express';
const config = { timeout: 5000 };

function createOrder(req, res) {
    const id = req.body.id;
    return res.json({ id });
}
`;
        const graph = buildFileGraph(newCode, 'orders.js', baseCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.some(n => n.label.includes('cancelOrder'))).toBe(true);
    });

    it('modified function: diff:modified (orange)', () => {
        const newCode = `
import express from 'express';
const config = { timeout: 10000 };

function createOrder(req, res) {
    const id = req.body.id;
    const timestamp = Date.now();
    return res.json({ id, timestamp });
}

function cancelOrder(req, res) {
    res.json({ cancelled: true });
}
`;
        const graph = buildFileGraph(newCode, 'orders.js', baseCode);
        const modifiedNodes = graph.nodes.filter(n => n.diff === 'modified');
        expect(modifiedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('file-level node becomes modified when any child changes', () => {
        const newCode = `
import express from 'express';
const config = { timeout: 5000 };

function createOrder(req, res) {
    const id = req.body.id;
    res.json({ id, extra: true });
}

function cancelOrder(req, res) {
    res.json({ cancelled: true });
}
`;
        const graph = buildFileGraph(newCode, 'orders.js', baseCode);
        const fileNode = graph.nodes.find(n => n.type === 'file');
        expect(fileNode?.diff).toBe('modified');
    });

    it('unchanged: file node and children stay unchanged when code identical', () => {
        const graph = buildFileGraph(baseCode, 'orders.js', baseCode);
        const fileNode = graph.nodes.find(n => n.type === 'file');
        expect(fileNode?.diff).toBe('unchanged');
        const changed = graph.nodes.filter(n => n.diff && n.diff !== 'unchanged');
        expect(changed).toHaveLength(0);
    });
});

// ─── L4: File Graph Diff Tests (Java via BaselineSymbols) ────────────────────

describe('L4 File Graph — non-JS (Java) diff via BaselineSymbols', () => {
    // Build baseline symbols from V1
    const baselineFunctions: BaselineSymbols['functions'] = [
        { name: 'addTodo', signature: 'ResponseEntity addTodo()', bodyText: 'return todoService.createTodo(title);', stableKey: 'function:addTodo' },
        { name: 'listTodos', signature: 'ResponseEntity listTodos()', bodyText: 'return todoService.listTodos();', stableKey: 'function:listTodos' },
        { name: 'deleteTodo', signature: 'ResponseEntity deleteTodo()', bodyText: 'todoService.deleteTodo(id); return ok;', stableKey: 'function:deleteTodo' },
    ];
    const baselineSymbols: BaselineSymbols = {
        functions: baselineFunctions,
        variables: [],
        imports: [
            { source: 'org.springframework.http.ResponseEntity', stableKey: 'import:ResponseEntity' },
        ],
    };

    // Working analysis with addTodo modified, deleteTodo removed, listFavorites added
    function makeAnalysis(entities: Array<{ kind: string; name: string; key: string; signature: string; bodyText: string }>) {
        return {
            filePath: 'TodoController.java',
            language: 'java' as const,
            entities: entities.map(e => ({
                ...e,
                locText: `${e.name} body`,
                calls: new Set<string>(),
                memberCalls: new Map<string, Set<string>>(),
                node: null,
            })),
            importsByLocal: new Map<string, string>([
                ['ResponseEntity', 'org.springframework.http.ResponseEntity'],
            ]),
            injectedDeps: new Map<string, string>(),
            // buildFileGraphFromAnalysis also accesses analysis.funcs
            funcs: new Map<string, any>(),
        };
    }

    it('added method: diff:added (green)', () => {
        const analysis = makeAnalysis([
            { kind: 'function', name: 'addTodo', key: 'function:addTodo', signature: 'ResponseEntity addTodo()', bodyText: 'return todoService.createTodo(title);' },
            { kind: 'function', name: 'listTodos', key: 'function:listTodos', signature: 'ResponseEntity listTodos()', bodyText: 'return todoService.listTodos();' },
            { kind: 'function', name: 'listFavorites', key: 'function:listFavorites', signature: 'ResponseEntity listFavorites()', bodyText: 'return todoService.listFavorites();' },
        ]);
        const graph = buildFileGraphFromAnalysis(analysis as any, 'TodoController.java', baselineSymbols);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.some(n => n.label === 'listFavorites')).toBe(true);
    });

    it('deleted method: ghost node with diff:deleted (red)', () => {
        const analysis = makeAnalysis([
            { kind: 'function', name: 'addTodo', key: 'function:addTodo', signature: 'ResponseEntity addTodo()', bodyText: 'return todoService.createTodo(title);' },
            { kind: 'function', name: 'listTodos', key: 'function:listTodos', signature: 'ResponseEntity listTodos()', bodyText: 'return todoService.listTodos();' },
            // deleteTodo is gone
        ]);
        const graph = buildFileGraphFromAnalysis(analysis as any, 'TodoController.java', baselineSymbols);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.some(n => n.label.includes('deleteTodo'))).toBe(true);
    });

    it('modified method: diff:modified (orange)', () => {
        const analysis = makeAnalysis([
            {
                kind: 'function', name: 'addTodo', key: 'function:addTodo',
                signature: 'ResponseEntity addTodo()',
                bodyText: 'System.out.println("Creating"); return todoService.createTodo(title);', // changed
            },
            { kind: 'function', name: 'listTodos', key: 'function:listTodos', signature: 'ResponseEntity listTodos()', bodyText: 'return todoService.listTodos();' },
            { kind: 'function', name: 'deleteTodo', key: 'function:deleteTodo', signature: 'ResponseEntity deleteTodo()', bodyText: 'todoService.deleteTodo(id); return ok;' },
        ]);
        const graph = buildFileGraphFromAnalysis(analysis as any, 'TodoController.java', baselineSymbols);
        const modifiedNodes = graph.nodes.filter(n => n.diff === 'modified');
        expect(modifiedNodes.some(n => n.label === 'addTodo')).toBe(true);
    });

    it('deleted import: ghost import node with diff:deleted', () => {
        const analysis = makeAnalysis([
            { kind: 'function', name: 'addTodo', key: 'function:addTodo', signature: 'ResponseEntity addTodo()', bodyText: 'return todoService.createTodo(title);' },
        ]);
        // Override importsByLocal to exclude the ResponseEntity import
        (analysis as any).importsByLocal = new Map();
        const graph = buildFileGraphFromAnalysis(analysis as any, 'TodoController.java', baselineSymbols);
        const deletedImports = graph.nodes.filter(n => n.diff === 'deleted' && n.type === 'import');
        expect(deletedImports.length).toBeGreaterThanOrEqual(1);
    });
});

// ─── L1: Service-level Diff Tests ────────────────────────────────────────────

describe('L1 Microservice / Service diff', () => {
    const makeFiles = (paths: string[], hashes: Record<string, string>) => {
        const result: Record<string, { hash: string }> = {};
        for (const p of paths) result[p] = { hash: hashes[p] ?? 'hash' };
        return result;
    };

    it('unchanged: service stays unchanged when no file hashes differ', () => {
        const svc = makeServiceRecord('service:backend', 'backend');
        const files = makeFiles(['backend/TodoController.java'], { 'backend/TodoController.java': 'abc' });
        const result = diffServices({ 'service:backend': svc }, { 'service:backend': svc }, files, files);
        expect(result['service:backend']?.diff).toBe('unchanged');
    });

    it('modified: service becomes modified when a member file hash changes', () => {
        const svc = makeServiceRecord('service:backend', 'backend');
        const baseFiles = makeFiles(['backend/TodoController.java'], { 'backend/TodoController.java': 'abc' });
        const workFiles = makeFiles(['backend/TodoController.java'], { 'backend/TodoController.java': 'def' });
        const result = diffServices({ 'service:backend': svc }, { 'service:backend': svc }, baseFiles, workFiles);
        expect(result['service:backend']?.diff).toBe('modified');
    });

    it('added: new service gets diff:added (green)', () => {
        const svc = makeServiceRecord('service:backend', 'backend');
        const result = diffServices({}, { 'service:backend': svc });
        expect(result['service:backend']?.diff).toBe('added');
    });

    it('deleted: removed service gets diff:deleted (red)', () => {
        const svc = makeServiceRecord('service:backend', 'backend');
        const result = diffServices({ 'service:backend': svc }, {});
        const deleted = Object.values(result).find(s => s.diff === 'deleted');
        expect(deleted).toBeDefined();
        expect(deleted?.name).toBe('backend');
    });

    it('multiple services: correct status for each', () => {
        const svcA = makeServiceRecord('service:backend', 'backend');
        const svcB = makeServiceRecord('service:auth', 'auth');
        const svcC = makeServiceRecord('service:newSvc', 'newSvc');
        const baseFiles = makeFiles(
            ['backend/TodoController.java', 'auth/AuthController.java'],
            { 'backend/TodoController.java': 'abc', 'auth/AuthController.java': 'xyz' }
        );
        const workFiles = makeFiles(
            ['backend/TodoController.java', 'auth/AuthController.java'],
            { 'backend/TodoController.java': 'changed', 'auth/AuthController.java': 'xyz' }
        );
        const baseline = { 'service:backend': svcA, 'service:auth': svcB };
        const working = { 'service:backend': svcA, 'service:auth': svcB, 'service:newSvc': svcC };
        const result = diffServices(baseline, working, baseFiles, workFiles);
        expect(result['service:backend']?.diff).toBe('modified');
        expect(result['service:auth']?.diff).toBe('unchanged');
        expect(result['service:newSvc']?.diff).toBe('added');
    });
});

// ─── L2a: Feature Cluster Diff Tests ─────────────────────────────────────────

describe('L2a Feature Cluster diff', () => {
    const dummySpan = { start: 0, end: 0 };

    function makeCluster(id: string, files: string[], overrides: Partial<FeatureCluster> = {}): FeatureCluster {
        return {
            id,
            label: id.replace('cluster:', ''),
            files,
            entryPoints: [],
            internalCallCount: 2,
            externalCallCount: 1,
            diff: 'unchanged',
            ...overrides,
        };
    }

    function makeSnapshotWithHashes(files: Record<string, string>): Snapshot {
        const result: Snapshot = { files: {}, apiIndex: {}, graphs: {} };
        for (const [fp, hash] of Object.entries(files)) {
            result.files[fp] = {
                path: fp, hash, mtime: 0, content: '',
                symbols: { functions: [], variables: [], imports: [] },
            };
        }
        return result;
    }

    it('cluster unchanged when member file hashes are same', () => {
        const cluster = makeCluster('cluster:todos', ['TodoController.java', 'TodoService.java']);
        const baseFiles = { 'TodoController.java': 'abc', 'TodoService.java': 'xyz' };
        const workFiles = { 'TodoController.java': 'abc', 'TodoService.java': 'xyz' };
        const result = diffClusters(
            { 'cluster:todos': cluster }, { 'cluster:todos': cluster },
            makeSnapshotWithHashes(baseFiles).files, makeSnapshotWithHashes(workFiles).files,
        );
        expect(result['cluster:todos']?.diff).toBe('unchanged');
    });

    it('cluster modified when a member file hash changes', () => {
        const cluster = makeCluster('cluster:todos', ['TodoController.java', 'TodoService.java']);
        const baseFiles = { 'TodoController.java': 'abc', 'TodoService.java': 'xyz' };
        const workFiles = { 'TodoController.java': 'changed', 'TodoService.java': 'xyz' };
        const result = diffClusters(
            { 'cluster:todos': cluster }, { 'cluster:todos': cluster },
            makeSnapshotWithHashes(baseFiles).files, makeSnapshotWithHashes(workFiles).files,
        );
        expect(result['cluster:todos']?.diff).toBe('modified');
    });

    it('cluster added when only in working', () => {
        const cluster = makeCluster('cluster:todos', ['TodoController.java']);
        const result = diffClusters({}, { 'cluster:todos': cluster }, {}, {});
        expect(result['cluster:todos']?.diff).toBe('added');
    });

    it('cluster deleted when only in baseline', () => {
        const cluster = makeCluster('cluster:todos', ['TodoController.java']);
        const result = diffClusters({ 'cluster:todos': cluster }, {}, {}, {});
        const deleted = Object.values(result).find(c => c.diff === 'deleted');
        expect(deleted?.label).toBe('todos');
    });

    it('cluster modified when membership changes (new file added to cluster)', () => {
        const base = makeCluster('cluster:todos', ['TodoController.java']);
        const working = makeCluster('cluster:todos', ['TodoController.java', 'TodoService.java']);
        // #373: file maps must reflect that TodoService.java is genuinely new
        // to the codebase (not just migrated between clusters). Without a
        // workingFiles entry it would look like clustering jitter and stay
        // unchanged.
        const baselineFiles = { 'TodoController.java': { hash: 'h1' } };
        const workingFiles = {
            'TodoController.java': { hash: 'h1' },
            'TodoService.java': { hash: 'h2' },
        };
        const result = diffClusters({ 'cluster:todos': base }, { 'cluster:todos': working }, baselineFiles, workingFiles);
        expect(result['cluster:todos']?.diff).toBe('modified');
    });
});

// ─── graph-level diff: diffGraphs utility ────────────────────────────────────

describe('diffGraphs utility — node and edge diff', () => {
    function makeGraph(
        graphId: string,
        nodes: Array<{ id: string; label: string; body?: string }>,
        edges: Array<{ id: string; source: string; target: string; label?: string }> = [],
    ): DiagramGraph {
        return {
            graphId,
            type: 'file',
            nodes: nodes.map(n => ({ ...n, type: 'function' as const })),
            edges: edges.map(e => ({ ...e })),
            anchors: {},
            meta: {},
        };
    }

    it('detects added node', () => {
        const baseline = makeGraph('g', [{ id: 'n1', label: 'createOrder' }]);
        const working = makeGraph('g', [{ id: 'n1', label: 'createOrder' }, { id: 'n2', label: 'bulkCreate' }]);
        const { graph, stats } = diffGraphs(baseline, working);
        const added = graph.nodes.filter(n => n.diff === 'added');
        expect(added.some(n => n.label === 'bulkCreate')).toBe(true);
        expect(stats.addedNodes).toBe(1);
    });

    it('detects deleted node (ghost node)', () => {
        const baseline = makeGraph('g', [{ id: 'n1', label: 'createOrder' }, { id: 'n2', label: 'cancelOrder' }]);
        const working = makeGraph('g', [{ id: 'n1', label: 'createOrder' }]);
        const { graph, stats } = diffGraphs(baseline, working);
        const deleted = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deleted.some(n => n.label.includes('cancelOrder'))).toBe(true);
        expect(stats.deletedNodes).toBe(1);
    });

    it('detects modified node (body changed)', () => {
        const baseline = makeGraph('g', [{ id: 'n1', label: 'createOrder', body: 'old body' }]);
        const working = makeGraph('g', [{ id: 'n1', label: 'createOrder', body: 'new body with changes' }]);
        const { graph, stats } = diffGraphs(baseline, working);
        const modified = graph.nodes.filter(n => n.diff === 'modified');
        expect(modified.some(n => n.label === 'createOrder')).toBe(true);
        expect(stats.modifiedNodes).toBe(1);
    });

    it('detects added edge', () => {
        const nodes = [{ id: 'n1', label: 'A' }, { id: 'n2', label: 'B' }];
        const baseline = makeGraph('g', nodes, []);
        const working = makeGraph('g', nodes, [{ id: 'e1', source: 'n1', target: 'n2', label: 'calls' }]);
        const { graph, stats } = diffGraphs(baseline, working);
        const addedEdges = graph.edges.filter(e => e.diff === 'added');
        expect(addedEdges.length).toBe(1);
        expect(stats.addedEdges).toBe(1);
    });

    it('detects deleted edge (ghost edge)', () => {
        const nodes = [{ id: 'n1', label: 'A' }, { id: 'n2', label: 'B' }];
        const baseline = makeGraph('g', nodes, [{ id: 'e1', source: 'n1', target: 'n2', label: 'calls' }]);
        const working = makeGraph('g', nodes, []);
        const { graph, stats } = diffGraphs(baseline, working);
        const deletedEdges = graph.edges.filter(e => e.diff === 'deleted');
        expect(deletedEdges.length).toBe(1);
        expect(stats.deletedEdges).toBe(1);
    });

    it('detects modified edge (label changed)', () => {
        const nodes = [{ id: 'n1', label: 'A' }, { id: 'n2', label: 'B' }];
        const baseline = makeGraph('g', nodes, [{ id: 'e1', source: 'n1', target: 'n2', label: 'calls' }]);
        const working = makeGraph('g', nodes, [{ id: 'e1', source: 'n1', target: 'n2', label: 'uses' }]);
        const { graph, stats } = diffGraphs(baseline, working);
        const modified = graph.edges.filter(e => e.diff === 'modified');
        expect(modified.length).toBe(1);
        expect(stats.modifiedEdges).toBe(1);
    });

    it('unchanged node stays unchanged', () => {
        const nodes = [{ id: 'n1', label: 'createOrder', body: 'same body' }];
        const baseline = makeGraph('g', nodes);
        const working = makeGraph('g', nodes);
        const { graph, stats } = diffGraphs(baseline, working);
        const n = graph.nodes.find(n => n.label === 'createOrder');
        expect(n?.diff).toBe('unchanged');
        expect(stats.unchangedNodes).toBe(1);
    });
});

// ─── SyncOrchestrator — JS integration ───────────────────────────────────────

describe('SyncOrchestrator — JS diff integration', () => {
    let workspace: string;
    let store: SnapshotStore;
    let sync: SyncOrchestrator;

    beforeEach(async () => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-test-js-'));
        fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });

        fs.writeFileSync(path.join(workspace, 'src', 'orders.js'), `
const express = require('express');
const router = express.Router();

function createOrder(req, res) {
    const id = req.body.id;
    res.json({ id });
}

function cancelOrder(req, res) {
    res.json({ cancelled: true });
}

router.post('/orders', createOrder);
router.delete('/orders/:id', cancelOrder);
module.exports = router;
`);
        store = new SnapshotStore(path.join(workspace, '.codeatlas'));
        sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('baseline and working are identical after initialize (no diffs)', async () => {
        const working = store.getWorking();
        const fileGraph = working.graphs['file:src/orders.js'];
        expect(fileGraph).toBeDefined();
        const diffedNodes = fileGraph.nodes.filter(n => n.diff && n.diff !== 'unchanged');
        expect(diffedNodes).toHaveLength(0);
    });

    it('modified function: file graph node becomes diff:modified after save', async () => {
        fs.writeFileSync(path.join(workspace, 'src', 'orders.js'), `
const express = require('express');
const router = express.Router();

function createOrder(req, res) {
    const id = req.body.id;
    const ts = Date.now();     // ADDED line
    res.json({ id, ts });      // MODIFIED
}

function cancelOrder(req, res) {
    res.json({ cancelled: true });
}

router.post('/orders', createOrder);
router.delete('/orders/:id', cancelOrder);
module.exports = router;
`);
        sync.handleFileSave(path.join(workspace, 'src', 'orders.js'));
        await wait(900);

        const fileGraph = store.getWorking().graphs['file:src/orders.js'];
        const modifiedOrAdded = fileGraph.nodes.filter(n => n.diff === 'modified' || n.diff === 'added');
        expect(modifiedOrAdded.length).toBeGreaterThanOrEqual(1);
    });

    it('deleted function: ghost node in file graph (diff:deleted)', async () => {
        fs.writeFileSync(path.join(workspace, 'src', 'orders.js'), `
const express = require('express');
const router = express.Router();

function createOrder(req, res) {
    res.json({ ok: true });
}

router.post('/orders', createOrder);
module.exports = router;
`);
        sync.handleFileSave(path.join(workspace, 'src', 'orders.js'));
        await wait(900);

        const fileGraph = store.getWorking().graphs['file:src/orders.js'];
        const deletedNodes = fileGraph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.some(n => n.label.includes('cancelOrder'))).toBe(true);
    });

    it('deleted handler: sequence graph becomes ghost (all nodes diff:deleted)', async () => {
        // Verify baseline has sequence graph for cancelOrder
        const baseline = store.getBaseline();
        const seqId = 'sequence:src/orders.js:cancelOrder';
        expect(baseline.graphs[seqId]).toBeDefined();

        // Remove cancelOrder
        fs.writeFileSync(path.join(workspace, 'src', 'orders.js'), `
const express = require('express');
const router = express.Router();

function createOrder(req, res) {
    res.json({ ok: true });
}

router.post('/orders', createOrder);
module.exports = router;
`);
        sync.handleFileSave(path.join(workspace, 'src', 'orders.js'));
        await wait(900);

        const working = store.getWorking();
        const ghostSeq = working.graphs[seqId];
        expect(ghostSeq).toBeDefined();
        const allDeleted = ghostSeq.nodes.every(n => n.diff === 'deleted');
        expect(allDeleted).toBe(true);
    });

    it('deleted function: flow graph becomes ghost (all nodes diff:deleted)', async () => {
        const baseline = store.getBaseline();
        const flowId = 'flow:src/orders.js:cancelOrder';
        expect(baseline.graphs[flowId]).toBeDefined();

        // Remove cancelOrder
        fs.writeFileSync(path.join(workspace, 'src', 'orders.js'), `
const express = require('express');
const router = express.Router();

function createOrder(req, res) {
    res.json({ ok: true });
}

router.post('/orders', createOrder);
module.exports = router;
`);
        sync.handleFileSave(path.join(workspace, 'src', 'orders.js'));
        await wait(900);

        const working = store.getWorking();
        const ghostFlow = working.graphs[flowId];
        expect(ghostFlow).toBeDefined();
        const allDeleted = ghostFlow.nodes.every(n => n.diff === 'deleted');
        expect(allDeleted).toBe(true);
    });

    it('deleted entire file: all graphs become ghost (diff:deleted)', async () => {
        const baseline = store.getBaseline();
        const fileId = 'file:src/orders.js';
        expect(baseline.graphs[fileId]).toBeDefined();

        fs.unlinkSync(path.join(workspace, 'src', 'orders.js'));
        sync.handleFileDeleted(path.join(workspace, 'src', 'orders.js'));
        await wait(900);

        const working = store.getWorking();
        const ghostFile = working.graphs[fileId];
        expect(ghostFile).toBeDefined();
        expect(ghostFile.nodes.every(n => n.diff === 'deleted')).toBe(true);
        expect(ghostFile.edges.every(e => e.diff === 'deleted')).toBe(true);
    });

    it('added handler: new sequence graph is created and has participant nodes', async () => {
        fs.writeFileSync(path.join(workspace, 'src', 'orders.js'), `
const express = require('express');
const router = express.Router();

function createOrder(req, res) {
    res.json({ ok: true });
}

function cancelOrder(req, res) {
    res.json({ cancelled: true });
}

function bulkCreateOrders(req, res) {
    res.json({ bulk: true });
}

router.post('/orders', createOrder);
router.delete('/orders/:id', cancelOrder);
router.post('/orders/bulk', bulkCreateOrders);
module.exports = router;
`);
        sync.handleFileSave(path.join(workspace, 'src', 'orders.js'));
        await wait(900);

        const working = store.getWorking();
        const newSeq = working.graphs['sequence:src/orders.js:bulkCreateOrders'];
        // New sequence graph should be created for the new handler
        expect(newSeq).toBeDefined();
        // Sequence graph should have participant nodes
        const participants = newSeq.nodes.filter(n => n.type === 'participant');
        expect(participants.length).toBeGreaterThanOrEqual(1);
    });
});

// ─── Java diff integration (direct graph building — no WASM required) ────────
//
// These tests verify diff propagation for Java code using buildFileGraphFromAnalysis()
// with hand-crafted FileAnalysis objects, bypassing the WASM parser entirely.
// This mirrors what tree-sitter would extract from the Java source fixtures above.

import { detectFrameworkApis } from '../parser/frameworkDetector';
import { buildSequenceGraphFromAnalysis } from '../graph/sequenceGraphBuilder';
import type { FileAnalysis } from '../parser/treeSitterExtractor';
import type { EntityRecord, ApiRecord } from '../graph/graphTypes';

function makeEntity(
    kind: EntityRecord['kind'], name: string, bodyText: string,
    extras: Partial<EntityRecord> = {},
): EntityRecord {
    return {
        kind, name, key: name, signature: `${kind} ${name}`,
        bodyText, locText: bodyText,
        calls: new Set(), memberCalls: new Map(), usesVars: new Set(), usesImports: new Set(),
        ...extras,
    };
}

/** Build a FileAnalysis matching what tree-sitter would produce for TODO_CONTROLLER_V1 */
function makeControllerV1Analysis(): FileAnalysis {
    const todoServiceCalls = (method: string) => {
        const mc = new Map<string, Set<string>>();
        mc.set('todoService', new Set([method]));
        return mc;
    };
    return {
        fileName: 'TodoController.java',
        entities: [
            makeEntity('class', 'TodoController', TODO_CONTROLLER_V1),
            makeEntity('function', 'addTodo', 'public ResponseEntity<?> addTodo(@RequestBody Map<String, String> body) {\n        String title = body.get("title");\n        if (title == null || title.trim().isEmpty()) {\n            return ResponseEntity.badRequest().body(Map.of("error", "Title is required"));\n        }\n        return ResponseEntity.ok(todoService.createTodo(title));\n    }', { memberCalls: todoServiceCalls('createTodo') }),
            makeEntity('function', 'listTodos', 'public ResponseEntity<?> listTodos() {\n        return ResponseEntity.ok(todoService.listTodos());\n    }', { memberCalls: todoServiceCalls('listTodos') }),
            makeEntity('function', 'deleteTodo', 'public ResponseEntity<?> deleteTodo(@PathVariable Long id) {\n        todoService.deleteTodo(id);\n        return ResponseEntity.ok(Map.of("message", "Deleted"));\n    }', { memberCalls: todoServiceCalls('deleteTodo') }),
        ],
        funcs: new Map(),
        vars: new Map(),
        importsByLocal: new Map([['ResponseEntity', 'org.springframework.http.ResponseEntity']]),
        injectedDeps: new Map([['todoService', 'TodoService']]),
    };
}

/** Build a FileAnalysis matching TODO_CONTROLLER_V2 (addTodo modified, deleteTodo removed, listFavorites added) */
function makeControllerV2Analysis(): FileAnalysis {
    const todoServiceCalls = (method: string) => {
        const mc = new Map<string, Set<string>>();
        mc.set('todoService', new Set([method]));
        return mc;
    };
    return {
        fileName: 'TodoController.java',
        entities: [
            makeEntity('class', 'TodoController', TODO_CONTROLLER_V2),
            makeEntity('function', 'addTodo', 'public ResponseEntity<?> addTodo(@RequestBody Map<String, String> body) {\n        String title = body.get("title");\n        if (title == null) {\n            return ResponseEntity.badRequest().body(Map.of("error", "Title required"));\n        }\n        System.out.println("Creating todo: " + title);\n        return ResponseEntity.ok(todoService.createTodo(title));\n    }', { memberCalls: todoServiceCalls('createTodo') }),
            makeEntity('function', 'listTodos', 'public ResponseEntity<?> listTodos() {\n        return ResponseEntity.ok(todoService.listTodos());\n    }', { memberCalls: todoServiceCalls('listTodos') }),
            makeEntity('function', 'listFavorites', 'public ResponseEntity<?> listFavorites() {\n        return ResponseEntity.ok(todoService.listFavorites());\n    }', { memberCalls: todoServiceCalls('listFavorites') }),
        ],
        funcs: new Map(),
        vars: new Map(),
        importsByLocal: new Map([['ResponseEntity', 'org.springframework.http.ResponseEntity']]),
        injectedDeps: new Map([['todoService', 'TodoService']]),
    };
}

function makeServiceV1Analysis(): FileAnalysis {
    return {
        fileName: 'TodoService.java',
        entities: [
            makeEntity('class', 'TodoService', TODO_SERVICE_V1),
            makeEntity('function', 'createTodo', 'public Object createTodo(String title) { return todoRepository.save(title); }'),
            makeEntity('function', 'listTodos', 'public Object listTodos() { return todoRepository.findAll(); }'),
            makeEntity('function', 'deleteTodo', 'public void deleteTodo(Long id) { todoRepository.deleteById(id); }'),
        ],
        funcs: new Map(),
        vars: new Map(),
        importsByLocal: new Map(),
        injectedDeps: new Map([['todoRepository', 'TodoRepository']]),
    };
}

describe('Java diff integration (direct graph building)', () => {
    const ctrlPath = 'backend/src/main/java/com/todo/features/todos/TodoController.java';
    const svcPath = 'backend/src/main/java/com/todo/features/todos/TodoService.java';

    // Baseline graphs (V1)
    let baselineCtrlGraph: DiagramGraph;
    let baselineSvcGraph: DiagramGraph;
    let baselineCtrlApis: ApiRecord[];

    // V2 graphs with diff
    let diffedCtrlGraph: DiagramGraph;

    beforeEach(() => {
        // Build baseline file graphs from V1 analysis
        baselineCtrlGraph = buildFileGraphFromAnalysis(makeControllerV1Analysis(), ctrlPath);
        baselineSvcGraph = buildFileGraphFromAnalysis(makeServiceV1Analysis(), svcPath);
        baselineCtrlApis = detectFrameworkApis(TODO_CONTROLLER_V1, ctrlPath, 'java');

        // Build V2 file graph with baseline symbols for diffing
        // Build baseline symbols from V1 analysis entities (stableKey = entity.key = name)
        const v1 = makeControllerV1Analysis();
        const baselineSymbols: BaselineSymbols = {
            functions: v1.entities.filter(e => e.kind === 'function' || e.kind === 'class').map(e => ({
                name: e.name,
                stableKey: e.key,
                signature: e.signature,
                bodyText: e.bodyText,
            })),
            variables: v1.entities.filter(e => e.kind === 'variable').map(e => ({
                name: e.name,
                stableKey: e.key,
                bodyText: e.bodyText,
            })),
            imports: v1.entities.filter(e => e.kind === 'import').map(e => ({
                source: e.name,
                stableKey: e.key,
            })),
        };
        diffedCtrlGraph = buildFileGraphFromAnalysis(makeControllerV2Analysis(), ctrlPath, baselineSymbols);
    });

    it('baseline: file graphs have nodes for both Java files', () => {
        expect(baselineCtrlGraph.nodes.length).toBeGreaterThanOrEqual(3);
        expect(baselineSvcGraph.nodes.length).toBeGreaterThanOrEqual(3);
    });

    it('baseline: API detection finds Spring endpoints in V1', () => {
        // V1 has: POST /api/todos, GET /api/todos, DELETE /api/todos/{id}
        expect(baselineCtrlApis.length).toBeGreaterThanOrEqual(3);
        const methods = baselineCtrlApis.map(a => a.method);
        expect(methods).toContain('POST');
        expect(methods).toContain('GET');
        expect(methods).toContain('DELETE');
    });

    it('baseline: no diff markers when baseline is not provided', () => {
        // Without baseline symbols, no diff is computed
        const diffed = baselineCtrlGraph.nodes.filter(n => n.diff && n.diff !== 'unchanged');
        expect(diffed).toHaveLength(0);
    });

    it('modified method: addTodo shows diff:modified', () => {
        const modifiedNodes = diffedCtrlGraph.nodes.filter(n => n.diff === 'modified');
        expect(modifiedNodes.some(n => n.label === 'addTodo')).toBe(true);
    });

    it('added method: listFavorites shows diff:added', () => {
        const addedNodes = diffedCtrlGraph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.some(n => n.label === 'listFavorites')).toBe(true);
    });

    it('deleted method: deleteTodo ghost node shows diff:deleted', () => {
        const deletedNodes = diffedCtrlGraph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.some(n => n.label.includes('deleteTodo'))).toBe(true);
    });

    it('V2 API detection finds new endpoint and drops deleted one', () => {
        const v2Apis = detectFrameworkApis(TODO_CONTROLLER_V2, ctrlPath, 'java');
        const routes = v2Apis.map(a => a.route);
        expect(routes.some(r => r.includes('favorites'))).toBe(true);
        // DELETE endpoint no longer exists in V2
        expect(v2Apis.find(a => a.method === 'DELETE')).toBeUndefined();
    });

    it('sequence graph can be built from V1 analysis + APIs', () => {
        const analysis = makeControllerV1Analysis();
        for (const api of baselineCtrlApis) {
            const seqGraph = buildSequenceGraphFromAnalysis(
                analysis, ctrlPath, [api], api.handlerName,
            );
            expect(seqGraph).toBeDefined();
            expect(seqGraph.nodes.length).toBeGreaterThanOrEqual(1);
            // Should have participant nodes
            const participants = seqGraph.nodes.filter(n => n.type === 'participant');
            expect(participants.length).toBeGreaterThanOrEqual(1);
        }
    });

    it('diff colors: all nodes have diff status after diffing', () => {
        // Every node in the diffed graph should have a diff status
        const noDiff = diffedCtrlGraph.nodes.filter(n => !n.diff);
        expect(noDiff).toHaveLength(0);

        // Verify we have all three diff statuses present
        const statuses = new Set(diffedCtrlGraph.nodes.map(n => n.diff));
        expect(statuses.has('modified')).toBe(true);  // addTodo
        expect(statuses.has('added')).toBe(true);      // listFavorites
        expect(statuses.has('deleted')).toBe(true);     // deleteTodo
    });

    it('diffGraphs: full graph diff produces correct node-level statuses', () => {
        const result = diffGraphs(baselineCtrlGraph, buildFileGraphFromAnalysis(makeControllerV2Analysis(), ctrlPath));
        const diffed = result.graph;
        // deleteTodo should appear as deleted ghost node
        const deleted = diffed.nodes.filter(n => n.diff === 'deleted');
        expect(deleted.some(n => n.label.includes('deleteTodo'))).toBe(true);
        // listFavorites should appear as added
        const added = diffed.nodes.filter(n => n.diff === 'added');
        expect(added.some(n => n.label === 'listFavorites')).toBe(true);
    });

    it('deleted file: diffGraphs against empty graph marks all as deleted', () => {
        // Simulate file deletion by diffing against an empty graph
        const emptyGraph: DiagramGraph = { graphId: baselineCtrlGraph.graphId, type: 'file', nodes: [], edges: [], anchors: {}, meta: {} };
        const result = diffGraphs(baselineCtrlGraph, emptyGraph);
        const ghostGraph = result.graph;
        expect(ghostGraph.nodes.length).toBeGreaterThanOrEqual(1);
        expect(ghostGraph.nodes.every(n => n.diff === 'deleted')).toBe(true);
        expect(ghostGraph.edges.every(e => e.diff === 'deleted')).toBe(true);
    });
});

// ─── makeDeletedGraph behavior (unit test for the helper) ────────────────────

describe('makeDeletedGraph behavior via SyncOrchestrator', () => {
    let workspace: string;
    let store: SnapshotStore;
    let sync: SyncOrchestrator;

    beforeEach(async () => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-del-'));
        fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'src', 'api.js'), `
const express = require('express');
const router = express.Router();

function handleGet(req, res) {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    return res.json({ data: 'ok' });
}

router.get('/data', handleGet);
module.exports = router;
`);
        store = new SnapshotStore(path.join(workspace, '.codeatlas'));
        sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('ghost sequence graph: all nodes are diff:deleted', async () => {
        // Delete the file → sequence graph becomes ghost
        fs.unlinkSync(path.join(workspace, 'src', 'api.js'));
        sync.handleFileDeleted(path.join(workspace, 'src', 'api.js'));
        await wait(900);

        const working = store.getWorking();
        const seqId = 'sequence:src/api.js:handleGet';
        const ghost = working.graphs[seqId];
        expect(ghost).toBeDefined();
        for (const node of ghost.nodes) {
            expect(node.diff).toBe('deleted');
        }
    });

    it('ghost sequence graph: all edges are diff:deleted', async () => {
        fs.unlinkSync(path.join(workspace, 'src', 'api.js'));
        sync.handleFileDeleted(path.join(workspace, 'src', 'api.js'));
        await wait(900);

        const working = store.getWorking();
        const seqId = 'sequence:src/api.js:handleGet';
        const ghost = working.graphs[seqId];
        expect(ghost).toBeDefined();
        for (const edge of ghost.edges) {
            expect(edge.diff).toBe('deleted');
        }
    });

    it('ghost flow graph: all nodes are diff:deleted', async () => {
        fs.unlinkSync(path.join(workspace, 'src', 'api.js'));
        sync.handleFileDeleted(path.join(workspace, 'src', 'api.js'));
        await wait(900);

        const working = store.getWorking();
        const flowId = 'flow:src/api.js:handleGet';
        const ghost = working.graphs[flowId];
        expect(ghost).toBeDefined();
        for (const node of ghost.nodes) {
            expect(node.diff).toBe('deleted');
        }
    });

    it('ghost file graph: all nodes are diff:deleted', async () => {
        fs.unlinkSync(path.join(workspace, 'src', 'api.js'));
        sync.handleFileDeleted(path.join(workspace, 'src', 'api.js'));
        await wait(900);

        const working = store.getWorking();
        const fileId = 'file:src/api.js';
        const ghost = working.graphs[fileId];
        expect(ghost).toBeDefined();
        for (const node of ghost.nodes) {
            expect(node.diff).toBe('deleted');
        }
    });

    it('ghost is replaced when handler is re-added (no stale ghost)', async () => {
        // Verify the sequence graph exists in baseline
        const seqId = 'sequence:src/api.js:handleGet';
        const baselineSeq = store.getBaseline().graphs[seqId];
        expect(baselineSeq).toBeDefined();

        // Delete the entire file → sequence graph becomes ghost
        fs.unlinkSync(path.join(workspace, 'src', 'api.js'));
        sync.handleFileDeleted(path.join(workspace, 'src', 'api.js'));
        await wait(900);

        const ghost = store.getWorking().graphs[seqId];
        expect(ghost).toBeDefined();
        // After deleteFile, all nodes should be deleted
        expect(ghost.nodes.every(n => n.diff === 'deleted')).toBe(true);

        // Re-create the file with the same handler
        fs.writeFileSync(path.join(workspace, 'src', 'api.js'), `
const express = require('express');
const router = express.Router();

function handleGet(req, res) {
    return res.json({ restored: true });
}

router.get('/data', handleGet);
module.exports = router;
`);
        sync.handleFileCreated(path.join(workspace, 'src', 'api.js'));
        await wait(900);

        const restored = store.getWorking().graphs[seqId];
        expect(restored).toBeDefined();
        // After restore, the graph should NOT have all-deleted nodes (it's rebuilt fresh)
        const allDeleted = restored.nodes.every(n => n.diff === 'deleted');
        expect(allDeleted).toBe(false);
    });
});
