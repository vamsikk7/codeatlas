/**
 * tier2.test.ts — unit tests for the six Tier 2 MCP enhancements.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Snapshot } from '../../core/graph/graphTypes';
import {
    paginate,
    trimToBudget,
    listEntryPointsPaged,
    listArchitectureViolations,
    findSimilarEntities,
    loadSavedViews,
} from '../tier2';

function makeSnapshot(): Snapshot {
    const apiIndex: Snapshot['apiIndex'] = {};
    // 100 routes for pagination / token budget tests.
    for (let i = 0; i < 100; i++) {
        const id = `GET:/r/${i}::src/file.ts::h${i}`;
        apiIndex[id] = {
            apiId: id, method: 'GET', route: `/r/${i}`,
            handlerName: `h${i}`, filePath: 'src/file.ts',
            anchor: { filePath: 'src/file.ts' },
            meta: { auth: i % 2 === 0 ? 'required' : undefined },
        };
    }
    // A POST without auth (rule violation).
    apiIndex['POST:/unsafe::src/a.ts::createThing'] = {
        apiId: 'POST:/unsafe::src/a.ts::createThing',
        method: 'POST', route: '/unsafe', handlerName: 'createThing',
        filePath: 'src/a.ts', anchor: { filePath: 'src/a.ts' },
    };
    // Webhook-like route without webhook flag (rule violation).
    apiIndex['POST:/webhooks/stripe::src/wh.ts::handleStripe'] = {
        apiId: 'POST:/webhooks/stripe::src/wh.ts::handleStripe',
        method: 'POST', route: '/webhooks/stripe', handlerName: 'handleStripe',
        filePath: 'src/wh.ts', anchor: { filePath: 'src/wh.ts' },
    };
    // A signup route with auth=undefined — should NOT be flagged as auth_required_on_writes (login/signup exempt).
    apiIndex['POST:/login::src/auth.ts::login'] = {
        apiId: 'POST:/login::src/auth.ts::login',
        method: 'POST', route: '/login', handlerName: 'login',
        filePath: 'src/auth.ts', anchor: { filePath: 'src/auth.ts' },
    };
    return {
        files: {
            'src/file.ts': { path: 'src/file.ts', hash: 'h', mtime: 0, symbols: { functions: [], variables: [], imports: [] } },
            'src/a.ts': { path: 'src/a.ts', hash: 'h', mtime: 0, symbols: { functions: [], variables: [], imports: [] } },
            'src/wh.ts': { path: 'src/wh.ts', hash: 'h', mtime: 0, symbols: { functions: [], variables: [], imports: [] } },
            'src/auth.ts': { path: 'src/auth.ts', hash: 'h', mtime: 0, symbols: { functions: [], variables: [], imports: [] } },
        },
        apiIndex,
        graphs: {},
        clusters: {
            'cluster:big': { id: 'cluster:big', label: 'big', files: ['src/file.ts'], entryPoints: [], internalCallCount: 0, externalCallCount: 0, serviceId: 'service:main' },
            'cluster:small': { id: 'cluster:small', label: 'small', files: ['src/a.ts'], entryPoints: [], internalCallCount: 0, externalCallCount: 0 /* no serviceId — rule violation */ },
        },
        services: {
            'service:main': { id: 'service:main', name: 'main', rootPath: '.', technology: 'express', exposedApiCount: 100, consumedUrls: [], consumedServices: [] },
        },
        health: {
            deadFunctions: ['src/x.ts::unused'],
            godFiles: ['src/giant.ts'],
            highCouplingFiles: [],
            cyclicDependencies: [['a.ts', 'b.ts', 'a.ts']],
            orphanedClusters: [],
        },
    };
}

describe('paginate', () => {
    it('returns first page when no cursor', () => {
        const r = paginate([1, 2, 3, 4, 5], { limit: 2 });
        expect(r.items).toEqual([1, 2]);
        expect(r.nextCursor).toBe(2);
        expect(r.total).toBe(5);
    });

    it('returns next page from cursor', () => {
        const r = paginate([1, 2, 3, 4, 5], { cursor: 2, limit: 2 });
        expect(r.items).toEqual([3, 4]);
        expect(r.nextCursor).toBe(4);
    });

    it('returns null nextCursor on the final page', () => {
        const r = paginate([1, 2, 3, 4, 5], { cursor: 4, limit: 2 });
        expect(r.items).toEqual([5]);
        expect(r.nextCursor).toBeNull();
    });

    it('caps limit at 500', () => {
        const r = paginate(new Array(2000).fill(0), { limit: 100000 });
        expect(r.items.length).toBe(500);
    });
});

