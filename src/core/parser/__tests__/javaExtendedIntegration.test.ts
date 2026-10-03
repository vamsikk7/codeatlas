/**
 * javaExtendedIntegration.test.ts
 *
 * Comprehensive integration tests for Java JAX-RS, Micronaut, and extended
 * Spring Boot support in CodeAtlas. Covers:
 *   - JAX-RS: @GET, @POST, @PUT, @DELETE, @Path, @PathParam
 *   - Micronaut: @Get, @Post, @Put, @Delete with paths
 *   - Spring Boot extended: @RequestMapping variants, class-level prefix,
 *     no-arg annotations, package-private methods
 *   - System classification: hibernate, jpa, mybatis, resttemplate, webclient,
 *     feign, kafka, redis
 *   - File graph generation + diff coloring (JS-equivalent)
 *   - Sequence graph generation + diff (JS-equivalent)
 *   - False positive prevention: repository, service, model, DTO classes
 *   - Handler name extraction for all access modifiers
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis, classifyExternalSystemMultiLang } from '../frameworkDetector';
import { buildFileGraph } from '../../graph/fileGraphBuilder';
import { buildSequenceGraph } from '../../graph/sequenceGraphBuilder';

// ─── Fixtures: JAX-RS ─────────────────────────────────────────────────────────

/** JAX-RS resource class with full CRUD */
const JAX_RS_RESOURCE_JAVA = `
package com.example.resources;

import javax.ws.rs.*;
import javax.ws.rs.core.MediaType;
import javax.ws.rs.core.Response;

@Path("/todos")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class TodoResource {

    @GET
    public Response listTodos() {
        return Response.ok(todoService.findAll()).build();
    }

    @GET
    @Path("/{id}")
    public Response getTodo(@PathParam("id") Long id) {
        return Response.ok(todoService.findById(id)).build();
    }

    @POST
    public Response createTodo(TodoDto dto) {
        Todo created = todoService.create(dto);
        return Response.status(Response.Status.CREATED).entity(created).build();
    }

    @PUT
    @Path("/{id}")
    public Response updateTodo(@PathParam("id") Long id, TodoDto dto) {
        Todo updated = todoService.update(id, dto);
        return Response.ok(updated).build();
    }

    @DELETE
    @Path("/{id}")
    public Response deleteTodo(@PathParam("id") Long id) {
        todoService.delete(id);
        return Response.noContent().build();
    }

    @PATCH
    @Path("/{id}/complete")
    public Response completeTodo(@PathParam("id") Long id) {
        todoService.markComplete(id);
        return Response.ok().build();
    }
}
`;

/** JAX-RS Application config class (should produce no API routes) */
const JAX_RS_APPLICATION_JAVA = `
package com.example;

import javax.ws.rs.ApplicationPath;
import javax.ws.rs.core.Application;
import java.util.Set;
import java.util.HashSet;

@ApplicationPath("/api")
public class RestApplication extends Application {

    @Override
    public Set<Class<?>> getClasses() {
        Set<Class<?>> classes = new HashSet<>();
        classes.add(TodoResource.class);
        classes.add(UserResource.class);
        return classes;
    }
}
`;

// ─── Fixtures: Micronaut ──────────────────────────────────────────────────────

/** Micronaut controller with full CRUD endpoints */
const MICRONAUT_CONTROLLER_JAVA = `
package com.example.controllers;

import io.micronaut.http.annotation.*;
import io.micronaut.http.HttpResponse;
import javax.inject.Inject;

@Controller("/api/products")
public class ProductController {

    @Inject
    private ProductService productService;

    @Get("/")
    public HttpResponse<?> listProducts() {
        return HttpResponse.ok(productService.findAll());
    }

    @Get("/{id}")
    public HttpResponse<?> getProduct(Long id) {
        return HttpResponse.ok(productService.findById(id));
    }

    @Post("/")
    public HttpResponse<?> createProduct(@Body ProductDto dto) {
        return HttpResponse.created(productService.create(dto));
    }

    @Put("/{id}")
    public HttpResponse<?> updateProduct(Long id, @Body ProductDto dto) {
        return HttpResponse.ok(productService.update(id, dto));
    }

    @Delete("/{id}")
    public HttpResponse<?> deleteProduct(Long id) {
        productService.delete(id);
        return HttpResponse.noContent();
    }

    @Patch("/{id}/activate")
    public HttpResponse<?> activateProduct(Long id) {
        productService.activate(id);
        return HttpResponse.ok();
    }
}
`;

/** Micronaut service class (non-route, should not produce API records) */
const MICRONAUT_SERVICE_JAVA = `
package com.example.services;

import javax.inject.Singleton;
import java.util.List;
import java.util.Optional;

@Singleton
public class ProductService {

    private final ProductRepository repository;

    public ProductService(ProductRepository repository) {
        this.repository = repository;
    }

    public List<Product> findAll() {
        return repository.findAll();
    }

    public Optional<Product> findById(Long id) {
        return repository.findById(id);
    }

    public Product create(ProductDto dto) {
        return repository.save(new Product(dto));
    }

    public Product update(Long id, ProductDto dto) {
        Product product = repository.findById(id).orElseThrow();
        product.update(dto);
        return repository.save(product);
    }

    public void delete(Long id) {
        repository.deleteById(id);
    }

    public void activate(Long id) {
        Product product = repository.findById(id).orElseThrow();
        product.setActive(true);
        repository.save(product);
    }
}
`;

// ─── Fixtures: Spring Boot Extended ───────────────────────────────────────────

