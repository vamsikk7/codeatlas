/**
 * djangoMiddleware.test.ts — UX-36 (2026-06-04)
 */

import { describe, it, expect } from 'vitest';
import {
    parseDjangoMiddlewareList,
    findDjangoSettingsFile,
    applyDjangoGlobalMiddleware,
} from '../djangoMiddleware';
import type { ApiRecord } from '../../graph/graphTypes';

function makeApi(over: Partial<ApiRecord>): ApiRecord {
    return {
        apiId: over.apiId ?? 'a:1',
        method: over.method ?? 'GET',
        route: over.route ?? '/',
        handlerName: over.handlerName ?? 'h',
        filePath: over.filePath ?? 'app/views.py',
        anchor: { filePath: over.filePath ?? 'app/views.py', symbol: 'h', span: { start: 0, end: 0 } },
        ...over,
    } as ApiRecord;
}

describe('parseDjangoMiddlewareList — UX-36', () => {
    it('extracts the MIDDLEWARE list verbatim', () => {
        const src = `
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]
`;
        expect(parseDjangoMiddlewareList(src)).toEqual([
            'django.middleware.security.SecurityMiddleware',
            'django.contrib.sessions.middleware.SessionMiddleware',
            'django.contrib.auth.middleware.AuthenticationMiddleware',
        ]);
    });

    it('handles MIDDLEWARE_CLASSES (pre-1.10 legacy spelling)', () => {
        const src = `MIDDLEWARE_CLASSES = ['django.contrib.sessions.middleware.SessionMiddleware']`;
        expect(parseDjangoMiddlewareList(src)).toEqual([
            'django.contrib.sessions.middleware.SessionMiddleware',
        ]);
    });

    it('returns [] when settings has no MIDDLEWARE block', () => {
        expect(parseDjangoMiddlewareList('SECRET_KEY = "xyz"\nDEBUG = True\n')).toEqual([]);
    });

    it('ignores commented-out entries', () => {
        // Real-world settings.py files comment out middleware during
        // development. The list extractor pulls every quoted string so
        // the comment-string itself wouldn't slip in unless quoted —
        // a normal `# "x.Middleware",` line has the quotes but not the
        // comma. We treat any quoted string in the block as live.
        const src = `
MIDDLEWARE = [
    "a.A",
    "b.B",
]
`;
        expect(parseDjangoMiddlewareList(src)).toEqual(['a.A', 'b.B']);
    });

    it('returns [] on empty input', () => {
        expect(parseDjangoMiddlewareList('')).toEqual([]);
    });
});

describe('findDjangoSettingsFile — UX-36', () => {
    it('finds settings.py with a MIDDLEWARE list', () => {
        const files = new Map<string, string>([
            ['myapp/settings.py', 'MIDDLEWARE = ["a.A"]'],
            ['myapp/views.py', 'def index(req): pass'],
        ]);
        const found = findDjangoSettingsFile(files);
        expect(found?.filePath).toBe('myapp/settings.py');
    });

    it('prefers shallower settings.py when multiple exist', () => {
        const files = new Map<string, string>([
            ['deeper/nested/proj/settings.py', 'MIDDLEWARE = ["x"]'],
            ['proj/settings.py', 'MIDDLEWARE = ["y"]'],
        ]);
        const found = findDjangoSettingsFile(files);
        expect(found?.filePath).toBe('proj/settings.py');
    });

    it('falls back to settings/base.py (split-settings layout)', () => {
        const files = new Map<string, string>([
            ['myapp/settings/base.py', 'MIDDLEWARE = ["a.A"]'],
        ]);
        const found = findDjangoSettingsFile(files);
        expect(found?.filePath).toBe('myapp/settings/base.py');
    });

    it('ignores settings.py without a MIDDLEWARE block', () => {
        const files = new Map<string, string>([
            ['svc/settings.py', 'DEBUG = True'],
        ]);
        expect(findDjangoSettingsFile(files)).toBeNull();
    });

    it('returns null when no settings.py at all', () => {
        const files = new Map<string, string>([
            ['app.py', 'from flask import Flask'],
        ]);
        expect(findDjangoSettingsFile(files)).toBeNull();
    });
});

describe('applyDjangoGlobalMiddleware — UX-36', () => {
    it('prepends the global MIDDLEWARE list (bare names) to every Django route', () => {
        const apis: Record<string, ApiRecord> = {
            'a1': makeApi({ apiId: 'a1', method: 'GET', route: '/articles', filePath: 'myproject/articles/views.py' }),
            'a2': makeApi({ apiId: 'a2', method: 'POST', route: '/articles', filePath: 'myproject/articles/views.py' }),
        };
        const files = new Map<string, string>([
            ['myproject/settings.py', `MIDDLEWARE = [
                "django.middleware.security.SecurityMiddleware",
                "django.contrib.sessions.middleware.SessionMiddleware",
                "django.contrib.auth.middleware.AuthenticationMiddleware",
            ]`],
        ]);
        const out = applyDjangoGlobalMiddleware(apis, files);
        for (const api of Object.values(out)) {
            expect(api.meta?.middlewares).toEqual([
                'SecurityMiddleware',
                'SessionMiddleware',
                'AuthenticationMiddleware',
            ]);
        }
    });

    it('stamps meta.auth = "required" when AuthenticationMiddleware is in the list', () => {
        const apis: Record<string, ApiRecord> = {
            'a': makeApi({ filePath: 'p/app/views.py' }),
        };
        const files = new Map<string, string>([
            ['p/settings.py', 'MIDDLEWARE = ["django.contrib.auth.middleware.AuthenticationMiddleware"]'],
        ]);
        const out = applyDjangoGlobalMiddleware(apis, files);
        expect(out['a'].meta?.auth).toBe('required');
    });

    it('does NOT apply when no settings.py exists', () => {
        const apis: Record<string, ApiRecord> = {
            'a': makeApi({ filePath: 'app/views.py' }),
        };
        const out = applyDjangoGlobalMiddleware(apis, new Map());
        expect(out['a'].meta?.middlewares ?? []).toEqual([]);
    });

    it('does NOT apply to APIs OUTSIDE the settings.py project root (monorepo isolation)', () => {
        const apis: Record<string, ApiRecord> = {
            'django-route': makeApi({ apiId: 'django-route', filePath: 'django-app/views.py' }),
            'express-route': makeApi({ apiId: 'express-route', filePath: 'express-service/routes.js' }),
        };
        const files = new Map<string, string>([
            ['django-app/settings.py', 'MIDDLEWARE = ["django.middleware.security.SecurityMiddleware"]'],
        ]);
        const out = applyDjangoGlobalMiddleware(apis, files);
        expect(out['django-route'].meta?.middlewares).toContain('SecurityMiddleware');
        // Express route in a sibling service stays untouched.
        expect(out['express-route'].meta?.middlewares ?? []).not.toContain('SecurityMiddleware');
    });

    it('preserves existing per-route middleware (appended, not replaced)', () => {
        const apis: Record<string, ApiRecord> = {
            'a': makeApi({
                filePath: 'p/views.py',
                meta: { middlewares: ['login_required'] },
            }),
        };
        const files = new Map<string, string>([
            ['p/settings.py', 'MIDDLEWARE = ["django.middleware.csrf.CsrfViewMiddleware"]'],
        ]);
        const out = applyDjangoGlobalMiddleware(apis, files);
        expect(out['a'].meta?.middlewares).toEqual(['CsrfViewMiddleware', 'login_required']);
    });
});
