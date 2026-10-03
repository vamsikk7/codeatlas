/**
 * domainAnalyzer.test.ts — Issue #701 heuristic domain clustering tests.
 *
 * Pins the keyword-table semantics + the "Other" bucket behavior + the
 * baseline-vs-working diff. The LLM-driven analyzer (follow-up) will get
 * its own focused tests; this file covers the heuristic MVP that ships
 * standalone.
 */

import { describe, it, expect } from 'vitest';
import { detectDomains, diffDomains } from '../domainAnalyzer';
import type {
    Snapshot,
    ApiRecord,
    FeatureCluster,
} from '../../graph/graphTypes';

function api(id: string, route: string, filePath: string): ApiRecord {
    return {
        apiId: id,
        method: 'GET',
        route,
        handlerName: 'handler',
        filePath,
        anchor: { filePath, span: { start: 0, end: 1 } },
    };
}

function cluster(id: string, label: string, files: string[], overrides: Partial<FeatureCluster> = {}): FeatureCluster {
    return {
        id,
        label,
        name: label,
        files,
        entryPoints: [],
        internalCallCount: 0,
        externalCallCount: 0,
        ...overrides,
    };
}

function emptySnapshot(): Snapshot {
    return { files: {}, apiIndex: {}, graphs: {} };
}

describe('detectDomains — route-path keyword matching', () => {
    it('routes "/auth/login" + "/login/signup" land in "Authenticate users"', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a1: api('a1', '/auth/login', 'src/auth/login.ts'),
                a2: api('a2', '/login/signup', 'src/auth/signup.ts'),
            },
        };
        const domains = detectDomains(snapshot);
        const auth = Object.values(domains).find(d => d.name === 'Authenticate users');
        expect(auth).toBeDefined();
        expect(auth!.routes).toEqual(['a1', 'a2']);
        expect(auth!.verb).toBe('authenticate');
    });

    it('routes "/billing/charge" land in "Process payments"', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a1: api('a1', '/billing/charge', 'src/billing.ts'),
            },
        };
        const domains = detectDomains(snapshot);
        expect(Object.values(domains).some(d => d.name === 'Process payments')).toBe(true);
    });

    it('BUG-POLAR-24: common commerce/SaaS routes no longer fall into "Other"', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                cust: api('cust', '/customers/{id}', 'src/customer.ts'),
                org: api('org', '/organizations/{id}', 'src/org.ts'),
                prod: api('prod', '/products/{id}', 'src/product.ts'),
                refund: api('refund', '/refunds', 'src/refund.ts'),
                discount: api('discount', '/discounts/{id}', 'src/discount.ts'),
                license: api('license', '/license-keys/{id}', 'src/license.ts'),
            },
        };
        const domains = detectDomains(snapshot);
        const names = Object.values(domains).map(d => d.name);
        expect(names).toContain('Manage customers');
        expect(names).toContain('Manage organizations');
        expect(names).toContain('Manage products');
        expect(names).toContain('Manage licenses');
        // refund + discount route to Process payments
        expect(names).toContain('Process payments');
        // None of these should have landed in the Other catch-all.
        const other = Object.values(domains).find(d => d.name === 'Other');
        expect(other?.routes ?? []).toHaveLength(0);
    });

    it('confidence is bumped to 0.6 for route-matched domains', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a1: api('a1', '/auth/login', 'src/auth/login.ts'),
            },
        };
        const domains = detectDomains(snapshot);
        const auth = Object.values(domains).find(d => d.name === 'Authenticate users')!;
        expect(auth.confidence).toBeCloseTo(0.6, 2);
    });
});

describe('detectDomains — cluster-label keyword matching', () => {
    it('cluster named "auth" pulls every file into "Authenticate users"', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            clusters: {
                'cluster:auth': cluster('cluster:auth', 'auth', ['src/auth/util.ts', 'src/auth/middleware.ts']),
            },
        };
        const domains = detectDomains(snapshot);
        const auth = Object.values(domains).find(d => d.name === 'Authenticate users')!;
        expect(auth.files).toEqual(expect.arrayContaining(['src/auth/util.ts', 'src/auth/middleware.ts']));
        // Cluster-only matches cap confidence at 0.4.
        expect(auth.confidence).toBeCloseTo(0.4, 2);
    });

    it('a route hit upgrades the same domain to 0.6 confidence', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a1: api('a1', '/auth/login', 'src/auth/login.ts'),
            },
            clusters: {
                'cluster:auth': cluster('cluster:auth', 'auth', ['src/auth/util.ts']),
            },
        };
        const domains = detectDomains(snapshot);
        const auth = Object.values(domains).find(d => d.name === 'Authenticate users')!;
        // Both the cluster-label match (0.4) and the route match (0.6) fire;
        // confidence keeps the max.
        expect(auth.confidence).toBeCloseTo(0.6, 2);
        // Files from BOTH paths are merged.
        expect(auth.files).toEqual(expect.arrayContaining(['src/auth/login.ts', 'src/auth/util.ts']));
    });
});