/** Comprehensive Spring Boot controller with all mapping variants */
const SPRING_BOOT_FULL_CONTROLLER_JAVA = `
package com.example.controllers;

import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping
    public List<OrderDto> listOrders() {
        return orderService.findAll();
    }

    @GetMapping("/{id}")
    public ResponseEntity<OrderDto> getOrder(@PathVariable Long id) {
        return ResponseEntity.ok(orderService.findById(id));
    }

    @PostMapping
    public ResponseEntity<OrderDto> createOrder(@RequestBody OrderDto dto) {
        return ResponseEntity.ok(orderService.create(dto));
    }

    @PostMapping("/bulk")
    public ResponseEntity<List<OrderDto>> createBulkOrders(@RequestBody List<OrderDto> dtos) {
        return ResponseEntity.ok(orderService.createBulk(dtos));
    }

    @PutMapping("/{id}")
    public ResponseEntity<OrderDto> updateOrder(@PathVariable Long id, @RequestBody OrderDto dto) {
        return ResponseEntity.ok(orderService.update(id, dto));
    }

    @PatchMapping("/{id}/status")
    public ResponseEntity<OrderDto> updateStatus(@PathVariable Long id, @RequestBody Map<String, String> status) {
        return ResponseEntity.ok(orderService.updateStatus(id, status));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteOrder(@PathVariable Long id) {
        orderService.delete(id);
        return ResponseEntity.noContent().build();
    }

    @RequestMapping(value = "/export", method = RequestMethod.GET)
    public ResponseEntity<byte[]> exportOrders() {
        return ResponseEntity.ok(orderService.exportToCsv());
    }

    @RequestMapping(path = "/import", method = RequestMethod.POST)
    public ResponseEntity<Void> importOrders(@RequestBody byte[] data) {
        orderService.importFromCsv(data);
        return ResponseEntity.ok().build();
    }

    @RequestMapping(value = "/archive", method = RequestMethod.PUT)
    public ResponseEntity<Void> archiveOrders() {
        orderService.archiveAll();
        return ResponseEntity.ok().build();
    }
}
`;

/** JPA repository (non-route, for infra classification) */
const SPRING_BOOT_REPOSITORY_JAVA = `
package com.example.repositories;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;
import java.util.List;

@Repository
public interface OrderRepository extends JpaRepository<Order, Long> {

    List<Order> findByStatus(String status);

    @Query("SELECT o FROM Order o WHERE o.customer.id = :customerId")
    List<Order> findByCustomerId(Long customerId);

    @Query(value = "SELECT * FROM orders WHERE total > ?1", nativeQuery = true)
    List<Order> findExpensiveOrders(double minTotal);
}
`;

/** Service using RestTemplate and WebClient (for system classification) */
const SPRING_BOOT_SERVICE_JAVA = `
package com.example.services;

import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.data.redis.core.RedisTemplate;

@Service
public class OrderService {

    private final RestTemplate restTemplate;
    private final WebClient webClient;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final RedisTemplate<String, Object> redisTemplate;

    public OrderService(RestTemplate restTemplate, WebClient webClient,
                        KafkaTemplate kafkaTemplate, RedisTemplate redisTemplate) {
        this.restTemplate = restTemplate;
        this.webClient = webClient;
        this.kafkaTemplate = kafkaTemplate;
        this.redisTemplate = redisTemplate;
    }

    public void notifyPaymentService(Long orderId) {
        restTemplate.postForObject("/api/payments", orderId, Void.class);
    }

    public void notifyShippingAsync(Long orderId) {
        webClient.post().uri("/api/shipping").bodyValue(orderId).retrieve().bodyToMono(Void.class);
    }

    public void publishOrderEvent(String event) {
        kafkaTemplate.send("orders-topic", event);
    }

    public void cacheOrder(Long id, Object order) {
        redisTemplate.opsForValue().set("order:" + id, order);
    }
}
`;

/** Model / DTO classes (no routes expected) */
const SPRING_BOOT_MODEL_JAVA = `
package com.example.models;

import javax.persistence.*;
import lombok.Data;

@Entity
@Table(name = "orders")
@Data
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String status;

    @Column(nullable = false)
    private double total;

    @ManyToOne
    @JoinColumn(name = "customer_id")
    private Customer customer;
}
`;

const SPRING_BOOT_DTO_JAVA = `
package com.example.dto;

import lombok.Data;
import lombok.Builder;

@Data
@Builder
public class OrderDto {
    private Long id;
    private String status;
    private double total;
    private Long customerId;
    private String customerName;
}
`;

// ─── Tests: JAX-RS ────────────────────────────────────────────────────────────