describe('trimToBudget', () => {
    it('keeps everything when under budget', () => {
        const r = trimToBudget([1, 2, 3], 1000);
        expect(r.truncated).toBe(false);
        expect(r.items).toEqual([1, 2, 3]);
    });

    it('truncates when over budget', () => {
        const items = new Array(50).fill('verylongstringthatconsumesbytes');
        const r = trimToBudget(items, 50); // 50 tokens ≈ 200 bytes
        expect(r.truncated).toBe(true);
        expect(r.items.length).toBeLessThan(50);
    });

    it('zero budget = no trim', () => {
        const r = trimToBudget([1, 2, 3], 0);
        expect(r.truncated).toBe(false);
        expect(r.items).toEqual([1, 2, 3]);
    });
});

describe('listEntryPointsPaged', () => {
    it('paginates the live entry-point list', () => {
        const snap = makeSnapshot();
        const r = listEntryPointsPaged(snap, {}, { limit: 10 });
        expect(r.items.length).toBe(10);
        expect(r.total).toBeGreaterThanOrEqual(100);
        expect(r.nextCursor).toBe(10);
    });

    it('respects filters', () => {
        const snap = makeSnapshot();
        const r = listEntryPointsPaged(snap, { authRequired: true }, { limit: 1000 });
        expect(r.items.every((e) => e.auth === 'required')).toBe(true);
    });

    it('honours maxResponseTokens cap', () => {
        const snap = makeSnapshot();
        const r = listEntryPointsPaged(snap, {}, { limit: 100 }, 100) as any;
        expect(r.truncated).toBe(true);
        expect(r.tokenEstimate).toBeLessThanOrEqual(110);
    });
});

describe('listArchitectureViolations', () => {
    it('flags POST without auth (auth_required_on_writes)', () => {
        const { violations } = listArchitectureViolations(makeSnapshot());
        const authViolations = violations.filter((v) => v.rule === 'auth_required_on_writes');
        expect(authViolations.some((v) => v.message.includes('POST /unsafe'))).toBe(true);
        // Login route is exempt.
        expect(authViolations.some((v) => v.message.includes('POST /login'))).toBe(false);
    });

    it('UX-48 follow-up: meta.middlewares with an auth-shaped name exempts the route', () => {
        // A POST with `meta.middlewares = ['JwtAuthGuard']` should NOT
        // be flagged — the chain provides the auth even though
        // meta.auth wasn't derived.
        const snap = makeSnapshot();
        snap.apiIndex['POST:/items::src/items.ts::create'] = {
            apiId: 'POST:/items::src/items.ts::create',
            method: 'POST', route: '/items', handlerName: 'create',
            filePath: 'src/items.ts', anchor: { filePath: 'src/items.ts' },
            meta: { middlewares: ['LoggingInterceptor', 'JwtAuthGuard', 'ValidateBody'] },
        };
        const { violations } = listArchitectureViolations(snap);
        expect(violations.some((v) => v.message.includes('POST /items'))).toBe(false);
    });

    it('UX-48 follow-up: meta.middlewares with no auth-shaped entry still raises a violation, citing the chain', () => {
        const snap = makeSnapshot();
        snap.apiIndex['POST:/upload::src/u.ts::upload'] = {
            apiId: 'POST:/upload::src/u.ts::upload',
            method: 'POST', route: '/upload', handlerName: 'upload',
            filePath: 'src/u.ts', anchor: { filePath: 'src/u.ts' },
            meta: { middlewares: ['multer', 'validateBody'] },
        };
        const { violations } = listArchitectureViolations(snap);
        const v = violations.find((x) => x.rule === 'auth_required_on_writes' && x.message.includes('POST /upload'));
        expect(v).toBeDefined();
        // Message should mention the chain so the user can act on it.
        expect(v?.message).toMatch(/chain: multer.*validateBody/);
    });

    it('UX-48 follow-up: broadened public-route exemption covers register / signup / forgot-password / sso/callback', () => {
        const snap = makeSnapshot();
        for (const route of ['/register', '/signup', '/forgot-password', '/reset-password', '/verify-email', '/oauth/callback', '/sso/callback']) {
            const id = `POST:${route}::src/a.ts::h`;
            snap.apiIndex[id] = {
                apiId: id, method: 'POST', route, handlerName: 'h',
                filePath: 'src/a.ts', anchor: { filePath: 'src/a.ts' },
            };
        }
        const { violations } = listArchitectureViolations(snap);
        for (const route of ['/register', '/signup', '/forgot-password', '/reset-password', '/verify-email', '/oauth/callback', '/sso/callback']) {
            expect(violations.some((v) => v.rule === 'auth_required_on_writes' && v.message.includes(route))).toBe(false);
        }
    });

    it('UX-48 follow-up: meta.webhook=true exempts the route from auth_required_on_writes (signature verification IS the auth)', () => {
        const snap = makeSnapshot();
        snap.apiIndex['POST:/webhooks/stripe::src/wh.ts::handleStripe'] = {
            apiId: 'POST:/webhooks/stripe::src/wh.ts::handleStripe',
            method: 'POST', route: '/webhooks/stripe', handlerName: 'handleStripe',
            filePath: 'src/wh.ts', anchor: { filePath: 'src/wh.ts' },
            meta: { webhook: true, webhookProvider: 'stripe' },
        };
        const { violations } = listArchitectureViolations(snap);
        const auth = violations.find((v) => v.rule === 'auth_required_on_writes' && v.message.includes('/webhooks/stripe'));
        expect(auth).toBeUndefined();
    });

    it('flags clusters without a service (every_cluster_has_a_service)', () => {
        const { violations } = listArchitectureViolations(makeSnapshot());
        expect(violations.some((v) => v.rule === 'every_cluster_has_a_service' && v.location?.id === 'cluster:small')).toBe(true);
    });

    it('surfaces health-report data via no_god_files / no_cyclic_dependencies / no_dead_functions', () => {
        const { violations } = listArchitectureViolations(makeSnapshot());
        expect(violations.some((v) => v.rule === 'no_god_files')).toBe(true);
        expect(violations.some((v) => v.rule === 'no_cyclic_dependencies')).toBe(true);
        expect(violations.some((v) => v.rule === 'no_dead_functions')).toBe(true);
    });

    it('flags unverified webhook routes', () => {
        const { violations } = listArchitectureViolations(makeSnapshot());
        expect(violations.some((v) => v.rule === 'webhook_routes_have_signature_verification' && v.message.includes('/webhooks/stripe'))).toBe(true);
    });

    it('filters by rule id', () => {
        const { rules, violations } = listArchitectureViolations(makeSnapshot(), { rules: ['no_god_files'] });
        expect(rules).toEqual(['no_god_files']);
        expect(violations.every((v) => v.rule === 'no_god_files')).toBe(true);
    });
});

