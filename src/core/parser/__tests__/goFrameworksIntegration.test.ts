/**
 * goFrameworksIntegration.test.ts
 *
 * Comprehensive integration tests for Go web framework detection in CodeAtlas.
 * Simulates real Go project patterns across all diagram layers:
 *   - API detection (Gin, Echo, Chi, Fiber, net/http)
 *   - Handler name extraction (Go backward scan: func receiver + func name)
 *   - System/infra classification (gorm, sqlx, pgx, database/sql, redis, kafka, nats, net/http)
 *   - File graph generation + diff coloring
 *   - Sequence graph generation from Go handlers
 *   - No false positives on non-route Go code
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis, classifyExternalSystemMultiLang } from '../frameworkDetector';
import { buildFileGraph } from '../../graph/fileGraphBuilder';
import { buildSequenceGraph } from '../../graph/sequenceGraphBuilder';

// ─── Fixtures: realistic Go project files ──────────────────────────────────

/** Gin REST API — cmd/api/main.go */
const GIN_MAIN_GO = `
package main

import (
    "net/http"
    "github.com/gin-gonic/gin"
    "myapp/internal/handler"
    "myapp/internal/middleware"
)

func main() {
    engine := gin.Default()
    engine.Use(middleware.Auth())

    engine.GET("/health", func(c *gin.Context) {
        c.JSON(http.StatusOK, gin.H{"status": "ok"})
    })

    v1 := engine.Group("/api/v1")
    {
        r := v1.Group("/todos")
        r.GET("/", handler.ListTodos)
        r.POST("/", handler.CreateTodo)
        r.GET("/:id", handler.GetTodo)
        r.PUT("/:id", handler.UpdateTodo)
        r.DELETE("/:id", handler.DeleteTodo)
        r.PATCH("/:id/complete", handler.CompleteTodo)
    }

    router := gin.New()
    router.GET("/ping", handler.Ping)
    router.POST("/webhook", handler.Webhook)

    g := engine.Group("/admin")
    g.GET("/stats", handler.AdminStats)
    g.DELETE("/cache", handler.ClearCache)

    engine.Run(":8080")
}
`;

/** Echo handler file — internal/handler/todo.go */
const ECHO_HANDLERS_GO = `
package handler

import (
    "net/http"
    "github.com/labstack/echo/v4"
    "myapp/internal/service"
)

func RegisterRoutes(e *echo.Echo) {
    e.GET("/health", HealthCheck)
    e.POST("/login", Login)

    group := e.Group("/api/v1/todos")
    group.GET("/", ListTodos)
    group.POST("/", CreateTodo)
    group.GET("/:id", GetTodo)
    group.PUT("/:id", UpdateTodo)
    group.DELETE("/:id", DeleteTodo)

    echo.GET("/echo-shorthand", EchoShorthand)
}

func HealthCheck(c echo.Context) error {
    return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}

func ListTodos(c echo.Context) error {
    todos := service.GetAll()
    return c.JSON(http.StatusOK, todos)
}
`;

/** Chi router — internal/router/router.go */
const CHI_ROUTER_GO = `
package router

import (
    "net/http"
    "github.com/go-chi/chi/v5"
    "myapp/internal/handler"
)

func NewRouter() http.Handler {
    r := chi.NewRouter()

    r.Get("/health", handler.HealthCheck)
    r.Post("/login", handler.Login)

    r.Route("/api/v1/todos", func(r chi.Router) {
        r.Get("/", handler.ListTodos)
        r.Post("/", handler.CreateTodo)
        r.Get("/{id}", handler.GetTodo)
        r.Put("/{id}", handler.UpdateTodo)
        r.Delete("/{id}", handler.DeleteTodo)
        r.Patch("/{id}/status", handler.UpdateStatus)
    })

    mux := chi.NewMux()
    mux.Get("/mux-health", handler.MuxHealth)
    mux.Post("/mux-submit", handler.MuxSubmit)

    router := chi.NewRouter()
    router.Get("/router-ping", handler.RouterPing)
    router.Delete("/router-cleanup", handler.RouterCleanup)

    return r
}
`;

/** Fiber application — main.go */
const FIBER_APP_GO = `
package main

import (
    "github.com/gofiber/fiber/v2"
    "myapp/internal/handler"
)

func main() {
    app := fiber.New()

    app.Get("/health", handler.Health)
    app.Post("/login", handler.Login)
    app.Get("/users", handler.ListUsers)
    app.Post("/users", handler.CreateUser)
    app.Put("/users/:id", handler.UpdateUser)
    app.Delete("/users/:id", handler.DeleteUser)
    app.Patch("/users/:id/avatar", handler.UploadAvatar)
    app.All("/proxy/*", handler.ProxyAll)

    api := app.Group("/api/v2")
    fiber.Get("/fiber-shorthand", handler.FiberShorthand)

    app.Listen(":3000")
}
`;

/** net/http standard library — internal/server/server.go */
const NET_HTTP_HANDLERS_GO = `
package server

import (
    "net/http"
    "myapp/internal/handler"
)

func SetupRoutes() {
    http.HandleFunc("/", handler.Home)
    http.HandleFunc("/health", handler.HealthCheck)
    http.HandleFunc("/api/todos", handler.TodoHandler)
    http.HandleFunc("/api/todos/", handler.TodoDetailHandler)
    http.HandleFunc("/api/users", handler.UserHandler)
    http.Handle("/static/", http.FileServer(http.Dir("./static")))
    http.Handle("/ws", handler.WebSocketHandler)
}
`;

