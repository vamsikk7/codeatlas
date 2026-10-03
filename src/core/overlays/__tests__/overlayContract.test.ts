/**
 * overlayContract.test.ts — #826 v1 (2026-06-11).
 *
 * Pins the keystone: join engine (anchor / apiRecord / service shapes,
 * function-level precision, unresolved counting), roll-up (sum/max/avg,
 * cluster + service membership), registry defaults + persistence +
 * listeners, and the two shipped adapters.
 */

import { describe, it, expect } from 'vitest';
import { joinOverlay } from '../overlayJoin';
import { OverlayRegistry } from '../overlayRegistry';
import { todoCommentsOverlay, coverageOverlay, registerBuiltinOverlays } from '../adapters';
import type { OverlayDataPoint, OverlayStateRow } from '../overlayTypes';

const GRAPH = {
    graphId: 'map:workspace', type: 'map',
    nodes: [
        { id: 'file:src/a.ts', label: 'a.ts', anchor: { filePath: 'src/a.ts' } },
        { id: 'fn:src/a.ts:login', label: 'login', anchor: { filePath: 'src/a.ts', symbol: 'login' } },
        { id: 'file:src/b.ts', label: 'b.ts', anchor: { filePath: 'src/b.ts' } },
        { id: 'cluster:auth', label: 'auth' },
        { id: 'service:main', label: 'main' },
        { id: 'api:GET:/x', label: 'GET /x', meta: { apiId: 'GET:/x' } },
    ],
    edges: [], anchors: {}, meta: {},
} as any;

const SNAPSHOT = {
    files: {}, apiIndex: {}, graphs: {},
    clusters: { 'cluster:auth': { id: 'cluster:auth', files: ['src/a.ts'] } },
    services: { 'service:main': { id: 'service:main', name: 'main', rootPath: '' } },
} as any;

describe('#826 — joinOverlay', () => {
    it('anchor join: file-level point lands on the file node + its cluster + its service', () => {
        const points: OverlayDataPoint[] = [{ key: { filePath: 'src/a.ts' }, value: 3 }];
        const r = joinOverlay({ id: 't', join: 'anchor' }, points, GRAPH, SNAPSHOT);
        expect(r.values.get('file:src/a.ts')?.value).toBe(3);
        expect(r.values.get('cluster:auth')?.value).toBe(3);
        expect(r.values.get('service:main')?.value).toBe(3);
        expect(r.unresolved).toHaveLength(0);
    });

    it('anchor join: function-level point prefers the function node over the file node', () => {
        const points: OverlayDataPoint[] = [{ key: { filePath: 'src/a.ts', functionName: 'login' }, value: 80 }];
        const r = joinOverlay({ id: 'cov', join: 'anchor', aggregation: 'avg' }, points, GRAPH, SNAPSHOT);
        expect(r.values.get('fn:src/a.ts:login')?.value).toBe(80);
        expect(r.values.get('file:src/a.ts')).toBeUndefined();
    });

    it('apiRecord join resolves via meta.apiId', () => {
        const points: OverlayDataPoint[] = [{ key: { apiId: 'GET:/x' }, value: 120 }];
        const r = joinOverlay({ id: 'apm', join: 'apiRecord', aggregation: 'avg' }, points, GRAPH, SNAPSHOT);
        expect(r.values.get('api:GET:/x')?.value).toBe(120);
    });

    it('service join resolves service nodes directly', () => {
        const points: OverlayDataPoint[] = [{ key: { serviceId: 'service:main' }, value: 1, severity: 'error' }];
        const r = joinOverlay({ id: 'sentry', join: 'service' }, points, GRAPH, SNAPSHOT);
        expect(r.values.get('service:main')?.severity).toBe('error');
    });

    it('unresolved points are counted, never dropped (R3)', () => {
        const points: OverlayDataPoint[] = [
            { key: { filePath: 'src/a.ts' }, value: 1 },
            { key: { filePath: 'vendor/unknown.ts' }, value: 1 },
        ];
        const r = joinOverlay({ id: 't', join: 'anchor' }, points, GRAPH, SNAPSHOT);
        expect(r.unresolved).toHaveLength(1);
        expect(r.unresolved[0].key.filePath).toBe('vendor/unknown.ts');
    });

    it('roll-up aggregators: sum (default), max severity, avg', () => {
        const points: OverlayDataPoint[] = [
            { key: { filePath: 'src/a.ts' }, value: 2, severity: 'info' },
            { key: { filePath: 'src/a.ts' }, value: 4, severity: 'error' },
        ];
        const sum = joinOverlay({ id: 's', join: 'anchor' }, points, GRAPH, SNAPSHOT);
        expect(sum.values.get('file:src/a.ts')?.value).toBe(6);
        expect(sum.values.get('file:src/a.ts')?.severity).toBe('error');
        expect(sum.values.get('file:src/a.ts')?.pointCount).toBe(2);
        const avg = joinOverlay({ id: 'a', join: 'anchor', aggregation: 'avg' }, points, GRAPH, SNAPSHOT);
        expect(avg.values.get('file:src/a.ts')?.value).toBe(3);
        const max = joinOverlay({ id: 'm', join: 'anchor', aggregation: 'max' }, points, GRAPH, SNAPSHOT);
        expect(max.values.get('file:src/a.ts')?.value).toBe(4);
    });

    it('path normalization tolerates separators + leading ./', () => {
        const points: OverlayDataPoint[] = [{ key: { filePath: './src\\a.ts' }, value: 1 }];
        const r = joinOverlay({ id: 't', join: 'anchor' }, points, GRAPH, SNAPSHOT);
        expect(r.values.get('file:src/a.ts')?.value).toBe(1);
    });
});

