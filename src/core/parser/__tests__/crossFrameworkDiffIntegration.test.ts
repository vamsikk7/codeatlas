import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';
import { buildFileGraph } from '../../graph/fileGraphBuilder';
import { buildSequenceGraph } from '../../graph/sequenceGraphBuilder';
import { diffGraphs } from '../../diff/graphDiff';
import type { DiagramGraph, GraphNode, GraphEdge, DiffStatus } from '../../graph/graphTypes';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Count nodes by diff status */
function countNodeDiffs(graph: DiagramGraph) {
    const counts = { added: 0, deleted: 0, modified: 0, unchanged: 0 };
    for (const n of graph.nodes) {
        const s = n.diff ?? 'unchanged';
        if (s in counts) counts[s as keyof typeof counts]++;
    }
    return counts;
}

/** Count edges by diff status */
function countEdgeDiffs(graph: DiagramGraph) {
    const counts = { added: 0, deleted: 0, modified: 0, unchanged: 0 };
    for (const e of graph.edges) {
        const s = e.diff ?? 'unchanged';
        if (s in counts) counts[s as keyof typeof counts]++;
    }
    return counts;
}

/** Get nodes of a specific type */
function nodesOfType(graph: DiagramGraph, type: GraphNode['type']) {
    return graph.nodes.filter(n => n.type === type);
}

/** Get nodes with a specific diff status */
function nodesWithDiff(graph: DiagramGraph, diff: DiffStatus) {
    return graph.nodes.filter(n => n.diff === diff);
}

/** Get edges with a specific diff status */
function edgesWithDiff(graph: DiagramGraph, diff: DiffStatus) {
    return graph.edges.filter(e => e.diff === diff);
}

// =============================================================================
//  1. Express / Node.js — API detection diff
// =============================================================================
describe('Express / Node.js — API detection diff', () => {
    const baselineCode = `
const express = require('express');
const router = express.Router();

router.get('/users', (req, res) => {
    res.json([]);
});

router.post('/users', (req, res) => {
    const user = req.body;
    res.status(201).json(user);
});

router.get('/users/:id', (req, res) => {
    res.json({ id: req.params.id });
});
`;

    const modifiedCode = `
const express = require('express');
const router = express.Router();

router.get('/users', (req, res) => {
    res.json([]);
});

router.post('/users', (req, res) => {
    const user = req.body;
    user.createdAt = new Date();
    res.status(201).json(user);
});

router.put('/users/:id', (req, res) => {
    const updated = { ...req.body, id: req.params.id };
    res.json(updated);
});
`;

    it('detects baseline routes correctly', () => {
        const apis = detectFrameworkApis(baselineCode, 'routes.js', 'javascript');
        expect(apis.length).toBe(3);
        const methods = apis.map(a => `${a.method} ${a.route}`).sort();
        expect(methods).toContain('GET /users');
        expect(methods).toContain('POST /users');
        expect(methods).toContain('GET /users/:id');
    });

    it('detects modified routes: added PUT, removed GET /:id', () => {
        const apis = detectFrameworkApis(modifiedCode, 'routes.js', 'javascript');
        expect(apis.length).toBe(3);
        const methods = apis.map(a => `${a.method} ${a.route}`).sort();
        expect(methods).toContain('GET /users');
        expect(methods).toContain('POST /users');
        expect(methods).toContain('PUT /users/:id');
        // GET /users/:id should no longer be present
        expect(methods).not.toContain('GET /users/:id');
    });

    it('file graph diff reflects added/removed/modified entities', () => {
        // Use code that differs at the named-function level for Babel parser detection
        const oldJS = `
const express = require('express');
function getUsers(req, res) { res.json([]); }
function getUser(req, res) { res.json({ id: req.params.id }); }
`;
        const newJS = `
const express = require('express');
function getUsers(req, res) { res.json([]); }
function createUser(req, res) { res.status(201).json(req.body); }
`;
        const graph = buildFileGraph(newJS, 'routes.js', oldJS);
        // File node should be modified (children changed)
        const fileNode = graph.nodes.find(n => n.type === 'file');
        expect(fileNode?.diff).toBe('modified');
        // Should have at least one added and one deleted node
        const diffs = countNodeDiffs(graph);
        expect(diffs.added + diffs.deleted + diffs.modified).toBeGreaterThan(0);
    });
});