/** Go repository layer using gorm — internal/repository/todo_repo.go */
const GO_REPOSITORY_GO = `
package repository

import (
    "context"
    "gorm.io/gorm"
    "myapp/internal/model"
)

type TodoRepository struct {
    db *gorm.DB
}

func NewTodoRepository(db *gorm.DB) *TodoRepository {
    return &TodoRepository{db: db}
}

func (r *TodoRepository) FindAll(ctx context.Context) ([]model.Todo, error) {
    var todos []model.Todo
    err := r.db.WithContext(ctx).Find(&todos).Error
    return todos, err
}

func (r *TodoRepository) Create(ctx context.Context, todo *model.Todo) error {
    return r.db.WithContext(ctx).Create(todo).Error
}

func (r *TodoRepository) FindByID(ctx context.Context, id uint) (*model.Todo, error) {
    var todo model.Todo
    err := r.db.WithContext(ctx).First(&todo, id).Error
    return &todo, err
}

func (r *TodoRepository) Delete(ctx context.Context, id uint) error {
    return r.db.WithContext(ctx).Delete(&model.Todo{}, id).Error
}
`;

/** Go service layer — internal/service/todo_service.go */
const GO_SERVICE_GO = `
package service

import (
    "context"
    "encoding/json"
    "github.com/go-redis/redis/v8"
    "github.com/segmentio/kafka-go"
    "myapp/internal/repository"
    "myapp/internal/model"
)

type TodoService struct {
    repo   *repository.TodoRepository
    cache  *redis.Client
    writer *kafka.Writer
}

func NewTodoService(repo *repository.TodoRepository, cache *redis.Client, writer *kafka.Writer) *TodoService {
    return &TodoService{repo: repo, cache: cache, writer: writer}
}

func (s *TodoService) GetAll(ctx context.Context) ([]model.Todo, error) {
    cached, err := s.cache.Get(ctx, "todos:all").Result()
    if err == nil {
        var todos []model.Todo
        json.Unmarshal([]byte(cached), &todos)
        return todos, nil
    }
    todos, err := s.repo.FindAll(ctx)
    if err != nil {
        return nil, err
    }
    data, _ := json.Marshal(todos)
    s.cache.Set(ctx, "todos:all", string(data), 300)
    return todos, nil
}

func (s *TodoService) Create(ctx context.Context, todo *model.Todo) error {
    err := s.repo.Create(ctx, todo)
    if err != nil {
        return err
    }
    s.cache.Del(ctx, "todos:all")
    msg := kafka.Message{Value: []byte(todo.Title)}
    s.writer.WriteMessages(ctx, msg)
    return nil
}
`;

/** Go model file — no routes (for false positive testing) */
const GO_MODEL_GO = `
package model

import "time"

type Todo struct {
    ID          uint
    Title       string
    Description string
    Completed   bool
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

type User struct {
    ID       uint
    Name     string
    Email    string
    Password string
}

func (t *Todo) MarkComplete() {
    t.Completed = true
}

func (u *User) FullName() string {
    return u.Name
}
`;

/** Go utility file — no routes (for false positive testing) */
const GO_UTILS_GO = `
package util

import (
    "crypto/rand"
    "encoding/hex"
    "fmt"
    "strings"
)

func GenerateID() string {
    bytes := make([]byte, 16)
    rand.Read(bytes)
    return hex.EncodeToString(bytes)
}

func SanitizeInput(input string) string {
    return strings.TrimSpace(input)
}

func FormatError(err error) string {
    return fmt.Sprintf("error: %v", err)
}
`;

