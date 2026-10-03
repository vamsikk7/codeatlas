/**
 * workspaceApiListBuilder.test.ts — TICKET-UI-1.
 */
import { describe, it, expect } from 'vitest';
import { buildWorkspaceApiListGraph, WORKSPACE_API_LIST_ID } from '../workspaceApiListBuilder';
import type { ApiRecord } from '../graphTypes';

function api(p: Partial<ApiRecord>): ApiRecord {
    return { apiId: `${p.method}:${p.route}`, method: 'GET', route: '/x', handlerName: 'h', filePath: 'a.ts', ...p } as ApiRecord;
}
function index(...recs: ApiRecord[]) { return Object.fromEntries(recs.map(r => [r.apiId, r])); }

describe('buildWorkspaceApiListGraph', () => {
    it('returns null for an empty workspace', () => {
        expect(buildWorkspaceApiListGraph({})).toBeNull();
        expect(buildWorkspaceApiListGraph(undefined)).toBeNull();
    });

    it('collects every endpoint into a single api-list:workspace graph', () => {
        const g = buildWorkspaceApiListGraph(index(
            api({ method: 'GET', route: '/a', filePath: 'a.ts' }),
            api({ method: 'POST', route: '/b', filePath: 'b.ts' }),
        ));
        expect(g?.graphId).toBe(WORKSPACE_API_LIST_ID);
        expect(g?.type).toBe('api-list');
        expect((g?.meta as any).apis).toHaveLength(2);
        expect((g?.meta as any).files.sort()).toEqual(['a.ts', 'b.ts']);
    });

    it('splits SCREEN / NAV_ROUTE / NETWORK / DI_BINDING into their own buckets (mobile parity)', () => {
        const g = buildWorkspaceApiListGraph(index(
            api({ method: 'GET', route: '/http', filePath: 'a.ts' }),
            api({ method: 'SCREEN', route: '/Home', filePath: 'Home.kt' }),
            api({ method: 'NAV_ROUTE', route: '/nav', filePath: 'Nav.kt' }),
            api({ method: 'NETWORK', route: 'Room: x', filePath: 'Dao.kt' }),
            api({ method: 'DI_BINDING', route: '@Inject', filePath: 'Di.kt' }),
        ));
        const m = g?.meta as any;
        expect(m.apis, 'only HTTP APIs in the apis bucket').toHaveLength(1);
        expect(m.screens).toHaveLength(1);
        expect(m.navRoutes).toHaveLength(1);
        expect(m.networkCalls).toHaveLength(1);
        expect(m.diBindings).toHaveLength(1);
    });
});