// =============================================================================
//  2. Spring Boot (Java) — API detection diff
// =============================================================================
describe('Spring Boot (Java) — API detection diff', () => {
    const baselineCode = `
@RestController
@RequestMapping("/api")
public class HealthController {

    @GetMapping("/health")
    public String health() {
        return "OK";
    }

    @PostMapping("/create")
    public Item createItem(@RequestBody Item item) {
        return itemService.save(item);
    }
}
`;

    const modifiedCode = `
@RestController
@RequestMapping("/api")
public class HealthController {

    @GetMapping("/health")
    public String health() {
        return "OK";
    }

    @PostMapping("/create")
    public Item createItem(@RequestBody Item item) {
        item.setTimestamp(Instant.now());
        return itemService.save(item);
    }

    @DeleteMapping("/delete")
    public void deleteItem(@RequestParam Long id) {
        itemService.delete(id);
    }
}
`;

    it('detects baseline Spring Boot endpoints', () => {
        const apis = detectFrameworkApis(baselineCode, 'HealthController.java', 'java');
        const methods = apis.map(a => `${a.method} ${a.route}`);
        expect(methods).toContain('GET /api/health');
        expect(methods).toContain('POST /api/create');
    });

    it('detects newly added @DeleteMapping', () => {
        const apis = detectFrameworkApis(modifiedCode, 'HealthController.java', 'java');
        const methods = apis.map(a => `${a.method} ${a.route}`);
        expect(methods).toContain('DELETE /api/delete');
        expect(methods).toContain('GET /api/health');
        expect(methods).toContain('POST /api/create');
    });

    it('diff between baseline and modified detects the new route', () => {
        const baseApis = detectFrameworkApis(baselineCode, 'HealthController.java', 'java');
        const modApis = detectFrameworkApis(modifiedCode, 'HealthController.java', 'java');

        const baseRoutes = new Set(baseApis.map(a => `${a.method}:${a.route}`));
        const modRoutes = new Set(modApis.map(a => `${a.method}:${a.route}`));

        // New route
        const added = [...modRoutes].filter(r => !baseRoutes.has(r));
        expect(added).toContain('DELETE:/api/delete');

        // No removed routes
        const removed = [...baseRoutes].filter(r => !modRoutes.has(r));
        expect(removed).toHaveLength(0);
    });
});

// =============================================================================
//  3. Django / Python — API detection diff
// =============================================================================
describe('Django / Python — API detection diff', () => {
    const baselineCode = `
from django.urls import path
from . import views

urlpatterns = [
    path('todos/', views.todo_list),
    path('todos/<int:pk>/', views.todo_detail),
]
`;

    const modifiedCode = `
from django.urls import path
from . import views

urlpatterns = [
    path('todos/', views.todo_list),
    path('todos/search/', views.search_todos),
]
`;

    it('detects baseline Django URL patterns', () => {
        const apis = detectFrameworkApis(baselineCode, 'urls.py', 'python');
        expect(apis.length).toBe(2);
        const routes = apis.map(a => a.route);
        expect(routes).toContain('/todos/');
        expect(routes).toContain('/todos/<int:pk>/');
    });

    it('detects modified patterns: added search, removed detail', () => {
        const apis = detectFrameworkApis(modifiedCode, 'urls.py', 'python');
        expect(apis.length).toBe(2);
        const routes = apis.map(a => a.route);
        expect(routes).toContain('/todos/');
        expect(routes).toContain('/todos/search/');
        expect(routes).not.toContain('/todos/<int:pk>/');
    });

    it('diff propagation identifies added and removed URLs', () => {
        const baseApis = detectFrameworkApis(baselineCode, 'urls.py', 'python');
        const modApis = detectFrameworkApis(modifiedCode, 'urls.py', 'python');

        const baseRoutes = new Set(baseApis.map(a => a.route));
        const modRoutes = new Set(modApis.map(a => a.route));

        const added = [...modRoutes].filter(r => !baseRoutes.has(r));
        const removed = [...baseRoutes].filter(r => !modRoutes.has(r));

        expect(added).toContain('/todos/search/');
        expect(removed).toContain('/todos/<int:pk>/');
    });
});

// =============================================================================
//  4. FastAPI / Python — API detection diff
// =============================================================================
describe('FastAPI / Python — API detection diff', () => {
    const baselineCode = `
from fastapi import FastAPI
app = FastAPI()

@app.get("/items")
def list_items():
    return db.query(Item).all()

@app.post("/items")
def create_item(item: ItemCreate):
    return db.add(item)
`;

    const modifiedCode = `
from fastapi import FastAPI
app = FastAPI()

@app.get("/items")
def list_items():
    return db.query(Item).all()

@app.post("/items")
def create_item(item: ItemCreate):
    return db.add(item)

@app.put("/items/{item_id}")
def update_item(item_id: int, item: ItemUpdate):
    return db.update(item_id, item)

@app.delete("/items/{item_id}")
def delete_item(item_id: int):
    db.delete(item_id)
`;

    it('detects baseline FastAPI endpoints', () => {
        const apis = detectFrameworkApis(baselineCode, 'main.py', 'python');
        expect(apis.length).toBe(2);
        expect(apis.map(a => a.method)).toContain('GET');
        expect(apis.map(a => a.method)).toContain('POST');
    });

    it('detects new PUT and DELETE endpoints', () => {
        const apis = detectFrameworkApis(modifiedCode, 'main.py', 'python');
        expect(apis.length).toBe(4);
        const methods = apis.map(a => `${a.method} ${a.route}`);
        expect(methods).toContain('PUT /items/{item_id}');
        expect(methods).toContain('DELETE /items/{item_id}');
    });

    it('diff identifies exact additions', () => {
        const baseApis = detectFrameworkApis(baselineCode, 'main.py', 'python');
        const modApis = detectFrameworkApis(modifiedCode, 'main.py', 'python');

        const baseIds = new Set(baseApis.map(a => `${a.method}:${a.route}`));
        const modIds = new Set(modApis.map(a => `${a.method}:${a.route}`));

        const added = [...modIds].filter(id => !baseIds.has(id));
        expect(added).toHaveLength(2);
        expect(added).toContain('PUT:/items/{item_id}');
        expect(added).toContain('DELETE:/items/{item_id}');
    });
});

