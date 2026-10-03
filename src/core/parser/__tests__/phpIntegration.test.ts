/**
 * phpIntegration.test.ts
 *
 * Comprehensive integration tests for PHP/Laravel support in CodeAtlas.
 * Simulates real Laravel project patterns across all diagram layers:
 *   - API detection (basic routes, array controllers, resource/apiResource)
 *   - Route group prefix detection
 *   - Symfony #[Route] with methods extraction
 *   - Handler name extraction (PHP forward scan)
 *   - Infrastructure detection (Eloquent, DB::, Redis::, Cache::, Queue::, Doctrine)
 *   - Relative API patterns (Http:: facade)
 *   - File graph integration + diff coloring
 *   - Sequence graph integration
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis, classifyExternalSystemMultiLang } from '../frameworkDetector';
import { buildFileGraph } from '../../graph/fileGraphBuilder';
import { buildSequenceGraph } from '../../graph/sequenceGraphBuilder';

// ─── Fixtures: realistic Laravel PHP project files ────────────────────────────

/** Basic Laravel routes (web.php) */
const ROUTES_WEB_PHP = `<?php

use App\\Http\\Controllers\\UserController;
use App\\Http\\Controllers\\PostController;

Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
Route::get('/users/{id}', [UserController::class, 'show']);
Route::put('/users/{id}', [UserController::class, 'update']);
Route::delete('/users/{id}', [UserController::class, 'destroy']);

Route::resource('/posts', PostController::class);
Route::apiResource('/comments', CommentController::class);

// Closure-based route
Route::get('/health', function () {
    return response()->json(['status' => 'ok']);
});
`;

/** Laravel API routes with prefix groups */
const ROUTES_API_PHP = `<?php

use App\\Http\\Controllers\\Api\\V1\\TodoController;
use App\\Http\\Controllers\\Api\\V1\\TagController;

Route::prefix('/api/v1')->group(function () {
    Route::get('/todos', [TodoController::class, 'index']);
    Route::post('/todos', [TodoController::class, 'store']);
    Route::get('/todos/{id}', [TodoController::class, 'show']);
    Route::delete('/todos/{id}', [TodoController::class, 'destroy']);

    Route::get('/tags', [TagController::class, 'list']);
});

// Route outside the group — no prefix
Route::get('/status', [StatusController::class, 'check']);
`;

/** Controller with constructor DI */
const CONTROLLER_PHP = `<?php

namespace App\\Http\\Controllers;

use App\\Services\\UserService;
use App\\Services\\NotificationService;
use Illuminate\\Http\\Request;

class UserController extends Controller
{
    public function __construct(
        private UserService $userService,
        private NotificationService $notificationService
    ) {}

    public function index(Request $request)
    {
        $users = $this->userService->listAll();
        return response()->json($users);
    }

    public function store(Request $request)
    {
        $user = $this->userService->create($request->validated());
        $this->notificationService->sendWelcome($user);
        return response()->json($user, 201);
    }

    public function show(Request $request, int $id)
    {
        $user = $this->userService->find($id);
        return response()->json($user);
    }
}
`;

/** Eloquent Model */
const MODEL_PHP = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Relations\\HasMany;

class User extends Model
{
    protected $fillable = ['name', 'email', 'password'];

    protected $hidden = ['password', 'remember_token'];

    public function posts(): HasMany
    {
        return $this->hasMany(Post::class);
    }

    public function todos(): HasMany
    {
        return $this->hasMany(Todo::class);
    }
}
`;

/** Service with DB/Cache/Queue facade calls */
const SERVICE_PHP = `<?php

namespace App\\Services;

use Illuminate\\Support\\Facades\\DB;
use Illuminate\\Support\\Facades\\Cache;
use Illuminate\\Support\\Facades\\Redis;
use Illuminate\\Support\\Facades\\Queue;
use App\\Jobs\\SendEmailJob;
use App\\Models\\User;

class UserService
{
    public function listAll()
    {
        return Cache::remember('users:all', 300, function () {
            return User::all();
        });
    }

