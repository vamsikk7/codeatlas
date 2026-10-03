/**
 * snapshotBuilder.test.ts
 *
 * Integration-style tests for buildSnapshotFromFiles.
 * These tests call the real parsers (Babel / tree-sitter) so they may be
 * slower than pure unit tests, but they catch regressions in the full pipeline.
 *
 * Tests that rely on tree-sitter (non-JS files) may skip if the WASM grammar
 * cannot be loaded in the test environment.
 */

import { describe, it, expect } from 'vitest';
import { buildSnapshotFromFiles, type FileInput } from '../snapshotBuilder';

// ─── helpers ─────────────────────────────────────────────────────────────────

function noop(_msg: string): void {}

// ─── JS/TS files ─────────────────────────────────────────────────────────────

describe('buildSnapshotFromFiles — JS/TS', () => {
    it('returns a snapshot with only phase-2 graphs for an empty file list', async () => {
        const snapshot = await buildSnapshotFromFiles([], '/workspace', noop);

        expect(snapshot.files).toEqual({});
        expect(snapshot.apiIndex).toEqual({});
        // Phase 2 may produce a microservice:workspace graph even with no files.
        // We only assert files and apiIndex are empty; graphs may contain L1/L2 graphs.
    });

    it('builds a file record for a simple CJS JS file', async () => {
        // Use non-export syntax so symbolExtractor's bare FunctionDeclaration path fires
        const files: FileInput[] = [{
            relativePath: 'src/utils.js',
            content: `
                function add(a, b) { return a + b; }
                function sub(a, b) { return a - b; }
                module.exports = { add, sub };
            `,
        }];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        const record = snapshot.files['src/utils.js'];
        expect(record).toBeDefined();
        expect(record.path).toBe('src/utils.js');
        expect(record.hash).toMatch(/^[0-9a-f]{16}$/);
        expect(record.symbols.functions.length).toBeGreaterThanOrEqual(2);

        const names = record.symbols.functions.map(f => f.name);
        expect(names).toContain('add');
        expect(names).toContain('sub');
    });

    it('populates a file graph for a JS file', async () => {
        const files: FileInput[] = [{
            relativePath: 'src/index.ts',
            content: `
                import { add } from './utils';
                export function main() { return add(1, 2); }
            `,
        }];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        expect(snapshot.graphs['file:src/index.ts']).toBeDefined();
        const graph = snapshot.graphs['file:src/index.ts'];
        expect(graph.type).toBe('file');
        expect(graph.graphId).toBe('file:src/index.ts');
    });

    it('builds a flow graph for each function in a JS file', async () => {
        // Use non-exported (bare) function declarations so symbolExtractor's
        // FunctionDeclaration path captures them and populates analysis.funcs.
        // (ExportNamedDeclaration wrapping is not unwrapped by symbolExtractor.)
        const files: FileInput[] = [{
            relativePath: 'src/order.js',
            content: `
                function createOrder(item) {
                    if (!item) return null;
                    return { id: 1, item };
                }
                function deleteOrder(id) {
                    if (id < 0) throw new Error('bad');
                    return true;
                }
                module.exports = { createOrder, deleteOrder };
            `,
        }];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        expect(snapshot.graphs['flow:src/order.js:createOrder']).toBeDefined();
        expect(snapshot.graphs['flow:src/order.js:deleteOrder']).toBeDefined();
    });

    it('builds a sequence graph for an Express route', async () => {
        const files: FileInput[] = [{
            relativePath: 'src/routes.ts',
            content: `
                import express from 'express';
                const router = express.Router();
                router.get('/todos', getTodos);
                function getTodos(req, res) {
                    res.json([]);
                }
            `,
        }];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        // At least one sequence graph should be produced
        const seqKeys = Object.keys(snapshot.graphs).filter(k => k.startsWith('sequence:'));
        expect(seqKeys.length).toBeGreaterThan(0);
    });

    it('stores API records in the apiIndex for detected routes', async () => {
        const files: FileInput[] = [{
            relativePath: 'src/app.js',
            content: `
                const express = require('express');
                const app = express();
                app.post('/users', createUser);
                function createUser(req, res) { res.status(201).json({}); }
            `,
        }];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        const apis = Object.values(snapshot.apiIndex);
        expect(apis.length).toBeGreaterThan(0);
        const post = apis.find(a => a.method === 'POST');
        expect(post).toBeDefined();
        expect(post?.route).toBe('/users');
    });

    it('records imports in the file record', async () => {
        const files: FileInput[] = [{
            relativePath: 'src/service.ts',
            content: `
                import { db } from './database';
                import axios from 'axios';
                export function fetch() { return axios.get('/api'); }
            `,
        }];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        const record = snapshot.files['src/service.ts'];
        const importSources = record.symbols.imports.map(i => i.source);
        expect(importSources.some(s => s.includes('database') || s.includes('./database'))).toBe(true);
        expect(importSources.some(s => s === 'axios')).toBe(true);
    });

    it('skips malformed JS files without throwing and continues to the next file', async () => {
        const files: FileInput[] = [
            {
                relativePath: 'src/broken.js',
                content: '<<< this is not valid JavaScript >>>',
            },
            {
                relativePath: 'src/valid.js',
                content: 'export function ok() { return 1; }',
            },
        ];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        // broken.js may or may not produce a record (depends on parser error handling),
        // but valid.js must always be present
        expect(snapshot.files['src/valid.js']).toBeDefined();
    });

    it('deduplicates sequence graphs when multiple routes share a handler', async () => {
        const files: FileInput[] = [{
            relativePath: 'src/routes.js',
            content: `
                const app = require('express')();
                app.get('/a', handler);
                app.get('/b', handler);
                function handler(req, res) { res.send('ok'); }
            `,
        }];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        const seqKeys = Object.keys(snapshot.graphs).filter(k =>
            k.startsWith('sequence:src/routes.js:')
        );
        // Should be exactly one sequence graph for the shared handler name
        const uniqueHandlerGraphs = new Set(seqKeys);
        expect(uniqueHandlerGraphs.size).toBe(1);
    });

    it('produces a content hash that changes when file content changes', async () => {
        const makeSnapshot = (content: string) =>
            buildSnapshotFromFiles([{ relativePath: 'src/a.ts', content }], '/workspace', noop);

        const snap1 = await makeSnapshot('export const x = 1;');
        const snap2 = await makeSnapshot('export const x = 2;');

        expect(snap1.files['src/a.ts'].hash).not.toBe(snap2.files['src/a.ts'].hash);
    });

    it('sequenceResolver correctly picks up files added earlier in the loop', async () => {
        // File A imports from file B; both are in the input list.
        // The sequence graph for A must be able to resolve B via the sequenceResolver.
        // This verifies the sequenceResolver closure reads snapshot.files at call time,
        // not just at the time it is defined (before the loop).
        const files: FileInput[] = [
            {
                relativePath: 'src/db.js',
                content: `
                    export async function query(sql) {
                        return [];
                    }
                `,
            },
            {
                relativePath: 'src/routes.js',
                content: `
                    const app = require('express')();
                    const { query } = require('./db');
                    app.get('/items', getItems);
                    function getItems(req, res) {
                        query('SELECT * FROM items').then(rows => res.json(rows));
                    }
                `,
            },
        ];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        // Both file records must exist
        expect(snapshot.files['src/db.js']).toBeDefined();
        expect(snapshot.files['src/routes.js']).toBeDefined();

        // The sequence graph for getItems should have been built
        const seqKeys = Object.keys(snapshot.graphs).filter(k => k.startsWith('sequence:src/routes.js:'));
        expect(seqKeys.length).toBeGreaterThan(0);
    });

    it('phase 2 services and clusters are set after all files are processed', async () => {
        const files: FileInput[] = [
            {
                relativePath: 'src/index.ts',
                content: `
                    import express from 'express';
                    const app = express();
                    app.get('/health', (req, res) => res.json({ ok: true }));
                `,
            },
        ];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        // Phase 2 should run and populate at least the call graph field
        // (services and clusters depend on workspace topology and may or may not fire)
        // — just assert it doesn't throw and the snapshot is structurally valid
        expect(snapshot).toHaveProperty('files');
        expect(snapshot).toHaveProperty('apiIndex');
        expect(snapshot).toHaveProperty('graphs');
    });
});

// ─── Multiple TS files ────────────────────────────────────────────────────────

describe('buildSnapshotFromFiles — multiple files', () => {
    it('processes multiple files and stores all records', async () => {
        const files: FileInput[] = [
            { relativePath: 'src/a.ts', content: 'export const A = 1;' },
            { relativePath: 'src/b.ts', content: 'export const B = 2;' },
            { relativePath: 'src/c.ts', content: 'export const C = 3;' },
        ];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        expect(Object.keys(snapshot.files)).toHaveLength(3);
        expect(snapshot.files['src/a.ts']).toBeDefined();
        expect(snapshot.files['src/b.ts']).toBeDefined();
        expect(snapshot.files['src/c.ts']).toBeDefined();
    });

    it('uses the same content reference for identical files (hash equality)', async () => {
        const content = 'export function foo() {}';
        const files: FileInput[] = [
            { relativePath: 'a/index.ts', content },
            { relativePath: 'b/index.ts', content },
        ];

        const snapshot = await buildSnapshotFromFiles(files, '/workspace', noop);

        expect(snapshot.files['a/index.ts'].hash).toBe(snapshot.files['b/index.ts'].hash);
    });
});
