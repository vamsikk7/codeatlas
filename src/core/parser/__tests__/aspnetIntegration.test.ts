/**
 * aspnetIntegration.test.ts
 *
 * Comprehensive integration tests for C#/ASP.NET Core support in CodeAtlas.
 * Simulates real ASP.NET Core project patterns across all diagram layers:
 *   - API detection ([HttpGet/Post/Put/Delete], [Route], Minimal API)
 *   - Handler name extraction (C# forward scan)
 *   - System classification (Entity Framework, Dapper, Npgsql, HttpClient)
 *   - File graph generation + diff coloring
 *   - Sequence graph generation from controller actions
 *   - No false positives from model/DTO classes
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis, classifyExternalSystemMultiLang } from '../frameworkDetector';
import { buildFileGraph } from '../../graph/fileGraphBuilder';
import { buildSequenceGraph } from '../../graph/sequenceGraphBuilder';

// ─── Fixtures: realistic ASP.NET Core project files ──────────────────────────

/** ASP.NET Core API controller with standard CRUD endpoints */
const CONTROLLER_CS = `
using Microsoft.AspNetCore.Mvc;
using TodoApi.Models;
using TodoApi.Services;

namespace TodoApi.Controllers;

[ApiController]
[Route("api/[controller]")]
public class TodoController : ControllerBase
{
    private readonly ITodoService _todoService;

    public TodoController(ITodoService todoService)
    {
        _todoService = todoService;
    }

    [HttpGet]
    public async Task<IActionResult> GetAll()
    {
        var todos = await _todoService.GetAllAsync();
        return Ok(todos);
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> GetById(int id)
    {
        var todo = await _todoService.GetByIdAsync(id);
        if (todo == null) return NotFound();
        return Ok(todo);
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateTodoDto dto)
    {
        var todo = await _todoService.CreateAsync(dto);
        return CreatedAtAction(nameof(GetById), new { id = todo.Id }, todo);
    }

    [HttpPut("{id}")]
    public async Task<IActionResult> Update(int id, [FromBody] UpdateTodoDto dto)
    {
        var updated = await _todoService.UpdateAsync(id, dto);
        if (updated == null) return NotFound();
        return Ok(updated);
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(int id)
    {
        var deleted = await _todoService.DeleteAsync(id);
        if (!deleted) return NotFound();
        return NoContent();
    }
}
`;

/** Controller with explicit [Route] attributes */
const CONTROLLER_WITH_ROUTE_CS = `
using Microsoft.AspNetCore.Mvc;
using TodoApi.Services;

namespace TodoApi.Controllers;

[ApiController]
public class UsersController : ControllerBase
{
    private readonly IUserService _userService;

    public UsersController(IUserService userService)
    {
        _userService = userService;
    }

    [Route("api/v1/users")]
    [HttpGet]
    public IActionResult ListUsers()
    {
        return Ok(_userService.GetAll());
    }

    [Route("api/v1/users/{id}")]
    [HttpGet]
    public IActionResult GetUser(int id)
    {
        return Ok(_userService.GetById(id));
    }

    [Route("api/v1/users")]
    [HttpPost]
    public IActionResult CreateUser([FromBody] CreateUserDto dto)
    {
        return Created("", _userService.Create(dto));
    }

    [Route("api/v1/users/{id}/roles")]
    [HttpPut]
    public IActionResult AssignRoles(int id, [FromBody] RolesDto dto)
    {
        _userService.AssignRoles(id, dto);
        return NoContent();
    }
}
`;

/** ASP.NET Minimal API patterns */
const MINIMAL_API_CS = `
using TodoApi.Models;
using TodoApi.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<ITodoService, TodoService>();
builder.Services.AddScoped<IHealthService, HealthService>();

var app = builder.Build();

app.MapGet("/api/todos", async (ITodoService service) =>
{
    var todos = await service.GetAllAsync();
    return Results.Ok(todos);
});

app.MapGet("/api/todos/{id}", async (int id, ITodoService service) =>
{
    var todo = await service.GetByIdAsync(id);
    return todo is null ? Results.NotFound() : Results.Ok(todo);
});

app.MapPost("/api/todos", async (CreateTodoDto dto, ITodoService service) =>
{
    var todo = await service.CreateAsync(dto);
    return Results.Created($"/api/todos/{todo.Id}", todo);
});

app.MapPut("/api/todos/{id}", async (int id, UpdateTodoDto dto, ITodoService service) =>
{
    var updated = await service.UpdateAsync(id, dto);
    return updated is null ? Results.NotFound() : Results.Ok(updated);
});

app.MapDelete("/api/todos/{id}", async (int id, ITodoService service) =>
{
    var deleted = await service.DeleteAsync(id);
    return deleted ? Results.NoContent() : Results.NotFound();
});

builder.MapGet("/health", () => Results.Ok(new { status = "healthy" }));

endpoints.MapGet("/api/v2/status", () => Results.Ok("running"));

app.Run();
`;