describe('detectDomains — Other bucket', () => {
    it('unmatched routes land in "Other" with confidence 0.2', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a1: api('a1', '/zzz/random', 'src/misc.ts'),
            },
        };
        const domains = detectDomains(snapshot);
        const other = Object.values(domains).find(d => d.name === 'Other')!;
        expect(other.routes).toEqual(['a1']);
        expect(other.confidence).toBeCloseTo(0.2, 2);
    });

    it('Other bucket is omitted when every route matches a keyword', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a1: api('a1', '/auth/login', 'src/auth.ts'),
                a2: api('a2', '/billing', 'src/billing.ts'),
            },
        };
        const domains = detectDomains(snapshot);
        expect(Object.values(domains).find(d => d.name === 'Other')).toBeUndefined();
    });
});

describe('detectDomains — service dominance', () => {
    it('tags domain with dominant service id when one service has ≥70% of files', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a1: api('a1', '/auth/login', 'src/auth.ts'),
                a2: api('a2', '/auth/signup', 'src/auth-util.ts'),
            },
            clusters: {
                'cluster:auth': cluster('cluster:auth', 'auth', ['src/auth.ts', 'src/auth-util.ts'], { serviceId: 'service:gateway' }),
            },
        };
        const domains = detectDomains(snapshot);
        const auth = Object.values(domains).find(d => d.name === 'Authenticate users')!;
        expect(auth.serviceId).toBe('service:gateway');
    });

    it('leaves serviceId unset when files are split across services', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a1: api('a1', '/auth/login', 'src/svc-a/auth.ts'),
                a2: api('a2', '/auth/signup', 'src/svc-b/signup.ts'),
            },
            clusters: {
                'cluster:auth-a': cluster('cluster:auth-a', 'auth', ['src/svc-a/auth.ts'], { serviceId: 'service:a' }),
                'cluster:auth-b': cluster('cluster:auth-b', 'auth', ['src/svc-b/signup.ts'], { serviceId: 'service:b' }),
            },
        };
        const domains = detectDomains(snapshot);
        const auth = Object.values(domains).find(d => d.name === 'Authenticate users')!;
        // Each service has 50% — neither hits the 70% threshold.
        expect(auth.serviceId).toBeUndefined();
    });
});

describe('diffDomains', () => {
    it('marks new domains as added', () => {
        const working = { 'domain:auth': { id: 'domain:auth', name: 'Authenticate users', verb: 'authenticate', routes: [], files: [], confidence: 0.5 } };
        const out = diffDomains({}, working);
        expect(out['domain:auth'].diff).toBe('added');
    });

    it('marks vanished domains as deleted tombstones', () => {
        const baseline = { 'domain:gone': { id: 'domain:gone', name: 'Gone', verb: 'g', routes: [], files: [], confidence: 0.5 } };
        const out = diffDomains(baseline, {});
        expect(out['domain:gone'].diff).toBe('deleted');
    });

    it('marks same-id-different-routes as modified', () => {
        const baseline = { 'domain:auth': { id: 'domain:auth', name: 'Authenticate users', verb: 'authenticate', routes: ['old'], files: [], confidence: 0.5 } };
        const working = { 'domain:auth': { id: 'domain:auth', name: 'Authenticate users', verb: 'authenticate', routes: ['new'], files: [], confidence: 0.5 } };
        const out = diffDomains(baseline, working);
        expect(out['domain:auth'].diff).toBe('modified');
    });

    it('marks byte-identical domains as unchanged', () => {
        const same = { 'domain:auth': { id: 'domain:auth', name: 'Authenticate users', verb: 'authenticate', routes: ['r1', 'r2'], files: ['f1'], confidence: 0.5 } };
        const out = diffDomains({ ...same }, { ...same });
        expect(out['domain:auth'].diff).toBe('unchanged');
    });
});
