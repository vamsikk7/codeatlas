/**
 * exportStaticDashboard.test.ts — Issue #710.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exportStaticDashboard } from '../exportStaticDashboard';
import type { Snapshot } from '../../core/graph/graphTypes';

function mkTmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmrf(p: string): void {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* noop */ }
}

function fakeSnapshot(): Snapshot {
    return {
        files: { 'src/a.ts': { path: 'src/a.ts', hash: 'h', mtime: 0, symbols: { functions: [], variables: [], imports: [] } } } as any,
        apiIndex: {
            'GET:/foo::src/a.ts::handler': { apiId: 'GET:/foo::src/a.ts::handler', method: 'GET', route: '/foo', handlerName: 'handler', filePath: 'src/a.ts', anchor: { filePath: 'src/a.ts', span: { start: 0, end: 1 } } },
        },
        graphs: {},
        clusters: {},
        services: {},
    };
}

function fakeStore(snapshot: Snapshot, workspaceRoot: string): any {
    return {
        getWorking: () => snapshot,
        workspaceRoot,
    };
}

describe('exportStaticDashboard', () => {
    let outDir: string;
    let webviewDist: string;

    beforeEach(() => {
        outDir = mkTmpdir('codeatlas-export-out-');
        webviewDist = mkTmpdir('codeatlas-export-wv-');
        // Lay down a tiny synthetic webview build so the copy path runs.
        fs.writeFileSync(path.join(webviewDist, 'index.html'), '<html><head></head><body>app</body></html>');
        fs.mkdirSync(path.join(webviewDist, 'assets'));
        fs.writeFileSync(path.join(webviewDist, 'assets', 'index.js'), 'console.log("app")');
        fs.writeFileSync(path.join(webviewDist, 'assets', 'index.css'), 'body{}');
    });

    afterEach(() => { rmrf(outDir); rmrf(webviewDist); });

    it('writes state.json + findings.json + README.md', async () => {
        const store = fakeStore(fakeSnapshot(), '/workspace');
        const result = await exportStaticDashboard(store, undefined, { outDir, webviewDist });

        expect(fs.existsSync(path.join(outDir, 'state.json'))).toBe(true);
        expect(fs.existsSync(path.join(outDir, 'findings.json'))).toBe(true);
        expect(fs.existsSync(path.join(outDir, 'README.md'))).toBe(true);
        expect(result.fileCount).toBeGreaterThanOrEqual(3);

        const state = JSON.parse(fs.readFileSync(path.join(outDir, 'state.json'), 'utf8'));
        expect(state.apiIndex['GET:/foo::src/a.ts::handler'].method).toBe('GET');
        const findings = JSON.parse(fs.readFileSync(path.join(outDir, 'findings.json'), 'utf8'));
        expect(findings).toEqual([]);
    });

    it('copies the webview-ui static build', async () => {
        const store = fakeStore(fakeSnapshot(), '/workspace');
        await exportStaticDashboard(store, undefined, { outDir, webviewDist });

        expect(fs.existsSync(path.join(outDir, 'index.html'))).toBe(true);
        expect(fs.existsSync(path.join(outDir, 'assets', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(outDir, 'assets', 'index.css'))).toBe(true);
    });

    it('injects the token gate when --token is supplied', async () => {
        const store = fakeStore(fakeSnapshot(), '/workspace');
        await exportStaticDashboard(store, undefined, { outDir, webviewDist, token: 'secret-token-42' });

        const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
        expect(html).toMatch(/<script>/);
        expect(html).toContain('"secret-token-42"');
        expect(html).toMatch(/codeatlas-export-token/);
    });

    it('does NOT inject the gate when no token is supplied', async () => {
        const store = fakeStore(fakeSnapshot(), '/workspace');
        await exportStaticDashboard(store, undefined, { outDir, webviewDist });

        const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
        expect(html).not.toContain('codeatlas-export-token');
    });

    it('handles missing webview build gracefully — state.json still written', async () => {
        const store = fakeStore(fakeSnapshot(), '/workspace');
        const result = await exportStaticDashboard(store, undefined, {
            outDir,
            webviewDist: '/nonexistent/path',
        });
        expect(fs.existsSync(path.join(outDir, 'state.json'))).toBe(true);
        expect(fs.existsSync(path.join(outDir, 'index.html'))).toBe(false);
        // state.json + findings.json + README.md  = 3 files minimum.
        expect(result.fileCount).toBe(3);
    });

    it('README includes counts from the snapshot', async () => {
        const store = fakeStore(fakeSnapshot(), '/workspace');
        await exportStaticDashboard(store, undefined, { outDir, webviewDist });
        const readme = fs.readFileSync(path.join(outDir, 'README.md'), 'utf8');
        expect(readme).toMatch(/1 files indexed/);
        expect(readme).toMatch(/1 entry points/);
    });

    it('totalBytes is reported and reasonable for the synthetic input', async () => {
        const store = fakeStore(fakeSnapshot(), '/workspace');
        const result = await exportStaticDashboard(store, undefined, { outDir, webviewDist });
        expect(result.totalBytes).toBeGreaterThan(0);
        // Synthetic input is tiny; export must fit comfortably in the
        // < 15 MB issue target.
        expect(result.totalBytes).toBeLessThan(15 * 1024 * 1024);
    });
});