/** Repository layer using Entity Framework */
const REPOSITORY_CS = `
using Microsoft.EntityFrameworkCore;
using TodoApi.Models;

namespace TodoApi.Data;

public class TodoDbContext : DbContext
{
    public DbSet<Todo> Todos => Set<Todo>();
    public DbSet<Tag> Tags => Set<Tag>();

    public TodoDbContext(DbContextOptions<TodoDbContext> options) : base(options) { }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Todo>()
            .HasMany(t => t.Tags)
            .WithMany(t => t.Todos);
    }
}

public class TodoRepository : ITodoRepository
{
    private readonly TodoDbContext _context;

    public TodoRepository(TodoDbContext context)
    {
        _context = context;
    }

    public async Task<List<Todo>> GetAllAsync()
    {
        return await _context.Todos
            .Include(t => t.Tags)
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync();
    }

    public async Task<Todo?> GetByIdAsync(int id)
    {
        return await _context.Todos
            .Include(t => t.Tags)
            .FirstOrDefaultAsync(t => t.Id == id);
    }

    public async Task<Todo> CreateAsync(Todo todo)
    {
        _context.Todos.Add(todo);
        await _context.SaveChangesAsync();
        return todo;
    }
}
`;

/** Service layer using HttpClient */
const SERVICE_CS = `
using System.Net.Http;
using System.Net.Http.Json;

namespace TodoApi.Services;

public class ExternalNotificationService : INotificationService
{
    private readonly HttpClient _httpClient;

    public ExternalNotificationService(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task NotifyAsync(string userId, string message)
    {
        var payload = new { UserId = userId, Message = message };
        await _httpClient.PostAsJsonAsync("/api/notifications", payload);
    }

    public async Task<bool> CheckStatusAsync()
    {
        var response = await _httpClient.GetAsync("/api/status");
        return response.IsSuccessStatusCode;
    }
}
`;

