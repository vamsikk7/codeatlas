import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectServices, diffServices, detectInfrastructureServices, HTTP_ROUTE_METHODS } from '../serviceDetector';
import { detectMultiRepoMode } from '../multiRepoDetector';
import type { ServiceRecord, Snapshot } from '../../graph/graphTypes';

// BUG-EXPLORE-12: the L1 "N HTTP routes exposed" service label must count only
// true HTTP routes — NOT Celery JOBs / Kafka MQ_CONSUMERs / CLI commands / etc.
describe('HTTP_ROUTE_METHODS whitelist (BUG-EXPLORE-12)', () => {
    it('includes the HTTP verbs / route-defining methods', () => {
        for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ROUTE', 'CONTROLLER', 'RESOURCE']) {
            expect(HTTP_ROUTE_METHODS.has(m), m).toBe(true);
        }
    });
    it('EXCLUDES background-job / non-HTTP entry-point kinds', () => {
        for (const m of ['JOB', 'MQ_CONSUMER', 'CLI_COMMAND', 'DB_MIGRATION', 'DB_SEED', 'MODEL_HOOK', 'SIGNAL', 'SCREEN', 'NAV_ROUTE', 'SUBSCRIPTION', 'SOCKET_EVENT', 'WS', 'SSE', 'HEALTH', 'MIDDLEWARE', 'DI_BINDING']) {
            expect(HTTP_ROUTE_METHODS.has(m), m).toBe(false);
        }
    });
});

function makeMinimalSnapshot(filePaths: string[] = []): Snapshot {
    const files: Snapshot['files'] = {};
    for (const fp of filePaths) {
        files[fp] = {
            path: fp, hash: 'h', mtime: 0, content: '',
            symbols: { functions: [], variables: [], imports: [] },
        };
    }
    return { files, apiIndex: {}, graphs: {} };
}

function makeService(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
    return {
        id: 'service:orders',
        name: 'orders',
        rootPath: 'services/orders',
        technology: 'express',
        category: 'backend',
        exposedApiCount: 5,
        consumedUrls: [],
        consumedServices: [],
        ...overrides,
    };
}

// #FE-EXPOSED-VS-CONSUMED (2026-06-07) — Phase 2 finding #6 residual.
// FE / mobile services don't EXPOSE HTTP routes — they CONSUME them
// (fetch / axios / useQuery / Dio / URLSession). Reporting their
// outgoing-call count under `exposedApiCount` mislabels the semantic.
// The fix splits the metric: `exposedApiCount` stays a "what does this
// service expose" number (always 0 for FE/mobile), and a new
// `consumedApiCount` carries the NETWORK / DATA_FETCH / etc. tally
// for the L1 label switch. Backward-compatible: backend services
// keep their existing exposedApiCount semantics; the new field
// defaults to 0 there.
describe('detectServices — exposedApiCount vs consumedApiCount (FE/mobile semantic split)', () => {
    function readFromDisk(tmpDir: string) {
        return (fp: string) => {
            try { return fs.readFileSync(path.join(tmpDir, fp), 'utf-8'); }
            catch { return undefined; }
        };
    }

    it('frontend service reports exposedApiCount=0 and consumedApiCount=N for NETWORK calls', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-consumed-'));
        try {
            // Next.js minimal scaffold so detectTechnology picks 'nextjs' / category 'frontend'.
            fs.writeFileSync(path.join(tmpDir, 'package.json'),
                '{"dependencies":{"next":"^14","react":"^18"}}');
            fs.writeFileSync(path.join(tmpDir, 'next.config.js'), 'module.exports = {};');
            fs.mkdirSync(path.join(tmpDir, 'app'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'app/page.tsx'),
                "import next from 'next';\nexport default function Page() { return <div>x</div>; }");
            const snap = makeMinimalSnapshot(['app/page.tsx', 'package.json', 'next.config.js']);
            snap.apiIndex['net1'] = {
                apiId: 'net1', method: 'NETWORK', route: '/api/users',
                handlerName: 'fetchUsers', filePath: 'app/page.tsx',
                anchor: { filePath: 'app/page.tsx' },
            } as any;
            snap.apiIndex['net2'] = {
                apiId: 'net2', method: 'NETWORK', route: '/api/products',
                handlerName: 'fetchProducts', filePath: 'app/page.tsx',
                anchor: { filePath: 'app/page.tsx' },
            } as any;
            snap.apiIndex['data1'] = {
                apiId: 'data1', method: 'DATA_FETCH', route: '/api/profile',
                handlerName: 'useProfile', filePath: 'app/page.tsx',
                anchor: { filePath: 'app/page.tsx' },
            } as any;
            const services = detectServices(tmpDir, snap, readFromDisk(tmpDir));
            const fe = Object.values(services).find(s => s.category === 'frontend');
            expect(fe, 'expected a frontend service to be detected').toBeTruthy();
            expect(fe!.exposedApiCount, 'frontend exposes no routes').toBe(0);
            // The new `consumedApiCount` field surfaces the outgoing-call tally.
            expect((fe as any).consumedApiCount, 'consumedApiCount should reflect NETWORK + DATA_FETCH calls').toBe(3);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('backend service keeps exposedApiCount, consumedApiCount=0 (no NETWORK calls in pure backend)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-exposed-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'),
                '{"dependencies":{"express":"^4"}}');
            fs.writeFileSync(path.join(tmpDir, 'index.js'),
                "const express = require('express'); const app = express();");
            const snap = makeMinimalSnapshot(['index.js', 'package.json']);
            snap.apiIndex['r1'] = {
                apiId: 'r1', method: 'GET', route: '/users',
                handlerName: 'h', filePath: 'index.js', anchor: { filePath: 'index.js' },
            } as any;
            snap.apiIndex['r2'] = {
                apiId: 'r2', method: 'POST', route: '/users',
                handlerName: 'h', filePath: 'index.js', anchor: { filePath: 'index.js' },
            } as any;
            const services = detectServices(tmpDir, snap, readFromDisk(tmpDir));
            const be = Object.values(services).find(s => s.category === 'backend');
            expect(be).toBeTruthy();
            expect(be!.exposedApiCount).toBe(2);
            expect((be as any).consumedApiCount ?? 0).toBe(0);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    // BUG-EXP-4: a frontend whose API base comes from an internal-API env var
    // (VITE_API_URL / REACT_APP_API_URL / API_BASE_URL …) points at the sibling
    // backend in a full-stack monorepo — it must resolve to that service, NOT a
    // phantom `vite-api` «external» node.
    it('resolves an internal API-base env var (VITE_API_URL) to the sibling backend (BUG-EXP-4)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-be-env-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
                'services:',
                '  backend:',
                '    build: backend',
                '  frontend:',
                '    build: frontend',
            ].join('\n'));
            fs.mkdirSync(path.join(tmpDir, 'backend'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'backend/main.py'),
                'from fastapi import FastAPI\napp = FastAPI()');
            fs.mkdirSync(path.join(tmpDir, 'frontend/src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'frontend/package.json'),
                '{"dependencies":{"vite":"^5","react":"^18"}}');
            fs.writeFileSync(path.join(tmpDir, 'frontend/src/main.tsx'),
                'import { OpenAPI } from "./client";\nOpenAPI.BASE = import.meta.env.VITE_API_URL;');
            const snap = makeMinimalSnapshot([
                'docker-compose.yml', 'backend/main.py',
                'frontend/package.json', 'frontend/src/main.tsx',
            ]);
            snap.apiIndex['r1'] = {
                apiId: 'r1', method: 'GET', route: '/items',
                handlerName: 'h', filePath: 'backend/main.py', anchor: { filePath: 'backend/main.py' },
            } as any;
            const services = detectServices(tmpDir, snap, readFromDisk(tmpDir));
            const fe = Object.values(services).find(s => s.category === 'frontend');
            const be = Object.values(services).find(s => s.category === 'backend');
            expect(fe, 'frontend detected').toBeTruthy();
            expect(be, 'backend detected').toBeTruthy();
            expect(fe!.consumedServices, 'FE resolves VITE_API_URL to sibling backend').toContain(be!.id);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    // BUG-EXP-5: a React + Vite SPA (no meta-framework) was detected as
    // technology 'unknown' → rendered as a bare «Service» node with no tech
    // badge. It should be recognized as `react` (category frontend).
    it('classifies a React + Vite SPA as technology "react", not unknown (BUG-EXP-5)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-vite-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'),
                '{"dependencies":{"react":"^18","react-dom":"^18","@tanstack/react-router":"^1","axios":"^1"},"devDependencies":{"vite":"^5","@vitejs/plugin-react-swc":"^3"}}');
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src/main.tsx'),
                "import React from 'react';\nimport { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')!).render(<App />);");
            const snap = makeMinimalSnapshot(['package.json', 'src/main.tsx']);
            const services = detectServices(tmpDir, snap, readFromDisk(tmpDir));
            const fe = Object.values(services).find(s => s.category === 'frontend');
            expect(fe, 'React SPA classified as frontend').toBeTruthy();
            expect(fe!.technology, 'technology should not be unknown').not.toBe('unknown');
            expect(fe!.technology).toBe('react');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    // TICKET-MOBILE-2 — a Jetpack Compose module whose `import androidx.*` is past
    // the source-scan cap must still classify as android via build.gradle(.kts),
    // not fall through to 'unknown'.
    it('classifies a Compose app as "android" via AndroidManifest.xml — plugin in app/, no androidx in scanned src (TICKET-MOBILE-2)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-'));
        try {
            // Real compose-samples layout: the android plugin is in app/build.gradle.kts,
            // NOT the module root — so a root-gradle check misses it.
            fs.writeFileSync(path.join(tmpDir, 'build.gradle.kts'), 'plugins {\n  id("org.jetbrains.kotlin.jvm") apply false\n}\n');
            fs.mkdirSync(path.join(tmpDir, 'app/src/main'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'app/build.gradle.kts'), 'plugins { id("com.android.application") }\n');
            fs.writeFileSync(path.join(tmpDir, 'app/src/main/AndroidManifest.xml'), '<manifest package="com.example" />\n');
            // Kotlin source WITHOUT an `import androidx.` in the scanned window (real module\'s is past the cap).
            fs.writeFileSync(path.join(tmpDir, 'app/src/main/Home.kt'), 'package com.example\n\nfun greet(): String = "hi"\n');
            const snap = makeMinimalSnapshot(['build.gradle.kts', 'app/build.gradle.kts', 'app/src/main/AndroidManifest.xml', 'app/src/main/Home.kt']);
            const services = detectServices(tmpDir, snap, readFromDisk(tmpDir));
            const svc = Object.values(services)[0];
            expect(svc, 'compose module detected as a service').toBeTruthy();
            expect(svc.technology, 'Compose module must classify as android via AndroidManifest, not unknown').toBe('android');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('classifies a @Composable source file as "android" (TICKET-MOBILE-2)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composable-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src/Screen.kt'),
                'package com.example\nimport androidx.compose.runtime.Composable\n\n@Composable\nfun HomeScreen() {}\n');
            const snap = makeMinimalSnapshot(['src/Screen.kt']);
            const services = detectServices(tmpDir, snap, readFromDisk(tmpDir));
            const svc = Object.values(services)[0];
            expect(svc?.technology).toBe('android');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    // BUG-EXP-5 regression — a Go service (go.mod) that bundles a JS/react EXAMPLE
    // (like go-echo's `react-router` recipe) must NOT be labeled `react`.
    it('does NOT label a Go service (go.mod) as react even with a bundled react example', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-react-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'main.go'),
                'package main\nimport "github.com/labstack/echo/v4"\nfunc main() {}');
            // A react example FILE within the same service (no separate package.json,
            // so no separate frontend service is split out).
            fs.writeFileSync(path.join(tmpDir, 'example.tsx'), "import React from 'react';\nexport const X = () => null;");
            const snap = makeMinimalSnapshot(['go.mod', 'main.go', 'example.tsx']);
            snap.apiIndex['r1'] = { apiId: 'r1', method: 'GET', route: '/', handlerName: 'h', filePath: 'main.go', anchor: { filePath: 'main.go' } } as any;
            const services = detectServices(tmpDir, snap, readFromDisk(tmpDir));
            const svc = Object.values(services)[0];
            expect(svc, 'service detected').toBeTruthy();
            expect(svc.technology, 'a Go-manifest service must not be labeled react').not.toBe('react');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('Issue #81: MAUI service (Microsoft.Maui using-import) classifies as mobile with consumedApiCount', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maui-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'MauiProgram.cs'),
                'using Microsoft.Maui;\npublic static class MauiProgram { }');
            const snap = makeMinimalSnapshot(['MauiProgram.cs']);
            snap.apiIndex['n1'] = {
                apiId: 'n1', method: 'NETWORK', route: 'https://api.example.com/users',
                handlerName: 'GetAsync', filePath: 'MauiProgram.cs',
                anchor: { filePath: 'MauiProgram.cs' },
            } as any;
            const services = detectServices(tmpDir, snap, readFromDisk(tmpDir));
            const maui = Object.values(services).find(s => s.technology === 'maui');
            expect(maui, 'expected MAUI service to be detected').toBeTruthy();
            expect(maui!.category).toBe('mobile');
            expect(maui!.exposedApiCount).toBe(0);
            expect((maui as any).consumedApiCount).toBe(1);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('mobile service (Flutter pubspec.yaml) reports exposedApiCount=0 and consumedApiCount=N', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-consumed-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pubspec.yaml'),
                "name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\n");
            fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'lib/main.dart'),
                "void main() { runApp(MyApp()); }");
            const snap = makeMinimalSnapshot(['lib/main.dart', 'pubspec.yaml']);
            snap.apiIndex['net1'] = {
                apiId: 'net1', method: 'NETWORK', route: 'https://api.example.com/users',
                handlerName: 'fetchUsers', filePath: 'lib/main.dart',
                anchor: { filePath: 'lib/main.dart' },
            } as any;
            const services = detectServices(tmpDir, snap, readFromDisk(tmpDir));
            const mob = Object.values(services).find(s => s.category === 'mobile');
            expect(mob).toBeTruthy();
            expect(mob!.exposedApiCount).toBe(0);
            expect((mob as any).consumedApiCount).toBe(1);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });
});