describe('JAX-RS: @GET, @POST, @PUT, @DELETE, @Path detection', () => {
    it('detects @GET annotation', () => {
        const apis = detectFrameworkApis(JAX_RS_RESOURCE_JAVA, 'TodoResource.java', 'java');
        const getApis = apis.filter(a => a.method === 'GET');
        expect(getApis.length).toBeGreaterThanOrEqual(1);
    });

    it('detects @POST annotation', () => {
        const apis = detectFrameworkApis(JAX_RS_RESOURCE_JAVA, 'TodoResource.java', 'java');
        const postApis = apis.filter(a => a.method === 'POST');
        expect(postApis.length).toBeGreaterThanOrEqual(1);
    });

    it('detects @PUT annotation', () => {
        const apis = detectFrameworkApis(JAX_RS_RESOURCE_JAVA, 'TodoResource.java', 'java');
        const putApis = apis.filter(a => a.method === 'PUT');
        expect(putApis.length).toBeGreaterThanOrEqual(1);
    });

    it('detects @DELETE annotation', () => {
        const apis = detectFrameworkApis(JAX_RS_RESOURCE_JAVA, 'TodoResource.java', 'java');
        const deleteApis = apis.filter(a => a.method === 'DELETE');
        expect(deleteApis.length).toBeGreaterThanOrEqual(1);
    });

    it('detects @PATCH annotation', () => {
        const apis = detectFrameworkApis(JAX_RS_RESOURCE_JAVA, 'TodoResource.java', 'java');
        const patchApis = apis.filter(a => a.method === 'PATCH');
        expect(patchApis.length).toBeGreaterThanOrEqual(1);
    });

    it('merges a method @Path into its HTTP-verb record; class @Path is not an entry (BUG-EXP-16)', () => {
        const apis = detectFrameworkApis(JAX_RS_RESOURCE_JAVA, 'TodoResource.java', 'java');
        // Class-level @Path("/todos") is a base prefix — never a standalone PATH entry.
        // Every method here has an HTTP verb, so NO record should carry method 'PATH'.
        expect(apis.some(a => a.method === 'PATH')).toBe(false);
        expect(apis.some(a => a.method === 'PATH' && a.route === '/todos')).toBe(false);
        // @GET/@PUT/@DELETE + @Path("/{id}") collapse to a single verb record whose
        // route is the @Path value (not a duplicate `GET /` + `PATH /{id}`).
        expect(apis.some(a => a.method === 'GET' && a.route === '/{id}')).toBe(true);
        expect(apis.some(a => a.method === 'PUT' && a.route === '/{id}')).toBe(true);
        expect(apis.some(a => a.method === 'DELETE' && a.route === '/{id}')).toBe(true);
    });

    it('extracts handler name from method following annotation', () => {
        const apis = detectFrameworkApis(JAX_RS_RESOURCE_JAVA, 'TodoResource.java', 'java');
        const handlerNames = apis.map(a => a.handlerName);
        expect(handlerNames).toContain('listTodos');
        expect(handlerNames).toContain('getTodo');
        expect(handlerNames).toContain('createTodo');
        expect(handlerNames).toContain('updateTodo');
        expect(handlerNames).toContain('deleteTodo');
    });

    it('produces valid ApiRecord shape for all detected APIs', () => {
        const apis = detectFrameworkApis(JAX_RS_RESOURCE_JAVA, 'TodoResource.java', 'java');
        for (const api of apis) {
            expect(api.apiId).toBeTruthy();
            expect(api.method).toBeTruthy();
            expect(api.handlerName).toBeTruthy();
            expect(api.filePath).toBe('TodoResource.java');
            expect(api.anchor).toBeDefined();
            expect(api.anchor.filePath).toBe('TodoResource.java');
        }
    });

    it('detects @Path with sub-path /{id}/complete', () => {
        const apis = detectFrameworkApis(JAX_RS_RESOURCE_JAVA, 'TodoResource.java', 'java');
        const completePath = apis.find(a => a.route.includes('/complete'));
        expect(completePath).toBeDefined();
    });

    it('does not detect routes from JAX-RS Application class', () => {
        const apis = detectFrameworkApis(JAX_RS_APPLICATION_JAVA, 'RestApplication.java', 'java');
        // @ApplicationPath is not a route annotation, should not be detected
        const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        const httpRoutes = apis.filter(a => httpMethods.includes(a.method));
        expect(httpRoutes.length).toBe(0);
    });
});

// ─── Tests: Micronaut ─────────────────────────────────────────────────────────