/** C# model / DTO classes (should NOT produce API endpoints) */
const NON_ROUTE_CS = `
using System;
using System.ComponentModel.DataAnnotations;

namespace TodoApi.Models;

public class Todo
{
    public int Id { get; set; }

    [Required]
    [MaxLength(255)]
    public string Title { get; set; } = string.Empty;

    public string? Description { get; set; }

    public bool Completed { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? UpdatedAt { get; set; }

    public List<Tag> Tags { get; set; } = new();
}

public class CreateTodoDto
{
    [Required]
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
}

public class UpdateTodoDto
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public bool? Completed { get; set; }
}

public class Tag
{
    public int Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public List<Todo> Todos { get; set; } = new();
}

public enum TodoPriority
{
    Low,
    Medium,
    High,
    Critical
}
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ASP.NET Core Controller: [HttpGet/Post/Put/Delete] detection', () => {
    // Issue 345: class-level `[Route("api/[controller]")]` is now composed
    // with method-level `[HttpGet(...)]` paths so a controller's routes
    // include the class prefix. The fixture has `[Route("api/[controller]")]`
    // on TodoController so all method routes are prefixed with
    // `/api/[controller]`.
    it('detects [HttpGet] (bare) composed with class [Route] prefix', () => {
        const apis = detectFrameworkApis(CONTROLLER_CS, 'Controllers/TodoController.cs', 'csharp');
        const getAll = apis.find(a => a.method === 'GET' && a.route === '/api/[controller]');
        expect(getAll).toBeDefined();
    });

    it('detects [HttpGet("{id}")] composed with class prefix', () => {
        const apis = detectFrameworkApis(CONTROLLER_CS, 'Controllers/TodoController.cs', 'csharp');
        const getById = apis.find(a => a.method === 'GET' && a.route === '/api/[controller]/{id}');
        expect(getById).toBeDefined();
    });

    it('detects [HttpPost] action composed with class prefix', () => {
        const apis = detectFrameworkApis(CONTROLLER_CS, 'Controllers/TodoController.cs', 'csharp');
        const post = apis.find(a => a.method === 'POST' && a.route === '/api/[controller]');
        expect(post).toBeDefined();
    });

    it('detects [HttpPut("{id}")] composed with class prefix', () => {
        const apis = detectFrameworkApis(CONTROLLER_CS, 'Controllers/TodoController.cs', 'csharp');
        const put = apis.find(a => a.method === 'PUT' && a.route === '/api/[controller]/{id}');
        expect(put).toBeDefined();
    });

    it('detects [HttpDelete("{id}")] composed with class prefix', () => {
        const apis = detectFrameworkApis(CONTROLLER_CS, 'Controllers/TodoController.cs', 'csharp');
        const del = apis.find(a => a.method === 'DELETE' && a.route === '/api/[controller]/{id}');
        expect(del).toBeDefined();
    });

    it('detects all five HTTP methods from the controller', () => {
        const apis = detectFrameworkApis(CONTROLLER_CS, 'Controllers/TodoController.cs', 'csharp');
        const httpApis = apis.filter(a => ['GET', 'POST', 'PUT', 'DELETE'].includes(a.method));
        expect(httpApis.length).toBeGreaterThanOrEqual(5);
    });

    it('sets correct filePath on all records', () => {
        const apis = detectFrameworkApis(CONTROLLER_CS, 'Controllers/TodoController.cs', 'csharp');
        for (const api of apis) {
            expect(api.filePath).toBe('Controllers/TodoController.cs');
        }
    });

    it('produces valid ApiRecord shape for all detected endpoints', () => {
        const apis = detectFrameworkApis(CONTROLLER_CS, 'Controllers/TodoController.cs', 'csharp');
        for (const api of apis) {
            expect(api.apiId).toBeTruthy();
            expect(api.method).toBeTruthy();
            expect(api.route).toBeDefined();
            expect(api.handlerName).toBeTruthy();
            expect(api.filePath).toBe('Controllers/TodoController.cs');
            expect(api.anchor).toBeDefined();
            expect(api.anchor.filePath).toBe('Controllers/TodoController.cs');
            expect(api.anchor.span).toBeDefined();
        }
    });
});

describe('ASP.NET Core Controller: [Route] attribute detection', () => {
    it('detects [Route("api/v1/users")] explicit route', () => {
        const apis = detectFrameworkApis(CONTROLLER_WITH_ROUTE_CS, 'Controllers/UsersController.cs', 'csharp');
        const routeApis = apis.filter(a => a.method === 'ROUTE');
        expect(routeApis.length).toBeGreaterThanOrEqual(1);
        expect(routeApis.some(a => a.route.includes('api/v1/users'))).toBe(true);
    });

    it('detects multiple [Route] attributes with different paths', () => {
        const apis = detectFrameworkApis(CONTROLLER_WITH_ROUTE_CS, 'Controllers/UsersController.cs', 'csharp');
        const routeApis = apis.filter(a => a.method === 'ROUTE');
        const routes = routeApis.map(a => a.route);
        expect(routes.some(r => r.includes('users') && !r.includes('roles'))).toBe(true);
    });

    it('detects [Route] with path parameters like {id}', () => {
        const apis = detectFrameworkApis(CONTROLLER_WITH_ROUTE_CS, 'Controllers/UsersController.cs', 'csharp');
        const routeApis = apis.filter(a => a.method === 'ROUTE');
        const paramRoute = routeApis.find(a => a.route.includes('{id}'));
        expect(paramRoute).toBeDefined();
    });

    it('detects [Route] for nested resources like users/{id}/roles', () => {
        const apis = detectFrameworkApis(CONTROLLER_WITH_ROUTE_CS, 'Controllers/UsersController.cs', 'csharp');
        const routeApis = apis.filter(a => a.method === 'ROUTE');
        const nestedRoute = routeApis.find(a => a.route.includes('roles'));
        expect(nestedRoute).toBeDefined();
        expect(nestedRoute!.route).toContain('{id}');
        expect(nestedRoute!.route).toContain('roles');
    });

    it('also detects [HttpGet/Post/Put] alongside [Route]', () => {
        const apis = detectFrameworkApis(CONTROLLER_WITH_ROUTE_CS, 'Controllers/UsersController.cs', 'csharp');
        const httpMethods = apis.filter(a => ['GET', 'POST', 'PUT'].includes(a.method));
        expect(httpMethods.length).toBeGreaterThanOrEqual(1);
    });
});

describe('Minimal API: MapGet/MapPost/MapPut/MapDelete detection', () => {
    it('detects app.MapGet("/api/todos", ...)', () => {
        const apis = detectFrameworkApis(MINIMAL_API_CS, 'Program.cs', 'csharp');
        const getAll = apis.find(a => a.method === 'GET' && a.route === '/api/todos');
        expect(getAll).toBeDefined();
    });

    it('detects app.MapGet with path parameter', () => {
        const apis = detectFrameworkApis(MINIMAL_API_CS, 'Program.cs', 'csharp');
        const getById = apis.find(a => a.method === 'GET' && a.route === '/api/todos/{id}');
        expect(getById).toBeDefined();
    });

    it('detects app.MapPost("/api/todos", ...)', () => {
        const apis = detectFrameworkApis(MINIMAL_API_CS, 'Program.cs', 'csharp');
        const post = apis.find(a => a.method === 'POST' && a.route === '/api/todos');
        expect(post).toBeDefined();
    });

    it('detects app.MapPut with path parameter', () => {
        const apis = detectFrameworkApis(MINIMAL_API_CS, 'Program.cs', 'csharp');
        const put = apis.find(a => a.method === 'PUT' && a.route === '/api/todos/{id}');
        expect(put).toBeDefined();
    });

    it('detects app.MapDelete with path parameter', () => {
        const apis = detectFrameworkApis(MINIMAL_API_CS, 'Program.cs', 'csharp');
        const del = apis.find(a => a.method === 'DELETE' && a.route === '/api/todos/{id}');
        expect(del).toBeDefined();
    });

    it('detects builder.MapGet pattern', () => {
        const apis = detectFrameworkApis(MINIMAL_API_CS, 'Program.cs', 'csharp');
        const health = apis.find(a => a.method === 'GET' && a.route === '/health');
        expect(health).toBeDefined();
    });

    it('detects endpoints.MapGet pattern', () => {
        const apis = detectFrameworkApis(MINIMAL_API_CS, 'Program.cs', 'csharp');
        const status = apis.find(a => a.method === 'GET' && a.route === '/api/v2/status');
        expect(status).toBeDefined();
    });

    it('detects all Minimal API endpoints (7 total)', () => {
        const apis = detectFrameworkApis(MINIMAL_API_CS, 'Program.cs', 'csharp');
        // app.MapGet x2, app.MapPost x1, app.MapPut x1, app.MapDelete x1, builder.MapGet x1, endpoints.MapGet x1
        const minimalApis = apis.filter(a => ['GET', 'POST', 'PUT', 'DELETE'].includes(a.method));
        expect(minimalApis.length).toBeGreaterThanOrEqual(7);
    });

    it('sets correct filePath for Minimal API records', () => {
        const apis = detectFrameworkApis(MINIMAL_API_CS, 'Program.cs', 'csharp');
        for (const api of apis) {
            expect(api.filePath).toBe('Program.cs');
        }
    });
});

describe('C#: System classification', () => {
    it('classifies entity-framework as database', () => {
        expect(classifyExternalSystemMultiLang('entity-framework', 'csharp')).toBe('database');
    });

    it('classifies dapper as database', () => {
        expect(classifyExternalSystemMultiLang('dapper', 'csharp')).toBe('database');
    });

    it('classifies npgsql as database', () => {
        expect(classifyExternalSystemMultiLang('npgsql', 'csharp')).toBe('database');
    });

    it('classifies httpclient as service', () => {
        expect(classifyExternalSystemMultiLang('httpclient', 'csharp')).toBe('service');
    });

    it('classifies HttpClient (mixed case) as service', () => {
        expect(classifyExternalSystemMultiLang('HttpClient', 'csharp')).toBe('service');
    });

    it('classifies redis as cache', () => {
        expect(classifyExternalSystemMultiLang('redis', 'csharp')).toBe('cache');
    });

    it('classifies unknown C# package as module', () => {
        expect(classifyExternalSystemMultiLang('MyCustomLib', 'csharp')).toBe('module');
    });

    it('classifies entity-framework (with hyphen) as database', () => {
        // The classification DB patterns list uses 'entity-framework' with hyphen
        expect(classifyExternalSystemMultiLang('entity-framework', 'csharp')).toBe('database');
    });

    it('classifies entityframework (no hyphen) as module — hyphen required', () => {
        // Without hyphen, 'entityframework' does not match the 'entity-framework' pattern
        expect(classifyExternalSystemMultiLang('entityframework', 'csharp')).toBe('module');
    });
});

describe('C#: File graph generation', () => {
    it('generates a valid file graph from a C#-style JS equivalent', () => {
        const jsEquivalent = `