/** Go config file — no routes (for false positive testing) */
const GO_CONFIG_GO = `
package config

import (
    "os"
    "strconv"
)

type Config struct {
    Port        int
    DatabaseURL string
    RedisURL    string
    KafkaBroker string
}

func Load() *Config {
    port, _ := strconv.Atoi(os.Getenv("PORT"))
    return &Config{
        Port:        port,
        DatabaseURL: os.Getenv("DATABASE_URL"),
        RedisURL:    os.Getenv("REDIS_URL"),
        KafkaBroker: os.Getenv("KAFKA_BROKER"),
    }
}
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Gin: Route detection', () => {
    it('detects engine.GET("/health", ...)', () => {
        const apis = detectFrameworkApis(GIN_MAIN_GO, 'cmd/api/main.go', 'go');
        const health = apis.find(a => a.route === '/health' && a.method === 'GET');
        expect(health).toBeDefined();
    });

    it('detects r.GET, r.POST, r.PUT, r.DELETE within a group', () => {
        const apis = detectFrameworkApis(GIN_MAIN_GO, 'cmd/api/main.go', 'go');
        const methods = ['GET', 'POST', 'PUT', 'DELETE'];
        for (const method of methods) {
            const match = apis.find(a => a.method === method);
            expect(match).toBeDefined();
        }
    });

    it('detects r.PATCH route prefixed by chained Group bindings', () => {
        // `r := v1.Group("/todos")` after `v1 := engine.Group("/api/v1")` → r prefix = /api/v1/todos.
        const apis = detectFrameworkApis(GIN_MAIN_GO, 'cmd/api/main.go', 'go');
        const patch = apis.find(a => a.method === 'PATCH' && a.route === '/api/v1/todos/:id/complete');
        expect(patch).toBeDefined();
    });

    it('detects router.GET and router.POST patterns', () => {
        const apis = detectFrameworkApis(GIN_MAIN_GO, 'cmd/api/main.go', 'go');
        const ping = apis.find(a => a.route === '/ping' && a.method === 'GET');
        const webhook = apis.find(a => a.route === '/webhook' && a.method === 'POST');
        expect(ping).toBeDefined();
        expect(webhook).toBeDefined();
    });

    it('detects g.GET and g.DELETE prefixed by parent Group binding', () => {
        // `g := engine.Group("/admin")` → g prefix = /admin.
        const apis = detectFrameworkApis(GIN_MAIN_GO, 'cmd/api/main.go', 'go');
        const stats = apis.find(a => a.route === '/admin/stats' && a.method === 'GET');
        const clearCache = apis.find(a => a.route === '/admin/cache' && a.method === 'DELETE');
        expect(stats).toBeDefined();
        expect(clearCache).toBeDefined();
    });

    it('all records reference the correct file path', () => {
        const apis = detectFrameworkApis(GIN_MAIN_GO, 'cmd/api/main.go', 'go');
        for (const api of apis) {
            expect(api.filePath).toBe('cmd/api/main.go');
        }
    });

    it('all records have valid ApiRecord structure', () => {
        const apis = detectFrameworkApis(GIN_MAIN_GO, 'cmd/api/main.go', 'go');
        for (const api of apis) {
            expect(api.apiId).toBeTruthy();
            expect(api.method).toBeTruthy();
            expect(api.route).toMatch(/^\//);
            expect(api.handlerName).toBeTruthy();
            expect(api.anchor).toBeDefined();
            expect(api.anchor.filePath).toBe('cmd/api/main.go');
        }
    });

    it('detects at least 11 routes from the Gin fixture', () => {
        const apis = detectFrameworkApis(GIN_MAIN_GO, 'cmd/api/main.go', 'go');
        expect(apis.length).toBeGreaterThanOrEqual(11);
    });
});

describe('Echo: Route detection', () => {
    it('detects e.GET("/health", ...)', () => {
        const apis = detectFrameworkApis(ECHO_HANDLERS_GO, 'internal/handler/todo.go', 'go');
        const health = apis.find(a => a.route === '/health' && a.method === 'GET');
        expect(health).toBeDefined();
    });

    it('detects e.POST("/login", ...)', () => {
        const apis = detectFrameworkApis(ECHO_HANDLERS_GO, 'internal/handler/todo.go', 'go');
        const login = apis.find(a => a.route === '/login' && a.method === 'POST');
        expect(login).toBeDefined();
    });

    it('detects group.GET, group.POST, group.PUT, group.DELETE prefixed by Group binding', () => {
        // `group := e.Group("/api/v1/todos")` → group prefix = /api/v1/todos.
        const apis = detectFrameworkApis(ECHO_HANDLERS_GO, 'internal/handler/todo.go', 'go');
        // combinePaths normalizes trailing slash: `/api/v1/todos` + `/` → `/api/v1/todos`.
        const groupList = apis.find(a => a.method === 'GET' && a.route === '/api/v1/todos');
        const groupGetById = apis.find(a => a.method === 'GET' && a.route === '/api/v1/todos/:id');
        const groupPost = apis.find(a => a.method === 'POST' && a.route === '/api/v1/todos');
        const groupPut = apis.find(a => a.method === 'PUT' && a.route === '/api/v1/todos/:id');
        const groupDelete = apis.find(a => a.method === 'DELETE' && a.route === '/api/v1/todos/:id');
        expect(groupList).toBeDefined();
        expect(groupGetById).toBeDefined();
        expect(groupPost).toBeDefined();
        expect(groupPut).toBeDefined();
        expect(groupDelete).toBeDefined();
    });

    it('detects echo.GET shorthand pattern', () => {
        const apis = detectFrameworkApis(ECHO_HANDLERS_GO, 'internal/handler/todo.go', 'go');
        const shorthand = apis.find(a => a.route === '/echo-shorthand' && a.method === 'GET');
        expect(shorthand).toBeDefined();
    });

    it('all records reference the correct file path', () => {
        const apis = detectFrameworkApis(ECHO_HANDLERS_GO, 'internal/handler/todo.go', 'go');
        for (const api of apis) {
            expect(api.filePath).toBe('internal/handler/todo.go');
        }
    });

    it('detects at least 8 routes from the Echo fixture', () => {
        const apis = detectFrameworkApis(ECHO_HANDLERS_GO, 'internal/handler/todo.go', 'go');
        expect(apis.length).toBeGreaterThanOrEqual(8);
    });
});

describe('Chi: Route detection', () => {
    it('detects r.Get("/health", ...)', () => {
        const apis = detectFrameworkApis(CHI_ROUTER_GO, 'internal/router/router.go', 'go');
        const health = apis.find(a => a.route === '/health' && a.method === 'GET');
        expect(health).toBeDefined();
    });

    it('detects r.Post("/login", ...)', () => {
        const apis = detectFrameworkApis(CHI_ROUTER_GO, 'internal/router/router.go', 'go');
        const login = apis.find(a => a.route === '/login' && a.method === 'POST');
        expect(login).toBeDefined();
    });

    it('#900 — r.Handle("/x", h) emits exactly ONE record with a bucketed ANY method (no double-match, no HANDLE)', () => {
        const src = `
package main
func routes(r chi.Router) {
    r.Handle("/webhook", webhookHandler)
    r.HandleFunc("/legacy", legacyHandler)
}
`;
        const apis = detectFrameworkApis(src, 'internal/router/handle.go', 'go');
        const webhook = apis.filter(a => a.route === '/webhook');
        expect(webhook).toHaveLength(1);              // not double-matched
        expect(webhook[0].method).toBe('ANY');        // bucketed, not the undocumented HANDLE
        const legacy = apis.filter(a => a.route === '/legacy');
        expect(legacy).toHaveLength(1);
        expect(legacy[0].method).toBe('ANY');
        // No record anywhere carries the old undocumented method.
        expect(apis.find(a => a.method === 'HANDLE')).toBeUndefined();
    });

    it('#928 — gorilla/mux concatenated route + .Methods() (Online Boutique frontend shape)', () => {
        // Real shape from GoogleCloudPlatform/microservices-demo frontend/main.go:
        // the route is `baseUrl + "/path"` (concatenation) and the verb comes from
        // a chained `.Methods(http.MethodGet, …)`.
        const src = `