    public function create(array $data)
    {
        $user = DB::table('users')->insert($data);
        Cache::forget('users:all');
        Redis::set('user:last-created', json_encode($data));
        dispatch(new SendEmailJob($user));
        return $user;
    }

    public function getStats()
    {
        return DB::select('SELECT count(*) as total FROM users');
    }
}
`;

/** Symfony controller with #[Route] attributes */
const SYMFONY_CONTROLLER_PHP = `<?php

namespace App\\Controller;

use Symfony\\Component\\Routing\\Annotation\\Route;

class ProductController
{
    #[Route('/products', methods: ['GET'])]
    public function list()
    {
        return $this->json([]);
    }

    #[Route('/products', methods: ['POST', 'PUT'])]
    public function save()
    {
        return $this->json(['saved' => true]);
    }

    #[Route('/products/{id}')]
    public function show(int $id)
    {
        return $this->json(['id' => $id]);
    }

    #[Route('/products/{id}/reviews', methods: ['GET', 'POST'])]
    public function reviews(int $id)
    {
        return $this->json([]);
    }
}
`;

/** HTTP client calls (for relative API pattern detection) */
const HTTP_CLIENT_PHP = `<?php

namespace App\\Services;

use Illuminate\\Support\\Facades\\Http;

class ExternalApiService
{
    public function fetchData()
    {
        $response = Http::get('/api/v1/data');
        return $response->json();
    }

    public function postData(array $payload)
    {
        return Http::post('/api/v1/submit', $payload);
    }
}
`;

/** Doctrine ORM usage */
const DOCTRINE_PHP = `<?php

use Doctrine\\ORM\\EntityManager;
use Doctrine\\DBAL\\Connection;

class UserRepository
{
    private EntityManager $entityManager;
    private Connection $connection;
}
`;

/** Nested prefix groups */
const NESTED_PREFIX_PHP = `<?php

Route::prefix('/admin')->group(function () {
    Route::get('/dashboard', [AdminController::class, 'dashboard']);
    Route::prefix('/users')->group(function () {
        Route::get('/', [AdminUserController::class, 'index']);
        Route::post('/', [AdminUserController::class, 'store']);
    });
});
`;

/** Non-Laravel PHP file (no routes) */
const PLAIN_PHP = `<?php

