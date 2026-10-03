/**
 * railsControllerAnchor.test.ts — #880.
 *
 * A Rails resource route declared in routes.rb must re-anchor onto its
 * controller so a controller-only PR is attributed to the route entry point,
 * WITHOUT inflating the entry count.
 */
import { describe, it, expect } from 'vitest';
import { resolveRailsControllerAnchors } from '../railsControllerAnchor';
import type { ApiRecord } from '../../graph/graphTypes';

function rec(p: Partial<ApiRecord>): ApiRecord {
    return {
        apiId: `${p.method}:${p.route}::${p.filePath}::${p.handlerName}`,
        method: 'GET', route: '/x', handlerName: 'h', filePath: 'config/routes.rb',
        ...p,
    } as ApiRecord;
}

function index(...recs: ApiRecord[]): Record<string, ApiRecord> {
    return Object.fromEntries(recs.map((r) => [r.apiId, r]));
}

describe('#880 — Rails controller anchor resolution', () => {
    it('re-anchors a `resources :uploads` POST entry onto uploads_controller.rb', () => {
        const before = index(rec({
            method: 'POST', route: '/uploads',
            handlerName: 'anonymous@RESOURCE:/uploads#create',
            filePath: 'config/routes.rb',
        }));
        const after = resolveRailsControllerAnchors(before, [
            'config/routes.rb',
            'app/controllers/uploads_controller.rb',
            'app/models/upload.rb',
        ]);
        const entries = Object.values(after);
        // Entry COUNT unchanged (re-anchor, not duplicate).
        expect(entries).toHaveLength(1);
        const e = entries[0];
        expect(e.filePath, 'anchors to the controller, not routes.rb').toBe('app/controllers/uploads_controller.rb');
        expect(e.handlerName, 'handler is the resource action').toBe('create');
        // TICKET-ANCHOR-1 residual — anchor sub-object consistent with filePath.
        expect(e.anchor?.filePath, 'anchor points at the controller too').toBe('app/controllers/uploads_controller.rb');
        expect(e.anchor?.span, 'stale routes.rb span dropped').toBeUndefined();
        // Method + route preserved (entry identity in the diff is method+route).
        expect(e.method).toBe('POST');
        expect(e.route).toBe('/uploads');
        // The declaring routes file is kept in meta for reference.
        expect(e.meta?.routeDeclFile).toBe('config/routes.rb');
        // apiId re-keyed to the controller path so the index key matches.
        expect(after[e.apiId]).toBe(e);
    });

    it('is deterministic — baseline + working re-anchor identically (no diff churn)', () => {
        const mk = () => index(rec({
            method: 'GET', route: '/uploads/:id',
            handlerName: 'anonymous@RESOURCE:/uploads#show',
            filePath: 'config/routes.rb',
        }));
        const files = ['config/routes.rb', 'app/controllers/uploads_controller.rb'];
        const a = resolveRailsControllerAnchors(mk(), files);
        const b = resolveRailsControllerAnchors(mk(), files);
        expect(Object.keys(a)).toEqual(Object.keys(b)); // same re-keyed apiId both sides
        expect(Object.values(a)[0].apiId).toBe(Object.values(b)[0].apiId);
    });

    it('matches a namespaced resource to its namespaced controller', () => {
        const before = index(rec({
            method: 'POST', route: '/admin/uploads',
            handlerName: 'anonymous@RESOURCE:/admin/uploads#create',
            filePath: 'config/routes.rb',
        }));
        const after = resolveRailsControllerAnchors(before, [
            'config/routes.rb',
            'app/controllers/admin/uploads_controller.rb',
            'app/controllers/uploads_controller.rb', // decoy — must NOT win
        ]);
        expect(Object.values(after)[0].filePath).toBe('app/controllers/admin/uploads_controller.rb');
    });

    it('leaves the entry unchanged when no matching controller exists', () => {
        const before = index(rec({
            method: 'POST', route: '/uploads',
            handlerName: 'anonymous@RESOURCE:/uploads#create',
            filePath: 'config/routes.rb',
        }));
        const after = resolveRailsControllerAnchors(before, ['config/routes.rb', 'app/models/upload.rb']);
        expect(after).toBe(before); // referentially unchanged
    });

    it('ignores non-Rails-resource entries (no _controller.rb files → fast bail)', () => {
        const before = index(rec({ method: 'GET', route: '/health', handlerName: 'health', filePath: 'app.js' }));
        const after = resolveRailsControllerAnchors(before, ['app.js', 'routes.js']);
        expect(after).toBe(before);
    });

    it('does not touch a resource entry already anchored to a non-routes file', () => {
        const before = index(rec({
            method: 'POST', route: '/uploads',
            handlerName: 'anonymous@RESOURCE:/uploads#create',
            filePath: 'app/controllers/uploads_controller.rb', // already resolved
        }));
        const after = resolveRailsControllerAnchors(before, [
            'app/controllers/uploads_controller.rb',
        ]);
        expect(after).toBe(before);
    });

    // BUG-EXP-10 — Rails controllers are ALWAYS plural, even for a singular
    // `resource :user`. Previously only the as-declared base was tried, so
    // singular resources (`/user`, `/follow`, `/favorite`) never matched their
    // plural controller and stayed stuck on config/routes.rb.
    it('re-anchors singular `resource :user` onto the PLURAL users_controller.rb (BUG-EXP-10)', () => {
        const before = index(rec({
            method: 'GET', route: '/user',
            handlerName: 'anonymous@RESOURCE:/user#show',
            filePath: 'config/routes.rb',
        }));
        const after = resolveRailsControllerAnchors(before, [
            'config/routes.rb',
            'app/controllers/users_controller.rb',
        ]);
        const e = Object.values(after)[0];
        expect(e.filePath).toBe('app/controllers/users_controller.rb');
        expect(e.handlerName).toBe('show');
    });

    it('re-anchors singular nested `resource :follow` onto follows_controller.rb (BUG-EXP-10)', () => {
        const before = index(rec({
            method: 'POST', route: '/follow',
            handlerName: 'anonymous@RESOURCE:/follow#create',
            filePath: 'config/routes.rb',
        }));
        const after = resolveRailsControllerAnchors(before, [
            'config/routes.rb',
            'app/controllers/follows_controller.rb',
        ]);
        expect(Object.values(after)[0].filePath).toBe('app/controllers/follows_controller.rb');
    });

    // TICKET-DETECT-3 — explicit routes `get "job" => "job#index"` / `to: 'x#y'`
    // name the controller LITERALLY (Rails does not pluralize an explicit
    // reference), so `job#index` → `job_controller.rb`, NOT `jobs_controller.rb`.
    it('re-anchors an explicit `get "job" => "job#index"` route onto job_controller.rb', () => {
        const before = index(rec({
            method: 'GET', route: '/job',
            handlerName: 'anonymous@ROUTE:job#index',
            filePath: 'myapp/config/routes.rb',
        }));
        const after = resolveRailsControllerAnchors(before, [
            'myapp/config/routes.rb',
            'myapp/app/controllers/job_controller.rb', // singular — literal, not pluralized
        ]);
        const e = Object.values(after)[0];
        expect(Object.values(after)).toHaveLength(1);
        expect(e.filePath, 'literal controller name, not pluralized').toBe('myapp/app/controllers/job_controller.rb');
        expect(e.handlerName).toBe('index');
        expect(e.method).toBe('GET');
        expect(e.route).toBe('/job');
        expect(e.meta?.routeDeclFile).toBe('myapp/config/routes.rb');
    });

    it('re-anchors an explicit `to:` route onto a namespaced controller', () => {
        const before = index(rec({
            method: 'POST', route: '/admin/reports',
            handlerName: 'anonymous@ROUTE:admin/reports#create',
            filePath: 'config/routes.rb',
        }));
        const after = resolveRailsControllerAnchors(before, [
            'config/routes.rb',
            'app/controllers/admin/reports_controller.rb',
            'app/controllers/reports_controller.rb', // decoy — must NOT win
        ]);
        expect(Object.values(after)[0].filePath).toBe('app/controllers/admin/reports_controller.rb');
        expect(Object.values(after)[0].handlerName).toBe('create');
    });

    it('leaves an explicit route unchanged when its controller file is absent (gem route)', () => {
        const before = index(rec({
            method: 'GET', route: '/job',
            handlerName: 'anonymous@ROUTE:job#index',
            filePath: 'config/routes.rb',
        }));
        // a decoy controller is present so the fast-bail doesn't trigger
        const after = resolveRailsControllerAnchors(before, ['config/routes.rb', 'app/controllers/other_controller.rb']);
        expect(after).toBe(before);
    });
});
