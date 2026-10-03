/**
 * filterViews.test.ts — #750 saved filter views (2026-06-06).
 *
 * TDD coverage for the filter-snapshot persistence layer that lives at
 * `.codeatlas/saved-filter-views.json`. Pure load/save/delete/byId
 * functions — no extension-host or webview concerns. The webview
 * round-trips a `SavedFilterView` through three WS message types
 * (listSavedFilterViews / saveFilterView / deleteFilterView).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    loadSavedFilterViews,
    saveFilterView,
    deleteFilterView,
    findSavedFilterView,
    type SavedFilterView,
} from '../filterViews';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-views-'));
    fs.mkdirSync(path.join(tmpDir, '.codeatlas'), { recursive: true });
});

afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('loadSavedFilterViews', () => {
    it('returns [] when the file does not exist', () => {
        expect(loadSavedFilterViews(tmpDir)).toEqual([]);
    });

    it('returns [] when the file is malformed', () => {
        fs.writeFileSync(path.join(tmpDir, '.codeatlas', 'saved-filter-views.json'), 'not json');
        expect(loadSavedFilterViews(tmpDir)).toEqual([]);
    });

    it('returns [] when the JSON root is not an array', () => {
        fs.writeFileSync(path.join(tmpDir, '.codeatlas', 'saved-filter-views.json'), '{"oops": true}');
        expect(loadSavedFilterViews(tmpDir)).toEqual([]);
    });

    it('reads a well-formed views file and drops malformed entries', () => {
        const views = [
            { id: 'auth-only', name: 'Auth only', route: '/apis/cluster:auth', filters: { search: 'login' }, createdAt: 1700000000000 },
            { id: 'no-route', name: 'Missing route' }, // malformed — should drop
            { id: 'kmap-snapshot', name: 'KMap recent', route: '/map', filters: { highlightCluster: 'auth' }, createdAt: 1700000001000 },
        ];
        fs.writeFileSync(path.join(tmpDir, '.codeatlas', 'saved-filter-views.json'), JSON.stringify(views));
        const result = loadSavedFilterViews(tmpDir);
        expect(result).toHaveLength(2);
        expect(result.map(v => v.id).sort()).toEqual(['auth-only', 'kmap-snapshot']);
    });
});

describe('saveFilterView', () => {
    it('writes a new view to disk and returns the persisted record', () => {
        const view: SavedFilterView = {
            id: 'auth-only',
            name: 'Auth only',
            route: '/apis/cluster:auth',
            filters: { search: 'login' },
            createdAt: 1700000000000,
        };
        const result = saveFilterView(tmpDir, view);
        expect(result).toEqual(view);
        const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, '.codeatlas', 'saved-filter-views.json'), 'utf-8'));
        expect(onDisk).toHaveLength(1);
        expect(onDisk[0].id).toBe('auth-only');
    });

    it('appends when other views already exist', () => {
        saveFilterView(tmpDir, { id: 'v1', name: 'One', route: '/map', filters: {}, createdAt: 1 });
        saveFilterView(tmpDir, { id: 'v2', name: 'Two', route: '/map', filters: {}, createdAt: 2 });
        const onDisk = loadSavedFilterViews(tmpDir);
        expect(onDisk.map(v => v.id).sort()).toEqual(['v1', 'v2']);
    });

    it('overwrites an existing view with the same id (upsert semantics)', () => {
        saveFilterView(tmpDir, { id: 'auth', name: 'Auth v1', route: '/apis/cluster:auth', filters: {}, createdAt: 1 });
        saveFilterView(tmpDir, { id: 'auth', name: 'Auth v2', route: '/apis/cluster:auth', filters: { search: 'updated' }, createdAt: 2 });
        const views = loadSavedFilterViews(tmpDir);
        expect(views).toHaveLength(1);
        expect(views[0].name).toBe('Auth v2');
        expect(views[0].filters).toEqual({ search: 'updated' });
    });

    it('creates the .codeatlas directory if missing', () => {
        const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-views-fresh-'));
        try {
            saveFilterView(cleanDir, { id: 'v', name: 'V', route: '/', filters: {}, createdAt: 1 });
            expect(fs.existsSync(path.join(cleanDir, '.codeatlas', 'saved-filter-views.json'))).toBe(true);
        } finally {
            fs.rmSync(cleanDir, { recursive: true, force: true });
        }
    });

    it('rejects a malformed view shape', () => {
        // Missing `route` → error.
        expect(() => saveFilterView(tmpDir, { id: 'x', name: 'X', filters: {}, createdAt: 1 } as any)).toThrow(/route/i);
        // Missing `id` → error.
        expect(() => saveFilterView(tmpDir, { name: 'X', route: '/', filters: {}, createdAt: 1 } as any)).toThrow(/id/i);
    });
});

describe('deleteFilterView', () => {
    it('removes the named view and returns true', () => {
        saveFilterView(tmpDir, { id: 'a', name: 'A', route: '/', filters: {}, createdAt: 1 });
        saveFilterView(tmpDir, { id: 'b', name: 'B', route: '/', filters: {}, createdAt: 2 });
        const removed = deleteFilterView(tmpDir, 'a');
        expect(removed).toBe(true);
        expect(loadSavedFilterViews(tmpDir).map(v => v.id)).toEqual(['b']);
    });

    it('returns false when the view does not exist', () => {
        saveFilterView(tmpDir, { id: 'a', name: 'A', route: '/', filters: {}, createdAt: 1 });
        expect(deleteFilterView(tmpDir, 'missing')).toBe(false);
        expect(loadSavedFilterViews(tmpDir)).toHaveLength(1);
    });

    it('returns false when no views file exists', () => {
        expect(deleteFilterView(tmpDir, 'a')).toBe(false);
    });
});

describe('findSavedFilterView', () => {
    it('returns the view when it exists', () => {
        saveFilterView(tmpDir, { id: 'kmap', name: 'KMap', route: '/map', filters: { highlight: 'auth' }, createdAt: 1 });
        const view = findSavedFilterView(tmpDir, 'kmap');
        expect(view?.name).toBe('KMap');
        expect(view?.filters).toEqual({ highlight: 'auth' });
    });

    it('returns null when the id is unknown', () => {
        expect(findSavedFilterView(tmpDir, 'nope')).toBeNull();
    });
});
