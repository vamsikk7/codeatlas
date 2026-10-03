/**
 * kotlinSwiftIntegration.test.ts
 *
 * Comprehensive integration tests for Kotlin (Ktor + Spring Boot) and Swift
 * (Vapor) framework support in CodeAtlas. Covers:
 *   - Ktor: get/post/put/delete route detection
 *   - Kotlin Spring Boot: @GetMapping, @PostMapping etc. (same annotations as Java)
 *   - Vapor: app.get, app.post, routes.get, group.post detection
 *   - System classification for Kotlin and Swift ecosystems
 *   - File graph generation + diff (JS-equivalent)
 *   - Sequence graph generation + diff (JS-equivalent)
 *   - False positive prevention for non-route Kotlin/Swift code
 *   - Handler name extraction for Kotlin/Swift patterns
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis, classifyExternalSystemMultiLang } from '../frameworkDetector';
import { buildFileGraph } from '../../graph/fileGraphBuilder';
import { buildSequenceGraph } from '../../graph/sequenceGraphBuilder';

// ─── Fixtures: Kotlin / Ktor ──────────────────────────────────────────────────

/** Ktor application with routing DSL */
const KTOR_APPLICATION_KT = `
package com.example

import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.netty.*

fun main() {
    embeddedServer(Netty, port = 8080) {
        routing {
            get("/") {
                call.respondText("Hello, Ktor!")
            }

            get("/api/health") {
                call.respondText("OK")
            }

            post("/api/todos") {
                val todo = call.receive<TodoDto>()
                val created = todoService.create(todo)
                call.respond(created)
            }

            put("/api/todos/{id}") {
                val id = call.parameters["id"]!!.toLong()
                val dto = call.receive<TodoDto>()
                val updated = todoService.update(id, dto)
                call.respond(updated)
            }

            delete("/api/todos/{id}") {
                val id = call.parameters["id"]!!.toLong()
                todoService.delete(id)
                call.respond(HttpStatusCode.NoContent)
            }

            patch("/api/todos/{id}/complete") {
                val id = call.parameters["id"]!!.toLong()
                todoService.markComplete(id)
                call.respond(HttpStatusCode.OK)
            }
        }
    }.start(wait = true)
}
`;

/** Ktor routes module with multiple endpoints */
const KTOR_ROUTES_KT = `
package com.example.routes

import io.ktor.server.routing.*
import io.ktor.server.response.*
import io.ktor.server.request.*
import io.ktor.http.*

fun Route.todoRoutes(service: TodoService) {
    get("/todos") {
        val todos = service.findAll()
        call.respond(todos)
    }

    get("/todos/{id}") {
        val id = call.parameters["id"]!!.toLong()
        val todo = service.findById(id)
        call.respond(todo)
    }

    post("/todos") {
        val dto = call.receive<CreateTodoDto>()
        val created = service.create(dto)
        call.respond(HttpStatusCode.Created, created)
    }

    delete("/todos/{id}") {
        val id = call.parameters["id"]!!.toLong()
        service.delete(id)
        call.respond(HttpStatusCode.NoContent)
    }
}

fun Route.userRoutes(userService: UserService) {
    get("/users") {
        call.respond(userService.findAll())
    }

    post("/users") {
        val dto = call.receive<CreateUserDto>()
        call.respond(HttpStatusCode.Created, userService.create(dto))
    }

    get("/users/{id}") {
        val id = call.parameters["id"]!!.toLong()
        call.respond(userService.findById(id))
    }
}
`;

// ─── Fixtures: Kotlin / Spring Boot ───────────────────────────────────────────

/** Kotlin Spring Boot @RestController */
const SPRING_BOOT_CONTROLLER_KT = `
package com.example.controllers

import org.springframework.web.bind.annotation.*
import org.springframework.http.ResponseEntity

@RestController
@RequestMapping("/api/products")
class ProductController(
    private val productService: ProductService,
    private val auditService: AuditService
) {

    @GetMapping
    fun listProducts(): ResponseEntity<List<ProductDto>> {
        return ResponseEntity.ok(productService.findAll())
    }

    @GetMapping("/{id}")
    fun getProduct(@PathVariable id: Long): ResponseEntity<ProductDto> {
        return ResponseEntity.ok(productService.findById(id))
    }

    @PostMapping
    fun createProduct(@RequestBody dto: ProductDto): ResponseEntity<ProductDto> {
        val created = productService.create(dto)
        auditService.log("product_created", created.id)
        return ResponseEntity.ok(created)
    }

    @PutMapping("/{id}")
    fun updateProduct(@PathVariable id: Long, @RequestBody dto: ProductDto): ResponseEntity<ProductDto> {
        return ResponseEntity.ok(productService.update(id, dto))
    }

    @DeleteMapping("/{id}")
    fun deleteProduct(@PathVariable id: Long): ResponseEntity<Void> {
        productService.delete(id)
        return ResponseEntity.noContent().build()
    }

    @PatchMapping("/{id}/discount")
    fun applyDiscount(@PathVariable id: Long, @RequestBody discount: DiscountDto): ResponseEntity<ProductDto> {
        return ResponseEntity.ok(productService.applyDiscount(id, discount))
    }

    @RequestMapping(value = ["/export"], method = [RequestMethod.GET])
    fun exportProducts(): ResponseEntity<ByteArray> {
        return ResponseEntity.ok(productService.exportToCsv())
    }
}
`;