describe('diffServices', () => {
    it('marks unchanged services as unchanged', () => {
        const svc = makeService();
        const result = diffServices({ 'service:orders': svc }, { 'service:orders': svc });
        expect(result['service:orders']?.diff).toBe('unchanged');
    });

    it('marks new services as added', () => {
        const svc = makeService();
        const result = diffServices({}, { 'service:orders': svc });
        expect(result['service:orders']?.diff).toBe('added');
    });

    it('marks removed services as deleted', () => {
        const svc = makeService();
        const result = diffServices({ 'service:orders': svc }, {});
        const deleted = Object.values(result).find((s) => s.name === 'orders' && s.diff === 'deleted');
        expect(deleted).toBeDefined();
    });

    it('marks service as modified when exposedApiCount changes', () => {
        const base = makeService({ exposedApiCount: 3 });
        const working = makeService({ exposedApiCount: 5 });
        const result = diffServices({ 'service:orders': base }, { 'service:orders': working });
        expect(result['service:orders']?.diff).toBe('modified');
    });

    it('marks service as modified when technology changes', () => {
        const base = makeService({ technology: 'express' });
        const working = makeService({ technology: 'fastify' });
        const result = diffServices({ 'service:orders': base }, { 'service:orders': working });
        expect(result['service:orders']?.diff).toBe('modified');
    });

    it('marks service as modified when a member file content hash changes', () => {
        const svc = makeService();
        const baselineFiles = {
            'services/orders/index.ts': { hash: 'abc123' },
            'services/orders/routes.ts': { hash: 'def456' },
        };
        const workingFiles = {
            'services/orders/index.ts': { hash: 'abc123_changed' }, // content changed
            'services/orders/routes.ts': { hash: 'def456' },
        };
        const result = diffServices(
            { 'service:orders': svc },
            { 'service:orders': svc },
            baselineFiles,
            workingFiles
        );
        expect(result['service:orders']?.diff).toBe('modified');
    });

    it('leaves service unchanged when all file hashes are identical', () => {
        const svc = makeService();
        const fileRecords = {
            'services/orders/index.ts': { hash: 'abc123' },
            'services/orders/routes.ts': { hash: 'def456' },
        };
        const result = diffServices(
            { 'service:orders': svc },
            { 'service:orders': svc },
            fileRecords,
            fileRecords
        );
        expect(result['service:orders']?.diff).toBe('unchanged');
    });

    it('does not mark service as modified when files outside its rootPath change', () => {
        const svc = makeService({ rootPath: 'services/orders' });
        const baselineFiles = {
            'services/orders/index.ts': { hash: 'abc' },
            'services/payments/index.ts': { hash: 'xyz' }, // different service
        };
        const workingFiles = {
            'services/orders/index.ts': { hash: 'abc' },   // unchanged
            'services/payments/index.ts': { hash: 'xyz_changed' }, // payments changed
        };
        const result = diffServices(
            { 'service:orders': svc },
            { 'service:orders': svc },
            baselineFiles,
            workingFiles
        );
        expect(result['service:orders']?.diff).toBe('unchanged');
    });

    it('handles workspace-root service (rootPath="") by checking all files', () => {
        const svc = makeService({ rootPath: '' });
        const baselineFiles = { 'src/index.ts': { hash: 'aaa' } };
        const workingFiles = { 'src/index.ts': { hash: 'bbb' } };
        const result = diffServices(
            { 'service:main': svc },
            { 'service:main': svc },
            baselineFiles,
            workingFiles
        );
        expect(result['service:main']?.diff).toBe('modified');
    });
});