package main
func main() {
    r := mux.NewRouter()
    r.HandleFunc(baseUrl+"/", svc.homeHandler).Methods(http.MethodGet, http.MethodHead)
    r.HandleFunc(baseUrl+"/product/{id}", svc.productHandler).Methods(http.MethodGet, http.MethodHead)
    r.HandleFunc(baseUrl+"/cart", svc.viewCartHandler).Methods(http.MethodGet, http.MethodHead)
    r.HandleFunc(baseUrl+"/cart", svc.addToCartHandler).Methods(http.MethodPost)
    r.HandleFunc(baseUrl+"/logout", svc.logoutHandler).Methods(http.MethodGet)
}
`;
        const apis = detectFrameworkApis(src, 'src/frontend/main.go', 'go');
        // The concatenated routes are now detected (previously missed entirely).
        expect(apis.find(a => a.route === '/product/{id}')).toBeDefined();
        expect(apis.find(a => a.route === '/logout' && a.method === 'GET')).toBeDefined();
        // .Methods() drives the real verb — POST add-to-cart vs GET view-cart on the
        // same `/cart` route are distinct records.
        const cartGet = apis.find(a => a.route === '/cart' && a.method === 'GET');
        const cartPost = apis.find(a => a.route === '/cart' && a.method === 'POST');
        expect(cartGet, 'GET /cart').toBeDefined();
        expect(cartPost, 'POST /cart').toBeDefined();
        // Multi-method .Methods(GET, HEAD) fans out both verbs.
        expect(apis.find(a => a.route === '/product/{id}' && a.method === 'GET')).toBeDefined();
        expect(apis.find(a => a.route === '/product/{id}' && a.method === 'HEAD')).toBeDefined();
        // No undocumented HANDLE method leaked.
        expect(apis.find(a => a.method === 'HANDLE')).toBeUndefined();
    });

    it('#928 — gorilla HandleFunc WITHOUT .Methods() falls back to ANY (verb-agnostic)', () => {
        const src = `