/** Kotlin data class / service (non-route) */
const KOTLIN_SERVICE_KT = `
package com.example.services

import org.springframework.stereotype.Service

@Service
class ProductService(
    private val repository: ProductRepository,
    private val cacheManager: CacheManager
) {

    fun findAll(): List<ProductDto> {
        return repository.findAll().map { it.toDto() }
    }

    fun findById(id: Long): ProductDto {
        return repository.findById(id).orElseThrow().toDto()
    }

    fun create(dto: ProductDto): ProductDto {
        val product = Product.fromDto(dto)
        return repository.save(product).toDto()
    }

    fun update(id: Long, dto: ProductDto): ProductDto {
        val product = repository.findById(id).orElseThrow()
        product.update(dto)
        return repository.save(product).toDto()
    }

    fun delete(id: Long) {
        repository.deleteById(id)
    }
}
`;

/** Kotlin data classes (non-route) */
const KOTLIN_DATA_CLASS_KT = `
package com.example.models

import javax.persistence.*

@Entity
@Table(name = "products")
data class Product(
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    val id: Long = 0,
    val name: String,
    val price: Double,
    val active: Boolean = true
) {
    fun toDto() = ProductDto(id, name, price, active)
    fun update(dto: ProductDto) { /* ... */ }
}

data class ProductDto(
    val id: Long,
    val name: String,
    val price: Double,
    val active: Boolean
)

data class DiscountDto(
    val percentage: Double,
    val reason: String
)
`;

// ─── Fixtures: Swift / Vapor ──────────────────────────────────────────────────

/** Vapor routes.swift with app.get, app.post, and group routes */
const VAPOR_ROUTES_SWIFT = `
import Vapor

func routes(_ app: Application) throws {
    app.get("hello") { req in
        return "Hello, world!"
    }

    app.get("health") { req in
        return ["status": "ok"]
    }

    app.post("todos") { req -> Todo in
        let dto = try req.content.decode(CreateTodoDTO.self)
        let todo = Todo(title: dto.title)
        try await todo.save(on: req.db)
        return todo
    }

    app.get("todos") { req -> [Todo] in
        try await Todo.query(on: req.db).all()
    }

    app.delete("todos") { req -> HTTPStatus in
        let todo = try await Todo.find(req.parameters.get("id"), on: req.db)
        try await todo?.delete(on: req.db)
        return .noContent
    }

    app.put("settings") { req -> HTTPStatus in
        return .ok
    }

    app.patch("profile") { req -> HTTPStatus in
        return .ok
    }

    // group routes use "routes" variable which matches the pattern
    routes.get("users") { req -> [User] in
        try await User.query(on: req.db).all()
    }

    routes.post("users") { req -> User in
        let user = try req.content.decode(User.self)
        try await user.save(on: req.db)
        return user
    }

    group.get("dashboard") { req in
        return ["page": "admin dashboard"]
    }

    group.delete("cache") { req -> HTTPStatus in
        try await req.cache.clear()
        return .ok
    }
}
`;

/** Vapor Controller with route registrations using routes variable */
const VAPOR_CONTROLLER_SWIFT = `
import Vapor

struct TodoController: RouteCollection {
    func boot(routes: RoutesBuilder) throws {
        routes.get("all") { req -> [Todo] in
            try await Todo.query(on: req.db).all()
        }

        routes.get("active") { req -> [Todo] in
            try await Todo.query(on: req.db)
                .filter(\\.$isCompleted == false)
                .all()
        }

        routes.post("create") { req -> Todo in
            let dto = try req.content.decode(CreateTodoDTO.self)
            let todo = Todo(title: dto.title)
            try await todo.save(on: req.db)
            return todo
        }

        routes.put("update") { req -> Todo in
            let dto = try req.content.decode(UpdateTodoDTO.self)
            guard let todo = try await Todo.find(dto.id, on: req.db) else {
                throw Abort(.notFound)
            }
            todo.title = dto.title
            try await todo.save(on: req.db)
            return todo
        }

        routes.delete("remove") { req -> HTTPStatus in
            let id = try req.parameters.require("id", as: UUID.self)
            guard let todo = try await Todo.find(id, on: req.db) else {
                throw Abort(.notFound)
            }
            try await todo.delete(on: req.db)
            return .noContent
        }

        app.get("status") { req in
            return "ok"
        }
    }
}
`;