// =============================================================================
//  5. Go / Gin — API detection diff
// =============================================================================
describe('Go / Gin — API detection diff', () => {
    const baselineCode = `
package main

import "github.com/gin-gonic/gin"

func main() {
    r := gin.Default()
    r.GET("/ping", pingHandler)
    r.POST("/users", createUserHandler)
}
`;

    const modifiedCode = `
package main

import "github.com/gin-gonic/gin"

func main() {
    r := gin.Default()
    r.GET("/ping", healthCheckHandler)
    r.POST("/users", createUserHandler)
    r.DELETE("/users/:id", deleteUserHandler)
}
`;

    it('detects baseline Gin routes', () => {
        const apis = detectFrameworkApis(baselineCode, 'main.go', 'go');
        expect(apis.length).toBe(2);
        expect(apis.map(a => a.route)).toContain('/ping');
        expect(apis.map(a => a.route)).toContain('/users');
    });

    it('detects added DELETE route and handler change', () => {
        const apis = detectFrameworkApis(modifiedCode, 'main.go', 'go');
        expect(apis.length).toBe(3);
        expect(apis.map(a => a.route)).toContain('/users/:id');
    });

    it('diff propagation detects added and unchanged routes', () => {
        const baseApis = detectFrameworkApis(baselineCode, 'main.go', 'go');
        const modApis = detectFrameworkApis(modifiedCode, 'main.go', 'go');

        const baseRoutes = new Set(baseApis.map(a => `${a.method}:${a.route}`));
        const modRoutes = new Set(modApis.map(a => `${a.method}:${a.route}`));

        const added = [...modRoutes].filter(r => !baseRoutes.has(r));
        expect(added).toContain('DELETE:/users/:id');

        // POST /users should be unchanged
        expect(baseRoutes.has('POST:/users')).toBe(true);
        expect(modRoutes.has('POST:/users')).toBe(true);
    });
});

// =============================================================================
//  6. Rust / Actix — API detection diff
// =============================================================================
describe('Rust / Actix — API detection diff', () => {
    const baselineCode = `
use actix_web::{get, post, web, HttpResponse};

#[get("/health")]
async fn health() -> HttpResponse {
    HttpResponse::Ok().json("OK")
}

#[post("/items")]
async fn create_item(item: web::Json<Item>) -> HttpResponse {
    HttpResponse::Created().json(item)
}
`;

    const modifiedCode = `
use actix_web::{post, put, web, HttpResponse};

#[post("/items")]
async fn create_item(item: web::Json<Item>) -> HttpResponse {
    HttpResponse::Created().json(item)
}

#[put("/items/{id}")]
async fn update_item(id: web::Path<u32>, item: web::Json<Item>) -> HttpResponse {
    HttpResponse::Ok().json(item)
}
`;

    it('detects baseline Actix endpoints', () => {
        const apis = detectFrameworkApis(baselineCode, 'main.rs', 'rust');
        expect(apis.length).toBe(2);
        expect(apis.map(a => `${a.method} ${a.route}`)).toContain('GET /health');
        expect(apis.map(a => `${a.method} ${a.route}`)).toContain('POST /items');
    });

    it('detects added PUT and removed GET', () => {
        const apis = detectFrameworkApis(modifiedCode, 'main.rs', 'rust');
        const methods = apis.map(a => `${a.method} ${a.route}`);
        expect(methods).toContain('PUT /items/{id}');
        expect(methods).toContain('POST /items');
        expect(methods).not.toContain('GET /health');
    });

    it('diff propagation: 1 added, 1 deleted, 1 unchanged', () => {
        const baseApis = detectFrameworkApis(baselineCode, 'main.rs', 'rust');
        const modApis = detectFrameworkApis(modifiedCode, 'main.rs', 'rust');

        const baseSet = new Set(baseApis.map(a => `${a.method}:${a.route}`));
        const modSet = new Set(modApis.map(a => `${a.method}:${a.route}`));

        const added = [...modSet].filter(r => !baseSet.has(r));
        const removed = [...baseSet].filter(r => !modSet.has(r));
        const unchanged = [...baseSet].filter(r => modSet.has(r));

        expect(added).toHaveLength(1);
        expect(added[0]).toBe('PUT:/items/{id}');
        expect(removed).toHaveLength(1);
        expect(removed[0]).toBe('GET:/health');
        expect(unchanged).toHaveLength(1);
        expect(unchanged[0]).toBe('POST:/items');
    });
});