describe('Micronaut: @Get, @Post, @Put, @Delete detection', () => {
    it('detects @Get("/") annotation', () => {
        const apis = detectFrameworkApis(MICRONAUT_CONTROLLER_JAVA, 'ProductController.java', 'java');
        const getApis = apis.filter(a => a.method === 'GET');
        expect(getApis.length).toBeGreaterThanOrEqual(1);
    });

    it('detects @Get with path parameter /{id}', () => {
        const apis = detectFrameworkApis(MICRONAUT_CONTROLLER_JAVA, 'ProductController.java', 'java');
        const getById = apis.find(a => a.method === 'GET' && a.route === '/{id}');
        expect(getById).toBeDefined();
    });

    it('detects @Post annotation', () => {
        const apis = detectFrameworkApis(MICRONAUT_CONTROLLER_JAVA, 'ProductController.java', 'java');
        const postApis = apis.filter(a => a.method === 'POST');
        expect(postApis.length).toBeGreaterThanOrEqual(1);
    });

    it('detects @Put annotation with path', () => {
        const apis = detectFrameworkApis(MICRONAUT_CONTROLLER_JAVA, 'ProductController.java', 'java');
        const putApis = apis.filter(a => a.method === 'PUT');
        expect(putApis.length).toBeGreaterThanOrEqual(1);
    });

    it('detects @Delete annotation with path', () => {
        const apis = detectFrameworkApis(MICRONAUT_CONTROLLER_JAVA, 'ProductController.java', 'java');
        const deleteApis = apis.filter(a => a.method === 'DELETE');
        expect(deleteApis.length).toBeGreaterThanOrEqual(1);
    });

    it('detects @Patch annotation with path', () => {
        const apis = detectFrameworkApis(MICRONAUT_CONTROLLER_JAVA, 'ProductController.java', 'java');
        const patchApis = apis.filter(a => a.method === 'PATCH');
        expect(patchApis.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts correct handler names from Micronaut controller', () => {
        const apis = detectFrameworkApis(MICRONAUT_CONTROLLER_JAVA, 'ProductController.java', 'java');
        const handlerNames = apis.map(a => a.handlerName);
        expect(handlerNames).toContain('listProducts');
        expect(handlerNames).toContain('getProduct');
        expect(handlerNames).toContain('createProduct');
        expect(handlerNames).toContain('updateProduct');
        expect(handlerNames).toContain('deleteProduct');
    });

    it('detects activate endpoint with compound path /{id}/activate', () => {
        const apis = detectFrameworkApis(MICRONAUT_CONTROLLER_JAVA, 'ProductController.java', 'java');
        const activate = apis.find(a => a.route.includes('/activate'));
        expect(activate).toBeDefined();
        expect(activate!.handlerName).toBe('activateProduct');
    });

    it('does not detect routes from Micronaut service class', () => {
        const apis = detectFrameworkApis(MICRONAUT_SERVICE_JAVA, 'ProductService.java', 'java');
        expect(apis).toHaveLength(0);
    });
});

// ─── Tests: Spring Boot Extended ──────────────────────────────────────────────

describe('Spring Boot Extended: comprehensive @RequestMapping variants', () => {
    it('detects @GetMapping without path (inherits class prefix)', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        const listOrders = apis.find(a => a.method === 'GET' && a.route === '/api/orders');
        expect(listOrders).toBeDefined();
        expect(listOrders!.handlerName).toBe('listOrders');
    });

    it('detects @GetMapping("/{id}") with class prefix', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        const getOrder = apis.find(a => a.method === 'GET' && a.route === '/api/orders/{id}');
        expect(getOrder).toBeDefined();
        expect(getOrder!.handlerName).toBe('getOrder');
    });

    it('detects @PostMapping without path', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        const createOrder = apis.find(a => a.method === 'POST' && a.route === '/api/orders');
        expect(createOrder).toBeDefined();
        expect(createOrder!.handlerName).toBe('createOrder');
    });

    it('detects @PostMapping("/bulk") with class prefix', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        const bulkOrders = apis.find(a => a.method === 'POST' && a.route === '/api/orders/bulk');
        expect(bulkOrders).toBeDefined();
        expect(bulkOrders!.handlerName).toBe('createBulkOrders');
    });

    it('detects @PutMapping("/{id}") with class prefix', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        const updateOrder = apis.find(a => a.method === 'PUT' && a.route === '/api/orders/{id}');
        expect(updateOrder).toBeDefined();
        expect(updateOrder!.handlerName).toBe('updateOrder');
    });

    it('detects @PatchMapping("/{id}/status") with class prefix', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        const updateStatus = apis.find(a => a.method === 'PATCH' && a.route === '/api/orders/{id}/status');
        expect(updateStatus).toBeDefined();
        expect(updateStatus!.handlerName).toBe('updateStatus');
    });

    it('detects @DeleteMapping("/{id}") with class prefix', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        const deleteOrder = apis.find(a => a.method === 'DELETE' && a.route === '/api/orders/{id}');
        expect(deleteOrder).toBeDefined();
        expect(deleteOrder!.handlerName).toBe('deleteOrder');
    });

    it('detects @RequestMapping(value="/export", method=RequestMethod.GET)', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        const exportOrders = apis.find(a => a.method === 'GET' && a.route === '/api/orders/export');
        expect(exportOrders).toBeDefined();
        expect(exportOrders!.handlerName).toBe('exportOrders');
    });

    it('detects @RequestMapping(path="/import", method=RequestMethod.POST)', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        const importOrders = apis.find(a => a.method === 'POST' && a.route === '/api/orders/import');
        expect(importOrders).toBeDefined();
        expect(importOrders!.handlerName).toBe('importOrders');
    });

    it('detects @RequestMapping(value="/archive", method=RequestMethod.PUT)', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        const archiveOrders = apis.find(a => a.method === 'PUT' && a.route === '/api/orders/archive');
        expect(archiveOrders).toBeDefined();
        expect(archiveOrders!.handlerName).toBe('archiveOrders');
    });

    it('suppresses class-level @RequestMapping from route list', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        // Class-level @RequestMapping("/api/orders") should NOT appear as a standalone route
        const classLevelRoute = apis.find(a => a.method === 'GET' && a.route === '/api/orders' && a.handlerName === 'OrderController');
        expect(classLevelRoute).toBeUndefined();
    });

    it('does not produce duplicate routes for annotations with explicit paths', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_FULL_CONTROLLER_JAVA, 'OrderController.java', 'java');
        // Each unique method+route combination should appear only once
        const seen = new Set<string>();
        for (const api of apis) {
            const key = `${api.method}:${api.route}:${api.handlerName}`;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
        }
    });
});

describe('Spring Boot: class-level @RequestMapping prefix handling', () => {
    it('prepends base path to all method-level routes', () => {
        const source = `
@RestController
@RequestMapping("/api/v2/items")
public class ItemController {
    @GetMapping("/search")
    public List<Item> search() {}

    @PostMapping("/create")
    public Item create() {}
}
`;
        const apis = detectFrameworkApis(source, 'ItemController.java', 'java');
        const search = apis.find(a => a.route === '/api/v2/items/search');
        const create = apis.find(a => a.route === '/api/v2/items/create');
        expect(search).toBeDefined();
        expect(create).toBeDefined();
    });

    it('handles class-level @RequestMapping with value= syntax', () => {
        const source = `
@RestController
@RequestMapping(value = "/api/catalog")
public class CatalogController {
    @GetMapping("/categories")
    public List<Category> listCategories() {}
}
`;
        const apis = detectFrameworkApis(source, 'CatalogController.java', 'java');
        const categories = apis.find(a => a.route === '/api/catalog/categories');
        expect(categories).toBeDefined();
    });

    it('handles class-level @RequestMapping with path= syntax', () => {
        const source = `
@RestController
@RequestMapping(path = "/api/users")
public class UserController {
    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) {}
}
`;
        const apis = detectFrameworkApis(source, 'UserController.java', 'java');
        const deleteUser = apis.find(a => a.method === 'DELETE' && a.route === '/api/users/{id}');
        expect(deleteUser).toBeDefined();
    });

    it('no-arg annotations map to base path when class-level prefix exists', () => {
        const source = `
@RestController
@RequestMapping("/api/tasks")
public class TaskController {
    @GetMapping
    public List<Task> list() {}

    @PostMapping
    public Task create() {}
}
`;
        const apis = detectFrameworkApis(source, 'TaskController.java', 'java');
        const getList = apis.find(a => a.method === 'GET' && a.route === '/api/tasks');
        const postCreate = apis.find(a => a.method === 'POST' && a.route === '/api/tasks');
        expect(getList).toBeDefined();
        expect(postCreate).toBeDefined();
    });
});