/** Vapor model (non-route) */
const VAPOR_MODEL_SWIFT = `
import Fluent
import Vapor

final class Todo: Model, Content {
    static let schema = "todos"

    @ID(key: .id)
    var id: UUID?

    @Field(key: "title")
    var title: String

    @Field(key: "is_completed")
    var isCompleted: Bool

    @Timestamp(key: "created_at", on: .create)
    var createdAt: Date?

    init() {}

    init(id: UUID? = nil, title: String, isCompleted: Bool = false) {
        self.id = id
        self.title = title
        self.isCompleted = isCompleted
    }
}
`;

/** Swift non-route utility */
const SWIFT_UTILITY = `
import Foundation

struct DateFormatter {
    static func formatISO(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        return formatter.string(from: date)
    }

    static func parse(_ string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: string)
    }
}
`;

// ─── Tests: Ktor ──────────────────────────────────────────────────────────────

describe('Ktor: get/post/put/delete route detection', () => {
    it('detects get("/") route', () => {
        const apis = detectFrameworkApis(KTOR_APPLICATION_KT, 'Application.kt', 'kotlin');
        const rootGet = apis.find(a => a.method === 'GET' && a.route === '/');
        expect(rootGet).toBeDefined();
    });

    it('detects get("/api/health") route', () => {
        const apis = detectFrameworkApis(KTOR_APPLICATION_KT, 'Application.kt', 'kotlin');
        const healthGet = apis.find(a => a.method === 'GET' && a.route === '/api/health');
        expect(healthGet).toBeDefined();
    });

    it('detects post("/api/todos") route', () => {
        const apis = detectFrameworkApis(KTOR_APPLICATION_KT, 'Application.kt', 'kotlin');
        const todosPost = apis.find(a => a.method === 'POST' && a.route === '/api/todos');
        expect(todosPost).toBeDefined();
    });

    it('detects put("/api/todos/{id}") route', () => {
        const apis = detectFrameworkApis(KTOR_APPLICATION_KT, 'Application.kt', 'kotlin');
        const todosPut = apis.find(a => a.method === 'PUT' && a.route === '/api/todos/{id}');
        expect(todosPut).toBeDefined();
    });

    it('detects delete("/api/todos/{id}") route', () => {
        const apis = detectFrameworkApis(KTOR_APPLICATION_KT, 'Application.kt', 'kotlin');
        const todosDelete = apis.find(a => a.method === 'DELETE' && a.route === '/api/todos/{id}');
        expect(todosDelete).toBeDefined();
    });

    it('detects patch route with compound path', () => {
        const apis = detectFrameworkApis(KTOR_APPLICATION_KT, 'Application.kt', 'kotlin');
        const patchComplete = apis.find(a => a.method === 'PATCH' && a.route.includes('/complete'));
        expect(patchComplete).toBeDefined();
    });

    it('detects all routes from Ktor routes module', () => {
        const apis = detectFrameworkApis(KTOR_ROUTES_KT, 'TodoRoutes.kt', 'kotlin');
        const methods = apis.map(a => a.method);
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
        expect(methods).toContain('DELETE');
    });

    it('detects todo routes from routes module', () => {
        const apis = detectFrameworkApis(KTOR_ROUTES_KT, 'TodoRoutes.kt', 'kotlin');
        const todoGet = apis.find(a => a.method === 'GET' && a.route === '/todos');
        const todoPost = apis.find(a => a.method === 'POST' && a.route === '/todos');
        expect(todoGet).toBeDefined();
        expect(todoPost).toBeDefined();
    });

    it('detects user routes from routes module', () => {
        const apis = detectFrameworkApis(KTOR_ROUTES_KT, 'TodoRoutes.kt', 'kotlin');
        const userGet = apis.find(a => a.method === 'GET' && a.route === '/users');
        const userPost = apis.find(a => a.method === 'POST' && a.route === '/users');
        expect(userGet).toBeDefined();
        expect(userPost).toBeDefined();
    });

    it('detects get route with path parameter from routes module', () => {
        const apis = detectFrameworkApis(KTOR_ROUTES_KT, 'TodoRoutes.kt', 'kotlin');
        const todoById = apis.find(a => a.method === 'GET' && a.route === '/todos/{id}');
        expect(todoById).toBeDefined();
    });

    it('produces valid ApiRecord shape for Ktor routes', () => {
        const apis = detectFrameworkApis(KTOR_APPLICATION_KT, 'Application.kt', 'kotlin');
        for (const api of apis) {
            expect(api.apiId).toBeTruthy();
            expect(api.method).toBeTruthy();
            expect(api.route).toBeTruthy();
            expect(api.filePath).toBe('Application.kt');
            expect(api.anchor).toBeDefined();
        }
    });
});

// ─── Tests: Kotlin Spring Boot ────────────────────────────────────────────────