package main
func reg(r *mux.Router) {
    r.HandleFunc(prefix+"/webhook", webhookHandler)
}
`;
        const apis = detectFrameworkApis(src, 'src/svc/routes.go', 'go');
        const webhook = apis.filter(a => a.route === '/webhook');
        expect(webhook).toHaveLength(1);
        expect(webhook[0].method).toBe('ANY');
    });

    it('detects r.Get, r.Post, r.Put, r.Delete, r.Patch inside Route() subrouter', () => {
        const apis = detectFrameworkApis(CHI_ROUTER_GO, 'internal/router/router.go', 'go');
        const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
        for (const method of methods) {
            const match = apis.find(a => a.method === method);
            expect(match).toBeDefined();
        }
    });

    it('Issue 337: Chi r.Route(prefix, func(r) {…}) prepends prefix to inner routes', () => {
        // The fixture has `r.Route("/api/v1/todos", func(r chi.Router) { r.Get("/", …) })`.
        const apis = detectFrameworkApis(CHI_ROUTER_GO, 'internal/router/router.go', 'go');
        const subList = apis.find(a => a.method === 'GET' && a.route === '/api/v1/todos');
        const subById = apis.find(a => a.method === 'GET' && a.route === '/api/v1/todos/{id}');
        const subPatch = apis.find(a => a.method === 'PATCH' && a.route === '/api/v1/todos/{id}/status');
        expect(subList).toBeDefined();
        expect(subById).toBeDefined();
        expect(subPatch).toBeDefined();
    });

    it('detects mux.Get and mux.Post patterns', () => {
        const apis = detectFrameworkApis(CHI_ROUTER_GO, 'internal/router/router.go', 'go');
        const muxHealth = apis.find(a => a.route === '/mux-health' && a.method === 'GET');
        const muxSubmit = apis.find(a => a.route === '/mux-submit' && a.method === 'POST');
        expect(muxHealth).toBeDefined();
        expect(muxSubmit).toBeDefined();
    });

    it('detects router.Get and router.Delete patterns', () => {
        const apis = detectFrameworkApis(CHI_ROUTER_GO, 'internal/router/router.go', 'go');
        const routerPing = apis.find(a => a.route === '/router-ping' && a.method === 'GET');
        const routerCleanup = apis.find(a => a.route === '/router-cleanup' && a.method === 'DELETE');
        expect(routerPing).toBeDefined();
        expect(routerCleanup).toBeDefined();
    });

    it('detects at least 11 routes from the Chi fixture', () => {
        const apis = detectFrameworkApis(CHI_ROUTER_GO, 'internal/router/router.go', 'go');
        expect(apis.length).toBeGreaterThanOrEqual(11);
    });

    it('all records have valid ApiRecord structure', () => {
        const apis = detectFrameworkApis(CHI_ROUTER_GO, 'internal/router/router.go', 'go');
        for (const api of apis) {
            expect(api.apiId).toBeTruthy();
            expect(api.method).toBeTruthy();
            expect(api.route).toMatch(/^\//);
            expect(api.handlerName).toBeTruthy();
            expect(api.anchor).toBeDefined();
        }
    });
});

describe('Fiber: Route detection', () => {
    it('detects app.Get("/health", ...)', () => {
        const apis = detectFrameworkApis(FIBER_APP_GO, 'main.go', 'go');
        const health = apis.find(a => a.route === '/health' && a.method === 'GET');
        expect(health).toBeDefined();
    });

    it('detects app.Post("/login", ...)', () => {
        const apis = detectFrameworkApis(FIBER_APP_GO, 'main.go', 'go');
        const login = apis.find(a => a.route === '/login' && a.method === 'POST');
        expect(login).toBeDefined();
    });

    it('detects app.Put and app.Delete with path parameters', () => {
        const apis = detectFrameworkApis(FIBER_APP_GO, 'main.go', 'go');
        const put = apis.find(a => a.method === 'PUT' && a.route === '/users/:id');
        const del = apis.find(a => a.method === 'DELETE' && a.route === '/users/:id');
        expect(put).toBeDefined();
        expect(del).toBeDefined();
    });

    it('detects app.Patch for avatar upload', () => {
        const apis = detectFrameworkApis(FIBER_APP_GO, 'main.go', 'go');
        const patch = apis.find(a => a.method === 'PATCH' && a.route === '/users/:id/avatar');
        expect(patch).toBeDefined();
    });

    it('detects app.All wildcard route', () => {
        const apis = detectFrameworkApis(FIBER_APP_GO, 'main.go', 'go');
        const all = apis.find(a => a.method === 'ALL' && a.route === '/proxy/*');
        expect(all).toBeDefined();
    });

    it('detects fiber.Get shorthand pattern', () => {
        const apis = detectFrameworkApis(FIBER_APP_GO, 'main.go', 'go');
        const shorthand = apis.find(a => a.route === '/fiber-shorthand' && a.method === 'GET');
        expect(shorthand).toBeDefined();
    });

    it('detects at least 8 routes from the Fiber fixture', () => {
        const apis = detectFrameworkApis(FIBER_APP_GO, 'main.go', 'go');
        expect(apis.length).toBeGreaterThanOrEqual(8);
    });

    it('all records reference the correct file path', () => {
        const apis = detectFrameworkApis(FIBER_APP_GO, 'main.go', 'go');
        for (const api of apis) {
            expect(api.filePath).toBe('main.go');
        }
    });
});

describe('net/http: Route detection', () => {
    it('detects http.HandleFunc("/", ...)', () => {
        const apis = detectFrameworkApis(NET_HTTP_HANDLERS_GO, 'internal/server/server.go', 'go');
        const home = apis.find(a => a.route === '/' && a.method === 'GET');
        expect(home).toBeDefined();
    });

    it('detects http.HandleFunc("/health", ...)', () => {
        const apis = detectFrameworkApis(NET_HTTP_HANDLERS_GO, 'internal/server/server.go', 'go');
        const health = apis.find(a => a.route === '/health' && a.method === 'GET');
        expect(health).toBeDefined();
    });

    it('detects http.HandleFunc with API paths', () => {
        const apis = detectFrameworkApis(NET_HTTP_HANDLERS_GO, 'internal/server/server.go', 'go');
        const todos = apis.find(a => a.route === '/api/todos');
        const users = apis.find(a => a.route === '/api/users');
        expect(todos).toBeDefined();
        expect(users).toBeDefined();
    });

    it('detects http.Handle("/static/", ...)', () => {
        const apis = detectFrameworkApis(NET_HTTP_HANDLERS_GO, 'internal/server/server.go', 'go');
        const staticRoute = apis.find(a => a.route === '/static/');
        expect(staticRoute).toBeDefined();
    });

    it('detects http.Handle("/ws", ...)', () => {
        const apis = detectFrameworkApis(NET_HTTP_HANDLERS_GO, 'internal/server/server.go', 'go');
        const ws = apis.find(a => a.route === '/ws');
        expect(ws).toBeDefined();
    });

    it('http.HandleFunc and http.Handle both produce method GET', () => {
        const apis = detectFrameworkApis(NET_HTTP_HANDLERS_GO, 'internal/server/server.go', 'go');
        for (const api of apis) {
            expect(api.method).toBe('GET');
        }
    });

    it('detects at least 7 routes from the net/http fixture', () => {
        const apis = detectFrameworkApis(NET_HTTP_HANDLERS_GO, 'internal/server/server.go', 'go');
        expect(apis.length).toBeGreaterThanOrEqual(7);
    });

    it('all records reference the correct file path', () => {
        const apis = detectFrameworkApis(NET_HTTP_HANDLERS_GO, 'internal/server/server.go', 'go');
        for (const api of apis) {
            expect(api.filePath).toBe('internal/server/server.go');
        }
    });
});

describe('Go: System classification', () => {
    it('classifies gorm as database', () => {
        expect(classifyExternalSystemMultiLang('gorm', 'go')).toBe('database');
    });

    it('classifies sqlx as database', () => {
        expect(classifyExternalSystemMultiLang('sqlx', 'go')).toBe('database');
    });

    it('classifies pgx as database', () => {
        expect(classifyExternalSystemMultiLang('pgx', 'go')).toBe('database');
    });

    it('classifies database/sql as database', () => {
        expect(classifyExternalSystemMultiLang('database/sql', 'go')).toBe('database');
    });

    it('classifies redis as cache', () => {
        expect(classifyExternalSystemMultiLang('redis', 'go')).toBe('cache');
    });

    it('classifies go-redis/redis as cache', () => {
        expect(classifyExternalSystemMultiLang('go-redis/redis', 'go')).toBe('cache');
    });

    it('classifies kafka as queue', () => {
        expect(classifyExternalSystemMultiLang('kafka', 'go')).toBe('queue');
    });

    it('classifies nats as queue', () => {
        expect(classifyExternalSystemMultiLang('nats', 'go')).toBe('queue');
    });

    it('classifies net/http as service', () => {
        expect(classifyExternalSystemMultiLang('net/http', 'go')).toBe('service');
    });

    it('classifies grpc as service', () => {
        expect(classifyExternalSystemMultiLang('grpc', 'go')).toBe('service');
    });

    it('classifies unknown Go package as module', () => {
        expect(classifyExternalSystemMultiLang('myapp/internal/handler', 'go')).toBe('module');
    });

    it('classifies sqs as queue', () => {
        expect(classifyExternalSystemMultiLang('sqs', 'go')).toBe('queue');
    });

    it('classifies s3 as storage', () => {
        expect(classifyExternalSystemMultiLang('s3', 'go')).toBe('storage');
    });
});

describe('Go: File graph generation', () => {
    // buildFileGraph uses the JS Babel parser, so we write JS-equivalent Go-style
    // code to test graph shape and diff coloring.

    it('generates a valid file graph from a Go-style JS equivalent', () => {
        const jsEquivalent = `
const gorm = require('gorm');