describe('#826 — OverlayRegistry', () => {
    it('low-noise defaults: diff ON, everything else OFF (R2b)', () => {
        const reg = new OverlayRegistry();
        registerBuiltinOverlays(reg);
        const state = Object.fromEntries(reg.list().map((e) => [e.descriptor.id, e.enabled]));
        expect(state['diff']).toBe(true);
        expect(state['coverage']).toBe(false);
        expect(state['todo-comments']).toBe(false);
        expect(state['comments']).toBe(false);
    });

    it('toggles persist through the injected persistence + notify listeners', () => {
        let saved: OverlayStateRow[] | undefined;
        const reg = new OverlayRegistry();
        registerBuiltinOverlays(reg);
        reg.attachPersistence({ loadRows: () => undefined, saveRows: (rows) => { saved = rows; } });
        const events: OverlayStateRow[][] = [];
        reg.onStateChanged((rows) => events.push(rows));
        reg.setEnabled('coverage', true);
        expect(reg.isEnabled('coverage')).toBe(true);
        expect(saved?.find((r) => r.overlayId === 'coverage')?.enabled).toBe(true);
        expect(events).toHaveLength(1);

        // A fresh registry hydrates from persisted rows.
        const reg2 = new OverlayRegistry();
        registerBuiltinOverlays(reg2);
        reg2.attachPersistence({ loadRows: () => saved, saveRows: () => { /* */ } });
        expect(reg2.isEnabled('coverage')).toBe(true);
    });
});

describe('#826 — shipped adapters', () => {
    it('todo-comments counts markers per file via lazy content', async () => {
        const points = await todoCommentsOverlay.fetch({
            workspaceRoot: '/ws',
            working: { files: { 'src/a.ts': {}, 'src/b.ts': {} }, apiIndex: {}, graphs: {} } as any,
            getFileContent: (fp) => fp === 'src/a.ts'
                ? '// TODO one\n// FIXME two\nconst x = 1; // HACK three'
                : 'clean file',
        });
        expect(points).toHaveLength(1);
        expect(points[0].key.filePath).toBe('src/a.ts');
        expect(points[0].value).toBe(3);
    });

    it('coverage adapter returns [] without a report (empty-state row, not a crash)', async () => {
        const points = await coverageOverlay.fetch({
            workspaceRoot: '/nonexistent-no-coverage',
            working: { files: {}, apiIndex: {}, graphs: {} } as any,
        });
        expect(points).toEqual([]);
    });
});