describe('findSimilarEntities', () => {
    it('finds routes with the same method + similar shape', () => {
        const snap = makeSnapshot();
        const id = 'GET:/r/5::src/file.ts::h5';
        const r = findSimilarEntities(snap, id, 5);
        expect(r.length).toBeGreaterThan(0);
        expect(r.every((e) => e.kind === 'route')).toBe(true);
        // All r/N share the same method + same file + similar shape.
        // Score floor is 0.3 (same path shape) + 0.08 (same file) = 0.38
        // when there's no middleware overlap signal.
        expect(r[0].score).toBeGreaterThanOrEqual(0.3);
    });

    it('finds clusters by file-count + service overlap', () => {
        const snap = makeSnapshot();
        const r = findSimilarEntities(snap, 'cluster:big', 5);
        expect(r.length).toBeGreaterThan(0);
        expect(r[0].kind).toBe('cluster');
    });

    it('returns empty for unknown id', () => {
        const snap = makeSnapshot();
        expect(findSimilarEntities(snap, 'nope', 5)).toEqual([]);
    });
});

describe('loadSavedViews', () => {
    let tmpRoot: string;
    beforeAll(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-test-'));
        fs.mkdirSync(path.join(tmpRoot, '.codeatlas'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpRoot, '.codeatlas', 'saved-queries.json'),
            JSON.stringify([
                { id: 'unprotected_writes', description: 'POST without auth', sql: "SELECT api_id FROM apis WHERE snapshot_kind='working'" },
                { id: 'broken', sql: '' }, // valid shape but trivial
                { sql: 'no id' }, // invalid — dropped
            ]),
        );
    });
    afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    it('loads valid saved views', () => {
        const views = loadSavedViews(tmpRoot);
        expect(views.length).toBe(2);
        expect(views[0].id).toBe('unprotected_writes');
    });

    it('returns empty when no file', () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-empty-'));
        expect(loadSavedViews(empty)).toEqual([]);
        fs.rmSync(empty, { recursive: true, force: true });
    });
});