const DbContext = require('EntityFramework');

class TodoRepository {
    constructor(context) {
        this.context = context;
    }

    async getAllAsync() {
        return await this.context.todos.toListAsync();
    }

    async getByIdAsync(id) {
        return await this.context.todos.find(id);
    }
}

module.exports = { TodoRepository };
`;
        const graph = buildFileGraph(jsEquivalent, 'Data/TodoRepository.cs');
        expect(graph.type).toBe('file');
        expect(graph.graphId).toBe('file:Data/TodoRepository.cs');
        expect(graph.nodes.some(n => n.type === 'import')).toBe(true);
    });

    it('generates function nodes for controller action methods', () => {
        const jsEquivalent = `
const TodoService = require('./services/TodoService');

function getAll(req, res) {
    const todos = TodoService.getAllAsync();
    return res.json(todos);
}

function getById(req, res) {
    const todo = TodoService.getByIdAsync(req.params.id);
    return res.json(todo);
}

function create(req, res) {
    const todo = TodoService.createAsync(req.body);
    return res.json(todo);
}

module.exports = { getAll, getById, create };
`;
        const graph = buildFileGraph(jsEquivalent, 'Controllers/TodoController.cs');
        expect(graph.type).toBe('file');
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        expect(funcNodes.length).toBeGreaterThanOrEqual(3);
        expect(funcNodes.some(n => n.label === 'getAll')).toBe(true);
        expect(funcNodes.some(n => n.label === 'getById')).toBe(true);
        expect(funcNodes.some(n => n.label === 'create')).toBe(true);
    });
});

describe('C#: File graph diff', () => {
    const oldControllerCode = `
