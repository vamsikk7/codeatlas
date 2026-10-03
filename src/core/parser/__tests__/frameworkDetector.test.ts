import { describe, it, expect } from 'vitest';
import { detectFrameworkApis, classifyExternalSystemMultiLang, isTestFile, dedupeSameLocationApis } from '../frameworkDetector';
import type { SupportedLanguage } from '../treeSitterParser';

describe('dedupeSameLocationApis (BUG-POLAR-3 — collapse same-location double-matches)', () => {
    const rec = (apiId: string, off: number): any => ({
        apiId, method: 'GET', route: '/customers/me/export', handlerName: 'anonymous@GET:/customers/me/export',
        filePath: 'customer.py', anchor: { filePath: 'customer.py', symbol: 'h', span: { start: off, end: off + 1 } },
    });
    it('collapses the same endpoint detected twice at the SAME offset', () => {
        const apis = [rec('GET:/x::customer.py::h', 2146), rec('GET:/x::customer.py::h#1', 2146)];
        const out = dedupeSameLocationApis(apis);
        expect(out).toHaveLength(1);
        expect(out[0].apiId).toBe('GET:/x::customer.py::h'); // keeps the stable (non-#1) id
    });
    it('KEEPS genuine multi-registration at DISTINCT offsets (BUG-EXPLORE-1 echo case)', () => {
        const apis = [rec('a', 100), rec('a#1', 500), rec('a#2', 900)];
        expect(dedupeSameLocationApis(apis)).toHaveLength(3);
    });
    it('is a no-op on already-unique apis', () => {
        const apis = [rec('a', 1), { ...rec('b', 1), route: '/other' }];
        expect(dedupeSameLocationApis(apis)).toHaveLength(2);
    });
});