describe('Spring Boot: no-arg annotations (inherit prefix)', () => {
    it('no-arg @GetMapping produces route = "/" when no class prefix', () => {
        const source = `
@RestController
public class SimpleController {
    @GetMapping
    public String index() { return "ok"; }
}
`;
        const apis = detectFrameworkApis(source, 'SimpleController.java', 'java');
        const getApi = apis.find(a => a.method === 'GET');
        expect(getApi).toBeDefined();
        expect(getApi!.route).toBe('/');
    });

    it('no-arg @PostMapping inherits class prefix', () => {
        const source = `
@RestController
@RequestMapping("/api/notifications")
public class NotificationController {
    @PostMapping
    public void send() {}
}
`;
        const apis = detectFrameworkApis(source, 'NotificationController.java', 'java');
        const postApi = apis.find(a => a.method === 'POST');
        expect(postApi).toBeDefined();
        expect(postApi!.route).toBe('/api/notifications');
    });

    it('no-arg @DeleteMapping inherits class prefix', () => {
        const source = `
@RestController
@RequestMapping("/api/cache")
public class CacheController {
    @DeleteMapping
    public void clearAll() {}
}
`;
        const apis = detectFrameworkApis(source, 'CacheController.java', 'java');
        const deleteApi = apis.find(a => a.method === 'DELETE');
        expect(deleteApi).toBeDefined();
        expect(deleteApi!.route).toBe('/api/cache');
    });

    it('no-arg @PutMapping inherits class prefix', () => {
        const source = `
@RestController
@RequestMapping("/api/config")
public class ConfigController {
    @PutMapping
    public void updateConfig() {}
}
`;
        const apis = detectFrameworkApis(source, 'ConfigController.java', 'java');
        const putApi = apis.find(a => a.method === 'PUT');
        expect(putApi).toBeDefined();
        expect(putApi!.route).toBe('/api/config');
    });

    it('no-arg @PatchMapping inherits class prefix', () => {
        const source = `
@RestController
@RequestMapping("/api/settings")
public class SettingsController {
    @PatchMapping
    public void patchSettings() {}
}
`;
        const apis = detectFrameworkApis(source, 'SettingsController.java', 'java');
        const patchApi = apis.find(a => a.method === 'PATCH');
        expect(patchApi).toBeDefined();
        expect(patchApi!.route).toBe('/api/settings');
    });
});

// ─── Tests: System classification ─────────────────────────────────────────────

describe('Java: System classification', () => {
    it('classifies hibernate as database', () => {
        expect(classifyExternalSystemMultiLang('hibernate', 'java')).toBe('database');
    });

    it('classifies jpa as database', () => {
        expect(classifyExternalSystemMultiLang('jpa', 'java')).toBe('database');
    });

    it('classifies mybatis as database', () => {
        expect(classifyExternalSystemMultiLang('mybatis', 'java')).toBe('database');
    });

    it('classifies jdbc as database', () => {
        expect(classifyExternalSystemMultiLang('jdbc', 'java')).toBe('database');
    });

    it('classifies r2dbc as database', () => {
        expect(classifyExternalSystemMultiLang('r2dbc', 'java')).toBe('database');
    });

    it('classifies resttemplate as service', () => {
        expect(classifyExternalSystemMultiLang('resttemplate', 'java')).toBe('service');
    });

    it('classifies webclient as service', () => {
        expect(classifyExternalSystemMultiLang('webclient', 'java')).toBe('service');
    });

    it('classifies feign as service', () => {
        expect(classifyExternalSystemMultiLang('feign', 'java')).toBe('service');
    });

    it('classifies retrofit as service', () => {
        expect(classifyExternalSystemMultiLang('retrofit', 'java')).toBe('service');
    });

    it('classifies kafka as queue', () => {
        expect(classifyExternalSystemMultiLang('kafka', 'java')).toBe('queue');
    });

    it('classifies redis as cache', () => {
        expect(classifyExternalSystemMultiLang('redis', 'java')).toBe('cache');
    });

    it('classifies caffeine as cache', () => {
        expect(classifyExternalSystemMultiLang('caffeine', 'java')).toBe('cache');
    });

    it('classifies rabbitmq as queue', () => {
        expect(classifyExternalSystemMultiLang('rabbitmq', 'java')).toBe('queue');
    });

    it('classifies unknown Java library as module', () => {
        expect(classifyExternalSystemMultiLang('com.example.custom.lib', 'java')).toBe('module');
    });
});

// ─── Tests: File graph generation (JS-equivalent) ─────────────────────────────