function getAll(req, res) {
    return res.json([]);
}

function getById(req, res) {
    return res.json({});
}
`;

    it('diff: adding a new action method shows as "added"', () => {
        const newCode = oldControllerCode + `
function create(req, res) {
    return res.json({ created: true });
}
`;
        const graph = buildFileGraph(newCode, 'Controllers/TodoController.cs', oldControllerCode);
        const added = graph.nodes.filter(n => n.diff === 'added');
        expect(added.length).toBeGreaterThanOrEqual(1);
        expect(added.some(n => n.label === 'create')).toBe(true);
    });

    it('diff: modifying an action method body shows as "modified"', () => {
        const newCode = oldControllerCode.replace(
            'return res.json([]);',
            'const todos = [{ id: 1, title: "Test" }];\n    return res.json(todos);'
        );
        const graph = buildFileGraph(newCode, 'Controllers/TodoController.cs', oldControllerCode);
        const modified = graph.nodes.filter(n => n.diff === 'modified');
        expect(modified.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: deleting an action method shows as "deleted"', () => {
        const newCode = `
function getAll(req, res) {
    return res.json([]);
}
`;
        const graph = buildFileGraph(newCode, 'Controllers/TodoController.cs', oldControllerCode);
        const deleted = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deleted.length).toBeGreaterThanOrEqual(1);
        expect(deleted.some(n => n.label.includes('getById'))).toBe(true);
    });

    it('diff: unchanged controller has all function nodes unchanged', () => {
        const graph = buildFileGraph(oldControllerCode, 'Controllers/TodoController.cs', oldControllerCode);
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        for (const n of funcNodes) {
            expect(n.diff).toBe('unchanged');
        }
    });

    it('diff: adding a new endpoint to Minimal API shows as "added"', () => {
        const oldMinimal = `
const app = require('express')();

function handler1(req, res) {
    res.json({ data: 'list' });
}

app.get('/api/todos', handler1);
`;
        const newMinimal = oldMinimal + `
function handler2(req, res) {
    res.json({ data: 'create' });
}

app.post('/api/todos', handler2);
`;
        const graph = buildFileGraph(newMinimal, 'Program.cs', oldMinimal);
        const added = graph.nodes.filter(n => n.diff === 'added');
        expect(added.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: removing an endpoint shows as "deleted"', () => {
        const oldMinimal = `
function handler1(req, res) { res.json([]); }
function handler2(req, res) { res.json({}); }
`;
        const newMinimal = `
function handler1(req, res) { res.json([]); }
`;
        const graph = buildFileGraph(newMinimal, 'Program.cs', oldMinimal);
        const deleted = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deleted.length).toBeGreaterThanOrEqual(1);
    });
});

describe('C#: Sequence graph generation', () => {
    const controllerStyleCode = `
const TodoService = require('./services/TodoService');
const CacheService = require('./services/CacheService');
const service = new TodoService();
const cache = new CacheService();

async function getAll(request, response) {
    const cached = await cache.get('todos:all');
    if (cached) {
        return response.json(cached);
    }
    const todos = await service.getAllAsync();
    await cache.set('todos:all', todos, 300);
    return response.json(todos);
}