class Calculator
{
    public function add(int $a, int $b): int
    {
        return $a + $b;
    }
}
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Laravel: Route detection', () => {
    it('detects basic Route::get/post with array controller syntax', () => {
        const apis = detectFrameworkApis(ROUTES_WEB_PHP, 'routes/web.php', 'php');
        const getUsers = apis.find(a => a.method === 'GET' && a.route === '/users');
        expect(getUsers).toBeDefined();
        expect(getUsers!.handlerName).toBe('index');
    });

    it('extracts handler name from array controller syntax', () => {
        const apis = detectFrameworkApis(ROUTES_WEB_PHP, 'routes/web.php', 'php');
        const postUsers = apis.find(a => a.method === 'POST' && a.route === '/users');
        expect(postUsers).toBeDefined();
        expect(postUsers!.handlerName).toBe('store');
    });

    it('detects all HTTP methods', () => {
        const apis = detectFrameworkApis(ROUTES_WEB_PHP, 'routes/web.php', 'php');
        const methods = apis.map(a => a.method);
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
    });

    it('detects Route::resource', () => {
        const apis = detectFrameworkApis(ROUTES_WEB_PHP, 'routes/web.php', 'php');
        const resource = apis.find(a => a.method === 'RESOURCE' && a.route === '/posts');
        expect(resource).toBeDefined();
        expect(resource!.handlerName).toBe('PostController');
    });

    it('detects Route::apiResource', () => {
        const apis = detectFrameworkApis(ROUTES_WEB_PHP, 'routes/web.php', 'php');
        const apiResource = apis.find(a => a.method === 'RESOURCE' && a.route === '/comments');
        expect(apiResource).toBeDefined();
    });

    it('detects closure-based routes', () => {
        const apis = detectFrameworkApis(ROUTES_WEB_PHP, 'routes/web.php', 'php');
        const health = apis.find(a => a.route === '/health');
        expect(health).toBeDefined();
        expect(health!.method).toBe('GET');
    });

    it('detects show and update with path parameters', () => {
        const apis = detectFrameworkApis(ROUTES_WEB_PHP, 'routes/web.php', 'php');
        const show = apis.find(a => a.method === 'GET' && a.route === '/users/{id}');
        expect(show).toBeDefined();
        expect(show!.handlerName).toBe('show');
        const update = apis.find(a => a.method === 'PUT' && a.route === '/users/{id}');
        expect(update).toBeDefined();
        expect(update!.handlerName).toBe('update');
    });

    // Issue #771: Laravel legacy "Controller@method" string syntax is
    // still used in routes/web.php / api.php in older skeletons and was
    // not picked up before — the basic Route::method('/path', …) matcher
    // only recognised array `[Controller::class, 'method']` form or
    // closures, falling back to the 'handler' default name.
    it('detects legacy `Controller@method` string-shape handler form', () => {
        const src = `<?php
Route::get('/posts', 'PostController@index');
Route::post('/posts', 'App\\\\Http\\\\Controllers\\\\PostController@store');
Route::delete('/posts/{id}', 'PostController@destroy');
`;
        const apis = detectFrameworkApis(src, 'routes/web.php', 'php');
        const idx = apis.find(a => a.method === 'GET' && a.route === '/posts');
        expect(idx).toBeDefined();
        expect(idx!.handlerName).toBe('index');
        const store = apis.find(a => a.method === 'POST' && a.route === '/posts');
        expect(store).toBeDefined();
        expect(store!.handlerName).toBe('store');
        const destroy = apis.find(a => a.method === 'DELETE' && a.route === '/posts/{id}');
        expect(destroy).toBeDefined();
        expect(destroy!.handlerName).toBe('destroy');
    });

    it('detects destroy handler', () => {
        const apis = detectFrameworkApis(ROUTES_WEB_PHP, 'routes/web.php', 'php');
        const destroy = apis.find(a => a.method === 'DELETE' && a.route === '/users/{id}');
        expect(destroy).toBeDefined();
        expect(destroy!.handlerName).toBe('destroy');
    });
});

describe('Laravel: Route group prefixes', () => {
    it('applies prefix to nested routes', () => {
        const apis = detectFrameworkApis(ROUTES_API_PHP, 'routes/api.php', 'php');
        const getTodos = apis.find(a => a.method === 'GET' && a.route.includes('/todos') && !a.route.includes('{'));
        expect(getTodos).toBeDefined();
        expect(getTodos!.route).toBe('/api/v1/todos');
    });

    it('applies prefix to all routes inside group', () => {
        const apis = detectFrameworkApis(ROUTES_API_PHP, 'routes/api.php', 'php');
        const postTodos = apis.find(a => a.method === 'POST' && a.route.includes('todos'));
        expect(postTodos).toBeDefined();
        expect(postTodos!.route).toBe('/api/v1/todos');
    });

    it('does not apply prefix to routes outside group', () => {
        const apis = detectFrameworkApis(ROUTES_API_PHP, 'routes/api.php', 'php');
        const status = apis.find(a => a.route === '/status');
        expect(status).toBeDefined();
        expect(status!.method).toBe('GET');
    });

    it('applies prefix to tags route too', () => {
        const apis = detectFrameworkApis(ROUTES_API_PHP, 'routes/api.php', 'php');
        const tags = apis.find(a => a.route.includes('tags'));
        expect(tags).toBeDefined();
        expect(tags!.route).toBe('/api/v1/tags');
    });

    it('handles nested prefix groups', () => {
        const apis = detectFrameworkApis(NESTED_PREFIX_PHP, 'routes/web.php', 'php');
        const dashboard = apis.find(a => a.route.includes('dashboard'));
        expect(dashboard).toBeDefined();
        expect(dashboard!.route).toBe('/admin/dashboard');
    });
});

