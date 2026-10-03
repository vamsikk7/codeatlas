/**
 * runtimeAdapters.test.ts — #911.
 *
 * The first runtime-data overlay adapter (Sentry error rate) end-to-end
 * (parse → join → paint) + regression-scope folded into the registry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { joinOverlay } from '../overlayJoin';
import { OverlayRegistry } from '../overlayRegistry';
import { registerBuiltinOverlays } from '../adapters';
import {
    parseSentryIssues,
    makeFileResolver,
    loadSentryConfig,
    sentryErrorsOverlay,
} from '../sentryAdapter';
import { regressionScopeOverlay } from '../regressionScopeAdapter';
import type { OverlayDataPoint } from '../overlayTypes';

const GRAPH = {
    graphId: 'map:workspace', type: 'map',
    nodes: [
        { id: 'file:src/a.ts', label: 'a.ts', anchor: { filePath: 'src/a.ts' } },
        { id: 'fn:src/a.ts:login', label: 'login', anchor: { filePath: 'src/a.ts', symbol: 'login' } },
        { id: 'file:src/b.ts', label: 'b.ts', anchor: { filePath: 'src/b.ts' } },
    ],
    edges: [], anchors: {}, meta: {},
} as any;
const SNAPSHOT = { files: {}, apiIndex: {}, graphs: {}, clusters: {}, services: {} } as any;

const tmp: string[] = [];
afterEach(() => { while (tmp.length) { try { fs.rmSync(tmp.pop()!, { recursive: true, force: true }); } catch { /* */ } } });

describe('#911 — Sentry adapter', () => {
    it('parseSentryIssues maps issues → points keyed by file/function with severity by threshold', () => {
        const points = parseSentryIssues([
            { id: '1', title: 'TypeError', count: '42', metadata: { filename: 'src/a.ts', function: 'login' } },
            { id: '2', title: 'RangeError', count: '3', metadata: { filename: 'src/b.ts' } },
            { id: '3', title: 'no file', count: '99', metadata: {} }, // dropped — no filename
        ], { errorThreshold: 10 });
        expect(points).toHaveLength(2);
        expect(points[0]).toMatchObject({ key: { filePath: 'src/a.ts', functionName: 'login' }, value: 42, severity: 'error' });
        expect(points[1]).toMatchObject({ key: { filePath: 'src/b.ts' }, value: 3, severity: 'warn' });
    });

    it('makeFileResolver suffix-matches a Sentry filename onto a workspace path', () => {
        const resolve = makeFileResolver(['src/a.ts', 'src/nested/b.ts']);
        expect(resolve('src/a.ts')).toBe('src/a.ts');
        expect(resolve('/abs/project/src/nested/b.ts')).toBe('src/nested/b.ts');
        expect(resolve('vendor/unknown.ts')).toBeUndefined();
    });

    it('end-to-end: parsed points join onto graph nodes (fetch → join → paint)', () => {
        const points = parseSentryIssues([
            { id: '1', count: '42', metadata: { filename: 'src/a.ts', function: 'login' } },
            { id: '2', count: '3', metadata: { filename: 'src/b.ts' } },
        ], { errorThreshold: 10 });
        const r = joinOverlay({ id: 'sentry-errors', join: 'anchor', paint: 'severity' } as any, points, GRAPH, SNAPSHOT);
        expect(r.values.get('fn:src/a.ts:login')).toMatchObject({ value: 42, severity: 'error' });
        expect(r.values.get('file:src/b.ts')).toMatchObject({ value: 3, severity: 'warn' });
        expect(r.unresolved).toHaveLength(0);
    });

    it('loadSentryConfig reads .codeatlas/sentry.json; missing required fields → null', () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrycfg-')); tmp.push(ws);
        expect(loadSentryConfig(ws), 'no file → null').toBeNull();
        fs.mkdirSync(path.join(ws, '.codeatlas'));
        fs.writeFileSync(path.join(ws, '.codeatlas', 'sentry.json'), JSON.stringify({ org: 'o' })); // missing project/token
        expect(loadSentryConfig(ws), 'incomplete → null').toBeNull();
        fs.writeFileSync(path.join(ws, '.codeatlas', 'sentry.json'), JSON.stringify({ org: 'o', project: 'p', authToken: 't', errorThreshold: 5 }));
        expect(loadSentryConfig(ws)).toMatchObject({ org: 'o', project: 'p', authToken: 't', errorThreshold: 5 });
    });

    it('adapter fetch returns [] (no network) when no config is present', async () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrynocfg-')); tmp.push(ws);
        const points = await sentryErrorsOverlay.fetch({ workspaceRoot: ws, working: SNAPSHOT });
        expect(points).toEqual([]);
    });
});

describe('#911 — regression-scope overlay', () => {
    it('no baseline → no points (matches the bespoke panel)', async () => {
        const points = await regressionScopeOverlay.fetch({ workspaceRoot: '/ws', working: SNAPSHOT });
        expect(points).toEqual([]);
    });

    it('emits a warn point for a changed file vs baseline', async () => {
        const baseline = { files: { 'src/a.ts': { hash: 'h1' } }, apiIndex: {}, graphs: {} } as any;
        const working = { files: { 'src/a.ts': { hash: 'h2' } }, apiIndex: {}, graphs: {} } as any;
        const points = await regressionScopeOverlay.fetch({ workspaceRoot: '/ws', working, baseline });
        const changed = points.find(p => p.key.filePath === 'src/a.ts');
        expect(changed, 'changed file should paint').toBeTruthy();
        expect(changed!.severity).toBe('warn');
        // The point joins onto the file node.
        const r = joinOverlay({ id: 'regression-scope', join: 'anchor', paint: 'severity', aggregation: 'max' } as any, points, GRAPH, SNAPSHOT);
        expect(r.values.get('file:src/a.ts')?.severity).toBe('warn');
    });
});

describe('#911 — registry folds both new adapters in', () => {
    it('sentry-errors + regression-scope are registered (default OFF, low-noise)', () => {
        const reg = new OverlayRegistry();
        registerBuiltinOverlays(reg);
        const state = Object.fromEntries(reg.list().map(e => [e.descriptor.id, e.enabled]));
        expect(state).toHaveProperty('sentry-errors', false);
        expect(state).toHaveProperty('regression-scope', false);
        // The runtime adapter declares an interval refresh; regression refreshes on cascade.
        const sentry = reg.list().find(e => e.descriptor.id === 'sentry-errors')!.descriptor;
        expect(sentry.refreshPolicy.kind).toBe('interval');
        expect(sentry.paint).toBe('severity');
    });
});