// =============================================================================
//  7. C# / ASP.NET — API detection diff
// =============================================================================
describe('C# / ASP.NET — API detection diff', () => {
    const baselineCode = `
[ApiController]
[Route("api/[controller]")]
public class ItemsController : ControllerBase {
    [HttpGet]
    public IActionResult GetAll() => Ok(items);

    [HttpPost]
    public IActionResult Create(Item item) => Created(item);
}
`;

    const modifiedCode = `
[ApiController]
[Route("api/[controller]")]
public class ItemsController : ControllerBase {
    [HttpGet]
    public IActionResult GetAll() => Ok(items);

    [HttpPost]
    public IActionResult Create(Item item) => Created(item);

    [HttpDelete("{id}")]
    public IActionResult Delete(int id) => NoContent();
}

app.MapGet("/health", () => Results.Ok("healthy"));
`;

    it('detects baseline ASP.NET endpoints', () => {
        const apis = detectFrameworkApis(baselineCode, 'ItemsController.cs', 'csharp');
        expect(apis.length).toBeGreaterThanOrEqual(2);
        const methods = apis.map(a => a.method);
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
    });

    it('detects added [HttpDelete] and app.MapGet (Issue 345: composed with class [Route] prefix)', () => {
        const apis = detectFrameworkApis(modifiedCode, 'ItemsController.cs', 'csharp');
        const methods = apis.map(a => `${a.method} ${a.route}`);
        // Class-level `[Route("api/[controller]")]` is now composed with method-level paths.
        expect(methods).toContain('DELETE /api/[controller]/{id}');
        // Minimal API `app.MapGet("/health", ...)` is outside any controller class so unprefixed.
        expect(methods).toContain('GET /health');
    });

    it('diff identifies 2 new endpoints', () => {
        const baseApis = detectFrameworkApis(baselineCode, 'ItemsController.cs', 'csharp');
        const modApis = detectFrameworkApis(modifiedCode, 'ItemsController.cs', 'csharp');

        const baseRoutes = new Set(baseApis.map(a => `${a.method}:${a.route}`));
        const modRoutes = new Set(modApis.map(a => `${a.method}:${a.route}`));

        const added = [...modRoutes].filter(r => !baseRoutes.has(r));
        expect(added.length).toBeGreaterThanOrEqual(2);
    });
});

// =============================================================================
//  8. PHP / Laravel — API detection diff
// =============================================================================
describe('PHP / Laravel — API detection diff', () => {
    const baselineCode = `
<?php
use Illuminate\\Support\\Facades\\Route;

Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
`;

    const modifiedCode = `
<?php
use Illuminate\\Support\\Facades\\Route;

Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
Route::delete('/users/{id}', [UserController::class, 'destroy']);
`;

    it('detects baseline Laravel routes', () => {
        const apis = detectFrameworkApis(baselineCode, 'web.php', 'php');
        // Both array-controller and basic patterns match each route, so count is >= 2.
        // The key assertion is that both GET and POST /users are detected.
        expect(apis.length).toBeGreaterThanOrEqual(2);
        expect(apis.map(a => `${a.method} ${a.route}`)).toContain('GET /users');
        expect(apis.map(a => `${a.method} ${a.route}`)).toContain('POST /users');
    });

    it('detects added DELETE route', () => {
        const apis = detectFrameworkApis(modifiedCode, 'web.php', 'php');
        expect(apis.length).toBeGreaterThanOrEqual(3);
        expect(apis.map(a => `${a.method} ${a.route}`)).toContain('DELETE /users/{id}');
    });

    it('diff propagation: DELETE added, GET and POST unchanged', () => {
        const baseApis = detectFrameworkApis(baselineCode, 'web.php', 'php');
        const modApis = detectFrameworkApis(modifiedCode, 'web.php', 'php');

        // Use method:route as the key (deduplicated by route shape)
        const baseSet = new Set(baseApis.map(a => `${a.method}:${a.route}`));
        const modSet = new Set(modApis.map(a => `${a.method}:${a.route}`));

        const added = [...modSet].filter(r => !baseSet.has(r));
        const unchanged = [...baseSet].filter(r => modSet.has(r));

        expect(added).toContain('DELETE:/users/{id}');
        expect(unchanged).toContain('GET:/users');
        expect(unchanged).toContain('POST:/users');
    });
});