function FindAll(ctx) {
    return gorm.Find(ctx);
}

function Create(ctx, todo) {
    return gorm.Create(ctx, todo);
}

function Delete(ctx, id) {
    return gorm.Delete(ctx, id);
}
`;
        const graph = buildFileGraph(jsEquivalent, 'internal/repository/todo_repo.go');
        expect(graph.type).toBe('file');
        expect(graph.graphId).toBe('file:internal/repository/todo_repo.go');
        expect(graph.nodes.some(n => n.type === 'import')).toBe(true);
    });

    it('includes function nodes for Go-style handlers', () => {
        const jsEquivalent = `
function ListTodos(req, res) {
    return res.json([]);
}

function CreateTodo(req, res) {
    return res.json({});
}

function GetTodo(req, res) {
    return res.json({});
}
`;
        const graph = buildFileGraph(jsEquivalent, 'internal/handler/todo.go');
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        expect(funcNodes.length).toBeGreaterThanOrEqual(3);
        expect(funcNodes.some(n => n.label === 'ListTodos')).toBe(true);
        expect(funcNodes.some(n => n.label === 'CreateTodo')).toBe(true);
        expect(funcNodes.some(n => n.label === 'GetTodo')).toBe(true);
    });

    it('diff: adding a new handler function shows as "added"', () => {
        const oldCode = `
function ListTodos(req, res) { return res.json([]); }
function GetTodo(req, res) { return res.json({}); }
`;
        const newCode = `
function ListTodos(req, res) { return res.json([]); }
function GetTodo(req, res) { return res.json({}); }
function CreateTodo(req, res) { return res.json({}); }
`;
        const graph = buildFileGraph(newCode, 'handler/todo.go', oldCode);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
        expect(addedNodes.some(n => n.label === 'CreateTodo')).toBe(true);
    });

    it('diff: modifying a handler function body shows as "modified"', () => {
        const oldCode = `
function ListTodos(req, res) {
    return res.json([]);
}
`;
        const newCode = `
function ListTodos(req, res) {
    const todos = [{ id: 1, title: "Test" }];
    return res.json(todos);
}
`;
        const graph = buildFileGraph(newCode, 'handler/todo.go', oldCode);
        const modified = graph.nodes.filter(n => n.diff === 'modified');
        expect(modified.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: deleting a handler function shows as "deleted"', () => {
        const oldCode = `
function ListTodos(req, res) { return res.json([]); }
function DeleteTodo(req, res) { return res.json({}); }
`;
        const newCode = `
function ListTodos(req, res) { return res.json([]); }
`;
        const graph = buildFileGraph(newCode, 'handler/todo.go', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
        expect(deletedNodes.some(n => n.label.includes('DeleteTodo'))).toBe(true);
    });

    it('diff: unchanged handler functions remain "unchanged"', () => {
        const code = `
function ListTodos(req, res) { return res.json([]); }
function GetTodo(req, res) { return res.json({}); }
`;
        const graph = buildFileGraph(code, 'handler/todo.go', code);
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        expect(funcNodes.every(n => n.diff === 'unchanged')).toBe(true);
    });
});

describe('Go: File graph diff — router scenarios', () => {
    const oldRouter = `
import express from 'express';
const router = express.Router();

function HealthCheck(req, res) {
    return res.json({ status: 'ok' });
}

function ListTodos(req, res) {
    return res.json([]);
}

router.get('/health', HealthCheck);
router.get('/todos', ListTodos);
`;

    it('adding a new route handler shows as "added"', () => {
        const newRouter = oldRouter + `
function CreateTodo(req, res) {
    return res.json({ created: true });
}
router.post('/todos', CreateTodo);
`;
        const graph = buildFileGraph(newRouter, 'router/router.go', oldRouter);
        const added = graph.nodes.filter(n => n.diff === 'added');
        expect(added.some(n => n.label === 'CreateTodo')).toBe(true);
    });

    it('modifying a route handler body shows as "modified"', () => {
        const newRouter = oldRouter.replace(
            "return res.json({ status: 'ok' });",
            "const uptime = process.uptime();\n    return res.json({ status: 'ok', uptime });"
        );
        const graph = buildFileGraph(newRouter, 'router/router.go', oldRouter);
        const modified = graph.nodes.filter(n => n.diff === 'modified');
        expect(modified.length).toBeGreaterThanOrEqual(1);
    });

    it('deleting a route handler shows as "deleted"', () => {
        const newRouter = `
import express from 'express';
const router = express.Router();

function HealthCheck(req, res) {
    return res.json({ status: 'ok' });
}

router.get('/health', HealthCheck);
`;
        const graph = buildFileGraph(newRouter, 'router/router.go', oldRouter);
        const deleted = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deleted.length).toBeGreaterThanOrEqual(1);
        expect(deleted.some(n => n.label.includes('ListTodos'))).toBe(true);
    });
});

describe('Go: Sequence graph generation', () => {
    // buildSequenceGraph uses the JS Babel parser, so we write JS-equivalent
    // Go-style code to test sequence diagram generation paths.

    const goStyleSequenceCode = `
const redis = require('go-redis');
const TodoRepo = require('./repository');

async function ListTodos(ctx, response) {
    const cached = await redis.Get(ctx, 'todos:all');
    if (cached) {
        return response.json(JSON.parse(cached));
    }
    const todos = await TodoRepo.FindAll(ctx);
    await redis.Set(ctx, 'todos:all', JSON.stringify(todos), 300);
    return response.json(todos);
}