describe('Java: File graph generation (JS-equivalent)', () => {
    it('generates a valid file graph from a controller-like structure', () => {
        const jsEquivalent = `
const OrderService = require('./services/OrderService');

class OrderController {
    constructor(orderService) {
        this.orderService = orderService;
    }

    listOrders() {
        return this.orderService.findAll();
    }

    getOrder(id) {
        return this.orderService.findById(id);
    }

    createOrder(dto) {
        return this.orderService.create(dto);
    }

    deleteOrder(id) {
        this.orderService.delete(id);
    }
}
`;
        const graph = buildFileGraph(jsEquivalent, 'com/example/OrderController.java');
        expect(graph.type).toBe('file');
        expect(graph.graphId).toBe('file:com/example/OrderController.java');
        expect(graph.nodes.some(n => n.type === 'import')).toBe(true);
        expect(graph.nodes.length).toBeGreaterThan(0);
    });

    it('generates file graph from repository-like structure', () => {
        const jsEquivalent = `
const JpaRepository = require('org.springframework.data.jpa.repository');

class OrderRepository extends JpaRepository {
    findByStatus(status) { return []; }
    findByCustomerId(customerId) { return []; }
}
`;
        const graph = buildFileGraph(jsEquivalent, 'com/example/OrderRepository.java');
        expect(graph.type).toBe('file');
        expect(graph.nodes.some(n => n.type === 'import')).toBe(true);
    });
});

// ─── Tests: File graph diff ───────────────────────────────────────────────────

describe('Java: File graph diff evaluation', () => {
    it('diff: adding a new endpoint method shows as "added"', () => {
        const oldCode = `
function listOrders() { return []; }
function getOrder(id) { return id; }
`;
        const newCode = `
function listOrders() { return []; }
function getOrder(id) { return id; }
function createOrder(dto) { return dto; }
`;
        const graph = buildFileGraph(newCode, 'OrderController.java', oldCode);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
        expect(addedNodes.some(n => n.label === 'createOrder')).toBe(true);
    });

    it('diff: modifying an endpoint method shows as "modified"', () => {
        const oldCode = `
function listOrders() { return []; }
`;
        const newCode = `
function listOrders() {
    const orders = db.findAll();
    return orders.map(o => o.toDto());
}
`;
        const graph = buildFileGraph(newCode, 'OrderController.java', oldCode);
        const modifiedNodes = graph.nodes.filter(n => n.diff === 'modified');
        expect(modifiedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: deleting an endpoint method shows as "deleted"', () => {
        const oldCode = `
function listOrders() { return []; }
function getOrder(id) { return id; }
function legacyExport() { return null; }
`;
        const newCode = `
function listOrders() { return []; }
function getOrder(id) { return id; }
`;
        const graph = buildFileGraph(newCode, 'OrderController.java', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
        expect(deletedNodes.some(n => n.label.includes('legacyExport'))).toBe(true);
    });

    it('diff: unchanged code keeps all nodes as "unchanged"', () => {
        const code = `
function listOrders() { return []; }
function getOrder(id) { return id; }
`;
        const graph = buildFileGraph(code, 'OrderController.java', code);
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
        const graph = buildFileGraph(newCode, 'OrderController.java', oldCode);
        const fileNode = graph.nodes.find(n => n.type === 'file');
        expect(fileNode?.diff).toBe('modified');
    });
});

// ─── Tests: Sequence graph generation (JS-equivalent) ─────────────────────────

describe('Java: Sequence graph generation (JS-equivalent)', () => {
    const springStyleSequenceCode = `
const OrderRepository = require('./repositories/OrderRepository');
const PaymentService = require('./services/PaymentService');
const KafkaTemplate = require('kafka');

const repo = new OrderRepository();
const paymentSvc = new PaymentService();

async function createOrder(req, res) {
    const order = await repo.save(req.body);
    await paymentSvc.processPayment(order.id);
    KafkaTemplate.send('orders-topic', JSON.stringify(order));
    return res.json(order);
}

async function listOrders(req, res) {
    const orders = await repo.findAll();
    return res.json(orders);
}

module.exports = { createOrder, listOrders };
`;

    it('generates a sequence graph with correct type', () => {
        const graph = buildSequenceGraph(springStyleSequenceCode, 'OrderController.java');
        expect(graph.type).toBe('sequence');
    });

    it('generates a graphId using the file path', () => {
        const graph = buildSequenceGraph(springStyleSequenceCode, 'OrderController.java');
        expect(graph.graphId).toBe('sequence:OrderController.java');
    });

    it('has participant nodes', () => {
        const graph = buildSequenceGraph(springStyleSequenceCode, 'OrderController.java');
        const participants = graph.nodes.filter(n => n.type === 'participant');
        expect(participants.length).toBeGreaterThanOrEqual(1);
    });

    it('has message edges representing service calls', () => {
        const graph = buildSequenceGraph(springStyleSequenceCode, 'OrderController.java');
        const messages = graph.edges.filter(e => e.edgeType === 'message');
        expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('detects repository participant', () => {
        const graph = buildSequenceGraph(springStyleSequenceCode, 'OrderController.java');
        const repoNode = graph.nodes.find(n =>
            n.label?.includes('OrderRepository') || n.label?.includes('repo')
        );
        expect(repoNode).toBeDefined();
    });

    it('detects multiple participants from service calls', () => {
        const graph = buildSequenceGraph(springStyleSequenceCode, 'OrderController.java');
        // The file imports 3 external modules; not all may become participants
        // (kafka is likely filtered as framework noise), but repo + payment service should appear
        const participants = graph.nodes.filter(n => n.type === 'participant');
        expect(participants.length).toBeGreaterThanOrEqual(2);
    });
});

// ─── Tests: Sequence graph diff ───────────────────────────────────────────────

describe('Java: Sequence graph diff evaluation', () => {
    it('diff mode: adding a new service call adds participant', () => {
        const oldCode = `
const OrderRepository = require('./repositories/OrderRepository');
const repo = new OrderRepository();

async function createOrder(req, res) {
    const order = await repo.save(req.body);
    return res.json(order);
}

module.exports = { createOrder };
`;
        const newCode = `
const OrderRepository = require('./repositories/OrderRepository');
const NotificationService = require('./services/NotificationService');
const repo = new OrderRepository();
const notifier = new NotificationService();

async function createOrder(req, res) {
    const order = await repo.save(req.body);
    await notifier.sendOrderConfirmation(order);
    return res.json(order);
}

module.exports = { createOrder };
`;
        const graph = buildSequenceGraph(newCode, 'OrderController.java', oldCode);
        const notifierNode = graph.nodes.find(n =>
            n.label?.includes('NotificationService') || n.label?.includes('notifier')
        );
        expect(notifierNode).toBeDefined();
    });

    it('diff mode: removing a service call marks participant as deleted', () => {
        const oldCode = `
const OrderRepository = require('./repositories/OrderRepository');
const AuditLogger = require('./services/AuditLogger');
const repo = new OrderRepository();
const audit = new AuditLogger();

async function createOrder(req, res) {
    const order = await repo.save(req.body);
    audit.log('order_created', order.id);
    return res.json(order);
}

module.exports = { createOrder };
`;
        const newCode = `
const OrderRepository = require('./repositories/OrderRepository');
const repo = new OrderRepository();

async function createOrder(req, res) {
    const order = await repo.save(req.body);
    return res.json(order);
}

module.exports = { createOrder };
`;
        const graph = buildSequenceGraph(newCode, 'OrderController.java', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
    });
});

// ─── Tests: No false positives ────────────────────────────────────────────────

describe('Java: No false positives for non-route classes', () => {
    it('JPA repository produces no API routes', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_REPOSITORY_JAVA, 'OrderRepository.java', 'java');
        const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        const httpRoutes = apis.filter(a => httpMethods.includes(a.method));
        expect(httpRoutes.length).toBe(0);
    });

    it('service class produces no API routes', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_SERVICE_JAVA, 'OrderService.java', 'java');
        const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        const httpRoutes = apis.filter(a => httpMethods.includes(a.method));
        expect(httpRoutes.length).toBe(0);
    });

    it('entity model class produces no API routes', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_MODEL_JAVA, 'Order.java', 'java');
        const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        const httpRoutes = apis.filter(a => httpMethods.includes(a.method));
        expect(httpRoutes.length).toBe(0);
    });

    it('DTO class produces no API routes', () => {
        const apis = detectFrameworkApis(SPRING_BOOT_DTO_JAVA, 'OrderDto.java', 'java');
        expect(apis).toHaveLength(0);
    });

    it('Micronaut service class produces no API routes', () => {
        const apis = detectFrameworkApis(MICRONAUT_SERVICE_JAVA, 'ProductService.java', 'java');
        expect(apis).toHaveLength(0);
    });

    it('empty file produces no API routes', () => {
        const apis = detectFrameworkApis('', 'Empty.java', 'java');
        expect(apis).toHaveLength(0);
    });

    it('Java main method produces no API routes', () => {
        const source = `
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
`;
        const apis = detectFrameworkApis(source, 'Application.java', 'java');
        const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        const httpRoutes = apis.filter(a => httpMethods.includes(a.method));
        expect(httpRoutes.length).toBe(0);
    });
});