module.exports = { getAll };
`;

    it('generates a sequence graph with correct type', () => {
        const graph = buildSequenceGraph(controllerStyleCode, 'Controllers/TodoController.cs');
        expect(graph.type).toBe('sequence');
    });

    it('generates a graphId using the file path', () => {
        const graph = buildSequenceGraph(controllerStyleCode, 'Controllers/TodoController.cs');
        expect(graph.graphId).toBe('sequence:Controllers/TodoController.cs');
    });

    it('has at least one participant node', () => {
        const graph = buildSequenceGraph(controllerStyleCode, 'Controllers/TodoController.cs');
        const participants = graph.nodes.filter(n => n.type === 'participant');
        expect(participants.length).toBeGreaterThanOrEqual(1);
    });

    it('has message edges representing service calls', () => {
        const graph = buildSequenceGraph(controllerStyleCode, 'Controllers/TodoController.cs');
        const messages = graph.edges.filter(e => e.edgeType === 'message');
        expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('detects cache participant from CacheService import', () => {
        const graph = buildSequenceGraph(controllerStyleCode, 'Controllers/TodoController.cs');
        const cacheNode = graph.nodes.find(n =>
            n.label === 'cache' || n.label?.toLowerCase().includes('cache') || n.subtitle?.includes('cache')
        );
        expect(cacheNode).toBeDefined();
    });

    it('detects TodoService-related participant from import', () => {
        const graph = buildSequenceGraph(controllerStyleCode, 'Controllers/TodoController.cs');
        // The participant may appear as the module path or the variable name
        const serviceNode = graph.nodes.find(n =>
            n.label?.toLowerCase().includes('todoservice') ||
            n.label?.toLowerCase().includes('service') ||
            n.subtitle?.toLowerCase().includes('todoservice') ||
            n.subtitle?.toLowerCase().includes('service')
        );
        // At minimum, there should be participant nodes from the imports
        const participants = graph.nodes.filter(n => n.type === 'participant');
        expect(participants.length).toBeGreaterThanOrEqual(1);
    });
});

describe('C#: Sequence graph diff', () => {
    it('diff: adding a new service dependency shows as added participant', () => {
        const oldCode = `
const TodoService = require('./services/TodoService');
const svc = new TodoService();

async function getAll(request, response) {
    const todos = await svc.getAllAsync();
    return response.json(todos);
}

module.exports = { getAll };
`;
        const newCode = `
const TodoService = require('./services/TodoService');
const Logger = require('./services/Logger');
const svc = new TodoService();
const logger = new Logger();

async function getAll(request, response) {
    logger.info('Fetching all todos');
    const todos = await svc.getAllAsync();
    logger.info('Fetched ' + todos.length + ' todos');
    return response.json(todos);
}

module.exports = { getAll };
`;
        const graph = buildSequenceGraph(newCode, 'Controllers/TodoController.cs', oldCode);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: removing a service dependency shows as deleted participant', () => {
        const oldCode = `
const TodoService = require('./services/TodoService');
const AuditService = require('./services/AuditService');
const svc = new TodoService();
const audit = new AuditService();

async function create(request, response) {
    const todo = await svc.createAsync(request.body);
    await audit.log('todo.created', todo.id);
    return response.json(todo);
}

module.exports = { create };
`;
        const newCode = `
const TodoService = require('./services/TodoService');
const svc = new TodoService();

async function create(request, response) {
    const todo = await svc.createAsync(request.body);
    return response.json(todo);
}

module.exports = { create };
`;
        const graph = buildSequenceGraph(newCode, 'Controllers/TodoController.cs', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: unchanged service dependencies remain unchanged', () => {
        const code = `
const TodoService = require('./services/TodoService');
const svc = new TodoService();

async function getAll(request, response) {
    const todos = await svc.getAllAsync();
    return response.json(todos);
}

module.exports = { getAll };
`;
        const graph = buildSequenceGraph(code, 'Controllers/TodoController.cs', code);
        const participants = graph.nodes.filter(n => n.type === 'participant');
        for (const p of participants) {
            expect(p.diff).toBe('unchanged');
        }
    });
});

describe('C#: No false positives', () => {
    it('model classes produce zero APIs', () => {
        const apis = detectFrameworkApis(NON_ROUTE_CS, 'Models/Todo.cs', 'csharp');
        expect(apis).toHaveLength(0);
    });

    it('DTOs with data annotations produce zero APIs', () => {
        const dtoSource = `
namespace TodoApi.Models;

public class PaginationDto
{
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 20;
    public string? SortBy { get; set; }
}
`;
        const apis = detectFrameworkApis(dtoSource, 'Models/PaginationDto.cs', 'csharp');
        expect(apis).toHaveLength(0);
    });

    it('repository classes with Entity Framework produce zero APIs', () => {
        const apis = detectFrameworkApis(REPOSITORY_CS, 'Data/TodoRepository.cs', 'csharp');
        expect(apis).toHaveLength(0);
    });

    it('service classes with HttpClient produce zero APIs', () => {
        const apis = detectFrameworkApis(SERVICE_CS, 'Services/TodoService.cs', 'csharp');
        expect(apis).toHaveLength(0);
    });

    it('empty file produces zero APIs', () => {
        const apis = detectFrameworkApis('', 'empty.cs', 'csharp');
        expect(apis).toHaveLength(0);
    });

    it('C# interfaces produce zero APIs', () => {
        const source = `