module.exports = { ListTodos };
`;

    it('generates a sequence graph with correct type', () => {
        const graph = buildSequenceGraph(goStyleSequenceCode, 'internal/handler/todo.go');
        expect(graph.type).toBe('sequence');
    });

    it('generates a graphId using the file path', () => {
        const graph = buildSequenceGraph(goStyleSequenceCode, 'internal/handler/todo.go');
        expect(graph.graphId).toBe('sequence:internal/handler/todo.go');
    });

    it('has at least one participant node', () => {
        const graph = buildSequenceGraph(goStyleSequenceCode, 'internal/handler/todo.go');
        const participants = graph.nodes.filter(n => n.type === 'participant');
        expect(participants.length).toBeGreaterThanOrEqual(1);
    });

    it('has message edges representing function calls', () => {
        const graph = buildSequenceGraph(goStyleSequenceCode, 'internal/handler/todo.go');
        const messages = graph.edges.filter(e => e.edgeType === 'message');
        expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('detects redis participant from go-redis import', () => {
        const graph = buildSequenceGraph(goStyleSequenceCode, 'internal/handler/todo.go');
        const redisNode = graph.nodes.find(n =>
            n.label === 'redis' || n.subtitle?.includes('redis') || n.label?.toLowerCase().includes('redis')
        );
        expect(redisNode).toBeDefined();
    });

    it('detects repository participant from import', () => {
        const graph = buildSequenceGraph(goStyleSequenceCode, 'internal/handler/todo.go');
        const repoNode = graph.nodes.find(n =>
            n.label === 'TodoRepo' || n.label?.toLowerCase().includes('repo')
        );
        expect(repoNode).toBeDefined();
    });
});

describe('Go: Sequence graph diff', () => {
    it('diff: adding a cache interaction shows new participant as added', () => {
        const oldCode = `
const TodoRepo = require('./repository');

async function ListTodos(ctx, response) {
    const todos = await TodoRepo.FindAll(ctx);
    return response.json(todos);
}
`;
        const newCode = `
const TodoRepo = require('./repository');
const redis = require('go-redis');

async function ListTodos(ctx, response) {
    const cached = await redis.Get(ctx, 'todos:all');
    if (cached) return response.json(JSON.parse(cached));
    const todos = await TodoRepo.FindAll(ctx);
    redis.Set(ctx, 'todos:all', JSON.stringify(todos), 300);
    return response.json(todos);
}
`;
        const graph = buildSequenceGraph(newCode, 'internal/handler/todo.go', oldCode);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: removing a service dependency shows deleted participant', () => {
        const oldCode = `
const TodoRepo = require('./repository');
const redis = require('go-redis');
const kafka = require('kafka-go');

async function CreateTodo(ctx, response) {
    await TodoRepo.Create(ctx, {});
    await redis.Del(ctx, 'todos:all');
    await kafka.WriteMessages(ctx, {});
    return response.json({});
}
`;
        const newCode = `
const TodoRepo = require('./repository');
const redis = require('go-redis');

async function CreateTodo(ctx, response) {
    await TodoRepo.Create(ctx, {});
    await redis.Del(ctx, 'todos:all');
    return response.json({});
}
`;
        const graph = buildSequenceGraph(newCode, 'internal/handler/todo.go', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: unchanged code produces no added or deleted participants', () => {
        const code = `
const TodoRepo = require('./repository');

async function ListTodos(ctx, response) {
    const todos = await TodoRepo.FindAll(ctx);
    return response.json(todos);
}
`;
        const graph = buildSequenceGraph(code, 'internal/handler/todo.go', code);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(addedNodes.length).toBe(0);
        expect(deletedNodes.length).toBe(0);
    });
});

describe('Go: No false positives', () => {
    it('model file produces zero API records', () => {
        const apis = detectFrameworkApis(GO_MODEL_GO, 'internal/model/todo.go', 'go');
        expect(apis.length).toBe(0);
    });

    it('utility file produces zero API records', () => {
        const apis = detectFrameworkApis(GO_UTILS_GO, 'internal/util/util.go', 'go');
        expect(apis.length).toBe(0);
    });

    it('config file produces zero API records', () => {
        const apis = detectFrameworkApis(GO_CONFIG_GO, 'internal/config/config.go', 'go');
        expect(apis.length).toBe(0);
    });

    it('repository file produces zero API records', () => {
        const apis = detectFrameworkApis(GO_REPOSITORY_GO, 'internal/repository/todo_repo.go', 'go');
        expect(apis.length).toBe(0);
    });

    it('service file produces zero API records', () => {
        const apis = detectFrameworkApis(GO_SERVICE_GO, 'internal/service/todo_service.go', 'go');
        expect(apis.length).toBe(0);
    });

    it('empty file produces zero API records', () => {
        const apis = detectFrameworkApis('', 'empty.go', 'go');
        expect(apis.length).toBe(0);
    });

    it('Go struct definition with Get method name does not trigger route detection', () => {
        const source = `
package model

type Cache struct {
    data map[string]string
}

func (c *Cache) Get(key string) string {
    return c.data[key]
}

func (c *Cache) Set(key string, value string) {
    c.data[key] = value
}
`;
        const apis = detectFrameworkApis(source, 'internal/cache/cache.go', 'go');
        // c.Get should NOT trigger chi pattern (c is not r|mux|router)
        // c.Set should NOT trigger any pattern
        expect(apis.length).toBe(0);
    });

    it('Go test file with http.Get does not create false positive routes', () => {
        const source = `
package handler_test

import (
    "net/http"
    "testing"
)

func TestHealthEndpoint(t *testing.T) {
    resp, err := http.Get("http://localhost:8080/health")
    if err != nil {
        t.Fatal(err)
    }
    defer resp.Body.Close()
}
`;
        // http.Get is not http.Handle or http.HandleFunc, so no match expected
        const apis = detectFrameworkApis(source, 'internal/handler/todo_test.go', 'go');
        const handleFuncRoutes = apis.filter(a => a.route.startsWith('http://'));
        expect(handleFuncRoutes.length).toBe(0);
    });
});

describe('Go: Handler name extraction', () => {
    it('extracts handler from function defined before Gin route call', () => {
        const source = `