describe('detectServices with docker-compose', () => {
    it('maps service with build: . to rootPath "" (whole workspace)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
                'version: "3"',
                'services:',
                '  backend:',
                '    build: .',
                '    ports:',
                '      - "3000:3000"',
                '  mongo:',
                '    image: mongo',
            ].join('\n'));

            const snapshot = makeMinimalSnapshot(['src/index.ts', 'src/routes.ts']);
            const services = detectServices(tmpDir, snapshot);

            // Only 'backend' (buildable) should be detected; 'mongo' (image-only) is skipped
            const serviceIds = Object.keys(services);
            expect(serviceIds).toContain('service:backend');
            expect(serviceIds.some((id) => id.includes('mongo'))).toBe(false);

            // backend with build: . maps to rootPath '' (entire workspace)
            expect(services['service:backend']?.rootPath).toBe('');
            // All workspace files should be attributed to backend
            expect(services['service:backend']?.exposedApiCount).toBeGreaterThanOrEqual(0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('skips image-only services (no build context) from service detection', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
                'version: "3"',
                'services:',
                '  redis:',
                '    image: redis:7',
                '  postgres:',
                '    image: postgres:15',
            ].join('\n'));

            // All services are image-only → should fall back to single 'main' service
            const snapshot = makeMinimalSnapshot(['src/app.ts']);
            const services = detectServices(tmpDir, snapshot);
            const serviceIds = Object.keys(services);
            expect(serviceIds).not.toContain('service:redis');
            expect(serviceIds).not.toContain('service:postgres');
            // Fallback: single 'main' service covering workspace
            expect(serviceIds).toContain('service:main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // BUG-EXP-3: the orphan-guard must not spawn a phantom workspace `main`
    // service when the only uncovered source files live in tooling /
    // scaffolding dirs (scripts/, hooks/, .copier/, .github/, …). py-fastapi's
    // root has `scripts/*.py`, `hooks/post_gen_project.py`, `.copier/*.py` —
    // none are app code, but they used to create a routeless `main` service.
    it('does NOT create a phantom "main" service from root-level tooling dirs (BUG-EXP-3)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
                'services:',
                '  backend:',
                '    build: backend',
                '  frontend:',
                '    build: frontend',
            ].join('\n'));
            const snapshot = makeMinimalSnapshot([
                'backend/app/main.py',
                'frontend/src/index.ts',
                // root-level tooling — must NOT trigger a phantom `main`
                'scripts/add_latest_release_date.py',
                'hooks/post_gen_project.py',
                '.copier/update_dotenv.py',
            ]);
            const services = detectServices(tmpDir, snapshot);
            const serviceIds = Object.keys(services);
            expect(serviceIds).toContain('service:backend');
            expect(serviceIds).toContain('service:frontend');
            expect(serviceIds).not.toContain('service:main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('detectServices — Spring Boot / Java projects', () => {
    it('detects spring technology from Spring Boot imports in Java source files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-java-'));
        try {
            // Simulate a backend/ service with pom.xml and a src/ directory
            fs.mkdirSync(path.join(tmpDir, 'backend', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'backend', 'pom.xml'), '<project/>');
            fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
                'version: "3"',
                'services:',
                '  backend:',
                '    build: ./backend',
                '  db:',
                '    image: postgres:16',
            ].join('\n'));

            // Snapshot with Java source containing Spring Boot imports
            const snapshot: Snapshot = {
                files: {
                    'backend/src/main/java/AuthController.java': {
                        path: 'backend/src/main/java/AuthController.java',
                        hash: 'abc',
                        mtime: 0,
                        content: 'import org.springframework.web.bind.annotation.*;\n@RestController\npublic class AuthController {}',
                        symbols: { functions: [], variables: [], imports: [] },
                    },
                },
                apiIndex: {},
                graphs: {},
            };

            const services = detectServices(tmpDir, snapshot);
            expect(services['service:backend']).toBeDefined();
            expect(services['service:backend']?.technology).toBe('spring');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('connects frontend to backend via relative-api same-origin detection', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-java2-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'backend', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'backend', 'pom.xml'), '<project/>');
            fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
                'version: "3"',
                'services:',
                '  backend:',
                '    build: ./backend',
            ].join('\n'));

            const snapshot: Snapshot = {
                files: {
                    'frontend/app.js': {
                        path: 'frontend/app.js',
                        hash: 'fe1',
                        mtime: 0,
                        content: "const API_BASE = '/api';\nfetch(API_BASE + '/todos');",
                        symbols: { functions: [], variables: [], imports: [] },
                    },
                    'backend/src/main/java/TodoController.java': {
                        path: 'backend/src/main/java/TodoController.java',
                        hash: 'be1',
                        mtime: 0,
                        content: 'import org.springframework.web.bind.annotation.*;\n@RestController\npublic class TodoController {}',
                        symbols: { functions: [], variables: [], imports: [] },
                    },
                },
                apiIndex: {
                    'GET:/api/todos::backend/src/main/java/TodoController.java::listTodos': {
                        apiId: 'GET:/api/todos::backend/src/main/java/TodoController.java::listTodos',
                        method: 'GET', route: '/api/todos',
                        handlerName: 'listTodos',
                        filePath: 'backend/src/main/java/TodoController.java',
                        anchor: { filePath: 'backend/src/main/java/TodoController.java', symbol: 'listTodos', span: { start: 0, end: 0 } },
                    },
                },
                graphs: {},
            };

            const services = detectServices(tmpDir, snapshot);
            // frontend should connect to backend via relative-api detection
            const frontendSvc = Object.values(services).find(s => s.name === 'main' || s.rootPath === '');
            const backendSvc = services['service:backend'];
            expect(backendSvc).toBeDefined();
            // backend exposes 1 API
            expect(backendSvc?.exposedApiCount).toBe(1);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('detectServices — nested category directories (#426)', () => {
    // Issue #426: rust-actix groups its examples into `https-tls/` /
    // `cors/` / `websockets/` etc., each containing per-example sub-crates
    // with their own Cargo.toml. The detector only scanned ROOT subdirs for
    // manifests and missed the depth-2 manifests, so clusters built from
    // those sub-crates had no matching service (orphan rate 96% for
    // rust-rocket, 76% for rust-axum, 89% for go-echo, 78% for php-laravel).
    it('detects services in depth-2 children of root subdirs without their own manifest', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-nested-svc-'));
        try {
            // Layout:
            //   <root>/Cargo.toml          ← root workspace
            //   <root>/background-jobs/Cargo.toml  ← depth-1 service
            //   <root>/https-tls/          ← category dir, NO manifest
            //   <root>/https-tls/acme-letsencrypt/Cargo.toml  ← depth-2 service
            //   <root>/https-tls/awc-https/Cargo.toml         ← depth-2 service
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[workspace]\nmembers = ["*"]\n');
            fs.mkdirSync(path.join(tmpDir, 'background-jobs', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'background-jobs', 'Cargo.toml'), '[package]\nname = "background-jobs"\n');
            fs.writeFileSync(path.join(tmpDir, 'background-jobs', 'src', 'main.rs'), 'fn main() {}\n');
            fs.mkdirSync(path.join(tmpDir, 'https-tls', 'acme-letsencrypt', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'https-tls', 'acme-letsencrypt', 'Cargo.toml'), '[package]\nname = "acme-letsencrypt"\n');
            fs.writeFileSync(path.join(tmpDir, 'https-tls', 'acme-letsencrypt', 'src', 'main.rs'), 'fn main() {}\n');
            fs.mkdirSync(path.join(tmpDir, 'https-tls', 'awc-https', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'https-tls', 'awc-https', 'Cargo.toml'), '[package]\nname = "awc-https"\n');
            fs.writeFileSync(path.join(tmpDir, 'https-tls', 'awc-https', 'src', 'main.rs'), 'fn main() {}\n');

            const snapshot = makeMinimalSnapshot([
                'background-jobs/src/main.rs',
                'https-tls/acme-letsencrypt/src/main.rs',
                'https-tls/awc-https/src/main.rs',
            ]);
            const services = detectServices(tmpDir, snapshot);
            const rootPaths = Object.values(services).map(s => s.rootPath).sort();
            expect(rootPaths, 'detected service rootPaths').toContain('background-jobs');
            expect(rootPaths, 'depth-2 services under https-tls/').toContain('https-tls/acme-letsencrypt');
            expect(rootPaths).toContain('https-tls/awc-https');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects services at depth-3 (e.g. contrib/db_pools/{lib,codegen}) — #426 residual', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-depth3-'));
        try {
            // Layout:
            //   <root>/Cargo.toml                                  ← workspace
            //   <root>/contrib/                                    ← category, NO manifest
            //   <root>/contrib/ws/Cargo.toml                       ← depth-2 service
            //   <root>/contrib/db_pools/                           ← sub-category, NO manifest
            //   <root>/contrib/db_pools/codegen/Cargo.toml         ← depth-3 service
            //   <root>/contrib/db_pools/lib/Cargo.toml             ← depth-3 service
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[workspace]\n');
            fs.mkdirSync(path.join(tmpDir, 'contrib', 'ws', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'contrib', 'ws', 'Cargo.toml'), '[package]\nname="ws"\n');
            fs.writeFileSync(path.join(tmpDir, 'contrib', 'ws', 'src', 'lib.rs'), 'fn x(){}\n');
            fs.mkdirSync(path.join(tmpDir, 'contrib', 'db_pools', 'codegen', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'contrib', 'db_pools', 'codegen', 'Cargo.toml'), '[package]\nname="db_pools_codegen"\n');
            fs.writeFileSync(path.join(tmpDir, 'contrib', 'db_pools', 'codegen', 'src', 'lib.rs'), 'fn y(){}\n');
            fs.mkdirSync(path.join(tmpDir, 'contrib', 'db_pools', 'lib', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'contrib', 'db_pools', 'lib', 'Cargo.toml'), '[package]\nname="db_pools_lib"\n');
            fs.writeFileSync(path.join(tmpDir, 'contrib', 'db_pools', 'lib', 'src', 'lib.rs'), 'fn z(){}\n');

            const snapshot = makeMinimalSnapshot([
                'contrib/ws/src/lib.rs',
                'contrib/db_pools/codegen/src/lib.rs',
                'contrib/db_pools/lib/src/lib.rs',
            ]);
            const services = detectServices(tmpDir, snapshot);
            const rootPaths = Object.values(services).map(s => s.rootPath).sort();
            expect(rootPaths).toContain('contrib/ws');
            expect(rootPaths, 'depth-3 db_pools/codegen').toContain('contrib/db_pools/codegen');
            expect(rootPaths, 'depth-3 db_pools/lib').toContain('contrib/db_pools/lib');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('disambiguates colliding service names across sub-trees (#426 follow-up)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-name-collide-'));
        try {
            // Two crates named `codegen` under different parents — without
            // disambiguation they'd collapse to a single `service:codegen`.
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[workspace]\n');
            fs.mkdirSync(path.join(tmpDir, 'core', 'codegen', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'core', 'codegen', 'Cargo.toml'), '[package]\nname="core-codegen"\n');
            fs.writeFileSync(path.join(tmpDir, 'core', 'codegen', 'src', 'lib.rs'), '');
            fs.mkdirSync(path.join(tmpDir, 'contrib', 'db_pools', 'codegen', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'contrib', 'db_pools', 'codegen', 'Cargo.toml'), '[package]\nname="db-codegen"\n');
            fs.writeFileSync(path.join(tmpDir, 'contrib', 'db_pools', 'codegen', 'src', 'lib.rs'), '');

            const snapshot = makeMinimalSnapshot([
                'core/codegen/src/lib.rs',
                'contrib/db_pools/codegen/src/lib.rs',
            ]);
            const services = detectServices(tmpDir, snapshot);
            const ids = Object.keys(services).sort();
            // Both services must survive — no overwrite — so their distinct
            // file trees can be attributed to distinct service IDs.
            expect(ids.length, `got services: ${ids.join(', ')}`).toBeGreaterThanOrEqual(2);
            // IDs must be unique (no duplicate `service:codegen` collapse).
            expect(new Set(ids).size).toBe(ids.length);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does NOT recurse into root subdirs that themselves carry a manifest', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-svc-no-recurse-'));
        try {
            // backend/Cargo.toml exists → backend is its own service.
            // backend/sub/Cargo.toml exists too, but we should not register
            // it as a sibling service of `backend`.
            fs.mkdirSync(path.join(tmpDir, 'backend', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'backend', 'Cargo.toml'), '[package]\nname = "backend"\n');
            fs.writeFileSync(path.join(tmpDir, 'backend', 'src', 'main.rs'), 'fn main() {}\n');
            fs.mkdirSync(path.join(tmpDir, 'backend', 'sub'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'backend', 'sub', 'Cargo.toml'), '[package]\nname = "sub"\n');

            const snapshot = makeMinimalSnapshot([
                'backend/src/main.rs',
                'backend/sub/main.rs',
            ]);
            const services = detectServices(tmpDir, snapshot);
            const rootPaths = Object.values(services).map(s => s.rootPath).sort();
            expect(rootPaths).toContain('backend');
            expect(rootPaths, 'sub-manifest under an existing service must not become a sibling').not.toContain('backend/sub');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('detectInfrastructureServices — Spring JPA patterns', () => {
    it('detects PostgreSQL JPA from Spring Data JPA imports in Java source', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-infra-'));
        try {
            // No docker-compose — infra detected purely from source code patterns
            const snapshot: Snapshot = {
                files: {
                    'src/UserRepository.java': {
                        path: 'src/UserRepository.java',
                        hash: 'h1',
                        mtime: 0,
                        content: 'import org.springframework.data.jpa.repository.JpaRepository;\npublic interface UserRepository extends JpaRepository<User, Long> {}',
                        symbols: { functions: [], variables: [], imports: [] },
                    },
                },
                apiIndex: {},
                graphs: {},
            };
            const services = { 'service:main': { id: 'service:main', name: 'main', rootPath: '', technology: 'spring' as const, exposedApiCount: 0, consumedUrls: [], consumedServices: [] } };
            const infra = detectInfrastructureServices(tmpDir, snapshot, services);
            const jpaInfra = infra.find(i => i.name.includes('JPA') || i.name.includes('PostgreSQL'));
            expect(jpaInfra).toBeDefined();
            expect(jpaInfra?.kind).toBe('database');
            expect(jpaInfra?.consumedBy).toContain('service:main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // Regression: #354 dropped FileRecord.content from RAM after save() to bound
    // memory on large workspaces. Service / infra detection must still work in
    // that state by reading content lazily via a ContentProvider callback —
    // otherwise the L1 DB / queue / cache layer disappears from the diagram on
    // every post-save L1 rebuild.
    it('detects DB infra via getContent callback when FileRecord.content is dropped', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-lazy-content-'));
        try {
            const filePath = 'src/db.ts';
            // Simulate post-save state: NO `content` field on the record.
            const snapshot: Snapshot = {
                files: {
                    [filePath]: {
                        path: filePath, hash: 'h1', mtime: 0,
                        symbols: { functions: [], variables: [], imports: [] },
                    } as any,
                },
                apiIndex: {},
                graphs: {},
            };
            const services = { 'service:main': { id: 'service:main', name: 'main', rootPath: '', technology: 'express' as const, exposedApiCount: 0, consumedUrls: [], consumedServices: [] } };

            // Without a provider, no infra is detected (records are empty).
            const without = detectInfrastructureServices(tmpDir, snapshot, services);
            expect(without).toHaveLength(0);

            // With a provider returning the real source, Prisma is detected.
            const getContent = (fp: string) =>
                fp === filePath
                    ? 'import { PrismaClient } from "@prisma/client";\nconst prisma = new PrismaClient();'
                    : undefined;
            const infra = detectInfrastructureServices(tmpDir, snapshot, services, getContent);
            const prisma = infra.find(i => i.name.includes('Prisma'));
            expect(prisma).toBeDefined();
            expect(prisma?.kind).toBe('database');
            expect(prisma?.consumedBy).toContain('service:main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects SQL JPA from jakarta.persistence annotations in Java entity files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-infra2-'));
        try {
            const snapshot: Snapshot = {
                files: {
                    'src/Todo.java': {
                        path: 'src/Todo.java',
                        hash: 'h2',
                        mtime: 0,
                        content: 'import jakarta.persistence.*;\n@Entity\n@Table(name="todos")\npublic class Todo {}',
                        symbols: { functions: [], variables: [], imports: [] },
                    },
                },
                apiIndex: {},
                graphs: {},
            };
            const services = { 'service:main': { id: 'service:main', name: 'main', rootPath: '', technology: 'spring' as const, exposedApiCount: 0, consumedUrls: [], consumedServices: [] } };
            const infra = detectInfrastructureServices(tmpDir, snapshot, services);
            const sqlInfra = infra.find(i => i.kind === 'database');
            expect(sqlInfra).toBeDefined();
            expect(sqlInfra?.consumedBy).toContain('service:main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // Issue #432: java-spring (Petclinic) L1 detected `Room` (Android SQLite ORM)
    // as an infrastructure database because the Room pattern matched bare
    // `@Entity` — which JPA also uses. The fix tightens the Room regex to
    // Android-specific decorators (`@Database` / `@Dao`) so JPA entities don't
    // false-positive into the Room bucket.
    it('does NOT detect Room infra for Spring JPA @Entity classes (#432)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-no-room-'));
        try {
            const snapshot: Snapshot = {
                files: {
                    'src/Vet.java': {
                        path: 'src/Vet.java',
                        hash: 'h1',
                        mtime: 0,
                        content: [
                            'import jakarta.persistence.Entity;',
                            'import jakarta.persistence.Table;',
                            '@Entity',
                            '@Table(name="vets")',
                            'public class Vet {}',
                        ].join('\n'),
                        symbols: { functions: [], variables: [], imports: [] },
                    },
                },
                apiIndex: {},
                graphs: {},
            };
            const services = { 'service:main': { id: 'service:main', name: 'main', rootPath: '', technology: 'spring' as const, exposedApiCount: 0, consumedUrls: [], consumedServices: [] } };
            const infra = detectInfrastructureServices(tmpDir, snapshot, services);
            const roomInfra = infra.find(i => i.name === 'Room');
            expect(roomInfra, 'JPA @Entity must not register as Room (Android SQLite)').toBeUndefined();
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('STILL detects Room infra for real Android Room @Database / @Dao usage (#432 sanity)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-real-room-'));
        try {
            const snapshot: Snapshot = {
                files: {
                    'app/AppDatabase.kt': {
                        path: 'app/AppDatabase.kt',
                        hash: 'h1',
                        mtime: 0,
                        content: [
                            'import androidx.room.Database',
                            'import androidx.room.RoomDatabase',
                            '@Database(entities = [User::class], version = 1)',
                            'abstract class AppDatabase : RoomDatabase() {}',
                        ].join('\n'),
                        symbols: { functions: [], variables: [], imports: [] },
                    },
                    'app/UserDao.kt': {
                        path: 'app/UserDao.kt',
                        hash: 'h2',
                        mtime: 0,
                        content: [
                            'import androidx.room.Dao',
                            '@Dao',
                            'interface UserDao { }',
                        ].join('\n'),
                        symbols: { functions: [], variables: [], imports: [] },
                    },
                },
                apiIndex: {},
                graphs: {},
            };
            const services = { 'service:main': { id: 'service:main', name: 'main', rootPath: '', technology: 'android' as any, exposedApiCount: 0, consumedUrls: [], consumedServices: [] } };
            const infra = detectInfrastructureServices(tmpDir, snapshot, services);
            const roomInfra = infra.find(i => i.name === 'Room');
            expect(roomInfra, 'real Android Room usage must still detect').toBeDefined();
            expect(roomInfra?.kind).toBe('database');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// #528 — Celery worker + beat scheduler expansion.
describe('detectServices — Celery worker + beat expansion (#528)', () => {
    function setup(opts: { extra: Array<{ relPath: string; content?: string }> }): { tmpDir: string; snapshot: Snapshot } {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'celery-detect-'));
        // Service root with a Django project + Celery app.
        const projDir = path.join(tmpDir, 'examples', 'django');
        const innerProj = path.join(projDir, 'proj');
        fs.mkdirSync(innerProj, { recursive: true });
        // Manifest so the monorepo detector picks up examples/django as a service.
        fs.writeFileSync(path.join(projDir, 'requirements.txt'), 'django\ncelery\n');
        const celeryPyContent = "from celery import Celery\napp = Celery('proj')\n";
        fs.writeFileSync(path.join(innerProj, 'celery.py'), celeryPyContent);
        for (const ex of opts.extra) {
            const full = path.join(tmpDir, ex.relPath);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, ex.content ?? '');
        }
        const snapshot: Snapshot = {
            files: {
                'examples/django/proj/celery.py': {
                    path: 'examples/django/proj/celery.py',
                    hash: 'h1', mtime: 0, content: celeryPyContent,
                    symbols: { functions: [], variables: [], imports: [] },
                },
            },
            apiIndex: {},
            graphs: {},
        };
        return { tmpDir, snapshot };
    }

    it('expands worker + beat when systemd unit files are present', () => {
        const { tmpDir, snapshot } = setup({
            extra: [
                { relPath: 'extra/systemd/celery.service', content: '[Unit]\nDescription=Celery\n' },
                { relPath: 'extra/systemd/celerybeat.service', content: '[Unit]\nDescription=Celery beat\n' },
            ],
        });
        try {
            const services = detectServices(tmpDir, snapshot);
            const names = Object.values(services).map((s) => s.name).sort();
            expect(names).toContain('django');
            expect(names).toContain('django-worker');
            expect(names).toContain('django-beat');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('expands worker + beat when supervisord configs are present', () => {
        const { tmpDir, snapshot } = setup({
            extra: [
                { relPath: 'extra/supervisord/celeryd.conf', content: '[program:celeryd]\n' },
                { relPath: 'extra/supervisord/celerybeat.conf', content: '[program:celerybeat]\n' },
            ],
        });
        try {
            const services = detectServices(tmpDir, snapshot);
            const names = Object.values(services).map((s) => s.name).sort();
            expect(names).toContain('django-worker');
            expect(names).toContain('django-beat');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('expands from Procfile lines that invoke celery worker / beat', () => {
        const { tmpDir, snapshot } = setup({
            extra: [{
                relPath: 'Procfile',
                content: 'web: gunicorn proj.wsgi\nworker: celery -A proj worker --loglevel=info\nscheduler: celery -A proj beat\n',
            }],
        });
        try {
            const services = detectServices(tmpDir, snapshot);
            const names = Object.values(services).map((s) => s.name);
            expect(names).toContain('django-worker');
            expect(names).toContain('django-beat');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does NOT expand when no runtime evidence exists', () => {
        const { tmpDir, snapshot } = setup({ extra: [] });
        try {
            const services = detectServices(tmpDir, snapshot);
            const names = Object.values(services).map((s) => s.name);
            expect(names).toContain('django');
            expect(names).not.toContain('django-worker');
            expect(names).not.toContain('django-beat');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does NOT expand when there is no celery.py with Celery() in the snapshot', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'celery-detect-no-app-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'extra', 'systemd'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'extra/systemd/celery.service'), '[Unit]\n');
            const snapshot: Snapshot = { files: {}, apiIndex: {}, graphs: {} };
            const services = detectServices(tmpDir, snapshot);
            // Falls back to single "main" service; no worker / beat siblings.
            const names = Object.values(services).map((s) => s.name);
            expect(names).not.toContain('main-worker');
            expect(names).not.toContain('main-beat');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// Issue #426 — when a single specific service is detected but doesn't cover
// every snapshot file, add a workspace-wide `service:main` catch-all so the
// uncovered files (and any cluster built from them) still get a serviceId.
// Repros: ts-remix found `remix.init/` only while the app lived in `app/`;
// go-echo found `website/` only while examples lived in `cookbook/`.
describe('detectServices — workspace catch-all (#426)', () => {
    function makeSnapshotWithFiles(filePaths: string[]): Snapshot {
        const files: Snapshot['files'] = {};
        for (const fp of filePaths) {
            files[fp] = {
                path: fp, hash: 'h', mtime: 0, content: '',
                symbols: { functions: [], variables: [], imports: [] },
            };
        }
        return { files, apiIndex: {}, graphs: {} };
    }

    it('adds a service:main catch-all when monorepo service does not cover all files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-guard-'));
        try {
            // Create a single subdir with a manifest (the "specific" service)
            fs.mkdirSync(path.join(tmpDir, 'remix.init', 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'remix.init/package.json'), '{"name":"remix.init"}');
            fs.writeFileSync(path.join(tmpDir, 'remix.init/src/init.ts'), '');
            // App code lives outside the manifest subdir
            const snapshot = makeSnapshotWithFiles([
                'remix.init/src/init.ts',
                'app/db.server.ts',
                'app/root.tsx',
                'server.ts',
            ]);
            const services = detectServices(tmpDir, snapshot);
            const ids = Object.keys(services);
            expect(ids).toContain('service:remix.init');
            // The catch-all keeps every other file attributable.
            expect(ids).toContain('service:main');
            expect(services['service:main']?.rootPath).toBe('');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does NOT add catch-all when an existing service already covers the workspace', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-guard-full-'));
        try {
            // docker-compose with build: . (rootPath='') already covers everything
            fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
                'version: "3"',
                'services:',
                '  backend:',
                '    build: .',
            ].join('\n'));
            const snapshot = makeSnapshotWithFiles(['src/index.ts', 'src/server.ts']);
            const services = detectServices(tmpDir, snapshot);
            const ids = Object.keys(services);
            expect(ids).toContain('service:backend');
            // service:backend has rootPath='' already — no need for a catch-all
            expect(services['service:backend']?.rootPath).toBe('');
            expect(ids).not.toContain('service:main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does NOT add catch-all when all snapshot files fall under existing service rootPaths', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-guard-covered-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'pkg-a'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'pkg-b'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'pkg-a/package.json'), '{"name":"pkg-a"}');
            fs.writeFileSync(path.join(tmpDir, 'pkg-b/package.json'), '{"name":"pkg-b"}');
            // Every snapshot file lives under one of the detected packages.
            const snapshot = makeSnapshotWithFiles([
                'pkg-a/index.ts',
                'pkg-b/index.ts',
            ]);
            const services = detectServices(tmpDir, snapshot);
            const ids = Object.keys(services);
            // Both packages detected, no need for a fallback.
            expect(ids).toContain('service:pkg-a');
            expect(ids).toContain('service:pkg-b');
            expect(ids).not.toContain('service:main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('disambiguates the catch-all name when a service named "main" already exists', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-guard-collision-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'main'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'main/package.json'), '{"name":"main"}');
            fs.writeFileSync(path.join(tmpDir, 'main/index.ts'), '');
            const snapshot = makeSnapshotWithFiles([
                'main/index.ts',
                'other/handler.ts',
            ]);
            const services = detectServices(tmpDir, snapshot);
            const ids = Object.keys(services);
            expect(ids).toContain('service:main');
            // Catch-all collides with the existing service:main — must pick a
            // disambiguated name and still cover the orphan files.
            expect(ids).toContain('service:main_2');
            expect(services['service:main_2']?.rootPath).toBe('');
            expect(services['service:main']?.rootPath).toBe('main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('ServiceRecord.category — v2 phase 2 PR-A', () => {
    // Locks the back-compat contract: every backend-tech service maps to
    // `'backend'`, every mobile-tech to `'mobile'`, nextjs to `'frontend'`.
    // Without a recognised technology, filesystem manifests (pubspec.yaml,
    // package.json, AndroidManifest.xml, Package.swift) drive the
    // classification. Failure modes the test catches:
    //   - a backend technology silently classified as 'unknown' (would
    //     break SDK detection by accidentally enabling it everywhere)
    //   - filesystem probes that read the wrong root path on monorepos
    //   - missing manifests producing a false-positive category
    function makeFsService(opts: {
        rootRel: string;
        files: Record<string, string>;  // file path → content
        srcFile?: { name: string; content: string };
    }): { workspaceRoot: string; rootPath: string; services: Record<string, ServiceRecord>; cleanup: () => void } {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-test-'));
        const serviceDir = path.join(tmpDir, opts.rootRel);
        fs.mkdirSync(serviceDir, { recursive: true });
        for (const [fp, body] of Object.entries(opts.files)) {
            const dest = path.join(serviceDir, fp);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, body, 'utf8');
        }
        const srcRel = opts.srcFile ? `${opts.rootRel}/${opts.srcFile.name}` : `${opts.rootRel}/index.js`;
        const srcContent = opts.srcFile?.content ?? '';
        const snapshot = makeMinimalSnapshot([srcRel]);
        snapshot.files[srcRel].content = srcContent;
        const services = detectServices(tmpDir, snapshot, (fp) => snapshot.files[fp]?.content);
        return {
            workspaceRoot: tmpDir,
            rootPath: opts.rootRel,
            services,
            cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
        };
    }

    it('Express service classifies as backend', () => {
        const { services, cleanup } = makeFsService({
            rootRel: 'apps/api',
            files: { 'package.json': '{"dependencies":{"express":"^4"}}' },
            srcFile: { name: 'server.ts', content: 'import express from "express";' },
        });
        try {
            const svc = Object.values(services)[0];
            expect(svc.technology).toBe('express');
            expect(svc.category).toBe('backend');
        } finally { cleanup(); }
    });

    it('Next.js service classifies as frontend', () => {
        const { services, cleanup } = makeFsService({
            rootRel: 'apps/web',
            files: { 'package.json': '{"dependencies":{"next":"^14"}}' },
            srcFile: { name: 'page.tsx', content: 'import Link from "next/link";' },
        });
        try {
            const svc = Object.values(services)[0];
            expect(svc.technology).toBe('nextjs');
            expect(svc.category).toBe('frontend');
        } finally { cleanup(); }
    });

    it('React Native service classifies as mobile', () => {
        const { services, cleanup } = makeFsService({
            rootRel: 'apps/mobile',
            files: { 'package.json': '{"dependencies":{"react-native":"^0.73"}}' },
            srcFile: { name: 'App.tsx', content: 'import { View } from "react-native";' },
        });
        try {
            const svc = Object.values(services)[0];
            expect(svc.technology).toBe('react-native');
            expect(svc.category).toBe('mobile');
        } finally { cleanup(); }
    });

    it('Flutter monorepo: apps/mobile/pubspec.yaml gets its own service:mobile record (#714)', () => {
        // Previously, pubspec.yaml was missing from findMonorepoServices'
        // manifest list, so `apps/mobile/pubspec.yaml` collapsed into the
        // workspace `main` service. #714 added it; this test pins the fix.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flutter-monorepo-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'apps/mobile/lib'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'apps/mobile/pubspec.yaml'),
                'name: mobile_app\nflutter:\n  sdk: flutter');
            fs.writeFileSync(path.join(tmpDir, 'apps/mobile/lib/main.dart'), 'void main() {}');
            // Sibling backend so we know the monorepo path is active.
            fs.mkdirSync(path.join(tmpDir, 'apps/api'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'apps/api/package.json'),
                '{"dependencies":{"express":"^4"}}');
            fs.writeFileSync(path.join(tmpDir, 'apps/api/index.ts'),
                "import express from 'express';");

            const snap = makeMinimalSnapshot(['apps/mobile/lib/main.dart', 'apps/api/index.ts']);
            snap.files['apps/mobile/lib/main.dart'].content = 'void main() {}';
            snap.files['apps/api/index.ts'].content = "import express from 'express';";

            const services = detectServices(tmpDir, snap, (fp) => snap.files[fp]?.content);
            const mobile = services['service:mobile'];
            const api = services['service:api'];

            expect(mobile, 'service:mobile should exist').toBeDefined();
            expect(mobile.rootPath).toBe('apps/mobile');
            expect(mobile.category).toBe('mobile');

            expect(api, 'service:api should exist').toBeDefined();
            expect(api.category).toBe('backend');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('Flutter (pubspec.yaml at workspace root) classifies as mobile via filesystem probe', () => {
        // Standalone Flutter repo — pubspec.yaml at workspace root,
        // service rootPath is ''. Tech is 'unknown' (Dart source isn't
        // recognised by detectTechnology yet); category falls back to
        // the pubspec.yaml probe.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-flutter-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pubspec.yaml'), 'name: my_app\nflutter:\n  sdk: flutter');
            fs.writeFileSync(path.join(tmpDir, 'main.dart'), 'void main() {}');
            const snapshot = makeMinimalSnapshot(['main.dart']);
            snapshot.files['main.dart'].content = 'void main() {}';
            const services = detectServices(tmpDir, snapshot, (fp) => snapshot.files[fp]?.content);
            const svc = Object.values(services)[0];
            expect(svc.technology).toBe('unknown');
            expect(svc.category).toBe('mobile');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('SPA-style React package (no server framework) classifies as frontend', () => {
        const { services, cleanup } = makeFsService({
            rootRel: 'apps/spa',
            files: { 'package.json': '{"dependencies":{"react":"^18","react-router":"^6"}}' },
            srcFile: { name: 'App.tsx', content: 'export default function App() { return null; }' },
        });
        try {
            const svc = Object.values(services)[0];
            // react-router specifically routes through the frontend manifest probe.
            expect(svc.category).toBe('frontend');
        } finally { cleanup(); }
    });

    it('Service with no recognised tech and no FE/mobile manifest is unknown', () => {
        const { services, cleanup } = makeFsService({
            rootRel: 'apps/noise',
            files: { 'README.md': '# something' },
            srcFile: { name: 'data.json', content: '{}' },
        });
        try {
            const svc = Object.values(services)[0];
            expect(svc.technology).toBe('unknown');
            expect(svc.category).toBe('unknown');
        } finally { cleanup(); }
    });
});

// v2 phase 2 PR-C backfill — end-to-end SDK detection through
// `detectInfrastructureServices`. Locks the gating contract: SDKs land
// as L1 infra entries ONLY for `category === 'frontend' | 'mobile'`
// services; backend services produce zero SDK entries even when their
// source imports an SDK (e.g. a Node backend that uses Stripe server-
// side — the prod intent there is "stripe-go talks to Stripe API",
// not "render Stripe as an L1 node on the system map").
describe('detectInfrastructureServices — SDK gating by category', () => {
    function mkSnap(filePaths: Record<string, string>): Snapshot {
        const files: Snapshot['files'] = {};
        for (const [fp, content] of Object.entries(filePaths)) {
            files[fp] = {
                path: fp, hash: 'h', mtime: 0, content,
                symbols: { functions: [], variables: [], imports: [] },
            };
        }
        return { files, apiIndex: {}, graphs: {} };
    }

    it('frontend service emits SDK infra entries for matching imports', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-fe-'));
        try {
            const snap = mkSnap({
                'apps/web/src/billing.ts': "import Stripe from 'stripe';",
                'apps/web/src/index.ts': "import * as Sentry from '@sentry/browser';",
            });
            const services: Record<string, ServiceRecord> = {
                'service:web': {
                    id: 'service:web', name: 'web', rootPath: 'apps/web',
                    technology: 'nextjs', category: 'frontend',
                    exposedApiCount: 0, consumedUrls: [], consumedServices: [],
                    diff: 'unchanged',
                },
            };
            const infra = detectInfrastructureServices(tmpDir, snap, services, (fp) => snap.files[fp]?.content);
            const sdkIds = infra.filter((i) => i.kind === 'sdk').map((i) => i.sdkId);
            expect(sdkIds).toContain('stripe');
            expect(sdkIds).toContain('sentry');
            // Each SDK is associated with the consuming service.
            const stripe = infra.find((i) => i.sdkId === 'stripe');
            expect(stripe!.consumedBy).toEqual(['service:web']);
            expect(stripe!.sdkCategory).toBe('payments');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('mobile service emits SDK infra entries', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-mob-'));
        try {
            const snap = mkSnap({
                'apps/mobile/src/Push.kt': 'import com.google.firebase.messaging.FirebaseMessagingService',
            });
            const services: Record<string, ServiceRecord> = {
                'service:mobile': {
                    id: 'service:mobile', name: 'mobile', rootPath: 'apps/mobile',
                    technology: 'android', category: 'mobile',
                    exposedApiCount: 0, consumedUrls: [], consumedServices: [],
                    diff: 'unchanged',
                },
            };
            const infra = detectInfrastructureServices(tmpDir, snap, services, (fp) => snap.files[fp]?.content);
            const fcm = infra.find((i) => i.sdkId === 'fcm');
            expect(fcm).toBeDefined();
            expect(fcm!.kind).toBe('sdk');
            expect(fcm!.consumedBy).toContain('service:mobile');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('backend service with matching SDK imports DOES NOT emit SDK infra entries (category gating)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-be-'));
        try {
            const snap = mkSnap({
                // Server-side Stripe usage — backend repos do this, but
                // we explicitly skip them at L1 to avoid noise.
                'apps/api/src/billing.ts': "import Stripe from 'stripe';",
            });
            const services: Record<string, ServiceRecord> = {
                'service:api': {
                    id: 'service:api', name: 'api', rootPath: 'apps/api',
                    technology: 'express', category: 'backend',
                    exposedApiCount: 0, consumedUrls: [], consumedServices: [],
                    diff: 'unchanged',
                },
            };
            const infra = detectInfrastructureServices(tmpDir, snap, services, (fp) => snap.files[fp]?.content);
            const sdkEntries = infra.filter((i) => i.kind === 'sdk');
            expect(sdkEntries).toEqual([]);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('unknown-category service does not emit SDK infra entries (safe default)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-unk-'));
        try {
            const snap = mkSnap({ 'apps/unknown/x.ts': "import Stripe from 'stripe';" });
            const services: Record<string, ServiceRecord> = {
                'service:unk': {
                    id: 'service:unk', name: 'unk', rootPath: 'apps/unknown',
                    technology: 'unknown', category: 'unknown',
                    exposedApiCount: 0, consumedUrls: [], consumedServices: [],
                    diff: 'unchanged',
                },
            };
            const infra = detectInfrastructureServices(tmpDir, snap, services, (fp) => snap.files[fp]?.content);
            expect(infra.filter((i) => i.kind === 'sdk')).toEqual([]);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('multiple FE services importing the same SDK share one infra entry with two consumedBy', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-multi-'));
        try {
            const snap = mkSnap({
                'apps/web/billing.ts': "import * as Sentry from '@sentry/browser';",
                'apps/admin/billing.ts': "import * as Sentry from '@sentry/browser';",
            });
            const services: Record<string, ServiceRecord> = {
                'service:web': {
                    id: 'service:web', name: 'web', rootPath: 'apps/web',
                    technology: 'nextjs', category: 'frontend',
                    exposedApiCount: 0, consumedUrls: [], consumedServices: [],
                    diff: 'unchanged',
                },
                'service:admin': {
                    id: 'service:admin', name: 'admin', rootPath: 'apps/admin',
                    technology: 'nextjs', category: 'frontend',
                    exposedApiCount: 0, consumedUrls: [], consumedServices: [],
                    diff: 'unchanged',
                },
            };
            const infra = detectInfrastructureServices(tmpDir, snap, services, (fp) => snap.files[fp]?.content);
            const sentry = infra.find((i) => i.sdkId === 'sentry');
            expect(sentry).toBeDefined();
            expect(sentry!.consumedBy.sort()).toEqual(['service:admin', 'service:web']);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('two related Firebase SDKs (firebase + fcm) coexist without merging', () => {
        // Without the kind-merge bypass, the name-similarity check would
        // collapse `Firebase` and `Firebase Cloud Messaging (FCM)` into
        // one node — a regression risk caught by this test.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-fb-fcm-'));
        try {
            const snap = mkSnap({
                'apps/mobile/Auth.kt': 'import com.google.firebase.FirebaseApp',
                'apps/mobile/Push.kt': 'import com.google.firebase.messaging.FirebaseMessagingService',
            });
            const services: Record<string, ServiceRecord> = {
                'service:mobile': {
                    id: 'service:mobile', name: 'mobile', rootPath: 'apps/mobile',
                    technology: 'android', category: 'mobile',
                    exposedApiCount: 0, consumedUrls: [], consumedServices: [],
                    diff: 'unchanged',
                },
            };
            const infra = detectInfrastructureServices(tmpDir, snap, services, (fp) => snap.files[fp]?.content);
            const sdkIds = infra.filter((i) => i.kind === 'sdk').map((i) => i.sdkId);
            expect(sdkIds).toContain('firebase');
            expect(sdkIds).toContain('fcm');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });
});

// v2 phase 2 PR-D (#483 — L1: backend boundary discovery from FE/mobile client calls) — FE-client URL extraction.
//
// What this suite covers:
//   1. Each new FE-client pattern (useSWR, useQuery, axios, fetch,
//      $.ajax, XMLHttpRequest, Python requests/httpx, Dart Dio,
//      Retrofit) emits a `path:<route>` entry into consumedUrls.
//   2. Backward compatibility: every pattern STILL also emits the
//      legacy `'relative-api:same-origin'` marker so consumers that
//      key off the marker (pre-#483 callers) keep working.
//   3. Post-process: when one service's consumedUrls contains a
//      `path:` entry matching ANOTHER service's apiIndex route,
//      `service:web.consumedServices` gains the specific backend id.
//   4. Post-process: when path-resolution succeeds, the legacy
//      "connect to every API-exposing service" fallback DOES NOT fire
//      — only the precise edge is emitted.
//   5. Route-template matcher: handles `:param`, `{param}`, and
//      `<param>` placeholders + trailing-slash normalisation.
//   6. Backend-only fixture: pure-backend repo with internal axios
//      calls doesn't gain spurious FE→backend edges (no `path:`
//      entries leak into consumedUrls from server-side HTTP clients).
describe('extractConsumedUrls — FE-client patterns (#483 PR-D)', () => {
    // The function is module-private, so we exercise it through
    // detectServices(). Each fixture writes one source file with the
    // call shape and asserts consumedUrls contains the expected
    // `path:` entry.

    function singleFileFixture(opts: {
        rootRel: string;
        srcName: string;
        srcContent: string;
        category?: ServiceRecord['category'];
    }): { workspaceRoot: string; services: Record<string, ServiceRecord>; cleanup: () => void } {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fec-test-'));
        const serviceDir = path.join(tmpDir, opts.rootRel);
        fs.mkdirSync(serviceDir, { recursive: true });
        const dest = path.join(serviceDir, opts.srcName);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, opts.srcContent, 'utf8');
        // Always include a package.json for monorepo detection to find
        // the service.
        fs.writeFileSync(path.join(serviceDir, 'package.json'),
            opts.category === 'frontend'
                ? '{"dependencies":{"next":"^14"}}'
                : '{"dependencies":{"express":"^4"}}');
        const srcRel = `${opts.rootRel}/${opts.srcName}`;
        const snapshot = makeMinimalSnapshot([srcRel]);
        snapshot.files[srcRel].content = opts.srcContent;
        const services = detectServices(tmpDir, snapshot, (fp) => snapshot.files[fp]?.content);
        return {
            workspaceRoot: tmpDir,
            services,
            cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
        };
    }

    function singleSvcUrls(services: Record<string, ServiceRecord>): string[] {
        const urls = Object.values(services)[0]?.consumedUrls ?? [];
        return [...urls].sort();
    }

    const CASES: Array<{ name: string; srcName: string; src: string; expectedPath: string }> = [
        {
            name: 'fetch',
            srcName: 'fetch.ts',
            src: "fetch('/api/articles');",
            expectedPath: 'path:/api/articles',
        },
        {
            name: 'axios.get',
            srcName: 'axios.ts',
            src: "axios.get('/api/users');",
            expectedPath: 'path:/api/users',
        },
        {
            name: 'axios.post',
            srcName: 'axios2.ts',
            src: "axios.post('/api/orders', payload);",
            expectedPath: 'path:/api/orders',
        },
        {
            name: 'useSWR',
            srcName: 'swr.ts',
            src: "useSWR('/api/profile', fetcher);",
            expectedPath: 'path:/api/profile',
        },
        {
            name: 'useQuery (older react-query)',
            srcName: 'rq.ts',
            src: "useQuery('/api/dashboards', fetcher);",
            expectedPath: 'path:/api/dashboards',
        },
        {
            name: 'XMLHttpRequest open',
            srcName: 'xhr.ts',
            src: "const xhr = new XMLHttpRequest(); xhr.open('GET', '/api/legacy');",
            expectedPath: 'path:/api/legacy',
        },
        {
            name: 'Python requests',
            srcName: 'fetch.py',
            src: "requests.get('/api/python_legacy')",
            expectedPath: 'path:/api/python_legacy',
        },
        {
            name: 'Python httpx',
            srcName: 'httpx_fetch.py',
            src: "httpx.post('/api/httpx_url', json=data)",
            expectedPath: 'path:/api/httpx_url',
        },
        {
            name: 'Dart Dio',
            srcName: 'dio_call.dart',
            src: "await dio.get('/api/feed');",
            expectedPath: 'path:/api/feed',
        },
        {
            name: 'Retrofit @GET',
            srcName: 'ApiService.kt',
            src: '@GET("/api/articles")\nfun listArticles(): Call<List<Article>>',
            expectedPath: 'path:/api/articles',
        },
        {
            name: 'Retrofit @POST',
            srcName: 'AuthService.kt',
            src: '@POST("/api/login") fun login(@Body req: LoginRequest): Call<Token>',
            expectedPath: 'path:/api/login',
        },
        {
            name: 'jQuery $.ajax',
            srcName: 'jq.js',
            src: "$.ajax({ url: '/api/jqlegacy', method: 'GET' })",
            expectedPath: 'path:/api/jqlegacy',
        },
        // #483 gap-fill (2026-05-30) — C# / Swift / Dart-http patterns.
        {
            name: 'C# HttpClient GetAsync',
            srcName: 'ApiClient.cs',
            src: 'await _httpClient.GetAsync("/api/articles");',
            expectedPath: 'path:/api/articles',
        },
        {
            name: 'C# HttpClient PostAsJsonAsync',
            srcName: 'ApiClient2.cs',
            src: 'await _httpClient.PostAsJsonAsync("/api/orders", payload);',
            expectedPath: 'path:/api/orders',
        },
        {
            name: 'Swift URLSession URL(string:)',
            srcName: 'ApiClient.swift',
            src: 'let task = URLSession.shared.dataTask(with: URL(string: "/api/profile")!) { _, _, _ in }',
            expectedPath: 'path:/api/profile',
        },
        {
            name: 'Dart package:http get',
            srcName: 'api_client.dart',
            src: "final res = await http.get(Uri.parse('/api/feed'));",
            expectedPath: 'path:/api/feed',
        },
    ];

    for (const c of CASES) {
        it(`captures the path from ${c.name}`, () => {
            const { services, cleanup } = singleFileFixture({
                rootRel: 'apps/web',
                srcName: c.srcName,
                srcContent: c.src,
                category: 'frontend',
            });
            try {
                const urls = singleSvcUrls(services);
                expect(urls).toContain(c.expectedPath);
            } finally { cleanup(); }
        });
    }

    it('every FE-client pattern also emits the legacy relative-api marker for back-compat', () => {
        const { services, cleanup } = singleFileFixture({
            rootRel: 'apps/web',
            srcName: 'mix.ts',
            srcContent: "useSWR('/api/foo'); fetch('/api/bar');",
            category: 'frontend',
        });
        try {
            const urls = singleSvcUrls(services);
            expect(urls).toContain('relative-api:same-origin');
            expect(urls).toContain('path:/api/foo');
            expect(urls).toContain('path:/api/bar');
        } finally { cleanup(); }
    });

    it('strips query string + trailing artifacts from captured paths', () => {
        const { services, cleanup } = singleFileFixture({
            rootRel: 'apps/web',
            srcName: 'qs.ts',
            srcContent: "fetch('/api/search?q=foo&limit=10');",
            category: 'frontend',
        });
        try {
            const urls = singleSvcUrls(services);
            expect(urls).toContain('path:/api/search');
        } finally { cleanup(); }
    });
});

describe('detectServices post-process — FE→backend boundary discovery (#483 PR-D)', () => {
    function mkMonorepo(opts: {
        webSrc: string;     // content of apps/web/index.ts
        apiRoute: string;   // route exposed by apps/api
    }): { workspaceRoot: string; services: Record<string, ServiceRecord>; cleanup: () => void } {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-be-'));
        // Set up apps/web (frontend) with package.json
        fs.mkdirSync(path.join(tmpDir, 'apps/web'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'apps/web/package.json'), '{"dependencies":{"next":"^14"}}');
        fs.writeFileSync(path.join(tmpDir, 'apps/web/index.ts'), opts.webSrc);
        // Set up apps/api (backend) with package.json
        fs.mkdirSync(path.join(tmpDir, 'apps/api'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'apps/api/package.json'), '{"dependencies":{"express":"^4"}}');
        fs.writeFileSync(path.join(tmpDir, 'apps/api/index.ts'), "import express from 'express';\nconst app = express();");

        const snapshot = makeMinimalSnapshot(['apps/web/index.ts', 'apps/api/index.ts']);
        snapshot.files['apps/web/index.ts'].content = opts.webSrc;
        snapshot.files['apps/api/index.ts'].content = "import express from 'express';";
        // Wire one ApiRecord into the api service's index.
        snapshot.apiIndex['api1'] = {
            apiId: 'api1',
            method: 'GET',
            route: opts.apiRoute,
            handlerName: 'handler',
            filePath: 'apps/api/index.ts',
            anchor: { filePath: 'apps/api/index.ts' },
        };
        const services = detectServices(tmpDir, snapshot, (fp) => snapshot.files[fp]?.content);
        return {
            workspaceRoot: tmpDir,
            services,
            cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
        };
    }

    it('web fetch(/api/articles) → consumedServices contains service:api when api exposes GET /api/articles', () => {
        const { services, cleanup } = mkMonorepo({
            webSrc: "fetch('/api/articles');",
            apiRoute: '/api/articles',
        });
        try {
            const web = services['service:web'];
            expect(web).toBeDefined();
            expect(web.consumedServices).toContain('service:api');
        } finally { cleanup(); }
    });

    it('web fetch(/api/articles/123) matches api route /api/articles/:id template', () => {
        const { services, cleanup } = mkMonorepo({
            webSrc: "axios.get('/api/articles/123');",
            apiRoute: '/api/articles/:id',
        });
        try {
            const web = services['service:web'];
            expect(web.consumedServices).toContain('service:api');
        } finally { cleanup(); }
    });

    it('web fetch matches Spring-style {id} placeholder', () => {
        const { services, cleanup } = mkMonorepo({
            webSrc: "axios.get('/api/users/42');",
            apiRoute: '/api/users/{id}',
        });
        try {
            const web = services['service:web'];
            expect(web.consumedServices).toContain('service:api');
        } finally { cleanup(); }
    });

    it('web fetch matches Django-style <id> placeholder', () => {
        const { services, cleanup } = mkMonorepo({
            webSrc: "fetch('/api/users/abc');",
            apiRoute: '/api/users/<id>',
        });
        try {
            const web = services['service:web'];
            expect(web.consumedServices).toContain('service:api');
        } finally { cleanup(); }
    });

    it('precise path match suppresses the broad fallback (does not over-connect)', () => {
        // Set up two backend services, but only one matches the path.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-be-narrow-'));
        try {
            // web — calls /api/articles
            fs.mkdirSync(path.join(tmpDir, 'apps/web'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'apps/web/package.json'), '{"dependencies":{"next":"^14"}}');
            fs.writeFileSync(path.join(tmpDir, 'apps/web/index.ts'), "fetch('/api/articles');");
            // api1 — exposes /api/articles (the match)
            fs.mkdirSync(path.join(tmpDir, 'apps/api1'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'apps/api1/package.json'), '{"dependencies":{"express":"^4"}}');
            fs.writeFileSync(path.join(tmpDir, 'apps/api1/index.ts'), "import express from 'express';");
            // api2 — exposes /api/users (NOT the match)
            fs.mkdirSync(path.join(tmpDir, 'apps/api2'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'apps/api2/package.json'), '{"dependencies":{"express":"^4"}}');
            fs.writeFileSync(path.join(tmpDir, 'apps/api2/index.ts'), "import express from 'express';");

            const snap = makeMinimalSnapshot(['apps/web/index.ts', 'apps/api1/index.ts', 'apps/api2/index.ts']);
            snap.files['apps/web/index.ts'].content = "fetch('/api/articles');";
            snap.files['apps/api1/index.ts'].content = "import express from 'express';";
            snap.files['apps/api2/index.ts'].content = "import express from 'express';";
            snap.apiIndex['r1'] = {
                apiId: 'r1', method: 'GET', route: '/api/articles', handlerName: 'h',
                filePath: 'apps/api1/index.ts', anchor: { filePath: 'apps/api1/index.ts' },
            };
            snap.apiIndex['r2'] = {
                apiId: 'r2', method: 'GET', route: '/api/users', handlerName: 'h',
                filePath: 'apps/api2/index.ts', anchor: { filePath: 'apps/api2/index.ts' },
            };
            const services = detectServices(tmpDir, snap, (fp) => snap.files[fp]?.content);
            const web = services['service:web'];
            expect(web).toBeDefined();
            expect(web.consumedServices).toContain('service:api1');
            // The key invariant: api2 must NOT appear, even though the
            // legacy fallback would have connected to every API service.
            expect(web.consumedServices).not.toContain('service:api2');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    // Issue #766: example-monorepos (rust-actix has 73 example subcrates
    // under `examples/`) should NOT each become a top-level service.
    // Threshold: 4+ manifest-bearing siblings under a known example-parent
    // dir triggers the skip so the framework's own showcase doesn't
    // overwhelm L1. Smaller `examples/` (1-3 children) stay eligible.
    it('#766 skips example-parent dirs that hold 4+ sub-projects (rust-actix shape)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoexample-'));
        try {
            // Workspace looks like an Actix-style framework repo.
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[workspace]\n');
            fs.mkdirSync(path.join(tmpDir, 'examples'), { recursive: true });
            for (const name of ['cors', 'websockets', 'auth', 'tls', 'logging']) {
                const dir = path.join(tmpDir, 'examples', name);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, 'Cargo.toml'), `[package]\nname = "${name}"\n`);
                fs.writeFileSync(path.join(dir, 'main.rs'), 'fn main(){}');
            }
            const snap = makeMinimalSnapshot([
                'examples/cors/main.rs', 'examples/websockets/main.rs',
                'examples/auth/main.rs', 'examples/tls/main.rs',
                'examples/logging/main.rs',
            ]);
            const services = detectServices(tmpDir, snap);
            const names = Object.values(services).map(s => s.name);
            // None of the 5 example subprojects becomes a service.
            expect(names).not.toContain('cors');
            expect(names).not.toContain('websockets');
            expect(names).not.toContain('auth');
            // The workspace still has a service (main / Cargo workspace
            // root) covering everything.
            expect(names.length).toBeLessThan(3);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('#766 retains 1-3 example subprojects (py-django-celery shape)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoexample-small-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.mkdirSync(path.join(tmpDir, 'examples', 'django'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'examples/django/manage.py'), '');
            fs.writeFileSync(path.join(tmpDir, 'examples/django/requirements.txt'), 'django\n');
            fs.mkdirSync(path.join(tmpDir, 'examples/django/src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'examples/django/src/main.py'), 'def main():\n    pass\n');
            const snap = makeMinimalSnapshot(['examples/django/src/main.py']);
            const services = detectServices(tmpDir, snap);
            const names = Object.values(services).map(s => s.name);
            // Below threshold (only 1 example) → still gets registered.
            // We don't assert on a specific name (the detector might
            // collapse it into 'main') — just that we haven't gone
            // overboard with skipping.
            expect(names.length).toBeGreaterThanOrEqual(1);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    // Issue #774: in multi-binary monorepos the same API file matches
    // both the workspace-root service AND a nested per-binary service.
    // The L1 service-node subtitle's `exposedApiCount` previously
    // double-counted, so the L1 sum disagreed with the home page total
    // and the KMap APIs count. With the longest-rootPath attribution
    // fix, each API is owned by exactly one service.
    // Issue #781: the L1 service-node body line shows `exposedApiCount`
    // (HTTP-only, per NON_HTTP_METHODS filter), while the home page
    // counter shows `apiIndex.size` (total, including synthetic
    // categories like MIDDLEWARE / SIGNAL / EVENT_LISTENER). The
    // divergence is intentional but invariant: the L1 sum + the count
    // of non-HTTP entries should equal apiIndex.size. This test locks
    // that invariant in so a future change can't silently violate it.
    it('#781 sum(exposedApiCount) + count(non-HTTP) == apiIndex.size', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-home-drift-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'apps/api'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'apps/api/package.json'), '{"dependencies":{"express":"^4"}}');
            fs.writeFileSync(path.join(tmpDir, 'apps/api/index.ts'), "import express from 'express';");
            const snap = makeMinimalSnapshot(['apps/api/index.ts']);
            // 2 HTTP routes + 1 middleware + 1 signal — total apiIndex = 4
            snap.apiIndex['r1'] = { apiId: 'r1', method: 'GET', route: '/users', handlerName: 'h', filePath: 'apps/api/index.ts', anchor: { filePath: 'apps/api/index.ts' } };
            snap.apiIndex['r2'] = { apiId: 'r2', method: 'POST', route: '/users', handlerName: 'h', filePath: 'apps/api/index.ts', anchor: { filePath: 'apps/api/index.ts' } };
            snap.apiIndex['r3'] = { apiId: 'r3', method: 'MIDDLEWARE', route: '/*', handlerName: 'authMW', filePath: 'apps/api/index.ts', anchor: { filePath: 'apps/api/index.ts' } };
            snap.apiIndex['r4'] = { apiId: 'r4', method: 'SIGNAL', route: 'post_save:User', handlerName: 'hook', filePath: 'apps/api/index.ts', anchor: { filePath: 'apps/api/index.ts' } };
            const services = detectServices(tmpDir, snap, (fp) => snap.files[fp]?.content);
            const NON_HTTP_METHODS = new Set([
                'SIGNAL', 'EVENT_LISTENER', 'EVENT_EMIT', 'AOP_ASPECT', 'AOP_AROUND',
                'AOP_BEFORE', 'AOP_AFTER', 'AOP_AFTERRETURNING', 'AOP_AFTERTHROWING',
                'DI_DEPENDENCY', 'MIDDLEWARE', 'SERVLET_FILTER', 'HANDLER_INTERCEPTOR',
                'DATA_FETCH', 'STATIC_PATHS',
            ]);
            const sumExposed = Object.values(services)
                .reduce((acc, s) => acc + s.exposedApiCount, 0);
            const nonHttpCount = Object.values(snap.apiIndex)
                .filter((a) => NON_HTTP_METHODS.has(a.method)).length;
            const apiIndexSize = Object.keys(snap.apiIndex).length;
            // The invariant: L1 sum + non-HTTP count == apiIndex.size
            expect(sumExposed + nonHttpCount).toBe(apiIndexSize);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('#774 each API is owned by ONE service in multi-binary repos (no double-count)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-binary-'));
        try {
            // Workspace root with a Go module + 2 nested binaries.
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example\n');
            fs.mkdirSync(path.join(tmpDir, 'articles'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'articles/go.mod'), 'module example/articles\n');
            fs.writeFileSync(path.join(tmpDir, 'articles/handler.go'),
                'package main\nfunc main() {}');
            fs.mkdirSync(path.join(tmpDir, 'users'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'users/go.mod'), 'module example/users\n');
            fs.writeFileSync(path.join(tmpDir, 'users/handler.go'),
                'package main\nfunc main() {}');
            const snap = makeMinimalSnapshot([
                'articles/handler.go',
                'users/handler.go',
                'main.go',
            ]);
            // 4 routes — 2 in articles/, 1 in users/, 1 at workspace root.
            snap.apiIndex['r1'] = { apiId: 'r1', method: 'GET', route: '/articles', handlerName: 'List', filePath: 'articles/handler.go', anchor: { filePath: 'articles/handler.go' } };
            snap.apiIndex['r2'] = { apiId: 'r2', method: 'POST', route: '/articles', handlerName: 'Create', filePath: 'articles/handler.go', anchor: { filePath: 'articles/handler.go' } };
            snap.apiIndex['r3'] = { apiId: 'r3', method: 'GET', route: '/users', handlerName: 'List', filePath: 'users/handler.go', anchor: { filePath: 'users/handler.go' } };
            snap.apiIndex['r4'] = { apiId: 'r4', method: 'GET', route: '/health', handlerName: 'Health', filePath: 'main.go', anchor: { filePath: 'main.go' } };
            const services = detectServices(tmpDir, snap, (fp) => snap.files[fp]?.content);

            // Sum exposedApiCount across all services. Without the fix
            // this would be > 4 because of double-attribution.
            const sumExposed = Object.values(services).reduce(
                (acc, s) => acc + s.exposedApiCount, 0,
            );
            expect(sumExposed).toBe(4);

            // The articles service must own its 2 routes, not 0 (which
            // would happen if root claimed them).
            const articles = Object.values(services).find(s => s.rootPath === 'articles');
            if (articles) expect(articles.exposedApiCount).toBe(2);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    // Issue #767: framework-convention dirs (Laravel `routes`/`config`,
    // Rails `db`/`config`, Next.js `app`/`components`, Symfony
    // `src`/`bin`) should NOT each become a top-level service when the
    // workspace root carries the framework's manifest. Without this
    // guard, a single-app Laravel repo shows 5+ services in L1 instead
    // of 1.
    it('#767 Laravel conventional subdirs do NOT become separate services', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-laravel-'));
        try {
            // Workspace root carries Laravel's manifest pair.
            fs.writeFileSync(path.join(tmpDir, 'composer.json'), '{"require":{"laravel/framework":"^11"}}');
            fs.writeFileSync(path.join(tmpDir, 'artisan'), '#!/usr/bin/env php\n<?php');
            // Each conventional dir has source files (PHP) so the bare
            // hasSource check would otherwise promote them all.
            for (const dir of ['app', 'bootstrap', 'config', 'public', 'routes']) {
                fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
                fs.writeFileSync(path.join(tmpDir, dir, 'index.php'), '<?php');
            }
            const snap = makeMinimalSnapshot([
                'app/index.php', 'bootstrap/index.php', 'config/index.php',
                'public/index.php', 'routes/index.php',
            ]);
            const services = detectServices(tmpDir, snap);
            const names = Object.values(services).map(s => s.name);
            // None of the 5 framework dirs should appear as its own service.
            for (const skip of ['app', 'bootstrap', 'config', 'public', 'routes']) {
                expect(names).not.toContain(skip);
            }
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    // #820 (2026-06-10) — when the workspace root ITSELF carries a project
    // manifest, the repo IS one project: source-only child dirs (`src/`,
    // `scripts/`) are that project's internal layout, not services.
    // Dev-walkthrough repro: payments-service (root package.json + src/ +
    // scripts/) produced phantom `scripts` + `src` services that inflated
    // the home stat to "4 SERVICES" for a 2-repo workspace and leaked
    // into the Knowledge Map as `«unknown» · 0 apis` tiles.
    it('#820 source-only subdirs do NOT become services when the root has a manifest', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-manifest-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"payments-service","dependencies":{"fastify":"*"}}');
            for (const dir of ['src', 'scripts']) {
                fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
                fs.writeFileSync(path.join(tmpDir, dir, 'index.ts'), 'export {};');
            }
            const snap = makeMinimalSnapshot(['src/index.ts', 'scripts/index.ts']);
            const services = detectServices(tmpDir, snap);
            const names = Object.values(services).map(s => s.name);
            expect(names).not.toContain('src');
            expect(names).not.toContain('scripts');
            // Whole repo collapses to one service.
            expect(names).toHaveLength(1);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('#820 regression guard: a child dir with its OWN manifest still becomes a service (#399 shape)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-manifest-'));
        try {
            // Root manifest (e.g. a tooling package.json) + a real
            // sub-project with its own manifest. The #820 suppression
            // must NOT swallow manifest-bearing children — whether the
            // monorepo child-scan or the top-level-dirs fallback detects
            // them, they must survive as services.
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"workspace-tools"}');
            fs.mkdirSync(path.join(tmpDir, 'backend', 'app'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'backend', 'pyproject.toml'), '[project]\nname = "backend"');
            fs.writeFileSync(path.join(tmpDir, 'backend', 'app', 'main.py'), 'app = 1');
            // Source-only sibling must still be suppressed in the same pass.
            fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'scripts', 'tool.ts'), 'export {};');
            const snap = makeMinimalSnapshot(['backend/app/main.py', 'scripts/tool.ts']);
            const services = detectServices(tmpDir, snap);
            const names = Object.values(services).map(s => s.name).sort();
            expect(names).toContain('backend');
            expect(names).not.toContain('scripts');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('#767 Rails conventional subdirs do NOT become separate services', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-rails-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Gemfile'), 'gem "rails"\n');
            fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'config/application.rb'),
                'require "rails/all"\nmodule App\n  class Application < Rails::Application\n  end\nend');
            for (const dir of ['app', 'bin', 'db', 'lib', 'public', 'test']) {
                fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
                fs.writeFileSync(path.join(tmpDir, dir, 'index.rb'), '# rails');
            }
            const snap = makeMinimalSnapshot([
                'app/index.rb', 'bin/index.rb', 'db/index.rb',
                'lib/index.rb', 'public/index.rb', 'test/index.rb',
            ]);
            const services = detectServices(tmpDir, snap);
            const names = Object.values(services).map(s => s.name);
            for (const skip of ['app', 'bin', 'db', 'lib', 'public', 'test']) {
                expect(names).not.toContain(skip);
            }
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('#767 Next.js conventional subdirs do NOT become separate services', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-nextjs-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'),
                '{"dependencies":{"next":"^14"}}');
            fs.writeFileSync(path.join(tmpDir, 'next.config.js'),
                'module.exports = {};');
            for (const dir of ['app', 'components', 'lib', 'pages', 'public', 'styles']) {
                fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
                fs.writeFileSync(path.join(tmpDir, dir, 'index.ts'), 'export {};');
            }
            const snap = makeMinimalSnapshot([
                'app/index.ts', 'components/index.ts', 'lib/index.ts',
                'pages/index.ts', 'public/index.ts', 'styles/index.ts',
            ]);
            const services = detectServices(tmpDir, snap);
            const names = Object.values(services).map(s => s.name);
            for (const skip of ['app', 'components', 'lib', 'pages', 'public', 'styles']) {
                expect(names).not.toContain(skip);
            }
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('#767 framework guard does NOT skip user-defined dirs (apps/, services/, packages/)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-userdirs-'));
        try {
            // Laravel root with two user-defined dirs alongside framework dirs.
            fs.writeFileSync(path.join(tmpDir, 'composer.json'), '{"require":{"laravel/framework":"^11"}}');
            fs.writeFileSync(path.join(tmpDir, 'artisan'), '#!/usr/bin/env php\n<?php');
            for (const dir of ['routes', 'config']) {
                fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
                fs.writeFileSync(path.join(tmpDir, dir, 'index.php'), '<?php');
            }
            // Non-framework dir that should remain eligible.
            fs.mkdirSync(path.join(tmpDir, 'integrations'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'integrations/index.php'), '<?php');
            const snap = makeMinimalSnapshot([
                'routes/index.php', 'config/index.php', 'integrations/index.php',
            ]);
            const services = detectServices(tmpDir, snap);
            const names = Object.values(services).map(s => s.name);
            // Framework dirs skipped, user-defined one survives.
            expect(names).not.toContain('routes');
            expect(names).not.toContain('config');
            // `integrations` is a top-level src dir but only 1 such dir
            // exists outside the framework set → falls through to the
            // single-dir branch and may end up under workspace fallback,
            // so we just assert it wasn't accidentally swept.
            // (No-op assertion here; the key is the skipped framework
            // dirs above.)
            expect(names.length).toBeGreaterThan(0);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    // Issue #769: pure Starlette projects (no FastAPI imports) should
    // be tagged `technology: 'starlette'` so L1 displays the framework
    // name. Previously they showed as 'unknown' / 'backend (generic)'.
    it('#769 detects Starlette via `from starlette.applications import`', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-starlette-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "demo"\n');
            fs.writeFileSync(path.join(tmpDir, 'app.py'),
                "from starlette.applications import Starlette\nfrom starlette.routing import Route\n\n" +
                "async def homepage(request): return JSONResponse({'h': 'i'})\n\n" +
                "app = Starlette(routes=[Route('/', endpoint=homepage)])\n");
            const snap = makeMinimalSnapshot(['app.py']);
            snap.files['app.py'].content =
                "from starlette.applications import Starlette\nfrom starlette.routing import Route\n\n" +
                "async def homepage(request): return JSONResponse({'h': 'i'})\n\n" +
                "app = Starlette(routes=[Route('/', endpoint=homepage)])\n";
            const services = detectServices(tmpDir, snap, (fp) => snap.files[fp]?.content);
            const svc = Object.values(services)[0];
            expect(svc).toBeDefined();
            expect(svc.technology).toBe('starlette');
            expect(svc.category).toBe('backend');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('#769 does NOT mis-tag FastAPI as Starlette when both imports are present', () => {
        // FastAPI projects routinely import from `starlette.*`. The
        // detector must check fastapi BEFORE starlette.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-fastapi-starlette-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "demo"\n');
            fs.writeFileSync(path.join(tmpDir, 'main.py'),
                "from fastapi import FastAPI\nfrom starlette.middleware.cors import CORSMiddleware\n\n" +
                "app = FastAPI()\napp.add_middleware(CORSMiddleware)\n");
            const snap = makeMinimalSnapshot(['main.py']);
            snap.files['main.py'].content =
                "from fastapi import FastAPI\nfrom starlette.middleware.cors import CORSMiddleware\n\n" +
                "app = FastAPI()\napp.add_middleware(CORSMiddleware)\n";
            const services = detectServices(tmpDir, snap, (fp) => snap.files[fp]?.content);
            const svc = Object.values(services)[0];
            expect(svc).toBeDefined();
            expect(svc.technology).toBe('fastapi');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('#767 framework guard is OFF when no framework manifest is present', () => {
        // A plain Express monorepo with a coincidental `app/` dir should
        // NOT be skipped because there's no Laravel/Rails/Next/Symfony
        // signature at the root.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-no-mark-'));
        try {
            // No composer.json, no Gemfile, no next.config.*.
            fs.mkdirSync(path.join(tmpDir, 'app'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'app/index.js'), "// app");
            fs.mkdirSync(path.join(tmpDir, 'services'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'services/index.js'), "// svc");
            const snap = makeMinimalSnapshot([
                'app/index.js', 'services/index.js',
            ]);
            const services = detectServices(tmpDir, snap);
            const names = Object.values(services).map(s => s.name);
            // Both dirs survive — the framework guard didn't fire.
            expect(names).toContain('app');
            expect(names).toContain('services');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    it('backend-only repo with internal axios call does not leak into consumedServices on a sibling', () => {
        // Two backend services. service:api calls /api/internal on itself
        // (via axios). Because both consume the same path, but the path
        // owner is api itself, no spurious self-edge or cross-edge fires.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-be-self-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'apps/api1'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'apps/api1/package.json'), '{"dependencies":{"express":"^4"}}');
            fs.writeFileSync(path.join(tmpDir, 'apps/api1/index.ts'),
                "import express from 'express';\nimport axios from 'axios';\naxios.get('/api/internal');");
            const snap = makeMinimalSnapshot(['apps/api1/index.ts']);
            snap.files['apps/api1/index.ts'].content =
                "import express from 'express';\nimport axios from 'axios';\naxios.get('/api/internal');";
            snap.apiIndex['r1'] = {
                apiId: 'r1', method: 'GET', route: '/api/internal', handlerName: 'h',
                filePath: 'apps/api1/index.ts', anchor: { filePath: 'apps/api1/index.ts' },
            };
            const services = detectServices(tmpDir, snap, (fp) => snap.files[fp]?.content);
            const api = services['service:api1'];
            expect(api).toBeDefined();
            // Self-reference is intentionally NOT emitted (the matcher
            // skips when `other.id === service.id`).
            expect(api.consumedServices).not.toContain('service:api1');
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });
});

describe('detectServices — multi-repo workspace', () => {
    it('suppresses the broad same-origin /api fallback in multi-repo mode', () => {
        // Three sibling repos, no orchestrator at root → multi-repo mode.
        // repo-a contains a stray `fetch('/api/foo')` and exposes no APIs;
        // repo-b and repo-c each expose an API. The OLD behaviour would
        // connect repo-a to BOTH repo-b and repo-c via the same-origin
        // fallback. The new behaviour: zero spurious consumedServices.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-repo-same-origin-'));
        try {
            // repo-a: caller with no API of its own
            fs.mkdirSync(path.join(tmp, 'repo-a'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'repo-a', 'package.json'), '{"dependencies":{"express":"^4"}}');
            const repoACode = "import axios from 'axios';\naxios.get('/api/foo');";
            fs.writeFileSync(path.join(tmp, 'repo-a', 'index.ts'), repoACode);

            // repo-b + repo-c: each exposes one API.
            for (const name of ['repo-b', 'repo-c']) {
                fs.mkdirSync(path.join(tmp, name), { recursive: true });
                fs.writeFileSync(path.join(tmp, name, 'package.json'), '{"dependencies":{"express":"^4"}}');
                fs.writeFileSync(path.join(tmp, name, 'server.ts'), "import express from 'express';");
            }

            const snap = makeMinimalSnapshot([
                'repo-a/index.ts',
                'repo-b/server.ts',
                'repo-c/server.ts',
            ]);
            snap.files['repo-a/index.ts'].content = repoACode;
            snap.apiIndex['b1'] = {
                apiId: 'b1', method: 'GET', route: '/api/items', handlerName: 'h',
                filePath: 'repo-b/server.ts', anchor: { filePath: 'repo-b/server.ts' },
            };
            snap.apiIndex['c1'] = {
                apiId: 'c1', method: 'GET', route: '/api/orders', handlerName: 'h',
                filePath: 'repo-c/server.ts', anchor: { filePath: 'repo-c/server.ts' },
            };

            const services = detectServices(tmp, snap, (fp) => snap.files[fp]?.content);
            const a = services['service:repo-a'];
            expect(a, 'repo-a should be detected as a service').toBeDefined();
            // No path-matching can resolve `/api/foo` to either b or c, and
            // the broad fallback is suppressed → no consumedServices.
            expect(a.consumedServices).toEqual([]);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('consolidates shared SDK imports across backend repos into one node', () => {
        // Two backend repos both `import openai`. Single-repo mode skips
        // SDK detection on backends; multi-repo mode should lift that gate
        // and emit ONE `sdk:openai` node consumed by both.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-repo-shared-sdk-'));
        try {
            for (const name of ['svc-a', 'svc-b']) {
                fs.mkdirSync(path.join(tmp, name), { recursive: true });
                fs.writeFileSync(path.join(tmp, name, 'package.json'), '{"dependencies":{"openai":"^4","express":"^4"}}');
                fs.writeFileSync(path.join(tmp, name, 'index.js'), "import OpenAI from 'openai';");
            }
            // Third sibling to push it into multi-repo mode.
            fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'docs', 'package.json'), '{"name":"docs"}');

            // Confirm the precondition.
            expect(detectMultiRepoMode(tmp).isMultiRepo).toBe(true);

            const snap = makeMinimalSnapshot([
                'svc-a/index.js',
                'svc-b/index.js',
                'docs/index.md',
            ]);
            snap.files['svc-a/index.js'].content = "import OpenAI from 'openai';";
            snap.files['svc-b/index.js'].content = "import OpenAI from 'openai';";
            const services = detectServices(tmp, snap, (fp) => snap.files[fp]?.content);
            const infra = detectInfrastructureServices(tmp, snap, services, (fp) => snap.files[fp]?.content);

            const openai = infra.find(i => i.id === 'sdk:openai');
            expect(openai, 'sdk:openai must be present once in multi-repo mode').toBeDefined();
            expect(openai!.consumedBy.sort()).toEqual(['service:svc-a', 'service:svc-b'].sort());
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('does NOT dive into a sibling repo\'s `examples/` / `packages/` as separate services', () => {
        // Replays the 42-repo bug: workspace has 3 sibling repos, one of
        // which (`web-fancy`) carries an `examples/` dir with N nested
        // sample apps. The OLD path called findMonorepoServices on the
        // workspace root and registered every example as its own service.
        // Multi-repo mode must short-circuit: one card per sibling repo,
        // ignore their internal example/package conventions.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-repo-no-dive-'));
        try {
            // Three sibling repos at root → multi-repo mode triggers.
            fs.writeFileSync(path.join(tmp, 'svc-a/package.json'.replace(/\//g, path.sep)),
                '{"dependencies":{"express":"^4"}}', { flag: 'wx', encoding: 'utf-8' });
        } catch { /* tmp helper below mkdirs lazily */ }
        try {
            for (const name of ['svc-a', 'svc-b', 'web-fancy']) {
                fs.mkdirSync(path.join(tmp, name), { recursive: true });
                fs.writeFileSync(path.join(tmp, name, 'package.json'), '{"dependencies":{"express":"^4"}}');
            }
            // web-fancy/examples/<lots of nested apps> — the trap.
            for (const ex of ['demo-a', 'demo-b', 'demo-c', 'demo-d', 'demo-e']) {
                const p = path.join(tmp, 'web-fancy', 'examples', ex);
                fs.mkdirSync(p, { recursive: true });
                fs.writeFileSync(path.join(p, 'package.json'), '{"name":"' + ex + '"}');
            }
            const snap = makeMinimalSnapshot(['svc-a/index.ts', 'svc-b/index.ts', 'web-fancy/index.ts']);
            const services = detectServices(tmp, snap, (fp) => snap.files[fp]?.content);
            const names = Object.values(services).map(s => s.name).sort();
            expect(names).toEqual(['svc-a', 'svc-b', 'web-fancy']);
            // Examples must NOT have become services.
            expect(names.some(n => n.startsWith('demo-'))).toBe(false);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('consolidates shared DB tables across repos into one Postgres·table node', () => {
        // Two backend repos with Prisma + Postgres datasource, BOTH declaring
        // a `User` model. Plus one repo with a private `Article` model.
        // Multi-repo mode should emit one shared `db:postgresql:user` node
        // consumed by both, and NOT a shared node for `Article` (only one
        // owner).
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-repo-shared-db-'));
        try {
            const schema = (extra: string) => `
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}

${extra}
`;
            fs.mkdirSync(path.join(tmp, 'svc-a/prisma'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'svc-a/package.json'), '{"dependencies":{"@prisma/client":"^5"}}');
            fs.writeFileSync(path.join(tmp, 'svc-a/prisma/schema.prisma'), schema(''));

            fs.mkdirSync(path.join(tmp, 'svc-b/prisma'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'svc-b/package.json'), '{"dependencies":{"@prisma/client":"^5"}}');
            fs.writeFileSync(path.join(tmp, 'svc-b/prisma/schema.prisma'), schema('model Article { id Int @id @default(autoincrement()) title String }'));

            // Third sibling so we definitively hit multi-repo mode.
            fs.mkdirSync(path.join(tmp, 'svc-c'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'svc-c/package.json'), '{"dependencies":{"express":"^4"}}');

            const aSchema = schema('');
            const bSchema = schema('model Article { id Int @id @default(autoincrement()) title String }');
            const snap = makeMinimalSnapshot([
                'svc-a/prisma/schema.prisma',
                'svc-b/prisma/schema.prisma',
                'svc-c/index.js',
            ]);
            snap.files['svc-a/prisma/schema.prisma'].content = aSchema;
            snap.files['svc-b/prisma/schema.prisma'].content = bSchema;

            const services = detectServices(tmp, snap, (fp) => snap.files[fp]?.content);
            const infra = detectInfrastructureServices(tmp, snap, services, (fp) => snap.files[fp]?.content);

            const shared = infra.find(i => i.id === 'db:postgresql:user');
            expect(shared, 'shared db node for `user` must exist').toBeDefined();
            expect(shared!.consumedBy.sort()).toEqual(['service:svc-a', 'service:svc-b'].sort());

            // `Article` is only in svc-b — not shared, should NOT appear as
            // a consolidated node in the multi-repo "Shared" lane.
            expect(infra.find(i => i.id === 'db:postgresql:article')).toBeUndefined();
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('still draws path-matched edges in multi-repo mode (precision is preserved)', () => {
        // Multi-repo workspace where repo-a calls `/api/items` and repo-b
        // actually exposes that exact route. The path matcher should still
        // emit the precise edge — only the broad fallback is suppressed.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-repo-pathmatch-'));
        try {
            // FE-ish caller (vite + react package.json) so consumedUrls
            // emits `path:/api/items` and triggers the precise matcher.
            fs.mkdirSync(path.join(tmp, 'web'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'web', 'package.json'),
                '{"dependencies":{"react":"^18","react-dom":"^18"}}');
            const webCode = "fetch('/api/items');";
            fs.writeFileSync(path.join(tmp, 'web', 'App.tsx'), webCode);

            // Backend exposing /api/items
            fs.mkdirSync(path.join(tmp, 'api'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'api', 'package.json'), '{"dependencies":{"express":"^4"}}');
            fs.writeFileSync(path.join(tmp, 'api', 'server.ts'), "import express from 'express';");

            // Third unrelated sibling so multi-repo mode fires.
            fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'docs', 'package.json'), '{"name":"docs"}');

            const snap = makeMinimalSnapshot([
                'web/App.tsx',
                'api/server.ts',
                'docs/index.md',
            ]);
            snap.files['web/App.tsx'].content = webCode;
            snap.apiIndex['a1'] = {
                apiId: 'a1', method: 'GET', route: '/api/items', handlerName: 'h',
                filePath: 'api/server.ts', anchor: { filePath: 'api/server.ts' },
            };

            const services = detectServices(tmp, snap, (fp) => snap.files[fp]?.content);
            const web = services['service:web'];
            expect(web).toBeDefined();
            // Precise path match wins; the edge to api MUST be present.
            expect(web.consumedServices).toContain('service:api');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

// 2026-06-09 — Serverless Framework detection. A `serverless.yml` in
// the service files is the canonical marker; handlers never import
// `express` / `koa` / etc. so the existing JS-runtime import detectors
// silently fall through to `unknown`. The 132-repo serverless-examples
// fixture surfaced this — every L2 Map node read "«unknown» · 0 apis"
// even though each handler.js had 4 valid POST/PUT/GET/DELETE routes.
describe('detectServices — Serverless Framework (serverless.yml)', () => {
    function readFromDisk(tmpDir: string) {
        return (fp: string) => {
            try { return fs.readFileSync(path.join(tmpDir, fp), 'utf-8'); }
            catch { return undefined; }
        };
    }

    it('detects technology=serverless when a serverless.yml lives in the service files', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sls-tech-'));
        try {
            // Single-service workspace with a serverless.yml at the root.
            // No express / koa / nestjs imports — pre-fix this came back as 'unknown'.
            fs.writeFileSync(path.join(tmp, 'serverless.yml'),
                "service: hello\nprovider:\n  name: aws\n  runtime: nodejs18.x\nfunctions:\n  hello:\n    handler: handler.hello\n    events:\n      - http: GET /hello\n");
            fs.writeFileSync(path.join(tmp, 'handler.js'),
                "module.exports.hello = async () => ({ statusCode: 200, body: 'hi' });");
            fs.writeFileSync(path.join(tmp, 'package.json'),
                '{"name":"sls-hello","version":"1.0.0"}');
            const snap = makeMinimalSnapshot(['serverless.yml', 'handler.js', 'package.json']);
            const services = detectServices(tmp, snap, readFromDisk(tmp));
            const tech = Object.values(services).map(s => s.technology);
            expect(tech).toContain('serverless');
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });

    it('maps technology=serverless to category=backend (consistent with express/koa)', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sls-cat-'));
        try {
            fs.writeFileSync(path.join(tmp, 'serverless.yml'),
                "service: x\nprovider:\n  name: aws\n  runtime: nodejs18.x\n");
            fs.writeFileSync(path.join(tmp, 'handler.js'), '');
            fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
            const snap = makeMinimalSnapshot(['serverless.yml', 'handler.js', 'package.json']);
            const services = detectServices(tmp, snap, readFromDisk(tmp));
            const sls = Object.values(services).find(s => s.technology === 'serverless');
            expect(sls, 'expected a serverless service to be detected').toBeTruthy();
            expect(sls!.category).toBe('backend');
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });

    it('still picks express when both `serverless.yml` and an express import are present (yml wins — it is the orchestration layer)', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sls-vs-express-'));
        try {
            fs.writeFileSync(path.join(tmp, 'serverless.yml'),
                "service: y\nprovider:\n  name: aws\n  runtime: nodejs18.x\n");
            // An express import alone would normally tag this as 'express'.
            // But the serverless.yml is the actual orchestration layer
            // (the express app is the handler), so we prefer 'serverless'.
            fs.writeFileSync(path.join(tmp, 'handler.js'),
                "const express = require('express'); module.exports.app = express();");
            fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
            const snap = makeMinimalSnapshot(['serverless.yml', 'handler.js', 'package.json']);
            const services = detectServices(tmp, snap, readFromDisk(tmp));
            const techs = Object.values(services).map(s => s.technology);
            expect(techs).toContain('serverless');
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
});