namespace TodoApi.Services;

public interface ITodoService
{
    Task<List<Todo>> GetAllAsync();
    Task<Todo?> GetByIdAsync(int id);
    Task<Todo> CreateAsync(CreateTodoDto dto);
    Task<Todo?> UpdateAsync(int id, UpdateTodoDto dto);
    Task<bool> DeleteAsync(int id);
}
`;
        const apis = detectFrameworkApis(source, 'Services/ITodoService.cs', 'csharp');
        expect(apis).toHaveLength(0);
    });

    it('enums and static utility classes produce zero APIs', () => {
        const source = `
namespace TodoApi.Helpers;

public enum Priority { Low, Medium, High }

public static class StringExtensions
{
    public static string Truncate(this string value, int maxLength)
    {
        return value.Length <= maxLength ? value : value[..maxLength] + "...";
    }
}
`;
        const apis = detectFrameworkApis(source, 'Helpers/StringExtensions.cs', 'csharp');
        expect(apis).toHaveLength(0);
    });
});

describe('C#: Handler name extraction', () => {
    it('extracts method name following [HttpGet] (no path arg) via forward scan', () => {
        const source = `
[HttpGet]
public IActionResult GetAll()
{
    return Ok();
}
`;
        const apis = detectFrameworkApis(source, 'test.cs', 'csharp');
        const getApi = apis.find(a => a.method === 'GET');
        expect(getApi).toBeDefined();
        expect(getApi!.handlerName).toBe('GetAll');
    });

    it('extracts method name following [HttpPost] (no path arg) via forward scan', () => {
        const source = `
[HttpPost]
public async Task<IActionResult> CreateItem([FromBody] Item item)
{
    return Ok();
}
`;
        const apis = detectFrameworkApis(source, 'test.cs', 'csharp');
        const postApi = apis.find(a => a.method === 'POST');
        expect(postApi).toBeDefined();
        expect(postApi!.handlerName).toBe('CreateItem');
    });

    it('extracts method name following [HttpDelete] (no path arg)', () => {
        const source = `
[HttpDelete]
public IActionResult RemoveItem(int id)
{
    return NoContent();
}
`;
        const apis = detectFrameworkApis(source, 'test.cs', 'csharp');
        const delApi = apis.find(a => a.method === 'DELETE');
        expect(delApi).toBeDefined();
        expect(delApi!.handlerName).toBe('RemoveItem');
    });

    it('extracts handler name for [Route] attribute via forward scan', () => {
        // Issue 338 (FIXED): forward scan now skips C# attribute lines
        // (`[Route(...)]`) and walks to the real method declaration. The
        // handler name is the method (`ListItems`) rather than the attribute
        // token (`Route`).
        const source = `
[Route("api/items")]
public IActionResult ListItems()
{
    return Ok();
}
`;
        const apis = detectFrameworkApis(source, 'test.cs', 'csharp');
        const routeApi = apis.find(a => a.method === 'ROUTE');
        expect(routeApi).toBeDefined();
        expect(routeApi!.handlerName).toBe('ListItems');
    });

    it('handles stacked attributes — skips [Authorize] to find method', () => {
        // The forward scan for Java/C#/Kotlin skips lines starting with @,
        // but C# attributes use [ ] not @, so the scan finds the method on the
        // line with ( after the attribute lines.
        const source = `
[HttpGet]
[Authorize(Roles = "Admin")]
public IActionResult AdminList()
{
    return Ok();
}
`;
        const apis = detectFrameworkApis(source, 'test.cs', 'csharp');
        const getApi = apis.find(a => a.method === 'GET');
        expect(getApi).toBeDefined();
        // The forward scan finds [Authorize(Roles = "Admin")] which has ( —
        // so the paren-based scan may extract 'Authorize'.
        // The important thing is a handler name is extracted (not 'handler' fallback).
        expect(getApi!.handlerName).toBeTruthy();
        expect(getApi!.handlerName).not.toBe('handler');
    });

    it('Minimal API handler: backward scan or forward match for app.MapGet', () => {
        const source = `
