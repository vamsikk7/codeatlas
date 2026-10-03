/**
 * workspaceRouterTracker.test.ts
 *
 * Coverage for the cross-file router tracker (Issue #357). Each test wires
 * up two synthetic Go or Kotlin source files where a router-receiving
 * function in file B is invoked from file A with a prefixed group, and
 * asserts the tracker emits the prefix-composed routes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceRouterTracker } from '../workspaceRouterTracker';

describe('WorkspaceRouterTracker — Go', () => {
    let tracker: WorkspaceRouterTracker;
    beforeEach(() => { tracker = new WorkspaceRouterTracker(); });

    it('two-file gin pattern: register fn called with v1.Group("/users")', () => {
        const main = `
package main
import "github.com/gin-gonic/gin"
import "users"
func main() {
    r := gin.Default()
    v1 := r.Group("/api")
    users.UsersRegister(v1.Group("/users"))
}`;
        const usersPkg = `
package users
import "github.com/gin-gonic/gin"
func UsersRegister(router *gin.RouterGroup) {
    router.GET("/", listUsers)
    router.POST("/", createUser)
    router.GET("/:id", getUser)
}`;
        tracker.scanDecls('main.go', main, 'go');
        tracker.scanDecls('users/users.go', usersPkg, 'go');
        tracker.scanCalls('main.go', main, 'go');
        tracker.scanCalls('users/users.go', usersPkg, 'go');

        const routes = tracker.resolvedRoutes().map(r => `${r.method} ${r.path}`).sort();
        expect(routes).toEqual([
            'GET /api/users/',
            'GET /api/users/:id',
            'POST /api/users/',
        ]);
    });

    it('two-file fiber pattern: SetupRoutes(app) with internal sub-groups', () => {
        const main = `
package main
import "github.com/gofiber/fiber/v3"
import "router"
func main() {
    app := fiber.New()
    router.SetupRoutes(app)
}`;
        const routerPkg = `
package router
import "github.com/gofiber/fiber/v3"
func SetupRoutes(app *fiber.App) {
    api := app.Group("/api")
    api.Get("/health", healthHandler)
    auth := api.Group("/auth")
    auth.Post("/login", loginHandler)
    auth.Post("/logout", logoutHandler)
}`;
        tracker.scanDecls('main.go', main, 'go');
        tracker.scanDecls('router/router.go', routerPkg, 'go');
        tracker.scanCalls('main.go', main, 'go');
        tracker.scanCalls('router/router.go', routerPkg, 'go');

        const routes = tracker.resolvedRoutes().map(r => `${r.method} ${r.path}`).sort();
        expect(routes).toEqual([
            'GET /api/health',
            'POST /api/auth/login',
            'POST /api/auth/logout',
        ]);
    });

    it('rescan replaces prior decls/calls for the file', () => {
        const v1 = `
package users
import "github.com/gin-gonic/gin"
func UsersRegister(r *gin.RouterGroup) { r.GET("/old", oldHandler) }`;
        const v2 = `
package users
import "github.com/gin-gonic/gin"
func UsersRegister(r *gin.RouterGroup) { r.GET("/new", newHandler) }`;
        tracker.scanDecls('users.go', v1, 'go');
        tracker.scanDecls('users.go', v2, 'go');
        // Add a call site so resolvedRoutes emits.
        const main = `
package main
import "users"
func main() {
    r := gin.Default()
    v1 := r.Group("/api")
    users.UsersRegister(v1)
}`;
        tracker.scanDecls('main.go', main, 'go');
        tracker.scanCalls('main.go', main, 'go');
        tracker.scanCalls('users.go', v2, 'go');
        const paths = tracker.resolvedRoutes().map(r => r.path);
        expect(paths).toContain('/api/new');
        expect(paths).not.toContain('/api/old');
    });

    it('root-app variable resolves to empty prefix', () => {
        const main = `
package main
import "github.com/gofiber/fiber/v3"
import "router"
func main() {
    app := fiber.New()
    router.MountAll(app)
}`;
        const routerPkg = `
package router
import "github.com/gofiber/fiber/v3"
func MountAll(app *fiber.App) {
    app.Get("/health", healthHandler)
}`;
        tracker.scanDecls('main.go', main, 'go');
        tracker.scanDecls('router.go', routerPkg, 'go');
        tracker.scanCalls('main.go', main, 'go');
        tracker.scanCalls('router.go', routerPkg, 'go');
        const routes = tracker.resolvedRoutes().map(r => `${r.method} ${r.path}`);
        expect(routes).toContain('GET /health');
    });

    it('skips function-call sites whose name does not match a tracked decl', () => {
        const main = `
package main
import "github.com/gin-gonic/gin"
func main() {
    r := gin.Default()
    v1 := r.Group("/api")
    fmt.Println(v1)        // should not be misread as a router call
    log.Printf("got %v", v1)
}`;
        tracker.scanDecls('main.go', main, 'go');
        tracker.scanCalls('main.go', main, 'go');
        expect(tracker.resolvedRoutes()).toHaveLength(0);
    });
});

describe('WorkspaceRouterTracker — Kotlin/Ktor', () => {
    let tracker: WorkspaceRouterTracker;
    beforeEach(() => { tracker = new WorkspaceRouterTracker(); });

    it('extension function on Routing called from routing { } block', () => {
        const app = `
fun Application.module() {
    routing {
        userRoutes()
        articleRoutes()
    }
}`;
        const userRoutes = `
fun Routing.userRoutes() {
    route("/users") {
        get("/{id}") { /* ... */ }
        post { /* ... */ }
    }
}`;
        const articleRoutes = `