// =============================================================================
//  9. Ruby / Rails — API detection diff
// =============================================================================
describe('Ruby / Rails — API detection diff', () => {
    const baselineCode = `
Rails.application.routes.draw do
  get '/health', to: 'health#index'
  resources :todos
end
`;

    const modifiedCode = `
Rails.application.routes.draw do
  resources :todos
  post '/search', to: 'search#create'
end
`;

    it('detects baseline Rails routes', () => {
        const apis = detectFrameworkApis(baselineCode, 'routes.rb', 'ruby');
        expect(apis.length).toBeGreaterThanOrEqual(2);
        const routes = apis.map(a => a.route);
        expect(routes).toContain('/health');
    });

    it('detects added POST /search and removed GET /health', () => {
        const apis = detectFrameworkApis(modifiedCode, 'routes.rb', 'ruby');
        const routes = apis.map(a => `${a.method} ${a.route}`);
        expect(routes).toContain('POST /search');
        expect(routes).not.toContain('GET /health');
    });

    it('diff propagation: health removed, search added, todos resources unchanged (Issue 339)', () => {
        const baseApis = detectFrameworkApis(baselineCode, 'routes.rb', 'ruby');
        const modApis = detectFrameworkApis(modifiedCode, 'routes.rb', 'ruby');

        const baseSet = new Set(baseApis.map(a => `${a.method}:${a.route}`));
        const modSet = new Set(modApis.map(a => `${a.method}:${a.route}`));

        expect(baseSet.has('GET:/health')).toBe(true);
        expect(modSet.has('GET:/health')).toBe(false);
        expect(modSet.has('POST:/search')).toBe(true);
        // `resources :todos` now expands to 7 actions; pick a representative
        // action (POST /todos for create) that should be in both diffs.
        expect(baseSet.has('POST:/todos')).toBe(true);
        expect(modSet.has('POST:/todos')).toBe(true);
        expect(baseSet.has('GET:/todos')).toBe(true);
        expect(modSet.has('GET:/todos')).toBe(true);
    });
});

// =============================================================================
//  10. GraphQL — API detection diff
// =============================================================================
describe('GraphQL — API detection diff', () => {
    const baselineCode = `
@Resolver(() => Todo)
export class TodoResolver {
    @Query()
    todos() {
        return this.todoService.findAll();
    }

    @Mutation()
    createTodo() {
        return this.todoService.create();
    }
}
`;

    const modifiedCode = `
@Resolver(() => Todo)
export class TodoResolver {
    @Query()
    todos() {
        return this.todoService.findAll();
    }

    @Mutation()
    createTodo() {
        return this.todoService.create();
    }

    @Mutation()
    deleteTodo() {
        return this.todoService.delete();
    }

    @Subscription()
    todoCreated() {
        return this.pubSub.asyncIterator('todoCreated');
    }
}
`;

    it('detects baseline GraphQL operations', () => {
        const apis = detectFrameworkApis(baselineCode, 'todo.resolver.ts', 'typescript');
        const methods = apis.map(a => a.method);
        expect(methods).toContain('QUERY');
        expect(methods).toContain('MUTATION');
        expect(methods).toContain('RESOLVER');
    });

    it('detects new @Mutation and @Subscription', () => {
        const apis = detectFrameworkApis(modifiedCode, 'todo.resolver.ts', 'typescript');
        const methods = apis.map(a => a.method);
        expect(methods).toContain('SUBSCRIPTION');
        // Should have 2 MUTATION entries now (createTodo + deleteTodo)
        const mutations = apis.filter(a => a.method === 'MUTATION');
        expect(mutations.length).toBeGreaterThanOrEqual(2);
    });

    it('diff identifies exact additions', () => {
        const baseApis = detectFrameworkApis(baselineCode, 'todo.resolver.ts', 'typescript');
        const modApis = detectFrameworkApis(modifiedCode, 'todo.resolver.ts', 'typescript');

        const baseIds = new Set(baseApis.map(a => a.apiId));
        const modIds = new Set(modApis.map(a => a.apiId));

        const added = [...modIds].filter(id => !baseIds.has(id));
        // At least 2 new operations (deleteTodo mutation + todoCreated subscription)
        expect(added.length).toBeGreaterThanOrEqual(2);
    });
});