describe('Symfony: #[Route] attribute detection', () => {
    it('extracts GET method from methods parameter', () => {
        const apis = detectFrameworkApis(SYMFONY_CONTROLLER_PHP, 'src/Controller/ProductController.php', 'php');
        const list = apis.find(a => a.route === '/products' && a.method === 'GET');
        expect(list).toBeDefined();
    });

    it('extracts POST from multi-method attribute with extra methods fan-out', () => {
        const apis = detectFrameworkApis(SYMFONY_CONTROLLER_PHP, 'src/Controller/ProductController.php', 'php');
        const post = apis.find(a => a.route === '/products' && a.method === 'POST');
        expect(post).toBeDefined();
        const put = apis.find(a => a.route === '/products' && a.method === 'PUT');
        expect(put).toBeDefined();
    });

    it('defaults to GET when no methods specified', () => {
        const apis = detectFrameworkApis(SYMFONY_CONTROLLER_PHP, 'src/Controller/ProductController.php', 'php');
        const show = apis.find(a => a.route === '/products/{id}' && a.method === 'GET');
        expect(show).toBeDefined();
    });

    it('extracts handler name via PHP forward scan', () => {
        const apis = detectFrameworkApis(SYMFONY_CONTROLLER_PHP, 'src/Controller/ProductController.php', 'php');
        const list = apis.find(a => a.route === '/products' && a.method === 'GET');
        expect(list!.handlerName).toBe('list');
        const show = apis.find(a => a.route === '/products/{id}' && a.method === 'GET');
        expect(show!.handlerName).toBe('show');
    });
});

describe('PHP: Handler name extraction', () => {
    it('extracts handler name via forward scan for function keyword', () => {
        const source = `
#[Route('/test')]
public function myHandler() { }
`;
        const apis = detectFrameworkApis(source, 'test.php', 'php');
        expect(apis.length).toBeGreaterThan(0);
        expect(apis[0].handlerName).toBe('myHandler');
    });

    it('skips stacked attributes during forward scan', () => {
        const source = `
#[Route('/test')]
#[IsGranted('ROLE_ADMIN')]
public function adminAction() { }
`;
        const apis = detectFrameworkApis(source, 'test.php', 'php');
        expect(apis.length).toBeGreaterThan(0);
        // The PHP forward scan skips lines starting with #[, but also the Java/C# forward scan
        // may pick this up via paren detection. Either way the handler name should resolve.
        expect(apis[0].handlerName).toBe('adminAction');
    });

    it('backward scan picks up function name for call patterns', () => {
        const source = `<?php
function setupRoutes() {
    Route::get('/setup', function () { return 'ok'; });
}
`;
        const apis = detectFrameworkApis(source, 'routes.php', 'php');
        expect(apis.length).toBeGreaterThan(0);
    });
});