// ─── Tests: Handler name extraction ───────────────────────────────────────────

describe('Java: Handler name extraction across access modifiers', () => {
    it('extracts handler name from public method', () => {
        const source = `
@RestController
public class TestController {
    @GetMapping("/test")
    public ResponseEntity<String> publicMethod() { return null; }
}
`;
        const apis = detectFrameworkApis(source, 'TestController.java', 'java');
        const testApi = apis.find(a => a.route.includes('/test'));
        expect(testApi?.handlerName).toBe('publicMethod');
    });

    it('extracts handler name from private method', () => {
        const source = `
@RestController
public class TestController {
    @GetMapping("/internal")
    private String internalHandler() { return "ok"; }
}
`;
        const apis = detectFrameworkApis(source, 'TestController.java', 'java');
        const api = apis.find(a => a.route.includes('/internal'));
        expect(api?.handlerName).toBe('internalHandler');
    });

    it('extracts handler name from protected method', () => {
        const source = `
@RestController
public class TestController {
    @PostMapping("/protected")
    protected void protectedHandler() {}
}
`;
        const apis = detectFrameworkApis(source, 'TestController.java', 'java');
        const api = apis.find(a => a.route.includes('/protected'));
        expect(api?.handlerName).toBe('protectedHandler');
    });

    it('extracts handler name from package-private method (no modifier)', () => {
        const source = `
@RestController
class PackagePrivateController {
    @GetMapping("/default")
    ResponseEntity<String> defaultAccess() { return null; }
}
`;
        const apis = detectFrameworkApis(source, 'PackagePrivateController.java', 'java');
        const api = apis.find(a => a.route.includes('/default'));
        expect(api?.handlerName).toBe('defaultAccess');
    });

    it('extracts handler name for method with complex generic return type', () => {
        const source = `
@RestController
public class GenericController {
    @GetMapping("/complex")
    public ResponseEntity<Map<String, List<OrderDto>>> complexReturn() { return null; }
}
`;
        const apis = detectFrameworkApis(source, 'GenericController.java', 'java');
        const api = apis.find(a => a.route.includes('/complex'));
        expect(api?.handlerName).toBe('complexReturn');
    });

    it('extracts handler name with multiple annotations stacked', () => {
        const source = `
@RestController
public class MultiAnnotationController {
    @GetMapping("/secured")
    @PreAuthorize("hasRole('ADMIN')")
    @Cacheable("results")
    public List<String> securedEndpoint() { return List.of(); }
}
`;
        const apis = detectFrameworkApis(source, 'MultiAnnotationController.java', 'java');
        const api = apis.find(a => a.route.includes('/secured'));
        expect(api?.handlerName).toBe('securedEndpoint');
    });

    it('extracts handler name for Micronaut @Get with standard method', () => {
        const source = `
@Controller("/api")
public class ApiController {
    @Get("/ping")
    public String ping() { return "pong"; }
}
`;
        const apis = detectFrameworkApis(source, 'ApiController.java', 'java');
        const api = apis.find(a => a.route === '/ping');
        expect(api?.handlerName).toBe('ping');
    });

    it('extracts handler name for JAX-RS @GET with standard method', () => {
        const source = `
@Path("/health")
public class HealthResource {
    @GET
    public String check() { return "ok"; }
}
`;
        const apis = detectFrameworkApis(source, 'HealthResource.java', 'java');
        const getApi = apis.find(a => a.method === 'GET');
        expect(getApi?.handlerName).toBe('check');
    });
});

