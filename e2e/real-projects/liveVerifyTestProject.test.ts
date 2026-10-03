/**
 * Live verification of every route in the user's test project
 * (~/work/node-express-realworld-example-app) — runs a full SyncOrchestrator
 * init via the cascade harness, then probes every detected route through
 * L2b api-list + L3 sequence + L4 file + L5 flow to confirm the issue
 * fixes hold up against the real source.
 *
 * Skipped when the test project directory isn't present (CI-safe).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runScenario, type ScenarioResult } from './cascadeHarness';
import { installFixtureSafetyGuard } from './fixtureSafety';

installFixtureSafetyGuard();

const ROOT = path.join(os.homedir(), 'work/node-express-realworld-example-app');
// CI hazard: GitHub Actions runners use `~/work/<repo-name>/` as the workspace
// path, and a sibling dir matching this prefix can falsely flip a bare
// `existsSync(ROOT)` to true. Probe a known sub-path so we only run when the
// real source tree is present. See liveProject.test.ts for the original CI
// failure trace.
function liveProjectPresent(): boolean {
    try {
        return fs.statSync(path.join(ROOT, 'src')).isDirectory();
    } catch {
        return false;
    }
}
const PRESENT = liveProjectPresent();

(PRESENT ? describe : describe.skip)('LIVE VERIFY: node-express-realworld-example-app', () => {
    let scenario: ScenarioResult;
    let workingApis: any[];
    let workingGraphs: Record<string, any>;

    beforeAll(async () => {
        scenario = await runScenario({ repoPath: ROOT, edits: [] });
        workingApis = Object.values(scenario.working.apiIndex);
        workingGraphs = scenario.working.graphs as any;
    }, 180_000);

    afterAll(() => scenario?.dispose());

    it('summary: prints the live snapshot statistics', () => {
        const seqIds = Object.keys(workingGraphs).filter(g => g.startsWith('sequence:'));
        const flowIds = Object.keys(workingGraphs).filter(g => g.startsWith('flow:'));
        const fileIds = Object.keys(workingGraphs).filter(g => g.startsWith('file:'));
        const apiListIds = Object.keys(workingGraphs).filter(g => g.startsWith('api-list:'));
        const featIds = Object.keys(workingGraphs).filter(g => g.startsWith('feature:'));
        const microIds = Object.keys(workingGraphs).filter(g => g.startsWith('microservice:'));

        const summary = {
            totalApis: workingApis.length,
            byMethod: workingApis.reduce((acc: any, a: any) => { acc[a.method] = (acc[a.method] || 0) + 1; return acc; }, {}),
            apiPrefixed: workingApis.filter(a => a.route.startsWith('/api/')).length,
            randomParameterizedRoute: workingApis.filter(a => a.route === '/api/random/:index').length,
            randomRouteCount: workingApis.find(a => a.route === '/api/random/:index')?.meta?.dynamicRange?.count ?? 0,
            authRequired: workingApis.filter(a => a.meta?.auth === 'required').length,
            authOptional: workingApis.filter(a => a.meta?.auth === 'optional').length,
            errorMiddleware: workingApis.filter(a => a.method === 'MIDDLEWARE' && a.meta?.error).length,
            sequenceGraphs: seqIds.length,
            flowGraphs: flowIds.length,
            fileGraphs: fileIds.length,
            apiListGraphs: apiListIds.length,
            featureGraphs: featIds.length,
            microserviceGraphs: microIds.length,
        };
        console.log('LIVE SNAPSHOT:', JSON.stringify(summary, null, 2));
        // After Issue 414's collapse to one parameterized record, the test
        // project's API count is: 4 auth + 14 article + 3 profile + 1 tag +
        // 1 random (parameterized) + 1 main + 1 error-mw + 1 db_seed ≈ 26.
        expect(summary.totalApis).toBeGreaterThanOrEqual(24);
    });

    // Issue 414 verification — for-loop produces ONE parameterized /api/random/:index record
    it('Issue 414: random.controller emits ONE parameterized record with meta.dynamicRange', () => {
        const random = workingApis.filter(a => /\/random\//.test(a.route));
        expect(random).toHaveLength(1);
        expect(random[0].route).toBe('/api/random/:index');
        expect(random[0].method).toBe('GET');
        expect(random[0].handlerName).toBe('anonymous@GET:/random/:index');
        expect(random[0].meta?.dynamicRange).toEqual({
            var: 'index', from: 1, to: 25, step: 1, count: 25,
        });
    });

    it('Issue 414: random sequence + flow graph are openable (anchor at arrow body)', () => {
        const handlerName = 'anonymous@GET:/random/:index';
        const seqId = `sequence:src/app/routes/random/random.controller.ts:${handlerName}`;
        const flowId = `flow:src/app/routes/random/random.controller.ts:${handlerName}`;
        expect(workingGraphs[seqId], `missing ${seqId}`).toBeDefined();
        expect(workingGraphs[flowId], `missing ${flowId}`).toBeDefined();
        // Anchor span must point inside the source file (not 0/0)
        const random = workingApis.find(a => a.handlerName === handlerName)!;
        expect(random.anchor.span.start).toBeGreaterThan(0);
        expect(random.anchor.span.end).toBeGreaterThan(random.anchor.span.start);
    });

    // Open-the-handler verification: every layer the user clicks through must
    // resolve to real content (not an empty / placeholder graph).
    it('Issue 414: anchor.span resolves to the actual arrow body source text', () => {
        const handlerName = 'anonymous@GET:/random/:index';
        const random = workingApis.find(a => a.handlerName === handlerName)!;
        // The tmpdir copy is in scenario.repoCopyDir — read the source slice.
        const absPath = path.join(scenario.repoCopyDir, random.anchor.filePath);
        expect(fs.existsSync(absPath), `tmpdir source missing: ${absPath}`).toBe(true);
        const fileSource = fs.readFileSync(absPath, 'utf-8');
        const slice = fileSource.slice(random.anchor.span.start, random.anchor.span.end);
        console.log(`\nHANDLER ANCHOR (${random.anchor.filePath} @${random.anchor.span.start}-${random.anchor.span.end}):\n----\n${slice}\n----\n`);
        // The anchor must land on the inline arrow handler.
        expect(slice, `slice should start with the arrow params: ${slice.slice(0, 50)}`).toMatch(/^\(req[^)]*\)\s*=>/);
        // And the slice must contain the body that calls res.json.
        expect(slice).toMatch(/res\.json/);
    });

    it('Issue 414: L3 sequence graph contains participants + at least one message edge', () => {
        const handlerName = 'anonymous@GET:/random/:index';
        const seqId = `sequence:src/app/routes/random/random.controller.ts:${handlerName}`;
        const g = workingGraphs[seqId];
        expect(g, `missing ${seqId}`).toBeDefined();
        // Must have at least: API Client + the file participant (2 participants).
        const participants = g.nodes.filter((n: any) => n.type === 'participant');
        expect(participants.length, 'expected ≥2 participants').toBeGreaterThanOrEqual(2);
        // Must have at least one message edge from API Client to the handler.
        const msgEdges = g.edges.filter((e: any) => e.edgeType === 'message');
        expect(msgEdges.length, 'expected ≥1 message edge').toBeGreaterThanOrEqual(1);
        // The entry message label should reference the route or method (so the
        // user can tell which route this graph is for).
        const labels = msgEdges.map((e: any) => e.label ?? '').join(' | ');
        expect(labels.toLowerCase()).toMatch(/get|random|anonymous/);
    });

    it('Issue 414: L5 flow graph contains real statement/decision nodes (not just Start/End)', () => {
        const handlerName = 'anonymous@GET:/random/:index';
        const flowId = `flow:src/app/routes/random/random.controller.ts:${handlerName}`;
        const g = workingGraphs[flowId];
        expect(g, `missing ${flowId}`).toBeDefined();
        const nonTerminal = g.nodes.filter((n: any) => n.type !== 'terminal');
        expect(nonTerminal.length, 'expected ≥1 non-terminal flow node (statement/decision)').toBeGreaterThanOrEqual(1);
        // The handler body calls res.json — the flow graph must include that.
        const text = g.nodes.map((n: any) => n.label ?? '').join('\n');
        expect(text).toMatch(/res\.json|json|endpoint|randomNumber/);
    });

    it('Issue 414: L4 file:graph for random.controller has the parameterized handler as a function node', () => {
        const fileId = 'file:src/app/routes/random/random.controller.ts';
        const g = workingGraphs[fileId];
        expect(g, `missing ${fileId}`).toBeDefined();
        const fnNodes = g.nodes.filter((n: any) => n.type === 'function');
        const handlerNode = fnNodes.find((n: any) => n.label === 'anonymous@GET:/random/:index');
        expect(handlerNode, `expected an L4 function node named 'anonymous@GET:/random/:index'; got ${fnNodes.map((n: any) => n.label).join(', ')}`).toBeDefined();
    });

    it('Issue 414: L2b api-list shows the parameterized row with dynamicRange meta carried through', () => {
        // The user's cluster naming may vary by LLM — search all api-list graphs.
        const apiLists = Object.entries(workingGraphs).filter(([gid]) => gid.startsWith('api-list:cluster:'));
        let found: any = null;
        for (const [, gAny] of apiLists) {
            const g = gAny as any;
            const apis = (g.meta as any)?.apis ?? [];
            const hit = apis.find((a: any) => a.route === '/api/random/:index');
            if (hit) { found = hit; break; }
        }
        expect(found, 'random parameterized row must appear in some L2b api-list').toBeDefined();
        expect(found.meta?.dynamicRange?.count).toBe(25);
        expect(found.meta?.dynamicRange?.var).toBe('index');
    });

    // Issue 417 verification — composite Router chain prefixes
    it('Issue 417: every controller route is under /api/', () => {
        const controllerApis = workingApis.filter(a =>
            /\/(article|auth|profile|tag|random)\/.+controller/.test(a.filePath) &&
            a.method !== 'MIDDLEWARE',
        );
        const unprefixed = controllerApis.filter(a => !a.route.startsWith('/api/'));
        expect(unprefixed.map(a => `${a.method} ${a.route} ← ${a.filePath}`)).toEqual([]);
    });

    // Issue 408 verification — auth markers populated from auth.required / auth.optional middleware
    it('Issue 408: auth markers populated correctly per route', () => {
        // `auth: undefined` represents `@auth none` in source — a public route
        // with no middleware. The detector correctly returns undefined for these.
        const checks: Array<{ route: string; method: string; auth: 'required' | 'optional' | undefined }> = [
            // auth.controller
            { route: '/api/user', method: 'GET', auth: 'required' },
            { route: '/api/user', method: 'PUT', auth: 'required' },
            { route: '/api/users', method: 'POST', auth: undefined },       // signup public — @auth none in source
            { route: '/api/users/login', method: 'POST', auth: undefined }, // login public
            // article.controller — sample
            { route: '/api/articles', method: 'GET', auth: 'optional' },
            { route: '/api/articles', method: 'POST', auth: 'required' },
            { route: '/api/articles/feed', method: 'GET', auth: 'required' },
            { route: '/api/articles/:slug', method: 'GET', auth: 'optional' },
            { route: '/api/articles/:slug', method: 'PUT', auth: 'required' },
            { route: '/api/articles/:slug', method: 'DELETE', auth: 'required' },
            { route: '/api/articles/:slug/comments', method: 'POST', auth: 'required' },
            { route: '/api/articles/:slug/comments/:id', method: 'DELETE', auth: 'required' },
            { route: '/api/articles/:slug/favorite', method: 'POST', auth: 'required' },
            { route: '/api/articles/:slug/favorite', method: 'DELETE', auth: 'required' },
            // profile.controller
            { route: '/api/profiles/:username', method: 'GET', auth: 'optional' },
            { route: '/api/profiles/:username/follow', method: 'POST', auth: 'required' },
            { route: '/api/profiles/:username/follow', method: 'DELETE', auth: 'required' },
        ];
        const missing: string[] = [];
        for (const c of checks) {
            const api = workingApis.find(a => a.method === c.method && a.route === c.route);
            if (!api) { missing.push(`route not found: ${c.method} ${c.route}`); continue; }
            if (api.meta?.auth !== c.auth) {
                missing.push(`${c.method} ${c.route}: expected auth=${c.auth ?? 'undefined'}, got ${api.meta?.auth ?? 'undefined'}`);
            }
        }
        expect(missing, `auth marker mismatches:\n  ${missing.join('\n  ')}`).toEqual([]);
    });

    it('Issue 408: total auth.required / auth.optional counts match source', () => {
        const required = workingApis.filter(a => a.meta?.auth === 'required').length;
        const optional = workingApis.filter(a => a.meta?.auth === 'optional').length;
        // Source declares ~22 of 26 controller routes authenticated. Allow some tolerance for synthetic routes.
        expect(required).toBeGreaterThanOrEqual(10);
        expect(optional).toBeGreaterThanOrEqual(6);
    });

    // Issue 418 verification — error middleware
    it('Issue 418: main.ts error-middleware detected with meta.error=true', () => {
        const errMw = workingApis.filter(a => a.method === 'MIDDLEWARE' && a.meta?.error);
        expect(errMw.length).toBeGreaterThanOrEqual(1);
        expect(errMw.find(a => a.filePath.endsWith('main.ts'))).toBeDefined();
    });

    // Issue 407 verification — per-handler sequence pollution check
    it('Issue 407: GET /articles/:slug sequence does NOT contain edges to POST /users / sibling routes', () => {
        const seqId = 'sequence:src/app/routes/article/article.controller.ts:anonymous@GET:/articles/:slug';
        const g = workingGraphs[seqId];
        expect(g, `expected ${seqId} present`).toBeDefined();
        // The single entry message must be API Client → file participant.
        const messageEdges = g.edges.filter((e: any) => e.edgeType === 'message');
        const clientNode = g.nodes.find((n: any) => n.label === 'API Client');
        expect(clientNode).toBeDefined();
        const clientOutEdges = messageEdges.filter((e: any) => e.source === clientNode.id);
        // For an inline anonymous arrow handler the inbound edge count should be exactly 1
        // (no leakage from sibling routes like POST /articles, PUT /articles/:slug, etc.)
        expect(clientOutEdges.length, 'API Client should emit exactly one inbound edge for this route').toBe(1);
    });

    // Issue 409 verification — every route handler has a corresponding flow graph
    it('Issue 409: every controller route has a flow graph for its anonymous@METHOD:route handler', () => {
        const controllerApis = workingApis.filter(a =>
            /\/(article|auth|profile|tag|random)\/.+controller/.test(a.filePath) &&
            a.handlerName.startsWith('anonymous@'),
        );
        const missing: string[] = [];
        for (const a of controllerApis) {
            const flowId = `flow:${a.filePath}:${a.handlerName}`;
            if (!workingGraphs[flowId]) missing.push(flowId);
        }
        expect(missing, `missing flow graphs:\n  ${missing.join('\n  ')}`).toEqual([]);
    });

    // Per-route check — every API has a sequence graph
    it('every API has a corresponding sequence graph', () => {
        const missing: string[] = [];
        for (const a of workingApis) {
            // Skip middleware records (they don't get sequence graphs)
            if (a.method === 'MIDDLEWARE') continue;
            const seqId = `sequence:${a.filePath}:${a.handlerName}`;
            if (!workingGraphs[seqId]) missing.push(`${a.method} ${a.route} (${seqId})`);
        }
        expect(missing, `missing sequence graphs:\n  ${missing.slice(0, 10).join('\n  ')}${missing.length > 10 ? `\n  ... (${missing.length} total)` : ''}`).toEqual([]);
    });

    // L2b api-list cluster verification
    it('L2b api-list clusters exist for each feature group', () => {
        const clusters = Object.keys(workingGraphs).filter(g => g.startsWith('api-list:cluster:')).sort();
        console.log('L2b clusters:', clusters);
        // We expect at minimum: article, auth, profile, tag, random (5)
        expect(clusters.length).toBeGreaterThanOrEqual(4);
    });

    it('L2b api-list routes carry through the auth marker', () => {
        const articleApiList = workingGraphs['api-list:cluster:article'];
        if (!articleApiList) return; // cluster name may be LLM-renamed; sample-only
        const meta = articleApiList.meta as any;
        const apis = meta?.apis ?? [];
        const articleSlugGet = apis.find((a: any) => a.method === 'GET' && a.route === '/api/articles/:slug');
        expect(articleSlugGet?.meta?.auth).toBe('optional');
    });

    // L1 microservice cluster check
    it('L1 microservice graph contains the workspace service', () => {
        const microIds = Object.keys(workingGraphs).filter(g => g.startsWith('microservice:'));
        expect(microIds.length).toBeGreaterThanOrEqual(1);
        const g = workingGraphs[microIds[0]];
        const services = g.nodes.filter((n: any) => n.type === 'service');
        console.log('L1 services:', services.map((s: any) => s.label));
        expect(services.length).toBeGreaterThanOrEqual(1);
    });

    // L2a feature graph check
    it('L2a feature graph contains the expected clusters', () => {
        const featIds = Object.keys(workingGraphs).filter(g => g.startsWith('feature:'));
        expect(featIds.length).toBeGreaterThanOrEqual(1);
        const g = workingGraphs[featIds[0]];
        const clusters = g.nodes.filter((n: any) => n.type === 'cluster');
        console.log('L2a clusters:', clusters.map((c: any) => c.label));
        expect(clusters.length).toBeGreaterThanOrEqual(3);
    });
});