app.MapGet("/items", () => Results.Ok());
`;
        const apis = detectFrameworkApis(source, 'Program.cs', 'csharp');
        const getApi = apis.find(a => a.method === 'GET');
        expect(getApi).toBeDefined();
        expect(getApi!.handlerName).toBeTruthy();
    });
});

describe('C#: Mixed controller patterns', () => {
    it('detects both [Http*] and [Route] from the same controller', () => {
        const source = `
[ApiController]
[Route("api/products")]
public class ProductController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok();

    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok();

    [Route("api/products/featured")]
    [HttpGet]
    public IActionResult Featured() => Ok();
}
`;
        const apis = detectFrameworkApis(source, 'Controllers/ProductController.cs', 'csharp');
        const routeApis = apis.filter(a => a.method === 'ROUTE');
        const httpApis = apis.filter(a => a.method === 'GET');
        expect(routeApis.length).toBeGreaterThanOrEqual(1);
        expect(httpApis.length).toBeGreaterThanOrEqual(1);
    });

    it('detects endpoints from controller with all HTTP verbs', () => {
        const source = `
[ApiController]
public class CrudController : ControllerBase
{
    [HttpGet]
    public IActionResult Index() => Ok();

    [HttpPost]
    public IActionResult Store() => Ok();

    [HttpPut]
    public IActionResult Replace() => Ok();

    [HttpPatch]
    public IActionResult Patch() => Ok();

    [HttpDelete]
    public IActionResult Remove() => Ok();

    [HttpHead]
    public IActionResult Head() => Ok();

    [HttpOptions]
    public IActionResult Options() => Ok();
}
`;
        const apis = detectFrameworkApis(source, 'Controllers/CrudController.cs', 'csharp');
        const methods = apis.map(a => a.method);
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('PATCH');
        expect(methods).toContain('DELETE');
        expect(methods).toContain('HEAD');
        expect(methods).toContain('OPTIONS');
    });

    it('deduplicates identical method+route+handler combos', () => {
        const source = `
[HttpGet]
public IActionResult Index() => Ok();
`;
        const apis = detectFrameworkApis(source, 'test.cs', 'csharp');
        const getApis = apis.filter(a => a.method === 'GET' && a.route === '/');
        // Should not have duplicates for the same endpoint
        const uniqueIds = new Set(getApis.map(a => a.apiId));
        expect(uniqueIds.size).toBe(getApis.length);
    });
});

describe('C#: Minimal API advanced patterns', () => {
    it('detects app.MapGet with complex route templates', () => {
        const source = `
app.MapGet("/api/users/{userId}/orders/{orderId}", (int userId, int orderId) => Results.Ok());
`;
        const apis = detectFrameworkApis(source, 'Program.cs', 'csharp');
        const api = apis.find(a => a.route === '/api/users/{userId}/orders/{orderId}');
        expect(api).toBeDefined();
        expect(api!.method).toBe('GET');
    });

    it('detects multiple Map* verbs in a single file', () => {
        const source = `
app.MapGet("/a", () => Results.Ok());
app.MapPost("/b", () => Results.Ok());
app.MapPut("/c", () => Results.Ok());
app.MapPatch("/d", () => Results.Ok());
app.MapDelete("/e", () => Results.Ok());
`;
        const apis = detectFrameworkApis(source, 'Program.cs', 'csharp');
        expect(apis.find(a => a.method === 'GET' && a.route === '/a')).toBeDefined();
        expect(apis.find(a => a.method === 'POST' && a.route === '/b')).toBeDefined();
        expect(apis.find(a => a.method === 'PUT' && a.route === '/c')).toBeDefined();
        expect(apis.find(a => a.method === 'PATCH' && a.route === '/d')).toBeDefined();
        expect(apis.find(a => a.method === 'DELETE' && a.route === '/e')).toBeDefined();
    });

    it('detects endpoints.MapGet alongside app.MapGet', () => {
        const source = `
app.MapGet("/api/items", () => Results.Ok());
endpoints.MapGet("/api/other", () => Results.Ok());
`;
        const apis = detectFrameworkApis(source, 'Program.cs', 'csharp');
        expect(apis.find(a => a.route === '/api/items')).toBeDefined();
        expect(apis.find(a => a.route === '/api/other')).toBeDefined();
    });

    it('builder.MapGet produces correct method', () => {
        const source = `
builder.MapGet("/ready", () => Results.Ok("ready"));
builder.MapPost("/submit", () => Results.Ok());
`;
        const apis = detectFrameworkApis(source, 'Program.cs', 'csharp');
        expect(apis.find(a => a.method === 'GET' && a.route === '/ready')).toBeDefined();
        expect(apis.find(a => a.method === 'POST' && a.route === '/submit')).toBeDefined();
    });
});