// ─── Issue 163: Spring WebFlux Router Function API ──────────────────────────

describe('Spring WebFlux Router Functions', () => {
    it('detects .route(GET("/path"), handler)', () => {
        const source = `
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerResponse;

@Bean
public RouterFunction<ServerResponse> route() {
    return RouterFunctions.route(GET("/api/users"), this::getUsers)
        .andRoute(POST("/api/users"), this::createUser)
        .andRoute(DELETE("/api/users/{id}"), this::deleteUser);
}
`;
        const apis = detectFrameworkApis(source, 'RouterConfig.java', 'java');
        expect(apis.find(a => a.method === 'GET' && a.route === '/api/users')).toBeDefined();
        expect(apis.find(a => a.method === 'POST' && a.route === '/api/users')).toBeDefined();
        expect(apis.find(a => a.method === 'DELETE' && a.route === '/api/users/{id}')).toBeDefined();
    });

    it('detects RouterFunctions builder chain .GET().POST()', () => {
        const source = `
import org.springframework.web.reactive.function.server.RouterFunction;

@Bean
public RouterFunction<ServerResponse> routes() {
    return route()
        .GET("/products", handler::listProducts)
        .POST("/products", handler::createProduct)
        .GET("/products/{id}", handler::getProduct);
}
`;
        const apis = detectFrameworkApis(source, 'ProductRouter.java', 'java');
        expect(apis.find(a => a.method === 'GET' && a.route === '/products')).toBeDefined();
        expect(apis.find(a => a.method === 'POST' && a.route === '/products')).toBeDefined();
    });
});

// ─── Issue 164: Spring AOP ──────────────────────────────────────────────────

describe('Spring AOP Detection', () => {
    it('detects @Aspect class', () => {
        const source = `
@Aspect
@Component
public class LoggingAspect {
    @Around("execution(* com.example.service.*.*(..))")
    public Object logMethodExecution(ProceedingJoinPoint joinPoint) throws Throwable {
        return joinPoint.proceed();
    }
}
`;
        const apis = detectFrameworkApis(source, 'LoggingAspect.java', 'java');
        expect(apis.find(a => a.method === 'AOP_ASPECT' && a.handlerName === 'LoggingAspect')).toBeDefined();
        expect(apis.find(a => a.method === 'AOP_AROUND')).toBeDefined();
    });

    it('detects @Before and @After advice', () => {
        const source = `
@Aspect
public class SecurityAspect {
    @Before("execution(* com.example.controller.*.*(..))")
    public void checkAuth(JoinPoint joinPoint) {}

    @AfterReturning("execution(* com.example.service.*.*(..))")
    public void auditLog(JoinPoint joinPoint) {}
}
`;
        const apis = detectFrameworkApis(source, 'SecurityAspect.java', 'java');
        expect(apis.find(a => a.method === 'AOP_BEFORE')).toBeDefined();
        expect(apis.find(a => a.method === 'AOP_AFTERRETURNING')).toBeDefined();
    });
});

// ─── Spring Servlet Filters & Interceptors ──────────────────────────────────

describe('Spring Servlet Filters & Interceptors', () => {
    it('detects class implementing Filter', () => {
        const source = `
public class CorsFilter implements Filter {
    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain) {
        chain.doFilter(req, res);
    }
}
`;
        const apis = detectFrameworkApis(source, 'CorsFilter.java', 'java');
        const filter = apis.find(a => a.method === 'SERVLET_FILTER');
        expect(filter).toBeDefined();
        expect(filter!.handlerName).toBe('CorsFilter');
        expect(filter!.route).toBe('/*');
    });

    it('detects class implementing HandlerInterceptor', () => {
        const source = `
public class AuthInterceptor implements HandlerInterceptor {
    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        return true;
    }
}
`;
        const apis = detectFrameworkApis(source, 'AuthInterceptor.java', 'java');
        const interceptor = apis.find(a => a.method === 'HANDLER_INTERCEPTOR');
        expect(interceptor).toBeDefined();
        expect(interceptor!.handlerName).toBe('AuthInterceptor');
    });
});
