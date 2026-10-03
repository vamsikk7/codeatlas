/**
 * ADR-034 Phase A — storeRouter tests (#786 — Phase A: per-repo DB foundation (ADR-034)).
 *
 * Pure-function tests for `resolveStoreFor()` — no DB I/O, no registry.
 * Asserts that every graphId prefix the live pipeline emits routes to the
 * correct scope.
 */
import { describe, it, expect } from 'vitest';
import { resolveStoreFor, getWorkspaceGraphIds } from '../storeRouter';

const WS = '/tmp/test-workspace';

describe('storeRouter — resolveStoreFor', () => {
    it.each([
        'microservice:workspace',
        'map:workspace',
        'domain:workspace',
        'tour:workspace',
        'health:report',
        'feature:workspace',
    ])('workspace-scope graphId %s routes to aggregator', (id) => {
        const r = resolveStoreFor(id, WS);
        expect(r).not.toBeNull();
        expect(r!.scope).toBe('workspace');
        expect(r!.graphId).toBe(id);
    });

    it('every workspace graphId in the export list routes to aggregator', () => {
        for (const id of getWorkspaceGraphIds()) {
            expect(resolveStoreFor(id, WS)!.scope).toBe('workspace');
        }
    });

    it.each([
        'file:src/app/auth.ts',
        'flow:src/app/auth.ts:login',
        'sequence:src/app/auth.controller.ts:anonymous@GET:/user',
        'feature:cluster:article',
        'feature:service:main',
        'api-list:cluster:auth',
    ])('repo-scope graphId %s routes to repo with empty repoId in Phase A', (id) => {
        const r = resolveStoreFor(id, WS);
        expect(r).not.toBeNull();
        expect(r!.scope).toBe('repo');
        if (r!.scope === 'repo') {
            expect(r!.repoId).toBe('');
            expect(r!.graphId).toBe(id);
        }
    });

    it('returns null for unknown prefix', () => {
        expect(resolveStoreFor('unknown:thing', WS)).toBeNull();
        expect(resolveStoreFor('legacy', WS)).toBeNull();
    });

    it('returns null for empty / non-string input', () => {
        expect(resolveStoreFor('', WS)).toBeNull();
        expect(resolveStoreFor(undefined as any, WS)).toBeNull();
        expect(resolveStoreFor(null as any, WS)).toBeNull();
        expect(resolveStoreFor(123 as any, WS)).toBeNull();
    });

    it('distinguishes feature:workspace (aggregator) from feature:service:* (repo)', () => {
        expect(resolveStoreFor('feature:workspace', WS)!.scope).toBe('workspace');
        expect(resolveStoreFor('feature:service:main', WS)!.scope).toBe('repo');
        expect(resolveStoreFor('feature:cluster:auth', WS)!.scope).toBe('repo');
    });

    it('graphId is passed through unchanged in both scopes', () => {
        const repo = resolveStoreFor('file:src/x.ts', WS)!;
        expect(repo.graphId).toBe('file:src/x.ts');
        const ws = resolveStoreFor('map:workspace', WS)!;
        expect(ws.graphId).toBe('map:workspace');
    });

    it('handles complex graphIds with colons in the suffix', () => {
        const r = resolveStoreFor('sequence:src/app/routes/auth.ts:anonymous@GET:/user', WS);
        expect(r).not.toBeNull();
        expect(r!.scope).toBe('repo');
        if (r!.scope === 'repo') {
            expect(r!.graphId).toBe('sequence:src/app/routes/auth.ts:anonymous@GET:/user');
        }
    });
});