func SetupRouter() {
    r := gin.Default()
    r.GET("/health", HealthCheck)
}
`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        const health = apis.find(a => a.route === '/health');
        expect(health).toBeDefined();
        // handlerName should be found via backward/forward scan
        expect(health!.handlerName).toBeTruthy();
    });

    it('extracts handler name from inline Gin route registration', () => {
        const source = `
func main() {
    engine := gin.Default()
    engine.POST("/submit", ProcessSubmission)
    engine.DELETE("/cleanup", CleanupHandler)
}
`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        expect(apis.length).toBeGreaterThanOrEqual(2);
        for (const api of apis) {
            expect(api.handlerName).toBeTruthy();
            expect(api.handlerName).not.toBe('handler');
        }
    });

    it('extracts handler name from Chi mux pattern', () => {
        const source = `
func NewMux() *chi.Mux {
    mux := chi.NewMux()
    mux.Get("/status", StatusHandler)
    mux.Post("/events", EventHandler)
    return mux
}
`;
        const apis = detectFrameworkApis(source, 'router.go', 'go');
        expect(apis.length).toBe(2);
        const names = apis.map(a => a.handlerName);
        // backward scan should find NewMux or forward scan should find the handler argument
        for (const name of names) {
            expect(name).toBeTruthy();
            expect(name).not.toBe('');
        }
    });

    it('extracts handler from net/http.HandleFunc pattern', () => {
        const source = `
func SetupRoutes() {
    http.HandleFunc("/api/data", DataHandler)
    http.HandleFunc("/api/status", StatusHandler)
}
`;
        const apis = detectFrameworkApis(source, 'server.go', 'go');
        expect(apis.length).toBe(2);
        for (const api of apis) {
            expect(api.handlerName).toBeTruthy();
        }
    });

    it('handler name defaults to non-empty string even for anonymous handlers', () => {
        const source = `
func main() {
    r.GET("/anon", func(c *gin.Context) {
        c.JSON(200, gin.H{})
    })
}
`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        const anon = apis.find(a => a.route === '/anon');
        expect(anon).toBeDefined();
        expect(anon!.handlerName).toBeTruthy();
    });
});

describe('Go: Mixed framework detection in same file', () => {
    it('detects routes from multiple Go frameworks in one file', () => {
        const source = `
package main

import (
    "net/http"
    "github.com/gin-gonic/gin"
)

func main() {
    // Gin routes
    r := gin.Default()
    r.GET("/gin-route", GinHandler)

    // Standard library routes
    http.HandleFunc("/stdlib-route", StdLibHandler)
}
`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        const ginRoute = apis.find(a => a.route === '/gin-route');
        const stdlibRoute = apis.find(a => a.route === '/stdlib-route');
        expect(ginRoute).toBeDefined();
        expect(stdlibRoute).toBeDefined();
    });

    it('correctly counts total routes across frameworks', () => {
        const source = `
func setup() {
    r := gin.Default()
    r.GET("/a", HandlerA)
    r.POST("/b", HandlerB)
    http.HandleFunc("/c", HandlerC)
    http.HandleFunc("/d", HandlerD)
    app.Get("/e", HandlerE)
}
`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        expect(apis.length).toBeGreaterThanOrEqual(5);
    });
});

describe('Go: Edge cases in route patterns', () => {
    it('detects route with trailing slash', () => {
        const source = `r.GET("/api/v1/todos/", ListTodos)`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        expect(apis.find(a => a.route === '/api/v1/todos/')).toBeDefined();
    });

    it('detects route with nested path parameters', () => {
        const source = `r.GET("/users/:userId/posts/:postId", GetUserPost)`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        expect(apis.find(a => a.route === '/users/:userId/posts/:postId')).toBeDefined();
    });

    it('detects HEAD and OPTIONS methods from Gin patterns', () => {
        const source = `
r.HEAD("/ping", PingHead)
r.OPTIONS("/cors", CorsHandler)
`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        const head = apis.find(a => a.method === 'HEAD');
        const options = apis.find(a => a.method === 'OPTIONS');
        expect(head).toBeDefined();
        expect(options).toBeDefined();
    });

    it('detects Gin Any and Handle methods (#900 — Handle buckets to ANY, not HANDLE)', () => {
        const source = `
r.Any("/wildcard", WildcardHandler)
r.Handle("/custom", CustomHandler)
`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        // Both the wildcard `Any` and the catch-all `Handle` map to the documented ANY bucket.
        expect(apis.find(a => a.method === 'ANY' && a.route === '/wildcard')).toBeDefined();
        const custom = apis.filter(a => a.route === '/custom');
        expect(custom).toHaveLength(1);                 // #900 — no double-match
        expect(custom[0].method).toBe('ANY');
        expect(apis.find(a => a.method === 'HANDLE')).toBeUndefined();  // undocumented method gone
    });

    it('detects Echo HEAD and OPTIONS methods', () => {
        const source = `
e.HEAD("/ping", PingHandler)
e.OPTIONS("/cors", CorsHandler)
`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        const head = apis.find(a => a.method === 'HEAD');
        const options = apis.find(a => a.method === 'OPTIONS');
        expect(head).toBeDefined();
        expect(options).toBeDefined();
    });

    it('detects Chi Head and Options methods', () => {
        const source = `
r.Head("/ping", PingHandler)
r.Options("/cors", CorsHandler)
`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        const head = apis.find(a => a.method === 'HEAD');
        const options = apis.find(a => a.method === 'OPTIONS');
        expect(head).toBeDefined();
        expect(options).toBeDefined();
    });

    it('detects Fiber Head and Options methods', () => {
        const source = `
app.Head("/ping", PingHandler)
app.Options("/cors", CorsHandler)
`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        const head = apis.find(a => a.method === 'HEAD');
        const options = apis.find(a => a.method === 'OPTIONS');
        expect(head).toBeDefined();
        expect(options).toBeDefined();
    });
});