describe('Kotlin Spring Boot: @GetMapping, @PostMapping etc.', () => {
    it('detects @GetMapping (no-arg) with class prefix', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_CONTROLLER_KT, 'ProductController.kt', 'kotlin');
        const listProducts = apis.find(a => a.method === 'GET' && a.route === '/api/products');
        expect(listProducts).toBeDefined();
        expect(listProducts!.handlerName).toBe('listProducts');
    });

    it('detects @GetMapping("/{id}") with class prefix', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_CONTROLLER_KT, 'ProductController.kt', 'kotlin');
        const getProduct = apis.find(a => a.method === 'GET' && a.route === '/api/products/{id}');
        expect(getProduct).toBeDefined();
        expect(getProduct!.handlerName).toBe('getProduct');
    });

    it('detects @PostMapping (no-arg) with class prefix', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_CONTROLLER_KT, 'ProductController.kt', 'kotlin');
        const createProduct = apis.find(a => a.method === 'POST' && a.route === '/api/products');
        expect(createProduct).toBeDefined();
        expect(createProduct!.handlerName).toBe('createProduct');
    });

    it('detects @PutMapping("/{id}") with class prefix', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_CONTROLLER_KT, 'ProductController.kt', 'kotlin');
        const updateProduct = apis.find(a => a.method === 'PUT' && a.route === '/api/products/{id}');
        expect(updateProduct).toBeDefined();
        expect(updateProduct!.handlerName).toBe('updateProduct');
    });

    it('detects @DeleteMapping("/{id}") with class prefix', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_CONTROLLER_KT, 'ProductController.kt', 'kotlin');
        const deleteProduct = apis.find(a => a.method === 'DELETE' && a.route === '/api/products/{id}');
        expect(deleteProduct).toBeDefined();
        expect(deleteProduct!.handlerName).toBe('deleteProduct');
    });

    it('detects @PatchMapping("/{id}/discount") with class prefix', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_CONTROLLER_KT, 'ProductController.kt', 'kotlin');
        const discount = apis.find(a => a.method === 'PATCH' && a.route === '/api/products/{id}/discount');
        expect(discount).toBeDefined();
        expect(discount!.handlerName).toBe('applyDiscount');
    });

    it('detects @RequestMapping with method array syntax', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_CONTROLLER_KT, 'ProductController.kt', 'kotlin');
        const exportApi = apis.find(a => a.route === '/api/products/export');
        expect(exportApi).toBeDefined();
        expect(exportApi!.handlerName).toBe('exportProducts');
    });

    it('suppresses class-level @RequestMapping from route list', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_CONTROLLER_KT, 'ProductController.kt', 'kotlin');
        const classLevel = apis.find(a => a.handlerName === 'ProductController' && a.method === 'GET');
        expect(classLevel).toBeUndefined();
    });

    it('does not produce duplicate routes', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_CONTROLLER_KT, 'ProductController.kt', 'kotlin');
        const seen = new Set<string>();
        for (const api of apis) {
            const key = `${api.method}:${api.route}:${api.handlerName}`;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
        }
    });
});

// ─── Tests: Vapor (Swift) ─────────────────────────────────────────────────────

describe('Vapor: app.get, app.post, routes.get, group.post detection', () => {
    it('detects app.get("hello") route', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        const hello = apis.find(a => a.method === 'GET' && a.route === '/hello');
        expect(hello).toBeDefined();
    });

    it('detects app.get("health") route', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        const health = apis.find(a => a.method === 'GET' && a.route === '/health');
        expect(health).toBeDefined();
    });

    it('detects app.post("todos") route', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        const todosPost = apis.find(a => a.method === 'POST' && a.route === '/todos');
        expect(todosPost).toBeDefined();
    });

    it('detects app.get("todos") route', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        const todosGet = apis.find(a => a.method === 'GET' && a.route === '/todos');
        expect(todosGet).toBeDefined();
    });

    it('detects app.delete("todos") route', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        const todosDelete = apis.find(a => a.method === 'DELETE' && a.route === '/todos');
        expect(todosDelete).toBeDefined();
    });

    it('detects routes.get("users") via routes variable', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        const usersGet = apis.find(a => a.method === 'GET' && a.route === '/users');
        expect(usersGet).toBeDefined();
    });

    it('detects routes.post("users") via routes variable', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        const usersPost = apis.find(a => a.method === 'POST' && a.route === '/users');
        expect(usersPost).toBeDefined();
    });

    it('detects group.get("dashboard") via group variable', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        const dashboard = apis.find(a => a.method === 'GET' && a.route === '/dashboard');
        expect(dashboard).toBeDefined();
    });

    it('detects group.delete("cache") via group variable', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        const clearCache = apis.find(a => a.method === 'DELETE' && a.route === '/cache');
        expect(clearCache).toBeDefined();
    });

    it('detects app.put("settings") route', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        const settings = apis.find(a => a.method === 'PUT' && a.route === '/settings');
        expect(settings).toBeDefined();
    });

    it('detects app.patch("profile") route', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        const profile = apis.find(a => a.method === 'PATCH' && a.route === '/profile');
        expect(profile).toBeDefined();
    });

    it('produces valid ApiRecord shape for Vapor routes', () => {
        const apis = detectFrameworkApis(VAPOR_ROUTES_SWIFT, 'routes.swift', 'swift');
        for (const api of apis) {
            expect(api.apiId).toBeTruthy();
            expect(api.method).toBeTruthy();
            expect(api.route).toBeTruthy();
            expect(api.filePath).toBe('routes.swift');
            expect(api.anchor).toBeDefined();
        }
    });
});