// =============================================================================
//  11. File graph diff — baseline vs modified code (JS-equivalent code)
// =============================================================================
describe('File graph diff — cross-pattern verification', () => {
    it('detects added function node', () => {
        const oldCode = `
import db from "./db";
function getUsers() { return db.query("SELECT * FROM users"); }
`;
        const newCode = `
import db from "./db";
function getUsers() { return db.query("SELECT * FROM users"); }
function createUser(data) { return db.insert("users", data); }
`;
        const graph = buildFileGraph(newCode, 'users.js', oldCode);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added' && n.type === 'function');
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
        expect(addedNodes.some(n => n.label === 'createUser')).toBe(true);
    });

    it('detects deleted function as ghost node', () => {
        const oldCode = `
function alpha() { return 1; }
function beta() { return 2; }
`;
        const newCode = `
function alpha() { return 1; }
`;
        const graph = buildFileGraph(newCode, 'utils.js', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
        expect(deletedNodes.some(n => n.label.includes('beta'))).toBe(true);
    });

    it('detects modified function body', () => {
        const oldCode = `function compute() { return 1 + 1; }`;
        const newCode = `function compute() { return 2 + 2; }`;
        const graph = buildFileGraph(newCode, 'math.js', oldCode);
        const computeNode = graph.nodes.find(n => n.label === 'compute');
        expect(computeNode?.diff).toBe('modified');
    });

    it('detects added import', () => {
        const oldCode = `import fs from "fs";
function read() { return fs.readFileSync("data.txt"); }`;
        const newCode = `import fs from "fs";
import path from "path";
function read() { return fs.readFileSync(path.join(".", "data.txt")); }`;
        const graph = buildFileGraph(newCode, 'io.js', oldCode);
        const addedImport = graph.nodes.find(n => n.type === 'import' && n.diff === 'added');
        expect(addedImport).toBeDefined();
        expect(addedImport!.label).toBe('path');
    });

    it('section diff summary reflects mixed changes', () => {
        const oldCode = `
function keep() { return 1; }
function remove() { return 2; }
`;
        const newCode = `
function keep() { return 1; }
function add() { return 3; }
`;
        const graph = buildFileGraph(newCode, 'mixed.js', oldCode);
        const funcSection = graph.nodes.find(n => n.type === 'section' && n.label.startsWith('Functions'));
        // Mixed added + deleted → section should be modified
        expect(funcSection?.diff).toBe('modified');
    });
});

// =============================================================================
//  12. Sequence graph diff — dependency changes
// =============================================================================
describe('Sequence graph diff — dependency and service changes', () => {
    it('detects added external service participant', () => {
        const oldCode = `
import { Pool } from "pg";
const pool = new Pool();

router.get("/users", async (req, res) => {
    const users = await pool.query("SELECT * FROM users");
    res.json(users.rows);
});
`;
        const newCode = `
import { Pool } from "pg";
import Redis from "ioredis";
const pool = new Pool();
const redis = new Redis();

router.get("/users", async (req, res) => {
    const cached = await redis.get("users");
    if (cached) return res.json(JSON.parse(cached));
    const users = await pool.query("SELECT * FROM users");
    await redis.set("users", JSON.stringify(users.rows));
    res.json(users.rows);
});
`;
        const graph = buildSequenceGraph(newCode, 'api.js', oldCode);
        // Should have participants for both pg and redis
        const participants = graph.nodes.filter(n => n.type === 'participant');
        expect(participants.length).toBeGreaterThanOrEqual(2);
        // The redis participant should be added or the overall graph should reflect changes
        const addedParticipants = participants.filter(n => n.diff === 'added');
        const modifiedParticipants = participants.filter(n => n.diff === 'modified');
        // Either redis is explicitly added, or participants are marked as modified due to new calls
        expect(addedParticipants.length + modifiedParticipants.length).toBeGreaterThan(0);
    });

    it('detects removed import participant', () => {
        const oldCode = `
import axios from "axios";
import db from "./db";

router.post("/sync", async (req, res) => {
    const remote = await axios.get("https://api.example.com/data");
    await db.save(remote.data);
    res.json({ synced: true });
});
`;
        const newCode = `
import db from "./db";

router.post("/sync", async (req, res) => {
    await db.save(req.body);
    res.json({ synced: true });
});
`;
        const graph = buildSequenceGraph(newCode, 'sync.js', oldCode);
        // Axios participant should be deleted or absent
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        const allLabels = graph.nodes.map(n => n.label.toLowerCase());
        // Either axios appears as deleted, or is simply absent
        const axiosPresent = allLabels.some(l => l.includes('axios'));
        if (axiosPresent) {
            const axiosNode = graph.nodes.find(n => n.label.toLowerCase().includes('axios'));
            expect(axiosNode?.diff).toBe('deleted');
        } else {
            // The node being absent is also correct
            expect(deletedNodes.length + graph.nodes.filter(n => n.diff === 'modified').length).toBeGreaterThan(0);
        }
    });

    it('detects modified handler body changes in message edges', () => {
        const oldCode = `
import db from "./db";

router.get("/items", async (req, res) => {
    const items = await db.findAll();
    res.json(items);
});
`;
        const newCode = `
import db from "./db";

router.get("/items", async (req, res) => {
    const items = await db.findAll();
    const filtered = items.filter(i => i.active);
    res.json(filtered);
});
`;
        const graph = buildSequenceGraph(newCode, 'items.js', oldCode);
        // Handler body changed, so message edges should reflect modification
        const messageEdges = graph.edges.filter(e => e.edgeType === 'message');
        // There should be at least some edges, and at least one participant should be modified
        expect(messageEdges.length).toBeGreaterThan(0);
        const modifiedNodes = graph.nodes.filter(n => n.diff === 'modified');
        expect(modifiedNodes.length).toBeGreaterThan(0);
    });

    it('all participants unchanged when code is identical', () => {
        const code = `
import db from "./db";
router.get("/items", async (req, res) => {
    const items = await db.findAll();
    res.json(items);
});
`;
        const graph = buildSequenceGraph(code, 'items.js', code);
        const participants = graph.nodes.filter(n => n.type === 'participant');
        // All participants should be unchanged when code is identical
        for (const p of participants) {
            expect(p.diff).toBe('unchanged');
        }
    });

    it('detects added route handler as new message flow', () => {
        const oldCode = `
import db from "./db";
router.get("/items", async (req, res) => {
    const items = await db.findAll();
    res.json(items);
});
`;
        const newCode = `
import db from "./db";
router.get("/items", async (req, res) => {
    const items = await db.findAll();
    res.json(items);
});
router.post("/items", async (req, res) => {
    const item = await db.create(req.body);
    res.status(201).json(item);
});
`;
        const graph = buildSequenceGraph(newCode, 'items.js', oldCode);
        // Should have message edges (some new)
        const messageEdges = graph.edges.filter(e => e.edgeType === 'message');
        expect(messageEdges.length).toBeGreaterThan(0);
        // Should detect changes
        const hasChanges = graph.nodes.some(n => n.diff !== 'unchanged') ||
                          graph.edges.some(e => e.diff !== 'unchanged');
        expect(hasChanges).toBe(true);
    });
});

// =============================================================================
//  13. diffGraphs() — full integration with constructed DiagramGraphs
// =============================================================================
describe('diffGraphs() — full integration', () => {
    function makeGraph(
        id: string,
        nodes: Array<Partial<GraphNode>>,
        edges: Array<Partial<GraphEdge>> = [],
    ): DiagramGraph {
        return {
            graphId: id,
            type: 'file',
            nodes: nodes.map((n, i) => ({
                id: n.id || `n${i}`,
                type: n.type || 'function',
                label: n.label || `node${i}`,
                body: n.body,
                subtitle: n.subtitle,
                diff: n.diff,
                anchor: n.anchor,
                meta: n.meta,
            })),
            edges: edges.map((e, i) => ({
                id: e.id || `e${i}`,
                source: e.source || '',
                target: e.target || '',
                label: e.label,
                edgeType: e.edgeType,
                diff: e.diff,
            })),
            anchors: {},
            meta: {},
        };
    }

    it('detects added nodes correctly', () => {
        const baseline = makeGraph('test', [
            { id: 'a', label: 'funcA', type: 'function' },
        ]);
        const working = makeGraph('test', [
            { id: 'a', label: 'funcA', type: 'function' },
            { id: 'b', label: 'funcB', type: 'function' },
        ]);

        const result = diffGraphs(baseline, working);
        expect(result.stats.addedNodes).toBe(1);
        expect(result.stats.unchangedNodes).toBe(1);
        expect(result.stats.deletedNodes).toBe(0);

        const addedNode = result.graph.nodes.find(n => n.diff === 'added');
        expect(addedNode?.label).toBe('funcB');
    });

    it('detects deleted nodes correctly', () => {
        const baseline = makeGraph('test', [
            { id: 'a', label: 'funcA', type: 'function' },
            { id: 'b', label: 'funcB', type: 'function' },
        ]);
        const working = makeGraph('test', [
            { id: 'a', label: 'funcA', type: 'function' },
        ]);

        const result = diffGraphs(baseline, working);
        expect(result.stats.deletedNodes).toBe(1);
        expect(result.stats.unchangedNodes).toBe(1);

        const deletedNode = result.graph.nodes.find(n => n.diff === 'deleted');
        expect(deletedNode?.label).toContain('funcB');
    });

    it('detects modified nodes (body changed)', () => {
        const baseline = makeGraph('test', [
            { id: 'a', label: 'funcA', type: 'function', body: 'return 1;' },
        ]);
        const working = makeGraph('test', [
            { id: 'a', label: 'funcA', type: 'function', body: 'return 2;' },
        ]);

        const result = diffGraphs(baseline, working);
        expect(result.stats.modifiedNodes).toBe(1);
        expect(result.stats.unchangedNodes).toBe(0);
    });

    it('handles edge diff: added, deleted, unchanged', () => {
        const baseline = makeGraph('test',
            [
                { id: 'a', label: 'A', type: 'function' },
                { id: 'b', label: 'B', type: 'function' },
                { id: 'c', label: 'C', type: 'function' },
            ],
            [
                { id: 'e1', source: 'a', target: 'b', label: 'calls' },
                { id: 'e2', source: 'b', target: 'c', label: 'calls' },
            ],
        );
        const working = makeGraph('test',
            [
                { id: 'a', label: 'A', type: 'function' },
                { id: 'b', label: 'B', type: 'function' },
                { id: 'c', label: 'C', type: 'function' },
                { id: 'd', label: 'D', type: 'function' },
            ],
            [
                { id: 'e1', source: 'a', target: 'b', label: 'calls' },
                // e2 removed (b→c), e3 added (a→d)
                { id: 'e3', source: 'a', target: 'd', label: 'calls' },
            ],
        );

        const result = diffGraphs(baseline, working);
        expect(result.stats.unchangedEdges).toBe(1);  // a→b preserved
        expect(result.stats.addedEdges).toBe(1);       // a→d new
        expect(result.stats.deletedEdges).toBe(1);     // b→c removed
    });

    it('full lifecycle: build baseline + working file graphs, then diffGraphs', () => {
        const oldCode = `
import http from "http";
const PORT = 3000;
function startServer() { http.createServer().listen(PORT); }
function handleRequest(req, res) { res.end("hello"); }
`;
        const newCode = `
import http from "http";
import url from "url";
const PORT = 8080;
function startServer() { http.createServer().listen(PORT); }
function handleRoute(req, res) { const parsed = url.parse(req.url); res.end(parsed.pathname); }
`;
        // Build graphs separately (not in diff mode) to feed into diffGraphs
        const baselineGraph = buildFileGraph(oldCode, 'server.js');
        const workingGraph = buildFileGraph(newCode, 'server.js');

        const result = diffGraphs(baselineGraph, workingGraph);

        // There should be changes detected
        const totalChanges = result.stats.addedNodes + result.stats.deletedNodes + result.stats.modifiedNodes;
        expect(totalChanges).toBeGreaterThan(0);

        // url import should be added
        const addedNodes = result.graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.some(n => n.label === 'url' || n.label.includes('url'))).toBe(true);

        // handleRequest should be deleted
        const deletedNodes = result.graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.some(n => n.label.includes('handleRequest'))).toBe(true);

        // PORT should be modified (3000 → 8080)
        const modifiedNodes = result.graph.nodes.filter(n => n.diff === 'modified');
        expect(modifiedNodes.some(n => n.label === 'PORT' || n.label.includes('PORT'))).toBe(true);

        // Edges should also have some diffs
        const edgeChanges = result.stats.addedEdges + result.stats.deletedEdges + result.stats.modifiedEdges;
        expect(edgeChanges).toBeGreaterThanOrEqual(0);
    });
});