describe('frameworkDetector', () => {

    // BUG-EXPLORE-14 (2026-07-15): test-suite files were counted as real entry
    // points. On ts-apollo, `packages/integration-testsuite/src/apolloServerTests.ts`
    // has 57 inline gql operations that surfaced as phantom GraphQL entry points —
    // clicking the first opened a 532-node L3 sequence. `isTestFile` must exclude
    // JS/TS `*Tests`/`*Spec` basenames and `testsuite`/`e2e`/`fixtures`/`__mocks__`
    // path segments (previously only `.test.`/`.spec.`/`__tests__`/`_test.go`).
    describe('isTestFile excludes JS/TS test-suite files (BUG-EXPLORE-14)', () => {
        it('excludes *Tests.ts / *Spec.ts basenames and integration-testsuite path', () => {
            expect(isTestFile('packages/integration-testsuite/src/apolloServerTests.ts')).toBe(true);
            expect(isTestFile('packages/integration-testsuite/src/httpSpecTests.ts')).toBe(true);
            expect(isTestFile('src/foo/BarSpec.ts')).toBe(true);
            expect(isTestFile('src/foo/BarTests.tsx')).toBe(true);
        });
        it('excludes e2e / fixtures / __mocks__ / test-suite path segments', () => {
            expect(isTestFile('e2e/checkout.ts')).toBe(true);
            expect(isTestFile('src/__fixtures__/user.ts')).toBe(true);
            expect(isTestFile('test/fixtures/payload.ts')).toBe(true);
            expect(isTestFile('src/__mocks__/api.ts')).toBe(true);
            expect(isTestFile('packages/test-suite/src/run.ts')).toBe(true);
        });
        it('does NOT exclude real production files (no false positives)', () => {
            expect(isTestFile('src/article/article.controller.ts')).toBe(false);
            expect(isTestFile('packages/server/src/plugin/index.ts')).toBe(false);
            // "latest.ts" ends in "est" but is not a Test file.
            expect(isTestFile('src/utils/latest.ts')).toBe(false);
            // A "contests" feature is not a test.
            expect(isTestFile('src/contests/contestController.ts')).toBe(false);
        });
    });

    // BUG-EXPLORE-1 (2026-07-15): anonymous-handler apiIds must be EDIT-STABLE.
    // They used to embed the byte offset (`anonymous@GET:/users@1234`), so any
    // edit above the route shifted the offset → the apiId changed → the
    // baseline diff falsely flagged the route added/deleted on every save, and
    // an edit+revert never returned to a clean match. The fix keys anonymous
    // handlers by a STABLE per-file occurrence index instead.
    describe('anonymous-handler apiId stability (BUG-EXPLORE-1)', () => {
        // Kotlin Ktor `get("/x") { … }` reliably yields an `anonymous@` handler
        // (inline lambda, no name to recover) — the exact class of route whose
        // apiId used to embed the byte offset.
        it('single inline handler → fully route-based apiId, no offset suffix', () => {
            const src = `fun Application.module() {\n    routing {\n        get("/users") {\n            call.respondText("hi")\n        }\n    }\n}`;
            const apis = detectFrameworkApis(src, 'app.kt', 'kotlin');
            const users = apis.find(a => a.method === 'GET' && a.route === '/users');
            expect(users).toBeTruthy();
            expect(users!.handlerName).toBe('anonymous@GET:/users');
            expect(users!.apiId).toBe('GET:/users::app.kt::anonymous@GET:/users');
            // No trailing `@<digits>` byte offset.
            expect(users!.apiId).not.toMatch(/@\d+$/);
        });

        it('editing content ABOVE the route does not change its apiId', () => {
            const before = `fun Application.module() {\n    routing {\n        get("/users") {\n            call.respondText("hi")\n        }\n    }\n}`;
            const after = `// a newly added comment line\n// and another one to shift byte offsets\nfun Application.module() {\n    routing {\n        get("/users") {\n            call.respondText("hi")\n        }\n    }\n}`;
            const idBefore = detectFrameworkApis(before, 'app.kt', 'kotlin').find(a => a.method === 'GET' && a.route === '/users')!.apiId;
            const idAfter = detectFrameworkApis(after, 'app.kt', 'kotlin').find(a => a.method === 'GET' && a.route === '/users')!.apiId;
            expect(idAfter).toBe(idBefore);
        });

        it('multiple same-(method,route) inline handlers stay distinct via a stable occurrence index', () => {
            const src = `fun Application.module() {\n    routing {\n        get("/") { call.respondText("a") }\n        get("/") { call.respondText("b") }\n    }\n}`;
            const apis = detectFrameworkApis(src, 'app.kt', 'kotlin');
            const roots = apis.filter(a => a.route === '/' && a.method === 'GET').map(a => a.apiId);
            expect(roots.length).toBeGreaterThanOrEqual(2);
            // Two distinct call sites → two distinct, stable ids (#0 implicit, #1).
            expect(new Set(roots).size).toBe(roots.length);
            expect(roots).toContain('GET:/::app.kt::anonymous@GET:/');
            expect(roots.some(id => /#1$/.test(id))).toBe(true);
            // None carry a byte offset.
            expect(roots.every(id => !/@\d+$/.test(id))).toBe(true);
        });
    });

    describe('JavaScript / TypeScript Patterns (Express/Nest)', () => {
        it('should detect Express/Fastify app.get pattern', () => {
            const source = `
                import express from 'express';
                const app = express();
                app.get('/users', (req, res) => res.send([]));
                router.post("/items", createItem);
            `;
            const apis = detectFrameworkApis(source, 'app.ts', 'typescript');
            expect(apis).toHaveLength(2);
            expect(apis[0]).toMatchObject({ method: 'GET', route: '/users' });
            expect(apis[1]).toMatchObject({ method: 'POST', route: '/items' });
        });

        it('should detect NestJS decorator patterns', () => {
            const source = `
                @Controller('cats')
                export class CatsController {
                    @Get()
                    findAll() {}
                    
                    @Post('create')
                    createCat() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'cats.controller.ts', 'typescript');
            expect(apis).toHaveLength(3);

            const controller = apis.find(a => a.method === 'CONTROLLER');
            const get = apis.find(a => a.method === 'GET');
            const post = apis.find(a => a.method === 'POST');

            expect(controller).toMatchObject({ method: 'CONTROLLER', route: '/cats' });
            expect(get).toMatchObject({ method: 'GET', route: '/' });
            expect(post).toMatchObject({ method: 'POST', route: '/create' });
        });

        // Regression: Issue 328 — the tRPC `.query(` / `.mutation(` pattern was
        // emitting bogus QUERY/MUTATION entries for SQL/Knex helper calls in
        // non-tRPC files (e.g. `connection.query("CREATE DATABASE ...")` in a
        // migration script). Detector now requires both a tRPC marker in the
        // file AND a real procedure-name capture before emitting.
        it('does not emit tRPC entries for SQL/Knex query() calls in non-tRPC files', () => {
            const source = `
                import mysql from 'mysql2/promise';
                async function createDb() {
                    const connection = await mysql.createConnection({});
                    await connection.query("CREATE DATABASE IF NOT EXISTS app");
                    await connection.query("DROP TABLE users");
                }
            `;
            const apis = detectFrameworkApis(source, 'scripts/create-database.ts', 'typescript');
            const trpc = apis.filter(a => a.method === 'QUERY' || a.method === 'MUTATION');
            expect(trpc).toEqual([]);
        });

        it('does not emit tRPC entries for `.mutation(` calls in non-tRPC files', () => {
            const source = `
                import { gql } from '@apollo/client';
                const cache = new InMemoryCache();
                cache.mutation({ id: 'User:1', fragment: gql\`{ name }\` });
            `;
            const apis = detectFrameworkApis(source, 'src/cache.ts', 'typescript');
            const trpc = apis.filter(a => a.method === 'QUERY' || a.method === 'MUTATION');
            expect(trpc).toEqual([]);
        });

        it('still detects real tRPC procedures when @trpc/server marker is present', () => {
            const source = `
                import { initTRPC } from '@trpc/server';
                const t = initTRPC.create();
                const publicProcedure = t.procedure;
                export const appRouter = t.router({
                    healthcheck: publicProcedure.query(() => ({ ok: true })),
                    createUser: publicProcedure.mutation(({ input }) => input),
                });
            `;
            const apis = detectFrameworkApis(source, 'src/server/router.ts', 'typescript');
            const trpc = apis.filter(a => a.method === 'QUERY' || a.method === 'MUTATION');
            expect(trpc.length).toBeGreaterThanOrEqual(2);
            const methods = new Set(trpc.map(a => a.method));
            expect(methods.has('QUERY')).toBe(true);
            expect(methods.has('MUTATION')).toBe(true);
        });

        // Regression: Issue 333 — the procedure-name walk-back used a
        // non-global `String.match()`, returning the FIRST `name: procedure`
        // pair in the preceding 200 chars. For sibling procedures inside a
        // single `t.router({...})` object, all entries got the same name
        // (the earliest one in the window). Fix: use matchAll and pick the
        // LAST match, which is the procedure currently being defined.
        it('captures the correct procedure name for sibling tRPC procedures', () => {
            const source = `
                import { initTRPC } from '@trpc/server';
                const t = initTRPC.create();
                const publicProcedure = t.procedure;
                export const appRouter = t.router({
                    healthcheck: publicProcedure.query(() => ({ ok: true })),
                    listUsers: publicProcedure.query(() => []),
                    createUser: publicProcedure.mutation(({ input }) => input),
                    deleteUser: publicProcedure.mutation(({ input }) => input),
                });
            `;
            const apis = detectFrameworkApis(source, 'src/server/router.ts', 'typescript');
            const handlers = apis
                .filter(a => a.method === 'QUERY' || a.method === 'MUTATION')
                .map(a => a.handlerName);
            // Each sibling procedure must get its own name, not collapse to
            // whichever one appears first in the router object.
            expect(new Set(handlers)).toEqual(
                new Set(['healthcheck', 'listUsers', 'createUser', 'deleteUser']),
            );
        });
    });

    describe('Python Patterns (Flask/FastAPI/Django)', () => {
        it('should detect FastAPI decorator patterns', () => {
            const source = `
                from fastapi import FastAPI
                app = FastAPI()

                @app.get("/items/{item_id}")
                def read_item(item_id: int):
                    return {"item_id": item_id}
                    
                @router.post("/users")
                async def create_user(): pass
            `;
            const apis = detectFrameworkApis(source, 'main.py', 'python');
            expect(apis).toHaveLength(2);
            expect(apis[0]).toMatchObject({ method: 'GET', route: '/items/{item_id}' });
            expect(apis[1]).toMatchObject({ method: 'POST', route: '/users' });
        });

        // Issue 419 follow-up: FastAPI Depends(get_current_user)-style auth.
        it('Issue 419: detects FastAPI auth via decorator-level dependencies=[Depends(get_current_user)]', () => {
            const source = `
from fastapi import APIRouter, Depends
from .deps import get_current_active_superuser

router = APIRouter()

@router.get(
    "/users",
    dependencies=[Depends(get_current_active_superuser)],
)
def read_users():
    return []

@router.get("/public")
def public_endpoint():
    return {}
`;
            const apis = detectFrameworkApis(source, 'app/routes/users.py', 'python');
            const usersRoute = apis.find(a => a.route === '/users');
            const publicRoute = apis.find(a => a.route === '/public');
            expect(usersRoute?.meta?.auth).toBe('required');
            expect(publicRoute?.meta?.auth).toBeUndefined();
        });

        it('Issue 419: detects FastAPI auth via parameter-level Depends(get_current_user)', () => {
            const source = `
from fastapi import APIRouter, Depends
from .deps import get_current_user

router = APIRouter()

@router.get("/me")
def read_me(current_user = Depends(get_current_user)):
    return current_user
`;
            const apis = detectFrameworkApis(source, 'app/routes/me.py', 'python');
            const meRoute = apis.find(a => a.route === '/me');
            expect(meRoute?.meta?.auth).toBe('required');
        });

        it('Issue 419: does not flag routes whose nearest Depends() is non-auth (e.g. SessionDep)', () => {
            const source = `
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

router = APIRouter()

@router.get("/items")
def list_items(session: Session = Depends(get_db)):
    return []
`;
            const apis = detectFrameworkApis(source, 'app/routes/items.py', 'python');
            const route = apis.find(a => a.route === '/items');
            expect(route?.meta?.auth).toBeUndefined();
        });

        // UX-37 (2026-06-04) — generalize the FastAPI Depends pass from
        // auth-only to ALL dependencies. Every `Depends(X)` near a
        // route is a participant in that route's request flow, not
        // just auth-shaped ones. Captured into `meta.middlewares` so
        // the UX-30 weaver renders them in the L3 sequence.
        it('UX-37: captures every Depends() near a route into meta.middlewares', () => {
            const source = `
from fastapi import APIRouter, Depends
from .deps import get_db, get_current_user, rate_limiter

router = APIRouter()

@router.get("/items")
def list_items(
    session = Depends(get_db),
    user = Depends(get_current_user),
    _ = Depends(rate_limiter),
):
    return []
`;
            const apis = detectFrameworkApis(source, 'app/items.py', 'python');
            const route = apis.find(a => a.route === '/items');
            expect(route?.meta?.middlewares).toEqual(
                expect.arrayContaining(['get_db', 'get_current_user', 'rate_limiter']),
            );
            // auth derivation still fires for auth-shaped names.
            expect(route?.meta?.auth).toBe('required');
        });

        it('UX-37: decorator-level dependencies=[Depends(...)] flows into meta.middlewares', () => {
            const source = `
from fastapi import APIRouter, Depends

router = APIRouter()

@router.post(
    "/admin",
    dependencies=[Depends(verify_token), Depends(audit_log)],
)
def admin_action():
    return {}
`;
            const apis = detectFrameworkApis(source, 'app/admin.py', 'python');
            const route = apis.find(a => a.route === '/admin');
            expect(route?.meta?.middlewares).toEqual(
                expect.arrayContaining(['verify_token', 'audit_log']),
            );
        });

        it('UX-37: routes with no Depends() get no middleware', () => {
            const source = `
from fastapi import APIRouter

router = APIRouter()

@router.get("/health")
def healthcheck():
    return {"ok": True}
`;
            const apis = detectFrameworkApis(source, 'app/health.py', 'python');
            const route = apis.find(a => a.route === '/health');
            expect(route?.meta?.middlewares ?? []).toEqual([]);
        });

        // UX-36 — Django per-view decorators.
        it('UX-36: @login_required + @permission_required land on the view route', () => {
            const source = `
from django.contrib.auth.decorators import login_required, permission_required
from django.urls import path

@login_required
@permission_required('articles.view_article')
def article_detail(request, slug):
    return ...

urlpatterns = [
    path('articles/<slug:slug>/', article_detail),
]
`;
            const apis = detectFrameworkApis(source, 'articles/views.py', 'python');
            // Django path() emits PATH-method API records; let's locate
            // by route.
            const article = apis.find(a => /articles/.test(a.route));
            expect(article?.meta?.middlewares).toEqual(
                expect.arrayContaining(['login_required', 'permission_required']),
            );
            expect(article?.meta?.auth).toBe('required');
        });

        it('UX-36: DRF permission_classes = [IsAuthenticated] on a viewset propagates to its routes', () => {
            const source = `
from rest_framework import viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.decorators import action

class ArticleViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]

    @action(detail=False, methods=['get'])
    def featured(self, request):
        return ...
`;
            const apis = detectFrameworkApis(source, 'articles/views.py', 'python');
            // The @action decorator emits a route — assert it picks up
            // the class-level permission.
            const featured = apis.find(a => /featured/.test(a.route) || a.handlerName === 'featured');
            expect(featured?.meta?.middlewares).toContain('IsAuthenticated');
            expect(featured?.meta?.auth).toBe('required');
        });

        it('UX-37: same Depends repeated across two routes lands on each (no cross-leak)', () => {
            const source = `
from fastapi import APIRouter, Depends

router = APIRouter()

@router.get("/a")
def route_a(db = Depends(get_db)):
    return []

@router.get("/b")
def route_b(db = Depends(get_db)):
    return []
`;
            const apis = detectFrameworkApis(source, 'app/multi.py', 'python');
            const a = apis.find(r => r.route === '/a');
            const b = apis.find(r => r.route === '/b');
            expect(a?.meta?.middlewares).toContain('get_db');
            expect(b?.meta?.middlewares).toContain('get_db');
        });

        // UX-38 (2026-06-05) — Flask middleware detection. Same-file
        // per-view decorators (`@login_required`, `@jwt_required`,
        // `@cross_origin`, `@cache.cached`, `@limiter.limit`) and
        // global `@app.before_request` / `@blueprint.before_request`
        // hooks should land on every route in the file (after_request
        // / teardown_request behave the same way at request scope).
        it('UX-38: @login_required + @jwt_required land on the Flask route', () => {
            const source = `
from flask import Flask
from flask_login import login_required
from flask_jwt_extended import jwt_required

app = Flask(__name__)

@app.route('/profile')
@login_required
@jwt_required()
def profile():
    return {}
`;
            const apis = detectFrameworkApis(source, 'app/views.py', 'python');
            const profile = apis.find(a => a.route === '/profile');
            expect(profile?.meta?.middlewares).toEqual(expect.arrayContaining(['login_required', 'jwt_required']));
            expect(profile?.meta?.auth).toBe('required');
        });

        it('UX-38: @app.before_request hook applies to every route in the file', () => {
            const source = `
from flask import Flask

app = Flask(__name__)

@app.before_request
def check_session():
    pass

@app.after_request
def add_headers(resp):
    return resp

@app.route('/a')
def a():
    return {}

@app.route('/b')
def b():
    return {}
`;
            const apis = detectFrameworkApis(source, 'app/views.py', 'python');
            const a = apis.find(r => r.route === '/a');
            const b = apis.find(r => r.route === '/b');
            expect(a?.meta?.middlewares).toEqual(expect.arrayContaining(['check_session', 'add_headers']));
            expect(b?.meta?.middlewares).toEqual(expect.arrayContaining(['check_session', 'add_headers']));
        });

        it('UX-38: @blueprint.before_request hook applies only to routes registered on that blueprint', () => {
            // Note: the Flask route detector regex matches `app|router|blueprint|bp`
            // receivers; arbitrary names (`api = Blueprint(...)`) require a
            // separate enhancement. For this UX-38 test we use `bp` which IS
            // in the recognised set.
            const source = `
from flask import Blueprint

bp = Blueprint('api', __name__)

@bp.before_request
def api_auth():
    pass

@bp.route('/items')
def items():
    return []
`;
            const apis = detectFrameworkApis(source, 'app/api.py', 'python');
            const items = apis.find(r => r.route === '/items');
            expect(items?.meta?.middlewares).toContain('api_auth');
        });

        it('UX-38: @limiter.limit("5/minute") decorator lands as middleware', () => {
            const source = `
from flask import Flask
from flask_limiter import Limiter

app = Flask(__name__)
limiter = Limiter()

@app.route('/login', methods=['POST'])
@limiter.limit("5/minute")
def login():
    return {}
`;
            const apis = detectFrameworkApis(source, 'app/auth.py', 'python');
            const login = apis.find(a => a.route === '/login');
            expect(login?.meta?.middlewares?.some(mw => /limit/i.test(mw))).toBe(true);
        });

        it('should detect Django path patterns', () => {
            const source = `
                from django.urls import path
                from . import views

                urlpatterns = [
                    path('articles/2003/', views.special_case_2003),
                    path('articles/<int:year>/', views.year_archive),
                ]
            `;
            const apis = detectFrameworkApis(source, 'urls.py', 'python');
            expect(apis).toHaveLength(2);
            expect(apis[0]).toMatchObject({ method: 'GET', route: '/articles/2003/' });
            expect(apis[1]).toMatchObject({ method: 'GET', route: '/articles/<int:year>/' });
        });
    });

    describe('Java / Kotlin Patterns (Spring Boot)', () => {
        it('should detect Spring Boot RequestMapping and GetMapping', () => {
            const source = `
                @RestController
                @RequestMapping("/api/v1")
                public class ApiController {
                    @GetMapping(value = "/health")
                    public ResponseEntity<String> healthCheck() { return "OK"; }

                    @PostMapping("/data")
                    public void addData() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'ApiController.java', 'java');
            // Class-level @RequestMapping is suppressed; method routes get the prefix prepended
            expect(apis).toHaveLength(2);

            const getHealth = apis.find(a => a.method === 'GET' && a.route === '/api/v1/health');
            const postData = apis.find(a => a.method === 'POST' && a.route === '/api/v1/data');

            expect(getHealth).toBeDefined();
            expect(postData).toBeDefined();
        });

        it('should detect Spring Boot annotations without path arguments', () => {
            // Represents a typical TodoController where @PostMapping and @GetMapping
            // have no explicit path — they inherit the class-level @RequestMapping prefix.
            const source = `
                @RestController
                @RequestMapping("/api/todos")
                public class TodoController {
                    @PostMapping
                    public ResponseEntity<TodoDto> createTodo(@RequestBody TodoDto dto) {
                        return ResponseEntity.ok(todoService.create(dto));
                    }

                    @GetMapping
                    public List<TodoDto> listTodos(@AuthenticationPrincipal AuthenticatedUser user) {
                        return todoService.list(user.getUserId());
                    }

                    @GetMapping("/favorites")
                    public List<TodoDto> listFavorites(@AuthenticationPrincipal AuthenticatedUser user) {
                        return todoService.favorites(user.getUserId());
                    }

                    @DeleteMapping("/{id}")
                    public ResponseEntity<Void> deleteTodo(@PathVariable Long id) {
                        todoService.delete(id);
                        return ResponseEntity.noContent().build();
                    }
                }
            `;
            const apis = detectFrameworkApis(source, 'TodoController.java', 'java');

            // Class-level @RequestMapping("/api/todos") is the prefix; method routes are combined with it.
            // No-arg @PostMapping and @GetMapping map to /api/todos itself.
            const postCreate = apis.find(a => a.method === 'POST' && a.route === '/api/todos');
            const getList = apis.find(a => a.method === 'GET' && a.route === '/api/todos');
            const getFavorites = apis.find(a => a.method === 'GET' && a.route === '/api/todos/favorites');
            const deleteById = apis.find(a => a.method === 'DELETE' && a.route === '/api/todos/{id}');

            expect(postCreate).toBeDefined();
            expect(getList).toBeDefined();
            expect(getFavorites).toBeDefined();
            expect(deleteById).toBeDefined();
        });

        it('should not double-detect annotations that have explicit paths', () => {
            const source = `
                @RestController
                @RequestMapping("/api/auth")
                public class AuthController {
                    @PostMapping("/register")
                    public ResponseEntity<AuthResponse> register(@RequestBody RegisterRequest req) {}

                    @PostMapping("/login")
                    public ResponseEntity<AuthResponse> login(@RequestBody LoginRequest req) {}

                    @GetMapping("/me")
                    public ResponseEntity<AuthResponse> getMe() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'AuthController.java', 'java');

            // Class-level @RequestMapping is suppressed; 3 method-level routes get the prefix.
            // The no-arg pattern must NOT create duplicates for annotations that already have paths.
            expect(apis).toHaveLength(3);
            const postRegister = apis.filter(a => a.method === 'POST' && a.route === '/api/auth/register');
            const postLogin = apis.filter(a => a.method === 'POST' && a.route === '/api/auth/login');
            const getMe = apis.filter(a => a.method === 'GET' && a.route === '/api/auth/me');

            expect(postRegister).toHaveLength(1);
            expect(postLogin).toHaveLength(1);
            expect(getMe).toHaveLength(1);
        });

        it('should extract correct handler names from Spring Boot method declarations', () => {
            const source = `
                @RestController
                public class HealthController {
                    @GetMapping("/health")
                    public Map<String, String> health() {
                        return Map.of("status", "ok");
                    }

                    @PostMapping("/reset")
                    public void reset() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'HealthController.java', 'java');
            const healthApi = apis.find(a => a.route === '/health');
            const resetApi = apis.find(a => a.route === '/reset');

            expect(healthApi?.handlerName).toBe('health');
            expect(resetApi?.handlerName).toBe('reset');
        });

        // Issue 419 follow-up: Spring Security annotations.
        it('Issue 419: @PreAuthorize at method level flags the route auth.required', () => {
            const source = `
@RestController
public class UserController {
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/admin/users")
    public List<User> listUsers() { return List.of(); }

    @GetMapping("/public/info")
    public Map<String, String> info() { return Map.of(); }
}
`;
            const apis = detectFrameworkApis(source, 'UserController.java', 'java');
            const adminRoute = apis.find(a => a.route === '/admin/users');
            const publicRoute = apis.find(a => a.route === '/public/info');
            expect(adminRoute?.meta?.auth).toBe('required');
            expect(publicRoute?.meta?.auth).toBeUndefined();
        });

        it('Issue 419: @Secured at class level applies to every route in the class', () => {
            const source = `
@RestController
@Secured("ROLE_USER")
@RequestMapping("/api/users")
public class UserController {
    @GetMapping("/")
    public List<User> list() { return List.of(); }

    @PostMapping("/")
    public User create() { return new User(); }
}
`;
            const apis = detectFrameworkApis(source, 'UserController.java', 'java');
            expect(apis.length).toBeGreaterThanOrEqual(2);
            for (const a of apis.filter(x => /^(GET|POST)$/.test(x.method))) {
                expect(a.meta?.auth, `${a.method} ${a.route} should be auth.required`).toBe('required');
            }
        });

        it('Issue 419: @RolesAllowed (JSR-250) flags auth.required', () => {
            const source = `
@RestController
public class FileController {
    @RolesAllowed("USER")
    @GetMapping("/files")
    public List<File> list() { return List.of(); }
}
`;
            const apis = detectFrameworkApis(source, 'FileController.java', 'java');
            expect(apis[0].meta?.auth).toBe('required');
        });

        it('Issue 419: @PermitAll explicit public marker leaves auth=optional', () => {
            const source = `
@RestController
public class PublicController {
    @PermitAll
    @GetMapping("/health")
    public String health() { return "ok"; }
}
`;
            const apis = detectFrameworkApis(source, 'PublicController.java', 'java');
            expect(apis[0].meta?.auth).toBe('optional');
        });

        // UX-35 (2026-06-05) — Spring middleware annotations land in
        // meta.middlewares (previously only auth flag was stamped).
        it('UX-35: @PreAuthorize lands in meta.middlewares (not just auth flag)', () => {
            const source = `
@RestController
public class AdminController {
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/admin/users")
    public List<User> listUsers() { return List.of(); }
}
`;
            const apis = detectFrameworkApis(source, 'AdminController.java', 'java');
            const route = apis.find(a => a.route === '/admin/users');
            expect(route?.meta?.middlewares).toContain('PreAuthorize');
        });

        it('UX-35: @Transactional lands in meta.middlewares as a Tx participant', () => {
            const source = `
@RestController
public class OrdersController {
    @Transactional
    @PostMapping("/orders")
    public Order create() { return new Order(); }
}
`;
            const apis = detectFrameworkApis(source, 'OrdersController.java', 'java');
            const route = apis.find(a => a.route === '/orders');
            expect(route?.meta?.middlewares).toContain('Transactional');
            // Doesn't imply auth on its own.
            expect(route?.meta?.auth).toBeUndefined();
        });

        it('UX-35: class-level @Secured propagates to every route as a middleware entry', () => {
            const source = `
@RestController
@Secured("ROLE_USER")
@RequestMapping("/api/items")
public class ItemsController {
    @GetMapping("/")    public void list() {}
    @PostMapping("/")   public void create() {}
}
`;
            const apis = detectFrameworkApis(source, 'ItemsController.java', 'java');
            const routes = apis.filter(a => /^(GET|POST)$/.test(a.method));
            for (const r of routes) {
                expect(r.meta?.middlewares).toContain('Secured');
                expect(r.meta?.auth).toBe('required');
            }
        });

        it('UX-35: @Transactional + @PreAuthorize combine in order', () => {
            const source = `
@RestController
public class C {
    @PreAuthorize("hasRole('ADMIN')")
    @Transactional
    @DeleteMapping("/users/{id}")
    public void delete() {}
}
`;
            const apis = detectFrameworkApis(source, 'C.java', 'java');
            const route = apis.find(a => a.route === '/users/{id}');
            expect(route?.meta?.middlewares).toEqual(
                expect.arrayContaining(['PreAuthorize', 'Transactional']),
            );
        });

        it('should detect Spring Boot RequestMapping with explicit methods', () => {
            const source = `
                @RestController
                @RequestMapping("/api/legacy")
                public class LegacyController {
                    @RequestMapping(value = "/create", method = RequestMethod.POST)
                    public void createItem() {}

                    @RequestMapping(path = "/update", method = RequestMethod.PUT)
                    public void updateItem() {}

                    @RequestMapping("/fetch")
                    public void fetchItem() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'LegacyController.java', 'java');
            // Expect 3 endpoints
            expect(apis).toHaveLength(3);

            const postCreate = apis.find(a => a.method === 'POST' && a.route === '/api/legacy/create');
            const putUpdate = apis.find(a => a.method === 'PUT' && a.route === '/api/legacy/update');
            const getFetch = apis.find(a => a.method === 'GET' && a.route === '/api/legacy/fetch');

            expect(postCreate).toBeDefined();
            expect(putUpdate).toBeDefined();
            expect(getFetch).toBeDefined();
        });

        it('should extract correct handler names for package-private methods', () => {
            const source = `
                @RestController
                class PackagePrivateController {
                    @GetMapping("/default")
                    ResponseEntity<String> defaultAccess() { return null; }

                    @PostMapping("/another")
                    void anotherAccess() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'PackagePrivateController.java', 'java');
            
            const defaultApi = apis.find(a => a.route === '/default');
            const anotherApi = apis.find(a => a.route === '/another');

            expect(defaultApi?.handlerName).toBe('defaultAccess');
            expect(anotherApi?.handlerName).toBe('anotherAccess');
        });
    });

    // UX-39 (2026-06-05) — Rails controller filters re-emitted as
    // per-route meta.middlewares so they render in L3 sequence diagrams.
    // FILTER records still emit as before (they remain visible in the
    // L2b Request Hooks section); the new behavior is the cross-record
    // attachment to HTTP routes living in the same controller file.
    describe('Ruby Patterns (Rails/Sinatra) — UX-39', () => {
        it('UX-39: before_action filters land as middleware on every route in the controller file', () => {
            // A Sinatra-style controller file with inline routes + before_action.
            const source = `
class UsersController < ApplicationController
  before_action :authenticate_user!
  before_action :set_user, only: [:show]

  get '/users' do
    User.all
  end

  get '/users/:id' do
    @user
  end
end
`;
            const apis = detectFrameworkApis(source, 'app/controllers/users_controller.rb', 'ruby');
            const httpRoutes = apis.filter(a => /^(GET|POST|PUT|PATCH|DELETE)$/.test(a.method));
            expect(httpRoutes.length).toBeGreaterThanOrEqual(2);
            for (const r of httpRoutes) {
                expect(r.meta?.middlewares, `${r.method} ${r.route} should carry filter chain`).toEqual(
                    expect.arrayContaining(['authenticate_user!', 'set_user']),
                );
            }
        });

        it('UX-39: around_action + after_action land alongside before_action', () => {
            const source = `
class ArticlesController < ApplicationController
  around_action :wrap_in_transaction
  after_action :track_view

  get '/articles/:id' do
    Article.find(params[:id])
  end
end
`;
            const apis = detectFrameworkApis(source, 'app/controllers/articles_controller.rb', 'ruby');
            const route = apis.find(a => a.method === 'GET' && a.route === '/articles/:id');
            expect(route?.meta?.middlewares).toEqual(
                expect.arrayContaining(['wrap_in_transaction', 'track_view']),
            );
        });

        it('UX-39: authenticate_user!-style filter derives meta.auth = required', () => {
            const source = `
class AdminController < ApplicationController
  before_action :authenticate_admin!

  get '/admin/dashboard' do
    {}
  end
end
`;
            const apis = detectFrameworkApis(source, 'app/controllers/admin_controller.rb', 'ruby');
            const route = apis.find(a => a.route === '/admin/dashboard');
            expect(route?.meta?.middlewares).toContain('authenticate_admin!');
            expect(route?.meta?.auth).toBe('required');
        });

        it('UX-39: before_action outside a controller file is NOT applied', () => {
            const source = `
class FooModel
  before_action :foo
end

get '/x' do
  {}
end
`;
            const apis = detectFrameworkApis(source, 'app/models/foo.rb', 'ruby');
            const route = apis.find(a => a.route === '/x');
            // The model has before_action (treated as AR callback inside app/models/,
            // not a controller filter), so the route should NOT receive it.
            expect(route?.meta?.middlewares ?? []).not.toContain('foo');
        });
    });

    // UX-41 (2026-06-05) — Go middleware chains. Gin/Echo/Chi/Fiber
    // declare middleware via `<router>.Use(...)` (global), group-level
    // `<router>.Group("/path", mw1, mw2)`, or per-route middleware
    // varargs. Each pattern needs to land in `meta.middlewares` so
    // the L3 sequence weaver renders the chain.
    describe('Go middleware chains — UX-41', () => {
        it('UX-41: r.Use(...) applies middleware to every Gin route on the same receiver', () => {
            const source = `
package main

import "github.com/gin-gonic/gin"

func main() {
    r := gin.New()
    r.Use(gin.Recovery())
    r.Use(AuthMiddleware())

    r.GET("/users", listUsers)
    r.POST("/users", createUser)
}
`;
            const apis = detectFrameworkApis(source, 'main.go', 'go');
            const list = apis.find(a => a.method === 'GET' && a.route === '/users');
            const create = apis.find(a => a.method === 'POST' && a.route === '/users');
            expect(list?.meta?.middlewares).toEqual(expect.arrayContaining(['gin.Recovery', 'AuthMiddleware']));
            expect(create?.meta?.middlewares).toEqual(expect.arrayContaining(['gin.Recovery', 'AuthMiddleware']));
        });

        it('UX-41: chi r.Use(middleware) applies to every route on the router', () => {
            const source = `
package main

import (
    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
)

func main() {
    r := chi.NewRouter()
    r.Use(middleware.Logger)
    r.Use(jwtAuth)

    r.Get("/items", listItems)
}
`;
            const apis = detectFrameworkApis(source, 'main.go', 'go');
            const list = apis.find(a => a.route === '/items');
            expect(list?.meta?.middlewares).toEqual(expect.arrayContaining(['middleware.Logger', 'jwtAuth']));
        });

        it('UX-41: Fiber app.Use(middleware) applies to every Fiber route', () => {
            const source = `
package main

import (
    "github.com/gofiber/fiber/v2"
    "github.com/gofiber/fiber/v2/middleware/cors"
)

func main() {
    app := fiber.New()
    app.Use(cors.New())
    app.Use(jwtAuth)

    app.Get("/health", healthz)
}
`;
            const apis = detectFrameworkApis(source, 'main.go', 'go');
            const healthRoute = apis.find(a => a.route === '/health');
            expect(healthRoute?.meta?.middlewares).toEqual(expect.arrayContaining(['cors.New', 'jwtAuth']));
        });

        it('UX-41: auth-shaped middleware names derive meta.auth = required', () => {
            const source = `
package main

import "github.com/gin-gonic/gin"

func main() {
    r := gin.New()
    r.Use(jwtAuth())

    r.GET("/secure", handler)
}
`;
            const apis = detectFrameworkApis(source, 'main.go', 'go');
            const secure = apis.find(a => a.route === '/secure');
            expect(secure?.meta?.middlewares).toContain('jwtAuth');
            expect(secure?.meta?.auth).toBe('required');
        });

        // UX-41 Phase 2 (2026-06-05) — group middleware + per-route varargs.
        it('UX-41 Phase 2: r.GET path with middleware varargs before handler', () => {
            const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
    r := gin.New()
    r.GET("/admin", AdminAuth, AuditLog, AdminHandler)
}
`;
            const apis = detectFrameworkApis(source, 'main.go', 'go');
            const admin = apis.find(a => a.route === '/admin');
            expect(admin?.meta?.middlewares).toEqual(expect.arrayContaining(['AdminAuth', 'AuditLog']));
            // Last arg (AdminHandler) is the handler, NOT middleware.
            expect(admin?.meta?.middlewares ?? []).not.toContain('AdminHandler');
        });

        it('UX-41 Phase 2: r.Group("/api", AuthMw) attaches AuthMw to group routes', () => {
            const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
    r := gin.New()
    api := r.Group("/api", AuthMiddleware)
    api.GET("/users", listUsers)
    api.POST("/users", createUser)
}
`;
            const apis = detectFrameworkApis(source, 'main.go', 'go');
            const list = apis.find(a => a.method === 'GET' && /users/.test(a.route));
            const create = apis.find(a => a.method === 'POST' && /users/.test(a.route));
            expect(list?.meta?.middlewares).toContain('AuthMiddleware');
            expect(create?.meta?.middlewares).toContain('AuthMiddleware');
        });

        it('UX-41 Phase 2: group middleware does NOT leak to sibling routes on other receivers', () => {
            const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
    r := gin.New()
    api := r.Group("/api", AuthMw)
    api.GET("/secure", handler)
    r.GET("/public", handler)
}
`;
            const apis = detectFrameworkApis(source, 'main.go', 'go');
            const secure = apis.find(a => /secure/.test(a.route));
            const pub = apis.find(a => /public/.test(a.route));
            expect(secure?.meta?.middlewares ?? []).toContain('AuthMw');
            // Public route on `r`, not on `api`, must not pick up AuthMw.
            expect(pub?.meta?.middlewares ?? []).not.toContain('AuthMw');
        });
    });

    // UX-40 (2026-06-05) — Laravel middleware. Three families:
    //   1. Route::middleware([...])->verb() per-route chains
    //   2. Route::group(['middleware' => [...]], fn) group middleware
    //   3. Controller __construct() $this->middleware('auth') class-wide
    // UX-45 (2026-06-05) — ASP.NET Core [Authorize] / [AllowAnonymous]
    // / [ServiceFilter] / [TypeFilter] attributes attach as middleware.
    // UX-46 (2026-06-05) — Rust middleware: Actix wrap() / Axum layer()
    // / Rocket attach() chains. V1 scope: collect file-level chained
    // calls and apply to every route detected in the same file.
    // UX-44 (2026-06-05) — Hono per-route middleware varargs and sub-app
    // mount middleware. The Express-shape JS detector in apiDetector.ts
    // already extracts varargs middleware between the route path and
    // the handler — this section confirms it works for Hono-style code
    // and adds the framework-level guard so we don't regress.
    // NOTE: frameworkDetector.ts doesn't own JS/TS routes — those flow
    // through apiDetector.ts Babel AST extraction. This test exercises
    // both the JS path AND the Hono regex fallback in
    // FRAMEWORK_PATTERNS for non-Babel-parseable sources.
    // UX-42 (2026-06-05) — gRPC interceptors. Attach interceptors to
    // every GRPC/RPC route in the same file across Node, Go, Python,
    // and Java idioms.
    // UX-43 (2026-06-05) — GraphQL SDL field directives. `@auth` /
    // `@hasRole` / `@isAuthenticated` directives sit on field
    // definitions inside `type Query { ... }`. Each field gets the
    // matching directive in its meta.middlewares.
    // UX-47 (2026-06-05) — polish bundle for lower-volume frameworks:
    // Symfony PHP attributes (#[IsGranted], #[Security]) and Sinatra
    // single-file `before` hooks. Micronaut @Secured and JAX-RS
    // @RolesAllowed are already covered by the Spring middleware
    // allowlist (UX-35) — pin those behaviours here.
    describe('UX-47 polish bundle (Symfony / Sinatra / Micronaut / JAX-RS)', () => {
        it('UX-47: Symfony #[IsGranted("ROLE_ADMIN")] above an action lands in meta.middlewares', () => {
            const source = `
<?php
namespace App\\Controller;

use Symfony\\Component\\Routing\\Annotation\\Route;
use Symfony\\Component\\Security\\Http\\Attribute\\IsGranted;

class AdminController {
    #[IsGranted('ROLE_ADMIN')]
    #[Route('/admin/users', methods: ['GET'])]
    public function listUsers() {}
}
`;
            const apis = detectFrameworkApis(source, 'src/Controller/AdminController.php', 'php');
            const list = apis.find(a => a.route === '/admin/users');
            expect(list?.meta?.middlewares?.some(m => /IsGranted/.test(m))).toBe(true);
            expect(list?.meta?.auth).toBe('required');
        });

        it('UX-47: Sinatra `before do ... end` applies to every route in the file', () => {
            const source = `
require 'sinatra'

before do
  authenticate!
end

get '/dashboard' do
  "ok"
end

post '/users' do
  "created"
end
`;
            const apis = detectFrameworkApis(source, 'app.rb', 'ruby');
            const dash = apis.find(a => a.route === '/dashboard' && a.method === 'GET');
            const create = apis.find(a => a.route === '/users' && a.method === 'POST');
            expect(dash?.meta?.middlewares).toContain('sinatra:before');
            expect(create?.meta?.middlewares).toContain('sinatra:before');
        });

        it('UX-47: Micronaut @Secured already covered via Spring allowlist (UX-35 regression pin)', () => {
            const source = `
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;
import io.micronaut.security.annotation.Secured;

@Controller("/api")
public class UserController {
    @Secured("ROLE_USER")
    @Get("/users")
    public List<User> list() { return List.of(); }
}
`;
            const apis = detectFrameworkApis(source, 'src/main/java/UserController.java', 'java');
            // The Spring annotation pass also covers Micronaut's @Secured
            // because Micronaut shares the JVM allowlist. Any route in
            // the file picking up `Secured` is sufficient (the dual
            // detection from `@GET`/`@Get` patterns can produce siblings;
            // we just want ONE of them to register).
            const withSecured = apis.find(a => a.meta?.middlewares?.includes('Secured'));
            expect(withSecured).toBeDefined();
            expect(withSecured?.meta?.auth).toBe('required');
        });

        it('UX-47: JAX-RS @RolesAllowed already covered (UX-35 regression pin)', () => {
            const source = `
import javax.ws.rs.GET;
import javax.ws.rs.Path;
import javax.annotation.security.RolesAllowed;

@Path("/admin")
public class AdminResource {
    @RolesAllowed("admin")
    @GET
    @Path("/audit")
    public Audit getAudit() { return new Audit(); }
}
`;
            const apis = detectFrameworkApis(source, 'src/main/java/AdminResource.java', 'java');
            const withRoles = apis.find(a => a.meta?.middlewares?.includes('RolesAllowed'));
            expect(withRoles).toBeDefined();
            expect(withRoles?.meta?.auth).toBe('required');
        });
    });

    describe('GraphQL @auth directives — UX-43', () => {
        it('UX-43: @auth directive on a SDL Query field lands in meta.middlewares', () => {
            const source = `
const typeDefs = gql\`
  type Query {
    publicData: String
    secret: String @auth(requires: ADMIN)
  }
\`;
`;
            const apis = detectFrameworkApis(source, 'src/schema.ts', 'typescript');
            const secret = apis.find(a => a.method === 'QUERY' && a.route === '/secret');
            const publicData = apis.find(a => a.route === '/publicData');
            expect(secret?.meta?.middlewares).toContain('auth');
            expect(secret?.meta?.auth).toBe('required');
            expect(publicData?.meta?.middlewares ?? []).not.toContain('auth');
        });

        it('UX-43: multiple directives on the same field stack', () => {
            const source = `
const typeDefs = gql\`
  type Mutation {
    deleteUser(id: ID!): User @auth @hasRole(role: "admin") @rateLimit(max: 5)
  }
\`;
`;
            const apis = detectFrameworkApis(source, 'src/schema.ts', 'typescript');
            const del = apis.find(a => a.method === 'MUTATION' && a.route === '/deleteUser');
            expect(del?.meta?.middlewares).toEqual(expect.arrayContaining(['auth', 'hasRole', 'rateLimit']));
            expect(del?.meta?.auth).toBe('required');
        });

        it('UX-43: isAuthenticated-style directive name also derives auth=required', () => {
            const source = `
const typeDefs = gql\`
  type Query {
    me: User @isAuthenticated
  }
\`;
`;
            const apis = detectFrameworkApis(source, 'src/schema.ts', 'typescript');
            const me = apis.find(a => a.route === '/me');
            expect(me?.meta?.middlewares).toContain('isAuthenticated');
            expect(me?.meta?.auth).toBe('required');
        });
    });

    describe('gRPC interceptors — UX-42', () => {
        it('UX-42: Node grpc.Server({ interceptors: [authInterceptor] }) attaches to GRPC routes', () => {
            const source = `
const grpc = require('@grpc/grpc-js');
const { authInterceptor, logInterceptor } = require('./interceptors');

const server = new grpc.Server({ interceptors: [authInterceptor, logInterceptor] });
server.addService(proto.UserService.service, { GetUser: getUser });
`;
            const apis = detectFrameworkApis(source, 'src/server.js', 'javascript');
            const userSvc = apis.find(a => a.method === 'GRPC');
            expect(userSvc?.meta?.middlewares).toEqual(expect.arrayContaining(['authInterceptor', 'logInterceptor']));
        });

        it('UX-42: Go grpc.UnaryInterceptor(...) registers a single unary interceptor', () => {
            const source = `
package main

import (
    "google.golang.org/grpc"
)

func main() {
    s := grpc.NewServer(
        grpc.UnaryInterceptor(AuthUnaryInterceptor),
    )
    pb.RegisterUserServiceServer(s, &userServer{})
}

// rpc GetUser(GetUserRequest) returns (User);
`;
            const apis = detectFrameworkApis(source, 'cmd/server/main.go', 'go');
            const rpc = apis.find(a => a.method === 'RPC' || a.method === 'GRPC');
            expect(rpc?.meta?.middlewares).toContain('AuthUnaryInterceptor');
        });

        it('UX-42: Go grpc.ChainUnaryInterceptor(a, b, c) captures every interceptor in the chain', () => {
            const source = `
s := grpc.NewServer(
    grpc.ChainUnaryInterceptor(LoggingInterceptor, AuthInterceptor, RecoveryInterceptor),
)
// rpc CreateUser(CreateUserRequest) returns (User);
`;
            const apis = detectFrameworkApis(source, 'cmd/server/main.go', 'go');
            const rpc = apis.find(a => a.method === 'RPC' || a.method === 'GRPC');
            expect(rpc?.meta?.middlewares).toEqual(
                expect.arrayContaining(['LoggingInterceptor', 'AuthInterceptor', 'RecoveryInterceptor'])
            );
        });

        it('UX-42: Python grpc.server(thread_pool, interceptors=[...]) attaches to RPC routes', () => {
            const source = `
import grpc
from concurrent import futures
from interceptors import AuthInterceptor, MetricsInterceptor

server = grpc.server(
    futures.ThreadPoolExecutor(max_workers=10),
    interceptors=[AuthInterceptor(), MetricsInterceptor()]
)
user_pb2_grpc.add_UserServicer_to_server(UserServicer(), server)
`;
            const apis = detectFrameworkApis(source, 'src/server.py', 'python');
            const rpc = apis.find(a => a.method === 'GRPC' || a.method === 'RPC');
            expect(rpc?.meta?.middlewares).toEqual(expect.arrayContaining(['AuthInterceptor', 'MetricsInterceptor']));
        });
    });

    describe('Hono per-route middleware — UX-44', () => {
        it('UX-44: app.get(path, middleware, handler) extracts middleware via JS detector', async () => {
            const { detectApis } = await import('../apiDetector');
            const source = `
import { Hono } from 'hono';
import { jwt } from 'hono/jwt';

const app = new Hono();

app.get('/profile', jwt({ secret: 'x' }), async (c) => {
  return c.json({ ok: true });
});
`;
            const apis = detectApis(source, 'src/app.ts');
            const profile = apis.find(a => a.route === '/profile');
            expect(profile?.meta?.middlewares).toEqual(expect.arrayContaining(['jwt']));
        });

        it('UX-44: multiple varargs middlewares all land in meta.middlewares', async () => {
            const { detectApis } = await import('../apiDetector');
            const source = `
import { Hono } from 'hono';
const app = new Hono();

app.post('/upload', authRequired, validateBody, rateLimiter, async (c) => c.text('ok'));
`;
            const apis = detectApis(source, 'src/app.ts');
            const upload = apis.find(a => a.route === '/upload' && a.method === 'POST');
            expect(upload?.meta?.middlewares).toEqual(expect.arrayContaining(['authRequired', 'validateBody', 'rateLimiter']));
            // authRequired derives meta.auth
            expect(upload?.meta?.auth).toBe('required');
        });
    });

    describe('Rust middleware — UX-46', () => {
        it('UX-46: Actix App::new().wrap(Logger::default()).wrap(Auth) attaches to file routes', () => {
            const source = `
use actix_web::{App, HttpServer, web};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .wrap(Logger::default())
            .wrap(AuthMiddleware)
            .service(get_users)
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}

#[get("/users")]
async fn get_users() -> impl Responder { "ok" }
`;
            const apis = detectFrameworkApis(source, 'src/main.rs', 'rust');
            const users = apis.find(a => a.route === '/users' && a.method === 'GET');
            expect(users?.meta?.middlewares).toEqual(expect.arrayContaining(['Logger', 'AuthMiddleware']));
        });

        it('UX-46: Axum Router::new().route(...).layer(Layer::new()) attaches to file routes', () => {
            const source = `
use axum::{Router, routing::get};

async fn list() -> &'static str { "ok" }

fn app() -> Router {
    Router::new()
        .route("/items", get(list))
        .layer(TraceLayer::new_for_http())
        .layer(JwtAuthLayer::new())
}
`;
            const apis = detectFrameworkApis(source, 'src/api.rs', 'rust');
            const items = apis.find(a => a.route === '/items');
            expect(items?.meta?.middlewares).toEqual(expect.arrayContaining(['TraceLayer', 'JwtAuthLayer']));
            expect(items?.meta?.auth).toBe('required');
        });

        it('UX-46: Rocket rocket::build().attach(Fairing::new()) lands on file routes', () => {
            const source = `
#[macro_use] extern crate rocket;

#[get("/hello")]
fn hello() -> &'static str { "world" }

#[launch]
fn rocket() -> _ {
    rocket::build()
        .attach(LoggingFairing)
        .attach(AuthFairing::new())
        .mount("/api", routes![hello])
}
`;
            const apis = detectFrameworkApis(source, 'src/main.rs', 'rust');
            const hello = apis.find(a => a.route === '/hello' && a.method === 'GET');
            expect(hello?.meta?.middlewares).toEqual(expect.arrayContaining(['LoggingFairing', 'AuthFairing']));
        });

        it('UX-46: no middleware → empty/undefined middlewares', () => {
            const source = `
#[get("/plain")]
async fn plain() -> &'static str { "ok" }
`;
            const apis = detectFrameworkApis(source, 'src/lib.rs', 'rust');
            const plain = apis.find(a => a.route === '/plain');
            expect(plain?.meta?.middlewares ?? []).toEqual([]);
        });
    });

    describe('ASP.NET Core attributes — UX-45', () => {
        it('UX-45: [Authorize] above an action lands in meta.middlewares + auth=required', () => {
            const source = `
public class UsersController : ControllerBase {
    [Authorize]
    [HttpGet("/users")]
    public IActionResult List() => Ok();
}
`;
            const apis = detectFrameworkApis(source, 'Controllers/UsersController.cs', 'csharp');
            const list = apis.find(a => a.route === '/users' && a.method === 'GET');
            expect(list?.meta?.middlewares).toContain('Authorize');
            expect(list?.meta?.auth).toBe('required');
        });

        it('UX-45: [Authorize(Roles = "Admin")] lands with the role-qualified form', () => {
            const source = `
public class AdminController : ControllerBase {
    [Authorize(Roles = "Admin")]
    [HttpDelete("/admin/users/{id}")]
    public IActionResult Delete(int id) => NoContent();
}
`;
            const apis = detectFrameworkApis(source, 'Controllers/AdminController.cs', 'csharp');
            const del = apis.find(a => a.method === 'DELETE');
            expect(del?.meta?.middlewares?.some(m => /Authorize/.test(m))).toBe(true);
            expect(del?.meta?.auth).toBe('required');
        });

        it('UX-45: class-level [Authorize] propagates to every action', () => {
            const source = `
[Authorize]
public class SecureController : ControllerBase {
    [HttpGet("/secure/a")]
    public IActionResult A() => Ok();

    [HttpGet("/secure/b")]
    public IActionResult B() => Ok();
}
`;
            const apis = detectFrameworkApis(source, 'Controllers/SecureController.cs', 'csharp');
            const a = apis.find(x => x.route === '/secure/a');
            const b = apis.find(x => x.route === '/secure/b');
            expect(a?.meta?.middlewares).toContain('Authorize');
            expect(b?.meta?.middlewares).toContain('Authorize');
            expect(a?.meta?.auth).toBe('required');
            expect(b?.meta?.auth).toBe('required');
        });

        it('UX-45: [AllowAnonymous] on a method overrides class-level [Authorize]', () => {
            const source = `
[Authorize]
public class MixedController : ControllerBase {
    [AllowAnonymous]
    [HttpGet("/public")]
    public IActionResult Public() => Ok();

    [HttpGet("/private")]
    public IActionResult Private() => Ok();
}
`;
            const apis = detectFrameworkApis(source, 'Controllers/MixedController.cs', 'csharp');
            const pub = apis.find(a => a.route === '/public');
            const priv = apis.find(a => a.route === '/private');
            expect(pub?.meta?.middlewares).toContain('AllowAnonymous');
            expect(pub?.meta?.auth).toBe('optional');
            expect(priv?.meta?.auth).toBe('required');
        });
    });

    describe('Laravel middleware — UX-40', () => {
        it('UX-40: Route::middleware(["auth"])->get(...) lands as meta.middlewares', () => {
            const source = `
<?php
use Illuminate\\Support\\Facades\\Route;

Route::middleware(['auth', 'verified'])->get('/dashboard', [DashboardController::class, 'index']);
`;
            const apis = detectFrameworkApis(source, 'routes/web.php', 'php');
            const dash = apis.find(a => a.route === '/dashboard');
            expect(dash?.meta?.middlewares).toEqual(expect.arrayContaining(['auth', 'verified']));
            expect(dash?.meta?.auth).toBe('required');
        });

        it('UX-40: Route::middleware("api")->post(...) single-string form', () => {
            const source = `
<?php
Route::middleware('api')->post('/users', [UserController::class, 'store']);
`;
            const apis = detectFrameworkApis(source, 'routes/api.php', 'php');
            const route = apis.find(a => a.route === '/users');
            expect(route?.meta?.middlewares).toContain('api');
        });

        it('UX-40: Route::group([middleware => [...]]) propagates to every nested route', () => {
            const source = `
<?php
Route::group(['middleware' => ['auth', 'admin']], function () {
    Route::get('/admin/users', [UserController::class, 'index']);
    Route::get('/admin/settings', [SettingsController::class, 'show']);
});
`;
            const apis = detectFrameworkApis(source, 'routes/admin.php', 'php');
            const users = apis.find(a => a.route === '/admin/users');
            const settings = apis.find(a => a.route === '/admin/settings');
            expect(users?.meta?.middlewares).toEqual(expect.arrayContaining(['auth', 'admin']));
            expect(settings?.meta?.middlewares).toEqual(expect.arrayContaining(['auth', 'admin']));
            expect(users?.meta?.auth).toBe('required');
        });

        it('UX-40: Route::middleware does NOT pollute sibling routes outside the chain', () => {
            const source = `
<?php
Route::middleware(['auth'])->get('/private', [Ctrl::class, 'private']);
Route::get('/public', [Ctrl::class, 'public']);
`;
            const apis = detectFrameworkApis(source, 'routes/web.php', 'php');
            const priv = apis.find(a => a.route === '/private');
            const pub = apis.find(a => a.route === '/public');
            expect(priv?.meta?.middlewares).toContain('auth');
            expect(pub?.meta?.middlewares ?? []).not.toContain('auth');
        });
    });

    describe('Go Patterns (Gin/Echo)', () => {
        it('should detect Gin router patterns', () => {
            const source = `
                func main() {
                    r := gin.Default()
                    r.GET("/ping", func(c *gin.Context) {
                        c.JSON(200, gin.H{"message": "pong"})
                    })
                    
                    v1 := r.Group("/v1")
                    {
                        v1.POST("/login", loginEndpoint)
                    }
                }
            `;
            const apis = detectFrameworkApis(source, 'main.go', 'go');
            // After #357 the receiver allowlist (r/router/group/engine/g) was
            // dropped in favor of any-identifier matching with stdlib filtering,
            // so `v1.POST("/login")` is also detected.
            expect(apis).toHaveLength(2);
            expect(apis.find(a => a.method === 'GET')).toMatchObject({ method: 'GET', route: '/ping' });
            // Group prefix is composed: `v1 := r.Group("/v1")` + `v1.POST("/login")` → `/v1/login`.
            expect(apis.find(a => a.method === 'POST')).toMatchObject({ method: 'POST', route: '/v1/login' });
        });
    });

    describe('System Classification', () => {
        it('should correctly classify common modules by ecosystem', () => {
            expect(classifyExternalSystemMultiLang('mongoose', 'javascript')).toBe('database');
            expect(classifyExternalSystemMultiLang('redis', 'python')).toBe('cache');
            expect(classifyExternalSystemMultiLang('boto3', 'python')).toBe('storage');
            expect(classifyExternalSystemMultiLang('rabbitmq', 'java')).toBe('queue');
            expect(classifyExternalSystemMultiLang('axios', 'typescript')).toBe('service');
            expect(classifyExternalSystemMultiLang('reqwest', 'rust')).toBe('service');
            expect(classifyExternalSystemMultiLang('some_unknown_lib', 'go')).toBe('module');
        });
    });

    // UX-34 (2026-06-04) — NestJS sibling decorators (@UseGuards /
    // @UseInterceptors / @UsePipes / @UseFilters) sitting next to a
    // route decorator (@Get / @Post / …) declare the middleware chain
    // for that route. They were 100% invisible pre-UX-34. The
    // post-processing pass scans the source around each detected
    // NestJS route and back-fills `meta.middlewares`.
    describe('NestJS @UseGuards / @UseInterceptors / @UsePipes / @UseFilters — UX-34', () => {
        it('binds method-level @UseGuards arguments to the matching route', () => {
            const source = `
                @Controller('users')
                export class UsersController {
                    @Get()
                    @UseGuards(JwtAuthGuard)
                    findAll() {}

                    @Post()
                    create() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'users.controller.ts', 'typescript');
            const get = apis.find(a => a.method === 'GET');
            const post = apis.find(a => a.method === 'POST');
            expect(get?.meta?.middlewares).toContain('JwtAuthGuard');
            // @Post() has no guard → no middleware.
            expect(post?.meta?.middlewares ?? []).not.toContain('JwtAuthGuard');
        });

        it('binds method-level @UseInterceptors and @UsePipes', () => {
            const source = `
                @Controller('items')
                export class ItemsController {
                    @Post()
                    @UseInterceptors(LoggingInterceptor, CacheInterceptor)
                    @UsePipes(ValidationPipe)
                    create() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'items.controller.ts', 'typescript');
            const post = apis.find(a => a.method === 'POST');
            expect(post?.meta?.middlewares).toEqual(
                expect.arrayContaining(['LoggingInterceptor', 'CacheInterceptor', 'ValidationPipe']),
            );
        });

        it('binds @UseFilters for exception-filter middleware', () => {
            const source = `
                @Controller()
                export class ApiController {
                    @Get('/health')
                    @UseFilters(HttpExceptionFilter)
                    healthcheck() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'api.controller.ts', 'typescript');
            const get = apis.find(a => a.method === 'GET');
            expect(get?.meta?.middlewares).toContain('HttpExceptionFilter');
        });

        it('class-level @UseGuards propagates to every method in the class', () => {
            const source = `
                @Controller('articles')
                @UseGuards(JwtAuthGuard)
                export class ArticlesController {
                    @Get() findAll() {}
                    @Post() create() {}
                    @Delete(':id') remove() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'articles.controller.ts', 'typescript');
            const methods = apis.filter(a => ['GET', 'POST', 'DELETE'].includes(a.method));
            for (const api of methods) {
                expect(api.meta?.middlewares).toContain('JwtAuthGuard');
            }
        });

        it('class-level + method-level guards combine (class first, method appended)', () => {
            const source = `
                @Controller('admin')
                @UseGuards(JwtAuthGuard)
                export class AdminController {
                    @Get()
                    @UseGuards(AdminGuard)
                    list() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'admin.controller.ts', 'typescript');
            const get = apis.find(a => a.method === 'GET');
            expect(get?.meta?.middlewares).toEqual(['JwtAuthGuard', 'AdminGuard']);
        });

        it('sets meta.auth = "required" when a guard name looks like an auth guard', () => {
            const source = `
                @Controller('p')
                export class PrivateController {
                    @Get()
                    @UseGuards(JwtAuthGuard)
                    list() {}
                }
            `;
            const apis = detectFrameworkApis(source, 'p.controller.ts', 'typescript');
            const get = apis.find(a => a.method === 'GET');
            expect(get?.meta?.auth).toBe('required');
        });

        it('non-NestJS files are unaffected', () => {
            const source = `
                router.get('/users', (req, res) => res.json([]));
                // No NestJS decorators here.
            `;
            const apis = detectFrameworkApis(source, 'plain.ts', 'typescript');
            for (const api of apis) {
                expect(api.meta?.middlewares ?? []).not.toContain('JwtAuthGuard');
            }
        });
    });
});