describe('Vapor: Controller route detection', () => {
    it('detects routes.get("all") from controller', () => {
        const apis = detectFrameworkApis(VAPOR_CONTROLLER_SWIFT, 'TodoController.swift', 'swift');
        const getAll = apis.find(a => a.method === 'GET' && a.route === '/all');
        expect(getAll).toBeDefined();
    });

    it('detects routes.get("active") from controller', () => {
        const apis = detectFrameworkApis(VAPOR_CONTROLLER_SWIFT, 'TodoController.swift', 'swift');
        const getActive = apis.find(a => a.method === 'GET' && a.route === '/active');
        expect(getActive).toBeDefined();
    });

    it('detects routes.post("create") from controller', () => {
        const apis = detectFrameworkApis(VAPOR_CONTROLLER_SWIFT, 'TodoController.swift', 'swift');
        const create = apis.find(a => a.method === 'POST' && a.route === '/create');
        expect(create).toBeDefined();
    });

    it('detects routes.put("update") from controller', () => {
        const apis = detectFrameworkApis(VAPOR_CONTROLLER_SWIFT, 'TodoController.swift', 'swift');
        const update = apis.find(a => a.method === 'PUT' && a.route === '/update');
        expect(update).toBeDefined();
    });

    it('detects routes.delete("remove") from controller', () => {
        const apis = detectFrameworkApis(VAPOR_CONTROLLER_SWIFT, 'TodoController.swift', 'swift');
        const remove = apis.find(a => a.method === 'DELETE' && a.route === '/remove');
        expect(remove).toBeDefined();
    });

    it('detects app.get("status") from controller', () => {
        const apis = detectFrameworkApis(VAPOR_CONTROLLER_SWIFT, 'TodoController.swift', 'swift');
        const status = apis.find(a => a.method === 'GET' && a.route === '/status');
        expect(status).toBeDefined();
    });

    it('detects all CRUD operations from controller', () => {
        const apis = detectFrameworkApis(VAPOR_CONTROLLER_SWIFT, 'TodoController.swift', 'swift');
        const methods = apis.map(a => a.method);
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
    });
});

// ─── Tests: Kotlin System Classification ──────────────────────────────────────

describe('Kotlin: System classification (same as Java patterns)', () => {
    it('classifies hibernate as database', () => {
        expect(classifyExternalSystemMultiLang('hibernate', 'kotlin')).toBe('database');
    });

    it('classifies jpa as database', () => {
        expect(classifyExternalSystemMultiLang('jpa', 'kotlin')).toBe('database');
    });

    it('classifies mybatis as database', () => {
        expect(classifyExternalSystemMultiLang('mybatis', 'kotlin')).toBe('database');
    });

    it('classifies resttemplate as service', () => {
        expect(classifyExternalSystemMultiLang('resttemplate', 'kotlin')).toBe('service');
    });

    it('classifies webclient as service', () => {
        expect(classifyExternalSystemMultiLang('webclient', 'kotlin')).toBe('service');
    });

    it('classifies retrofit as service', () => {
        expect(classifyExternalSystemMultiLang('retrofit', 'kotlin')).toBe('service');
    });

    it('classifies kafka as queue', () => {
        expect(classifyExternalSystemMultiLang('kafka', 'kotlin')).toBe('queue');
    });

    it('classifies redis as cache', () => {
        expect(classifyExternalSystemMultiLang('redis', 'kotlin')).toBe('cache');
    });

    it('classifies unknown kotlin lib as module', () => {
        expect(classifyExternalSystemMultiLang('com.example.custom', 'kotlin')).toBe('module');
    });
});

// ─── Tests: Swift System Classification ───────────────────────────────────────

describe('Swift: System classification', () => {
    it('classifies fluent as database', () => {
        expect(classifyExternalSystemMultiLang('fluent', 'swift')).toBe('database');
    });

    it('classifies redis as cache', () => {
        expect(classifyExternalSystemMultiLang('redis', 'swift')).toBe('cache');
    });

    it('classifies unknown swift lib as module', () => {
        expect(classifyExternalSystemMultiLang('SwiftNIO', 'swift')).toBe('module');
    });

    it('classifies http-related lib as service', () => {
        expect(classifyExternalSystemMultiLang('http', 'swift')).toBe('service');
    });
});