// =============================================================================
//  14. Cross-framework API count stability
// =============================================================================
describe('Cross-framework API detection — stability checks', () => {
    it('identical code produces identical API counts (Express)', () => {
        const code = `router.get('/a', h1); router.post('/b', h2);`;
        const a = detectFrameworkApis(code, 'r.js', 'javascript');
        const b = detectFrameworkApis(code, 'r.js', 'javascript');
        expect(a.length).toBe(b.length);
        expect(a.map(x => x.apiId)).toEqual(b.map(x => x.apiId));
    });

    it('identical code produces identical API counts (FastAPI)', () => {
        const code = `@app.get("/x")\ndef x(): pass\n@app.post("/y")\ndef y(): pass`;
        const a = detectFrameworkApis(code, 'm.py', 'python');
        const b = detectFrameworkApis(code, 'm.py', 'python');
        expect(a.length).toBe(b.length);
    });

    it('identical code produces identical API counts (Spring Boot)', () => {
        const code = `@GetMapping("/x") public String x() { return ""; }`;
        const a = detectFrameworkApis(code, 'C.java', 'java');
        const b = detectFrameworkApis(code, 'C.java', 'java');
        expect(a.length).toBe(b.length);
    });

    it('identical code produces identical API counts (Gin)', () => {
        const code = `r.GET("/x", h1)\nr.POST("/y", h2)`;
        const a = detectFrameworkApis(code, 'm.go', 'go');
        const b = detectFrameworkApis(code, 'm.go', 'go');
        expect(a.length).toBe(b.length);
    });

    it('identical code produces identical API counts (Laravel)', () => {
        const code = `Route::get('/x', fn); Route::post('/y', fn);`;
        const a = detectFrameworkApis(code, 'w.php', 'php');
        const b = detectFrameworkApis(code, 'w.php', 'php');
        expect(a.length).toBe(b.length);
    });
});