fun Routing.articleRoutes() {
    route("/articles") {
        get("/recent") { /* ... */ }
    }
}`;
        tracker.scanDecls('App.kt', app, 'kotlin');
        tracker.scanDecls('UserRoutes.kt', userRoutes, 'kotlin');
        tracker.scanDecls('ArticleRoutes.kt', articleRoutes, 'kotlin');
        tracker.scanCalls('App.kt', app, 'kotlin');
        tracker.scanCalls('UserRoutes.kt', userRoutes, 'kotlin');
        tracker.scanCalls('ArticleRoutes.kt', articleRoutes, 'kotlin');

        const routes = tracker.resolvedRoutes().map(r => `${r.method} ${r.path}`).sort();
        expect(routes).toContain('GET /users/{id}');
        expect(routes).toContain('POST /users');
        expect(routes).toContain('GET /articles/recent');
    });

    it('extension on Route also resolves', () => {
        const app = `
fun Application.module() {
    routing {
        adminRoutes()
    }
}`;
        const adminRoutes = `
fun Route.adminRoutes() {
    route("/admin") {
        get("/dashboard") { /* ... */ }
    }
}`;
        tracker.scanDecls('App.kt', app, 'kotlin');
        tracker.scanDecls('AdminRoutes.kt', adminRoutes, 'kotlin');
        tracker.scanCalls('App.kt', app, 'kotlin');
        tracker.scanCalls('AdminRoutes.kt', adminRoutes, 'kotlin');
        const routes = tracker.resolvedRoutes().map(r => `${r.method} ${r.path}`);
        expect(routes).toContain('GET /admin/dashboard');
    });

    it('built-in DSL calls (route/get/post/install) are not tracked as user functions', () => {
        const app = `
fun Application.module() {
    routing {
        install(Authentication)
        route("/api") {
            get("/items") { /* ... */ }
        }
    }
}`;
        tracker.scanDecls('App.kt', app, 'kotlin');
        tracker.scanCalls('App.kt', app, 'kotlin');
        // No decls for `install`/`route`/`get` should be created — they're built-ins.
        expect(tracker.declsForFunction('install')).toHaveLength(0);
        expect(tracker.declsForFunction('route')).toHaveLength(0);
        expect(tracker.declsForFunction('get')).toHaveLength(0);
    });
});

describe('WorkspaceRouterTracker — lifecycle', () => {
    it('clear() wipes all decls and calls', () => {
        const tracker = new WorkspaceRouterTracker();
        const src = `
package users
import "github.com/gin-gonic/gin"
func UsersRegister(r *gin.RouterGroup) { r.GET("/x", h) }`;
        tracker.scanDecls('users.go', src, 'go');
        expect(tracker.declCount).toBeGreaterThan(0);
        tracker.clear();
        expect(tracker.declCount).toBe(0);
        expect(tracker.callCount).toBe(0);
    });
});