// ─── Tests: File graph (JS-equivalent) ────────────────────────────────────────

describe('Kotlin/Swift: File graph generation (JS-equivalent)', () => {
    it('generates file graph from Kotlin controller-like structure', () => {
        const jsEquivalent = `
const ProductService = require('./services/ProductService');
const AuditService = require('./services/AuditService');

class ProductController {
    constructor(productService, auditService) {
        this.productService = productService;
        this.auditService = auditService;
    }

    listProducts() {
        return this.productService.findAll();
    }

    createProduct(dto) {
        const created = this.productService.create(dto);
        this.auditService.log("product_created", created.id);
        return created;
    }
}
`;
        const graph = buildFileGraph(jsEquivalent, 'com/example/ProductController.kt');
        expect(graph.type).toBe('file');
        expect(graph.graphId).toBe('file:com/example/ProductController.kt');
        expect(graph.nodes.some(n => n.type === 'import')).toBe(true);
    });

    it('generates file graph from Swift routes-like structure', () => {
        const jsEquivalent = `
const db = require('fluent');

function listTodos(req, res) {
    const todos = db.query('todos');
    return res.json(todos);
}

function createTodo(req, res) {
    const todo = db.insert('todos', req.body);
    return res.json(todo);
}
`;
        const graph = buildFileGraph(jsEquivalent, 'Sources/App/routes.swift');
        expect(graph.type).toBe('file');
        expect(graph.graphId).toBe('file:Sources/App/routes.swift');
        expect(graph.nodes.some(n => n.type === 'function')).toBe(true);
    });
});