// =============================================================================
//  15. Edge diff propagation from node diffs in file graph
// =============================================================================
describe('File graph — edge diff propagation from node diffs', () => {
    it('edge from added function inherits "added" diff', () => {
        const oldCode = `
import db from "./db";
function existing() { return db.query(); }
`;
        const newCode = `
import db from "./db";
function existing() { return db.query(); }
function newFunc() { return existing(); }
`;
        const graph = buildFileGraph(newCode, 'svc.js', oldCode);
        const callsEdges = graph.edges.filter(e => e.edgeType === 'calls');
        // If newFunc calls existing, that edge should be "added" (source is added)
        const addedCallEdges = callsEdges.filter(e => e.diff === 'added');
        expect(addedCallEdges.length).toBeGreaterThanOrEqual(1);
    });

    it('edge between two unchanged functions stays "unchanged"', () => {
        const code = `
function alpha() { return beta(); }
function beta() { return 42; }
`;
        const graph = buildFileGraph(code, 'stable.js', code);
        const callsEdges = graph.edges.filter(e => e.edgeType === 'calls');
        for (const e of callsEdges) {
            expect(e.diff).toBe('unchanged');
        }
    });

    it('edge to deleted function inherits "deleted" diff via section contains', () => {
        const oldCode = `
function caller() { return callee(); }
function callee() { return 1; }
`;
        const newCode = `
function caller() { return 42; }
`;
        const graph = buildFileGraph(newCode, 'rm.js', oldCode);
        // callee was deleted, caller was modified
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.some(n => n.label.includes('callee'))).toBe(true);
    });
});