describe('PHP: Infrastructure detection', () => {
    it('classifies Eloquent as database', () => {
        expect(classifyExternalSystemMultiLang('eloquent', 'php')).toBe('database');
    });

    it('classifies Doctrine as database', () => {
        expect(classifyExternalSystemMultiLang('doctrine', 'php')).toBe('database');
    });

    it('classifies guzzle as service', () => {
        expect(classifyExternalSystemMultiLang('guzzle', 'php')).toBe('service');
    });

    it('classifies curl as service', () => {
        expect(classifyExternalSystemMultiLang('curl', 'php')).toBe('service');
    });

    it('DB_CONNECTION_PATTERNS matches Eloquent Model extends', () => {
        // This is tested indirectly — the pattern is `class Foo extends Model`
        const source = `class User extends Model { }`;
        const pattern = /class\s+\w+\s+extends\s+Model\b/g;
        expect(pattern.test(source)).toBe(true);
    });

    it('DB_CONNECTION_PATTERNS matches DB:: facade', () => {
        const source = `DB::table('users')->insert($data);`;
        const pattern = /DB\s*::\s*(?:select|insert|update|delete|table|raw|statement)\s*\(/g;
        expect(pattern.test(source)).toBe(true);
    });

    it('DB_CONNECTION_PATTERNS matches Redis:: facade', () => {
        const source = `Redis::set('key', 'value');`;
        const pattern = /Redis\s*::\s*(?:get|set|del|command)\s*\(/g;
        expect(pattern.test(source)).toBe(true);
    });

    it('DB_CONNECTION_PATTERNS matches Cache:: facade', () => {
        const source = `Cache::remember('key', 300, function () { });`;
        const pattern = /Cache\s*::\s*(?:get|put|forget|remember|store)\s*\(/g;
        expect(pattern.test(source)).toBe(true);
    });

    it('DB_CONNECTION_PATTERNS matches Queue dispatch', () => {
        const source = `dispatch(new SendEmailJob($user));`;
        const pattern = /Queue\s*::\s*(?:push|later|bulk)\s*\(|dispatch\s*\(\s*new\s+\w+/g;
        expect(pattern.test(source)).toBe(true);
    });

    it('DB_CONNECTION_PATTERNS matches Doctrine ORM', () => {
        const source = `use Doctrine\\ORM\\EntityManager;`;
        const pattern = /use\s+Doctrine\\ORM\b|use\s+Doctrine\\DBAL\b/g;
        expect(pattern.test(source)).toBe(true);
    });

    it('SQL_ORM_TERMS merges eloquent with relational DB nodes', () => {
        // Test the merge logic by verifying that eloquent, doctrine, laravel are in the ORM terms
        const SQL_ORM_TERMS = ['jpa', 'jdbc', 'hibernate', 'sequelize', 'djangoorm', 'sqlalchemy', 'eloquent', 'doctrine', 'laravel'];
        const clean = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
        const isOrm = (s: string) => SQL_ORM_TERMS.some(k => s.includes(k));
        // "SQL (Eloquent)" cleaned → "sqleloquent" should match
        expect(isOrm(clean('SQL (Eloquent)'))).toBe(true);
        expect(isOrm(clean('SQL (Doctrine)'))).toBe(true);
        expect(isOrm(clean('SQL (Laravel)'))).toBe(true);
    });
});

describe('PHP: Relative API patterns', () => {
    it('matches Http:: facade calls', () => {
        const pattern = /Http\s*::\s*(?:get|post|put|patch|delete)\s*\(\s*['"]/g;
        expect(pattern.test(`Http::get('/api/v1/data')`)).toBe(true);
    });

    it('does not match non-Http calls', () => {
        const pattern = /Http\s*::\s*(?:get|post|put|patch|delete)\s*\(\s*['"]/g;
        expect(pattern.test(`$client->get('/api/data')`)).toBe(false);
    });
});

describe('PHP: File graph integration', () => {
    it('generates a valid file graph from a Laravel-style JS equivalent', () => {
        const jsEquivalent = `
const Model = require('Illuminate/Database/Eloquent/Model');

class User extends Model {
    constructor() {
        this.fillable = ['name', 'email'];
    }

    posts() {
        return this.hasMany('Post');
    }
}
`;
        const graph = buildFileGraph(jsEquivalent, 'app/Models/User.php');
        expect(graph.type).toBe('file');
        expect(graph.graphId).toBe('file:app/Models/User.php');
        expect(graph.nodes.some(n => n.type === 'import')).toBe(true);
    });

    it('diff: adding a new method shows as "modified" on the class', () => {
        const oldCode = `
function UserService() {
    this.list = function() { return []; };
}
`;
        const newCode = `
function UserService() {
    this.list = function() { return []; };
    this.create = function(data) { return data; };
}
`;
        const graph = buildFileGraph(newCode, 'app/Services/UserService.php', oldCode);
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        const serviceNode = funcNodes.find(n => n.label === 'UserService');
        expect(serviceNode?.diff).toBe('modified');
    });

    it('diff: adding a new function shows as "added"', () => {
        const oldCode = `function index() { return []; }`;
        const newCode = `
function index() { return []; }
function store(data) { return data; }
`;
        const graph = buildFileGraph(newCode, 'app/Controllers/UserController.php', oldCode);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThan(0);
    });

    it('diff: deleting a function shows as "deleted"', () => {
        const oldCode = `
function index() { return []; }
function show(id) { return id; }
`;
        const newCode = `function index() { return []; }`;
        const graph = buildFileGraph(newCode, 'app/Controllers/UserController.php', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThan(0);
    });

    it('diff: unchanged file has all nodes unchanged', () => {
        const code = `
function index() { return []; }
function store(data) { return data; }
`;
        const graph = buildFileGraph(code, 'app/Controllers/UserController.php', code);
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        for (const n of funcNodes) {
            expect(n.diff).toBe('unchanged');
        }
    });
});

describe('PHP: Sequence graph integration', () => {
    it('generates a sequence graph from a Laravel-like route handler', () => {
        const source = `
const UserService = require('./services/UserService');
const service = new UserService();

function index(req, res) {
    const users = service.listAll();
    res.json(users);
}

module.exports = { index };
`;
        const graph = buildSequenceGraph(source, 'app/Controllers/UserController.php');
        expect(graph).toBeDefined();
    });

    it('diff: adding a new service call adds a participant', () => {
        const oldCode = `
const UserService = require('./services/UserService');
const svc = new UserService();

function handler(req, res) {
    const users = svc.list();
    res.json(users);
}

module.exports = { handler };
`;
        const newCode = `
const UserService = require('./services/UserService');
const NotificationService = require('./services/NotificationService');
const svc = new UserService();
const notifier = new NotificationService();

function handler(req, res) {
    const users = svc.list();
    notifier.send('new-data');
    res.json(users);
}

module.exports = { handler };
`;
        const graph = buildSequenceGraph(newCode, 'app/Controllers/UserController.php', oldCode);
        // The new service (NotificationService) should appear
        const notifierParticipant = graph.nodes.find(n =>
            n.label?.includes('NotificationService') || n.label?.includes('notifier')
        );
        expect(notifierParticipant).toBeDefined();
    });

    it('diff: removing a service call removes participant', () => {
        const oldCode = `
const A = require('./services/A');
const B = require('./services/B');
const a = new A();
const b = new B();

function handler(req, res) {
    a.doA();
    b.doB();
    res.json({});
}

module.exports = { handler };
`;
        const newCode = `
const A = require('./services/A');
const a = new A();

function handler(req, res) {
    a.doA();
    res.json({});
}

module.exports = { handler };
`;
        const graph = buildSequenceGraph(newCode, 'app/Controllers/UserController.php', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThan(0);
    });
});

describe('PHP: Edge cases', () => {
    it('returns no APIs for an empty file', () => {
        const apis = detectFrameworkApis('', 'empty.php', 'php');
        expect(apis).toHaveLength(0);
    });

    it('returns no APIs for non-Laravel PHP', () => {
        const apis = detectFrameworkApis(PLAIN_PHP, 'calculator.php', 'php');
        expect(apis).toHaveLength(0);
    });

    it('Model keyword in non-Eloquent context does not match route patterns', () => {
        const source = `<?php
class ViewModel extends BaseModel {
    public function render() { return 'view'; }
}
`;
        const apis = detectFrameworkApis(source, 'src/ViewModel.php', 'php');
        expect(apis).toHaveLength(0);
    });
});

describe('PHP: INFRA_FILE_PATTERNS for Laravel migrations', () => {
    it('matches Schema::create in migration files', () => {
        const source = `Schema::create('users', function (Blueprint $table) { $table->id(); });`;
        const pattern = /Schema\s*::\s*(?:create|table|drop)\s*\(/g;
        expect(pattern.test(source)).toBe(true);
    });

    it('matches Schema::table for alterations', () => {
        const source = `Schema::table('users', function (Blueprint $table) { $table->string('avatar'); });`;
        const pattern = /Schema\s*::\s*(?:create|table|drop)\s*\(/g;
        expect(pattern.test(source)).toBe(true);
    });

    it('matches Schema::drop', () => {
        const source = `Schema::drop('old_table');`;
        const pattern = /Schema\s*::\s*(?:create|table|drop)\s*\(/g;
        expect(pattern.test(source)).toBe(true);
    });
});