describe('Kotlin/Swift: File graph diff evaluation', () => {
    it('diff: adding a Kotlin endpoint shows as "added"', () => {
        const oldCode = `
function listProducts() { return []; }
`;
        const newCode = `
function listProducts() { return []; }
function createProduct(dto) { return dto; }
`;
        const graph = buildFileGraph(newCode, 'ProductController.kt', oldCode);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
        expect(addedNodes.some(n => n.label === 'createProduct')).toBe(true);
    });

    it('diff: modifying a Swift route handler shows as "modified"', () => {
        const oldCode = `
function listTodos() { return []; }
`;
        const newCode = `
function listTodos() {
    const cached = cache.get('todos');
    return cached || [];
}
`;
        const graph = buildFileGraph(newCode, 'routes.swift', oldCode);
        const modifiedNodes = graph.nodes.filter(n => n.diff === 'modified');
        expect(modifiedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: deleting a Kotlin endpoint shows as "deleted"', () => {
        const oldCode = `
function listProducts() { return []; }
function getProduct(id) { return id; }
function legacySearch() { return null; }
`;
        const newCode = `
function listProducts() { return []; }
function getProduct(id) { return id; }
`;
        const graph = buildFileGraph(newCode, 'ProductController.kt', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
        expect(deletedNodes.some(n => n.label.includes('legacySearch'))).toBe(true);
    });

    it('diff: unchanged Kotlin code keeps all nodes "unchanged"', () => {
        const code = `
function listProducts() { return []; }
function getProduct(id) { return id; }
`;
        const graph = buildFileGraph(code, 'ProductController.kt', code);
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        for (const n of funcNodes) {
            expect(n.diff).toBe('unchanged');
        }
    });

    it('diff: unchanged Swift code keeps all nodes "unchanged"', () => {
        const code = `
function listTodos() { return []; }
function createTodo(dto) { return dto; }
`;
        const graph = buildFileGraph(code, 'routes.swift', code);
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        for (const n of funcNodes) {
            expect(n.diff).toBe('unchanged');
        }
    });

    it('diff: file root node becomes "modified" when children change', () => {
        const oldCode = `function list() { return []; }`;
        const newCode = `
function list() { return []; }
function create(dto) { return dto; }
`;
        const graph = buildFileGraph(newCode, 'ProductController.kt', oldCode);
        const fileNode = graph.nodes.find(n => n.type === 'file');
        expect(fileNode?.diff).toBe('modified');
    });
});

// ─── Tests: Sequence graph (JS-equivalent) ────────────────────────────────────

describe('Kotlin/Swift: Sequence graph generation (JS-equivalent)', () => {
    const ktorStyleCode = `
const ProductRepository = require('./repositories/ProductRepository');
const CacheManager = require('./cache/CacheManager');

const repo = new ProductRepository();
const cache = new CacheManager();

async function listProducts(req, res) {
    const cached = await cache.get('products:all');
    if (cached) return res.json(cached);
    const products = await repo.findAll();
    cache.set('products:all', products, 300);
    return res.json(products);
}

async function createProduct(req, res) {
    const product = await repo.save(req.body);
    cache.invalidate('products:all');
    return res.json(product);
}

module.exports = { listProducts, createProduct };
`;

    it('generates sequence graph with correct type for Kotlin', () => {
        const graph = buildSequenceGraph(ktorStyleCode, 'ProductRoutes.kt');
        expect(graph.type).toBe('sequence');
    });

    it('generates graphId using Kotlin file path', () => {
        const graph = buildSequenceGraph(ktorStyleCode, 'ProductRoutes.kt');
        expect(graph.graphId).toBe('sequence:ProductRoutes.kt');
    });

    it('has participant nodes for Kotlin sequence', () => {
        const graph = buildSequenceGraph(ktorStyleCode, 'ProductRoutes.kt');
        const participants = graph.nodes.filter(n => n.type === 'participant');
        expect(participants.length).toBeGreaterThanOrEqual(1);
    });

    it('generates graphId using Swift file path', () => {
        const graph = buildSequenceGraph(ktorStyleCode, 'routes.swift');
        expect(graph.graphId).toBe('sequence:routes.swift');
    });

    it('has message edges for service calls', () => {
        const graph = buildSequenceGraph(ktorStyleCode, 'ProductRoutes.kt');
        const messages = graph.edges.filter(e => e.edgeType === 'message');
        expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('detects repository participant', () => {
        const graph = buildSequenceGraph(ktorStyleCode, 'ProductRoutes.kt');
        const repoNode = graph.nodes.find(n =>
            n.label?.includes('ProductRepository') || n.label?.includes('repo')
        );
        expect(repoNode).toBeDefined();
    });

    it('detects cache participant', () => {
        const graph = buildSequenceGraph(ktorStyleCode, 'ProductRoutes.kt');
        const cacheNode = graph.nodes.find(n =>
            n.label?.includes('CacheManager') || n.label?.includes('cache')
        );
        expect(cacheNode).toBeDefined();
    });
});

describe('Kotlin/Swift: Sequence graph diff evaluation', () => {
    it('diff: adding a new service call adds participant', () => {
        const oldCode = `
const ProductRepository = require('./repositories/ProductRepository');
const repo = new ProductRepository();

async function createProduct(req, res) {
    const product = await repo.save(req.body);
    return res.json(product);
}

module.exports = { createProduct };
`;
        const newCode = `
const ProductRepository = require('./repositories/ProductRepository');
const EventBus = require('./events/EventBus');
const repo = new ProductRepository();
const events = new EventBus();

async function createProduct(req, res) {
    const product = await repo.save(req.body);
    await events.publish('product.created', product);
    return res.json(product);
}

module.exports = { createProduct };
`;
        const graph = buildSequenceGraph(newCode, 'ProductRoutes.kt', oldCode);
        const eventNode = graph.nodes.find(n =>
            n.label?.includes('EventBus') || n.label?.includes('events')
        );
        expect(eventNode).toBeDefined();
    });

    it('diff: removing a service call marks participant as deleted', () => {
        const oldCode = `
const ProductRepository = require('./repositories/ProductRepository');
const MetricsCollector = require('./monitoring/MetricsCollector');
const repo = new ProductRepository();
const metrics = new MetricsCollector();

async function createProduct(req, res) {
    const product = await repo.save(req.body);
    metrics.increment('products.created');
    return res.json(product);
}

module.exports = { createProduct };
`;
        const newCode = `
const ProductRepository = require('./repositories/ProductRepository');
const repo = new ProductRepository();

async function createProduct(req, res) {
    const product = await repo.save(req.body);
    return res.json(product);
}

module.exports = { createProduct };
`;
        const graph = buildSequenceGraph(newCode, 'ProductRoutes.kt', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: Swift sequence graph detects added participant', () => {
        const oldCode = `
const db = require('./db');

async function listTodos(req, res) {
    const todos = await db.query('todos');
    return res.json(todos);
}

module.exports = { listTodos };
`;
        const newCode = `
const db = require('./db');
const cache = require('./cache');

async function listTodos(req, res) {
    const cached = await cache.get('todos');
    if (cached) return res.json(cached);
    const todos = await db.query('todos');
    cache.set('todos', todos, 60);
    return res.json(todos);
}

module.exports = { listTodos };
`;
        const graph = buildSequenceGraph(newCode, 'routes.swift', oldCode);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
    });
});

// ─── Tests: No false positives ────────────────────────────────────────────────

describe('Kotlin/Swift: No false positives for non-route code', () => {
    it('Kotlin service class produces no API routes', () => {
        const apis = detectFrameworkApis(KOTLIN_SERVICE_KT, 'ProductService.kt', 'kotlin');
        const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        const httpRoutes = apis.filter(a => httpMethods.includes(a.method));
        expect(httpRoutes.length).toBe(0);
    });

    it('Kotlin data classes produce no API routes', () => {
        const apis = detectFrameworkApis(KOTLIN_DATA_CLASS_KT, 'Product.kt', 'kotlin');
        const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        const httpRoutes = apis.filter(a => httpMethods.includes(a.method));
        expect(httpRoutes.length).toBe(0);
    });

    it('Swift model class produces no API routes', () => {
        const apis = detectFrameworkApis(VAPOR_MODEL_SWIFT, 'Todo.swift', 'swift');
        expect(apis).toHaveLength(0);
    });

    it('Swift utility class produces no API routes', () => {
        const apis = detectFrameworkApis(SWIFT_UTILITY, 'DateFormatter.swift', 'swift');
        expect(apis).toHaveLength(0);
    });

    it('empty Kotlin file produces no API routes', () => {
        const apis = detectFrameworkApis('', 'Empty.kt', 'kotlin');
        expect(apis).toHaveLength(0);
    });

    it('empty Swift file produces no API routes', () => {
        const apis = detectFrameworkApis('', 'Empty.swift', 'swift');
        expect(apis).toHaveLength(0);
    });

    it('Kotlin main function produces no API routes', () => {
        const source = `
fun main(args: Array<String>) {
    println("Hello, World!")
}
`;
        const apis = detectFrameworkApis(source, 'Main.kt', 'kotlin');
        const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        const httpRoutes = apis.filter(a => httpMethods.includes(a.method));
        expect(httpRoutes.length).toBe(0);
    });

    it('Swift struct without routes produces no API routes', () => {
        const source = `
struct Config {
    let host: String
    let port: Int
    let databaseURL: String

    static let production = Config(
        host: "0.0.0.0",
        port: 8080,
        databaseURL: "postgres://localhost/mydb"
    )
}
`;
        const apis = detectFrameworkApis(source, 'Config.swift', 'swift');
        expect(apis).toHaveLength(0);
    });
});

// ─── Tests: Handler name extraction ───────────────────────────────────────────

describe('Kotlin: Handler name extraction', () => {
    it('extracts handler name from Kotlin fun after Spring annotation', () => {
        const source = `
@RestController
class TestController {
    @GetMapping("/test")
    fun testEndpoint(): String = "ok"
}
`;
        const apis = detectFrameworkApis(source, 'TestController.kt', 'kotlin');
        const api = apis.find(a => a.route.includes('/test'));
        expect(api?.handlerName).toBe('testEndpoint');
    });

    it('extracts handler name from suspend fun', () => {
        const source = `
@RestController
class AsyncController {
    @GetMapping("/async")
    suspend fun asyncEndpoint(): ResponseEntity<String> {
        return ResponseEntity.ok("async")
    }
}
`;
        const apis = detectFrameworkApis(source, 'AsyncController.kt', 'kotlin');
        const api = apis.find(a => a.route.includes('/async'));
        expect(api?.handlerName).toBe('asyncEndpoint');
    });

    it('extracts handler name from internal fun', () => {
        const source = `
@RestController
class InternalController {
    @PostMapping("/internal")
    internal fun internalEndpoint(): String = "ok"
}
`;
        const apis = detectFrameworkApis(source, 'InternalController.kt', 'kotlin');
        const api = apis.find(a => a.route.includes('/internal'));
        expect(api?.handlerName).toBe('internalEndpoint');
    });

    it('extracts handler name from override fun', () => {
        const source = `
@RestController
class OverrideController : BaseController() {
    @GetMapping("/override")
    override fun handleRequest(): String = "overridden"
}
`;
        const apis = detectFrameworkApis(source, 'OverrideController.kt', 'kotlin');
        const api = apis.find(a => a.route.includes('/override'));
        expect(api?.handlerName).toBe('handleRequest');
    });

    it('extracts handler name with generic return type', () => {
        const source = `
@RestController
class GenericController {
    @GetMapping("/items")
    fun getItems(): ResponseEntity<List<ItemDto>> {
        return ResponseEntity.ok(listOf())
    }
}
`;
        const apis = detectFrameworkApis(source, 'GenericController.kt', 'kotlin');
        const api = apis.find(a => a.route.includes('/items'));
        expect(api?.handlerName).toBe('getItems');
    });
});

describe('Swift: Handler name extraction', () => {
    it('extracts function name from Vapor route handler context', () => {
        // Vapor routes are typically closures, so handler name comes from nearest function
        const source = `
func configureRoutes(_ app: Application) throws {
    app.get("ping") { req in
        return "pong"
    }
}
`;
        const apis = detectFrameworkApis(source, 'routes.swift', 'swift');
        const ping = apis.find(a => a.route === '/ping');
        expect(ping).toBeDefined();
        expect(ping!.handlerName).toBeTruthy();
    });

    it('extracts handler name from grouped routes context', () => {
        const source = `
func userRoutes(_ routes: RoutesBuilder) {
    routes.get("profile") { req in
        return "profile"
    }
}
`;
        const apis = detectFrameworkApis(source, 'UserRoutes.swift', 'swift');
        const profile = apis.find(a => a.route === '/profile');
        expect(profile).toBeDefined();
        expect(profile!.handlerName).toBeTruthy();
    });
});
