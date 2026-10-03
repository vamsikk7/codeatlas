/**
 * issue354Regression.test.ts
 *
 * Regression tests for Issue 354 — body-finder gap closure.
 *
 * Each test pins one of the seven categorical fixes so that future
 * detector / extractor changes can't silently re-introduce the gap.
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';
import { findAnonymousRouteBody } from '../anonRouteFinder';

describe('Issue 354 regressions', () => {
    describe('Kotlin: JAX-RS @GET label false positives', () => {
        it('does NOT match `return@get` as a JAX-RS @GET annotation', () => {
            const code = `
                fun Route.dynamic() {
                    get("/items/{id}") {
                        val id = call.parameters["id"] ?: return@get
                        call.respondText(id)
                    }
                }
            `;
            const apis = detectFrameworkApis(code, 'app.kt', 'kotlin');
            // Must detect /items/{id} via Ktor pattern, must NOT emit a
            // phantom GET / from `return@get` matching JAX-RS @GET.
            expect(apis.some(a => a.method === 'GET' && a.route === '/items/{id}')).toBe(true);
            expect(apis.some(a => a.method === 'GET' && a.route === '/')).toBe(false);
        });

        it('does NOT match `break@post`, `this@delete`, `super@put`', () => {
            const code = `
                fun Route.x() {
                    post("/x") { break@post; this@delete; super@put }
                }
            `;
            const apis = detectFrameworkApis(code, 'app.kt', 'kotlin');
            // Only the real `post("/x")` route — no phantom POST/DELETE/PUT on `/`.
            expect(apis.filter(a => a.route === '/').length).toBe(0);
        });
    });

    describe('Kotlin: HTTP client filter', () => {
        it('rejects `client.get("/x")` as a server route', () => {
            const code = `
                import io.ktor.client.*
                import io.ktor.client.request.*
                suspend fun fetch(client: HttpClient) {
                    client.get("/captured-headers")
                    client.post("/data")
                }
            `;
            const apis = detectFrameworkApis(code, 'Requests.kt', 'kotlin');
            // No server routes — file imports io.ktor.client without
            // io.ktor.server.routing markers.
            expect(apis.length).toBe(0);
        });

        it('still detects bare `get("/x")` inside Ktor server routing', () => {
            const code = `
                import io.ktor.server.routing.*
                fun Route.api() {
                    routing {
                        get("/users") {
                            call.respondText("ok")
                        }
                    }
                }
            `;
            const apis = detectFrameworkApis(code, 'app.kt', 'kotlin');
            expect(apis.some(a => a.method === 'GET' && a.route === '/users')).toBe(true);
        });

        it('rejects `someObject.get("/x")` (dot-prefixed receiver)', () => {
            const code = `
                fun load() {
                    val key = jwkProvider.get("6f8856ed-9189-488f-9011-0ff4b6c08edc")
                }
            `;
            const apis = detectFrameworkApis(code, 'auth.kt', 'kotlin');
            // jwkProvider.get(...) is a Map-like accessor, not a route.
            expect(apis.length).toBe(0);
        });
    });

    describe('Kotlin: string-template route literal body lookup', () => {
        it('resolves body when route arg contains $variable interpolation', async () => {
            const code = `
                fun Route.listing() {
                    val pathParameterName = "x"
                    get("{$pathParameterName...}") {
                        call.respondText("hello")
                    }
                }
            `;
            // Detector emits route as the literal source between quotes.
            const apis = detectFrameworkApis(code, 'app.kt', 'kotlin');
            const api = apis.find(a => a.method === 'GET');
            expect(api).toBeDefined();
            // Body lookup must succeed despite the string-template chunks
            // in tree-sitter's view of the literal.
            const m = api!.handlerName.match(/^anonymous@([A-Z]+):(.+)$/);
            expect(m).not.toBeNull();
            const body = await findAnonymousRouteBody(code, 'kotlin', m![1], m![2]);
            expect(body).not.toBeNull();
        });
    });

    describe('Rust actix Shape 2: receiver-walk + closure-body wrapping', () => {
        it('resolves direct `web::resource("/x").to(<closure>)`', async () => {
            const code = `
                use actix_web::{web, HttpRequest, HttpResponse, Method};
                fn config() {
                    web::resource("/test").to(|req: HttpRequest| match *req.method() {
                        Method::GET => HttpResponse::Ok(),
                        _ => HttpResponse::NotFound(),
                    });
                }
            `;
            const apis = detectFrameworkApis(code, 'main.rs', 'rust');
            const api = apis.find(a => a.handlerName?.startsWith('anonymous@'));
            expect(api).toBeDefined();
            const body = await findAnonymousRouteBody(code, 'rust', 'GET', '/test');
            expect(body).not.toBeNull();
        });

        it('resolves `web::resource("/").route(web::get().to(<async closure>))`', async () => {
            const code = `
                use actix_web::{web, HttpRequest, HttpResponse};
                fn config() {
                    web::resource("/").route(web::get().to(|req: HttpRequest| async move {
                        HttpResponse::Ok().body("hi")
                    }));
                }
            `;
            const body = await findAnonymousRouteBody(code, 'rust', 'GET', '/');
            expect(body).not.toBeNull();
        });
    });

    describe('Rust same-line decorator+fn', () => {
        it('captures `index` as handler for `#[get("/")] fn index()`', () => {
            // Mimics rust-rocket testbench/sni_resolver pattern.
            const code = `
                fn outer() {
                    let server = spawn! {
                        #[get("/")] fn index() { }
                    };
                }
            `;
            const apis = detectFrameworkApis(code, 'sni.rs', 'rust');
            const api = apis.find(a => a.method === 'GET' && a.route === '/');
            expect(api).toBeDefined();
            // Should NOT be anonymous@ — the inline scan recovers `index`.
            expect(api!.handlerName).toBe('index');
        });
    });

    describe('Go: forward-look named handler arg', () => {
        it('captures named handler when long file pushes `func main` past backward window', () => {
            // Build a file where main() opens far above the route call.
            const filler = 'val := 1\n'.repeat(200);
            const code = `
                package main
                import "github.com/gofiber/fiber/v3"
                func main() {
                    app := fiber.New()
                    ${filler}
                    app.Get("/salaanthe", salanthe)
                    app.Get("/hello", hello)
                }
                func salanthe(c fiber.Ctx) error { return nil }
                func hello(c fiber.Ctx) error { return nil }
            `;
            const apis = detectFrameworkApis(code, 'main.go', 'go');
            const sal = apis.find(a => a.route === '/salaanthe');
            const hel = apis.find(a => a.route === '/hello');
            expect(sal?.handlerName).toBe('salanthe');
            expect(hel?.handlerName).toBe('hello');
        });

        it('still emits anonymous@ for inline closure handler', () => {
            const code = `
                package main
                func main() {
                    app.Get("/x", func(c fiber.Ctx) error {
                        return c.SendString("ok")
                    })
                }
            `;
            const apis = detectFrameworkApis(code, 'main.go', 'go');
            const api = apis.find(a => a.route === '/x');
            expect(api?.handlerName).toBe('anonymous@GET:/x');
        });
    });

    describe('Go Chi: HandleFunc / Handle verb support', () => {
        it('detects `r.HandleFunc("/x", pkg.Index)` and captures `Index`', () => {
            const code = `
                package middleware
                func Profiler() http.Handler {
                    r := chi.NewRouter()
                    r.HandleFunc("/pprof/*", pprof.Index)
                    r.HandleFunc("/pprof/cmdline", pprof.Cmdline)
                    return r
                }
            `;
            const apis = detectFrameworkApis(code, 'profiler.go', 'go');
            const a = apis.find(api => api.route === '/pprof/*');
            const b = apis.find(api => api.route === '/pprof/cmdline');
            expect(a?.handlerName).toBe('Index');
            expect(b?.handlerName).toBe('Cmdline');
        });
    });
});
