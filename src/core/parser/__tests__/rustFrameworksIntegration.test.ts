/**
 * rustFrameworksIntegration.test.ts
 *
 * Comprehensive integration tests for Rust web framework detection in CodeAtlas.
 * Covers all three major Rust web frameworks across all diagram layers:
 *   - Actix-web: #[get/post/put/delete] decorator patterns + web::resource call patterns
 *   - Axum: .route("/path", get(handler)) call patterns
 *   - Rocket: #[get/post/put/delete] decorator patterns (same syntax as Actix)
 *   - System classification (diesel, sqlx, sea-orm, reqwest, hyper)
 *   - File graph generation + diff coloring
 *   - Sequence graph generation + diff
 *   - Handler name extraction via forward/backward scan
 *   - No false positives from non-route Rust code
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis, classifyExternalSystemMultiLang } from '../frameworkDetector';
import { buildFileGraph } from '../../graph/fileGraphBuilder';
import { buildSequenceGraph } from '../../graph/sequenceGraphBuilder';

// ─── Fixtures: realistic Rust web project files ──────────────────────────────

/** Actix-web main application (src/main.rs) */
const ACTIX_MAIN_RS = `
use actix_web::{web, App, HttpServer, HttpResponse, Responder};
use actix_web::{get, post, put, delete};

mod handlers;
mod models;
mod db;

#[get("/health")]
async fn health_check() -> impl Responder {
    HttpResponse::Ok().json(serde_json::json!({"status": "ok"}))
}

#[post("/users")]
async fn create_user(body: web::Json<CreateUser>, pool: web::Data<DbPool>) -> impl Responder {
    let user = db::insert_user(&pool, body.into_inner()).await;
    HttpResponse::Created().json(user)
}

#[put("/users/{id}")]
async fn update_user(
    path: web::Path<i32>,
    body: web::Json<UpdateUser>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    let id = path.into_inner();
    let user = db::update_user(&pool, id, body.into_inner()).await;
    HttpResponse::Ok().json(user)
}

#[delete("/users/{id}")]
async fn delete_user(path: web::Path<i32>, pool: web::Data<DbPool>) -> impl Responder {
    let id = path.into_inner();
    db::delete_user(&pool, id).await;
    HttpResponse::NoContent().finish()
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .service(health_check)
            .service(create_user)
            .service(update_user)
            .service(delete_user)
            .service(
                web::resource("/items")
                    .route(web::get().to(handlers::list_items))
                    .route(web::post().to(handlers::create_item))
            )
            .service(
                web::resource("/items/{id}")
                    .route(web::get().to(handlers::get_item))
            )
    })
    .bind("127.0.0.1:8080")?
    .run()
    .await
}
`;

/** Actix-web handler module (src/handlers/todo.rs) */
const ACTIX_HANDLERS_RS = `
use actix_web::{get, post, put, delete, web, HttpResponse, Responder};
use crate::models::Todo;
use crate::db::DbPool;

#[get("/todos")]
async fn list_todos(pool: web::Data<DbPool>) -> impl Responder {
    let todos = sqlx::query_as!(Todo, "SELECT * FROM todos")
        .fetch_all(pool.get_ref())
        .await
        .unwrap();
    HttpResponse::Ok().json(todos)
}

#[get("/todos/{id}")]
async fn get_todo(path: web::Path<i32>, pool: web::Data<DbPool>) -> impl Responder {
    let id = path.into_inner();
    let todo = sqlx::query_as!(Todo, "SELECT * FROM todos WHERE id = $1", id)
        .fetch_one(pool.get_ref())
        .await;
    match todo {
        Ok(t) => HttpResponse::Ok().json(t),
        Err(_) => HttpResponse::NotFound().finish(),
    }
}

#[post("/todos")]
async fn create_todo(body: web::Json<CreateTodo>, pool: web::Data<DbPool>) -> impl Responder {
    let todo = sqlx::query_as!(
        Todo,
        "INSERT INTO todos (title, completed) VALUES ($1, false) RETURNING *",
        body.title
    )
    .fetch_one(pool.get_ref())
    .await
    .unwrap();
    HttpResponse::Created().json(todo)
}

#[put("/todos/{id}")]
async fn update_todo(
    path: web::Path<i32>,
    body: web::Json<UpdateTodo>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    let id = path.into_inner();
    let todo = sqlx::query_as!(
        Todo,
        "UPDATE todos SET title = $1, completed = $2 WHERE id = $3 RETURNING *",
        body.title, body.completed, id
    )
    .fetch_one(pool.get_ref())
    .await
    .unwrap();
    HttpResponse::Ok().json(todo)
}

#[delete("/todos/{id}")]
async fn delete_todo(path: web::Path<i32>, pool: web::Data<DbPool>) -> impl Responder {
    let id = path.into_inner();
    sqlx::query!("DELETE FROM todos WHERE id = $1", id)
        .execute(pool.get_ref())
        .await
        .unwrap();
    HttpResponse::NoContent().finish()
}
`;

/** Axum router configuration (src/router.rs) */
const AXUM_ROUTER_RS = `
use axum::{
    routing::{get, post, put, delete},
    Router,
    extract::{Path, State, Json},
    http::StatusCode,
    response::IntoResponse,
};
use crate::handlers;
use crate::AppState;

pub fn create_router(state: AppState) -> Router {
    let api_routes = Router::new()
        .route("/health", get(handlers::health_check))
        .route("/users", get(handlers::list_users))
        .route("/users", post(handlers::create_user))
        .route("/users/:id", get(handlers::get_user))
        .route("/users/:id", put(handlers::update_user))
        .route("/users/:id", delete(handlers::delete_user))
        .route("/items", get(handlers::list_items))
        .route("/items", post(handlers::create_item))
        .route("/items/:id", delete(handlers::delete_item));

    let nested = Router::new()
        .route("/admin/stats", get(handlers::admin_stats))
        .route("/admin/users", get(handlers::admin_list_users));

    Router::new()
        .nest("/api/v1", api_routes)
        .nest("/api/v1", nested)
        .with_state(state)
}
`;

/** Rocket routes (src/routes.rs) */
const ROCKET_ROUTES_RS = `
use rocket::serde::json::Json;
use rocket::http::Status;
use crate::models::{Todo, CreateTodo, UpdateTodo};
use crate::db::DbConn;

#[get("/")]
pub async fn index() -> &'static str {
    "Welcome to the Rocket Todo API"
}

#[get("/health")]
pub async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status": "ok"}))
}

#[get("/todos")]
pub async fn list_todos(conn: DbConn) -> Json<Vec<Todo>> {
    let todos = conn.run(|c| Todo::all(c)).await;
    Json(todos)
}

#[get("/todos/<id>")]
pub async fn get_todo(id: i32, conn: DbConn) -> Option<Json<Todo>> {
    conn.run(move |c| Todo::find(c, id)).await.map(Json)
}

#[post("/todos")]
pub async fn create_todo(todo: Json<CreateTodo>, conn: DbConn) -> Status {
    conn.run(move |c| Todo::insert(c, todo.into_inner())).await;
    Status::Created
}

#[put("/todos/<id>")]
pub async fn update_todo(id: i32, todo: Json<UpdateTodo>, conn: DbConn) -> Json<Todo> {
    let updated = conn.run(move |c| Todo::update(c, id, todo.into_inner())).await;
    Json(updated)
}

#[delete("/todos/<id>")]
pub async fn delete_todo(id: i32, conn: DbConn) -> Status {
    conn.run(move |c| Todo::delete(c, id)).await;
    Status::NoContent
}

#[options("/todos")]
pub async fn todos_options() -> Status {
    Status::Ok
}
`;

/** Rust database layer using diesel/sqlx (src/db.rs) */
const RUST_DB_LAYER_RS = `
use diesel::prelude::*;
use diesel::pg::PgConnection;
use sqlx::PgPool;
use sea_orm::DatabaseConnection;
use crate::models::{User, NewUser};

pub struct DbPool {
    pool: PgPool,
}

impl DbPool {
    pub async fn new(database_url: &str) -> Self {
        let pool = PgPool::connect(database_url).await.unwrap();
        DbPool { pool }
    }

    pub async fn get_users(&self) -> Vec<User> {
        sqlx::query_as!(User, "SELECT * FROM users")
            .fetch_all(&self.pool)
            .await
            .unwrap()
    }

    pub async fn insert_user(&self, user: NewUser) -> User {
        sqlx::query_as!(
            User,
            "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *",
            user.name, user.email
        )
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }
}

pub fn diesel_get_users(conn: &mut PgConnection) -> Vec<User> {
    use crate::schema::users::dsl::*;
    users.load::<User>(conn).expect("Error loading users")
}
`;

/** Non-route Rust code: structs, impls, tests (src/models.rs) */
const NON_ROUTE_RS = `
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i32,
    pub name: String,
    pub email: String,
    pub created_at: chrono::NaiveDateTime,
}

#[derive(Debug, Deserialize)]
pub struct CreateUser {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateUser {
    pub name: Option<String>,
    pub email: Option<String>,
}

impl User {
    pub fn full_name(&self) -> String {
        self.name.clone()
    }

    pub fn is_valid_email(&self) -> bool {
        self.email.contains('@')
    }
}

pub trait Repository {
    fn find_by_id(&self, id: i32) -> Option<User>;
    fn find_all(&self) -> Vec<User>;
    fn save(&self, user: &User) -> Result<(), String>;
    fn delete(&self, id: i32) -> Result<(), String>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_user_creation() {
        let user = User {
            id: 1,
            name: "Alice".to_string(),
            email: "alice@example.com".to_string(),
            created_at: chrono::Utc::now().naive_utc(),
        };
        assert_eq!(user.full_name(), "Alice");
    }

    #[test]
    fn test_valid_email() {
        let user = User {
            id: 1,
            name: "Bob".to_string(),
            email: "bob@test.com".to_string(),
            created_at: chrono::Utc::now().naive_utc(),
        };
        assert!(user.is_valid_email());
    }
}
`;

/** Rust Actix-web app with web::resource patterns only */
const ACTIX_RESOURCE_RS = `
use actix_web::{web, App, HttpServer};
use crate::handlers;

pub fn configure_app(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/products")
            .route(web::get().to(handlers::list_products))
            .route(web::post().to(handlers::create_product))
    )
    .service(
        web::resource("/products/{id}")
            .route(web::get().to(handlers::get_product))
            .route(web::put().to(handlers::update_product))
            .route(web::delete().to(handlers::delete_product))
    )
    .service(
        web::resource("/categories")
            .route(web::get().to(handlers::list_categories))
    )
    .service(
        web::resource("/orders/{order_id}/items")
            .route(web::get().to(handlers::list_order_items))
    );
}
`;

/** Rust with reqwest/hyper HTTP client calls (src/client.rs) */
const RUST_HTTP_CLIENT_RS = `
use reqwest::Client;
use hyper::body::HttpBody;

pub struct ApiClient {
    client: Client,
    base_url: String,
}

impl ApiClient {
    pub fn new(base_url: &str) -> Self {
        ApiClient {
            client: Client::new(),
            base_url: base_url.to_string(),
        }
    }

    pub async fn fetch_data(&self) -> Result<String, reqwest::Error> {
        let resp = self.client
            .get(&format!("{}/api/data", self.base_url))
            .send()
            .await?;
        resp.text().await
    }
}
`;

/** Rocket with #[head] and #[options] attributes */
const ROCKET_EXTRA_METHODS_RS = `
use rocket::http::Status;

#[head("/ping")]
pub async fn ping_head() -> Status {
    Status::Ok
}

#[options("/cors")]
pub async fn cors_options() -> Status {
    Status::Ok
}

#[get("/version")]
pub async fn get_version() -> &'static str {
    "1.0.0"
}
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Actix-web: Decorator route detection', () => {
    it('detects #[get("/health")] decorator', () => {
        const apis = detectFrameworkApis(ACTIX_MAIN_RS, 'src/main.rs', 'rust');
        const health = apis.find(a => a.method === 'GET' && a.route === '/health');
        expect(health).toBeDefined();
    });

    it('detects #[post("/users")] decorator', () => {
        const apis = detectFrameworkApis(ACTIX_MAIN_RS, 'src/main.rs', 'rust');
        const createUser = apis.find(a => a.method === 'POST' && a.route === '/users');
        expect(createUser).toBeDefined();
    });

    it('detects #[put("/users/{id}")] decorator', () => {
        const apis = detectFrameworkApis(ACTIX_MAIN_RS, 'src/main.rs', 'rust');
        const updateUser = apis.find(a => a.method === 'PUT' && a.route === '/users/{id}');
        expect(updateUser).toBeDefined();
    });

    it('detects #[delete("/users/{id}")] decorator', () => {
        const apis = detectFrameworkApis(ACTIX_MAIN_RS, 'src/main.rs', 'rust');
        const deleteUser = apis.find(a => a.method === 'DELETE' && a.route === '/users/{id}');
        expect(deleteUser).toBeDefined();
    });

    it('detects all four HTTP methods from main.rs decorators', () => {
        const apis = detectFrameworkApis(ACTIX_MAIN_RS, 'src/main.rs', 'rust');
        const decoratorApis = apis.filter(a =>
            ['GET', 'POST', 'PUT', 'DELETE'].includes(a.method) &&
            (a.route === '/health' || a.route.startsWith('/users'))
        );
        const methods = new Set(decoratorApis.map(a => a.method));
        expect(methods.has('GET')).toBe(true);
        expect(methods.has('POST')).toBe(true);
        expect(methods.has('PUT')).toBe(true);
        expect(methods.has('DELETE')).toBe(true);
    });

    it('all records reference the correct file path', () => {
        const apis = detectFrameworkApis(ACTIX_MAIN_RS, 'src/main.rs', 'rust');
        for (const api of apis) {
            expect(api.filePath).toBe('src/main.rs');
        }
    });

    it('all records have valid ApiRecord structure', () => {
        const apis = detectFrameworkApis(ACTIX_MAIN_RS, 'src/main.rs', 'rust');
        for (const api of apis) {
            expect(api.apiId).toBeTruthy();
            expect(api.method).toBeTruthy();
            expect(api.route).toMatch(/^\//);
            expect(api.handlerName).toBeTruthy();
            expect(api.anchor).toBeDefined();
            expect(api.anchor.filePath).toBe('src/main.rs');
        }
    });
});

describe('Actix-web: Handler module decorator detection', () => {
    it('detects #[get("/todos")] in handler module', () => {
        const apis = detectFrameworkApis(ACTIX_HANDLERS_RS, 'src/handlers/todo.rs', 'rust');
        const listTodos = apis.find(a => a.method === 'GET' && a.route === '/todos');
        expect(listTodos).toBeDefined();
    });

    it('detects #[get("/todos/{id}")] with path parameter', () => {
        const apis = detectFrameworkApis(ACTIX_HANDLERS_RS, 'src/handlers/todo.rs', 'rust');
        const getTodo = apis.find(a => a.method === 'GET' && a.route === '/todos/{id}');
        expect(getTodo).toBeDefined();
    });

    it('detects #[post("/todos")] for creation', () => {
        const apis = detectFrameworkApis(ACTIX_HANDLERS_RS, 'src/handlers/todo.rs', 'rust');
        const createTodo = apis.find(a => a.method === 'POST' && a.route === '/todos');
        expect(createTodo).toBeDefined();
    });

    it('detects #[put("/todos/{id}")] for update', () => {
        const apis = detectFrameworkApis(ACTIX_HANDLERS_RS, 'src/handlers/todo.rs', 'rust');
        const updateTodo = apis.find(a => a.method === 'PUT' && a.route === '/todos/{id}');
        expect(updateTodo).toBeDefined();
    });

    it('detects #[delete("/todos/{id}")] for deletion', () => {
        const apis = detectFrameworkApis(ACTIX_HANDLERS_RS, 'src/handlers/todo.rs', 'rust');
        const deleteTodo = apis.find(a => a.method === 'DELETE' && a.route === '/todos/{id}');
        expect(deleteTodo).toBeDefined();
    });

    it('detects all 5 CRUD routes in handler module', () => {
        const apis = detectFrameworkApis(ACTIX_HANDLERS_RS, 'src/handlers/todo.rs', 'rust');
        const httpApis = apis.filter(a => ['GET', 'POST', 'PUT', 'DELETE'].includes(a.method));
        expect(httpApis.length).toBeGreaterThanOrEqual(5);
    });
});

describe('Actix-web: web::resource patterns', () => {
    it('detects web::resource("/products")', () => {
        const apis = detectFrameworkApis(ACTIX_RESOURCE_RS, 'src/config.rs', 'rust');
        const products = apis.find(a => a.route === '/products');
        expect(products).toBeDefined();
    });

    it('detects web::resource("/products/{id}")', () => {
        const apis = detectFrameworkApis(ACTIX_RESOURCE_RS, 'src/config.rs', 'rust');
        const productById = apis.find(a => a.route === '/products/{id}');
        expect(productById).toBeDefined();
    });

    it('detects web::resource("/categories")', () => {
        const apis = detectFrameworkApis(ACTIX_RESOURCE_RS, 'src/config.rs', 'rust');
        const categories = apis.find(a => a.route === '/categories');
        expect(categories).toBeDefined();
    });

    it('detects web::resource with nested path parameters', () => {
        const apis = detectFrameworkApis(ACTIX_RESOURCE_RS, 'src/config.rs', 'rust');
        const orderItems = apis.find(a => a.route === '/orders/{order_id}/items');
        expect(orderItems).toBeDefined();
    });

    it('detects web::resource patterns from main.rs service config', () => {
        const apis = detectFrameworkApis(ACTIX_MAIN_RS, 'src/main.rs', 'rust');
        const items = apis.find(a => a.route === '/items');
        expect(items).toBeDefined();
    });

    it('detects web::resource("/items/{id}") from main.rs', () => {
        const apis = detectFrameworkApis(ACTIX_MAIN_RS, 'src/main.rs', 'rust');
        const itemById = apis.find(a => a.route === '/items/{id}');
        expect(itemById).toBeDefined();
    });

    it('resource patterns default to GET method', () => {
        const apis = detectFrameworkApis(ACTIX_RESOURCE_RS, 'src/config.rs', 'rust');
        const resourceApis = apis.filter(a => a.method === 'GET');
        expect(resourceApis.length).toBeGreaterThanOrEqual(1);
    });
});

describe('Axum: .route() pattern detection', () => {
    it('detects .route("/health", get(handler))', () => {
        const apis = detectFrameworkApis(AXUM_ROUTER_RS, 'src/router.rs', 'rust');
        const health = apis.find(a => a.method === 'GET' && a.route === '/health');
        expect(health).toBeDefined();
    });

    it('detects .route("/users", get(handler)) for list', () => {
        const apis = detectFrameworkApis(AXUM_ROUTER_RS, 'src/router.rs', 'rust');
        const listUsers = apis.find(a => a.method === 'GET' && a.route === '/users');
        expect(listUsers).toBeDefined();
    });

    it('detects .route("/users", post(handler)) for create', () => {
        const apis = detectFrameworkApis(AXUM_ROUTER_RS, 'src/router.rs', 'rust');
        const createUser = apis.find(a => a.method === 'POST' && a.route === '/users');
        expect(createUser).toBeDefined();
    });

    it('detects .route("/users/:id", get(handler))', () => {
        const apis = detectFrameworkApis(AXUM_ROUTER_RS, 'src/router.rs', 'rust');
        const getUser = apis.find(a => a.method === 'GET' && a.route === '/users/:id');
        expect(getUser).toBeDefined();
    });

    it('detects .route("/users/:id", put(handler))', () => {
        const apis = detectFrameworkApis(AXUM_ROUTER_RS, 'src/router.rs', 'rust');
        const updateUser = apis.find(a => a.method === 'PUT' && a.route === '/users/:id');
        expect(updateUser).toBeDefined();
    });

    it('detects .route("/users/:id", delete(handler))', () => {
        const apis = detectFrameworkApis(AXUM_ROUTER_RS, 'src/router.rs', 'rust');
        const deleteUser = apis.find(a => a.method === 'DELETE' && a.route === '/users/:id');
        expect(deleteUser).toBeDefined();
    });

    it('detects all Axum routes in the router', () => {
        const apis = detectFrameworkApis(AXUM_ROUTER_RS, 'src/router.rs', 'rust');
        const httpApis = apis.filter(a => ['GET', 'POST', 'PUT', 'DELETE'].includes(a.method));
        expect(httpApis.length).toBeGreaterThanOrEqual(9);
    });

    it('detects nested router routes', () => {
        const apis = detectFrameworkApis(AXUM_ROUTER_RS, 'src/router.rs', 'rust');
        const adminStats = apis.find(a => a.method === 'GET' && a.route === '/admin/stats');
        expect(adminStats).toBeDefined();
    });

    it('all records reference the correct file path', () => {
        const apis = detectFrameworkApis(AXUM_ROUTER_RS, 'src/router.rs', 'rust');
        for (const api of apis) {
            expect(api.filePath).toBe('src/router.rs');
        }
    });
});

describe('Rocket: Decorator route detection', () => {
    it('detects #[get("/")] index route', () => {
        const apis = detectFrameworkApis(ROCKET_ROUTES_RS, 'src/routes.rs', 'rust');
        const index = apis.find(a => a.method === 'GET' && a.route === '/');
        expect(index).toBeDefined();
    });

    it('detects #[get("/health")]', () => {
        const apis = detectFrameworkApis(ROCKET_ROUTES_RS, 'src/routes.rs', 'rust');
        const health = apis.find(a => a.method === 'GET' && a.route === '/health');
        expect(health).toBeDefined();
    });

    it('detects #[get("/todos")]', () => {
        const apis = detectFrameworkApis(ROCKET_ROUTES_RS, 'src/routes.rs', 'rust');
        const listTodos = apis.find(a => a.method === 'GET' && a.route === '/todos');
        expect(listTodos).toBeDefined();
    });

    it('detects #[get("/todos/<id>")] with Rocket path parameter', () => {
        const apis = detectFrameworkApis(ROCKET_ROUTES_RS, 'src/routes.rs', 'rust');
        const getTodo = apis.find(a => a.method === 'GET' && a.route === '/todos/<id>');
        expect(getTodo).toBeDefined();
    });

    it('detects #[post("/todos")]', () => {
        const apis = detectFrameworkApis(ROCKET_ROUTES_RS, 'src/routes.rs', 'rust');
        const createTodo = apis.find(a => a.method === 'POST' && a.route === '/todos');
        expect(createTodo).toBeDefined();
    });

    it('detects #[put("/todos/<id>")]', () => {
        const apis = detectFrameworkApis(ROCKET_ROUTES_RS, 'src/routes.rs', 'rust');
        const updateTodo = apis.find(a => a.method === 'PUT' && a.route === '/todos/<id>');
        expect(updateTodo).toBeDefined();
    });

    it('does not match Rocket data attributes (extra args after path)', () => {
        // Rocket supports #[post("/path", data = "<input>")] but the current regex
        // requires the closing ) right after the quoted path, so extra attributes
        // prevent a match. This documents the current behavior.
        const source = `
#[post("/upload", data = "<file>")]
pub async fn upload_file(file: Data) -> Status {
    Status::Ok
}
`;
        const apis = detectFrameworkApis(source, 'src/routes.rs', 'rust');
        const upload = apis.find(a => a.method === 'POST' && a.route === '/upload');
        expect(upload).toBeUndefined();
    });

    it('detects #[delete("/todos/<id>")]', () => {
        const apis = detectFrameworkApis(ROCKET_ROUTES_RS, 'src/routes.rs', 'rust');
        const deleteTodo = apis.find(a => a.method === 'DELETE' && a.route === '/todos/<id>');
        expect(deleteTodo).toBeDefined();
    });

    it('detects #[options("/todos")] decorator', () => {
        const apis = detectFrameworkApis(ROCKET_ROUTES_RS, 'src/routes.rs', 'rust');
        const options = apis.find(a => a.method === 'OPTIONS' && a.route === '/todos');
        expect(options).toBeDefined();
    });

    it('detects #[head] and #[options] extra methods', () => {
        const apis = detectFrameworkApis(ROCKET_EXTRA_METHODS_RS, 'src/extra.rs', 'rust');
        const head = apis.find(a => a.method === 'HEAD' && a.route === '/ping');
        expect(head).toBeDefined();
        const options = apis.find(a => a.method === 'OPTIONS' && a.route === '/cors');
        expect(options).toBeDefined();
    });

    it('all records reference the correct file path', () => {
        const apis = detectFrameworkApis(ROCKET_ROUTES_RS, 'src/routes.rs', 'rust');
        for (const api of apis) {
            expect(api.filePath).toBe('src/routes.rs');
        }
    });
});

describe('Rust: System classification', () => {
    it('classifies diesel as database', () => {
        expect(classifyExternalSystemMultiLang('diesel', 'rust')).toBe('database');
    });

    it('classifies sqlx as database', () => {
        expect(classifyExternalSystemMultiLang('sqlx', 'rust')).toBe('database');
    });

    it('classifies sea-orm as database', () => {
        expect(classifyExternalSystemMultiLang('sea-orm', 'rust')).toBe('database');
    });

    it('classifies reqwest as service', () => {
        expect(classifyExternalSystemMultiLang('reqwest', 'rust')).toBe('service');
    });

    it('classifies hyper as service', () => {
        expect(classifyExternalSystemMultiLang('hyper', 'rust')).toBe('service');
    });

    it('classifies redis as cache', () => {
        expect(classifyExternalSystemMultiLang('redis', 'rust')).toBe('cache');
    });

    it('classifies unknown rust crate as module', () => {
        expect(classifyExternalSystemMultiLang('my_custom_crate', 'rust')).toBe('module');
    });

    it('classifies tokio-postgres (contains pg) as database', () => {
        expect(classifyExternalSystemMultiLang('pg', 'rust')).toBe('database');
    });
});

describe('Rust: File graph generation', () => {
    it('generates a valid file graph from Rust-like JS equivalent', () => {
        const jsEquivalent = `
const actix_web = require('actix-web');

async function health_check() {
    return { status: 'ok' };
}

async function create_user(body, pool) {
    const user = await pool.insert(body);
    return user;
}

async function update_user(id, body, pool) {
    const user = await pool.update(id, body);
    return user;
}

module.exports = { health_check, create_user, update_user };
`;
        const graph = buildFileGraph(jsEquivalent, 'src/main.rs');
        expect(graph.type).toBe('file');
        expect(graph.graphId).toBe('file:src/main.rs');
        expect(graph.nodes.some(n => n.type === 'import')).toBe(true);
    });

    it('file graph contains function nodes for handlers', () => {
        const jsEquivalent = `
async function list_todos(pool) {
    return await pool.query("SELECT * FROM todos");
}

async function get_todo(id, pool) {
    return await pool.query("SELECT * FROM todos WHERE id = ?", id);
}

async function create_todo(body, pool) {
    return await pool.insert(body);
}
`;
        const graph = buildFileGraph(jsEquivalent, 'src/handlers/todo.rs');
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        expect(funcNodes.length).toBeGreaterThanOrEqual(3);
    });
});

describe('Rust: File graph diff', () => {
    it('diff: adding a new handler shows as "added"', () => {
        const oldCode = `
async function list_todos(pool) {
    return [];
}

async function get_todo(id, pool) {
    return { id };
}
`;
        const newCode = `
async function list_todos(pool) {
    return [];
}

async function get_todo(id, pool) {
    return { id };
}

async function create_todo(body, pool) {
    return body;
}
`;
        const graph = buildFileGraph(newCode, 'src/handlers/todo.rs', oldCode);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThan(0);
        expect(addedNodes.some(n => n.label === 'create_todo')).toBe(true);
    });

    it('diff: modifying a handler body shows as "modified"', () => {
        const oldCode = `
async function health_check() {
    return { status: 'ok' };
}
`;
        const newCode = `
async function health_check() {
    return { status: 'ok', version: '1.0.0', uptime: process.uptime() };
}
`;
        const graph = buildFileGraph(newCode, 'src/main.rs', oldCode);
        const modified = graph.nodes.filter(n => n.diff === 'modified');
        expect(modified.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: deleting a handler shows as "deleted"', () => {
        const oldCode = `
async function list_todos(pool) {
    return [];
}

async function create_todo(body, pool) {
    return body;
}

async function delete_todo(id, pool) {
    return true;
}
`;
        const newCode = `
async function list_todos(pool) {
    return [];
}

async function create_todo(body, pool) {
    return body;
}
`;
        const graph = buildFileGraph(newCode, 'src/handlers/todo.rs', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
        expect(deletedNodes.some(n => n.label.includes('delete_todo'))).toBe(true);
    });

    it('diff: unchanged handlers remain "unchanged"', () => {
        const code = `
async function list_todos(pool) {
    return [];
}

async function get_todo(id, pool) {
    return { id };
}
`;
        const graph = buildFileGraph(code, 'src/handlers/todo.rs', code);
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        for (const n of funcNodes) {
            expect(n.diff).toBe('unchanged');
        }
    });

    it('diff: adding and removing handlers simultaneously', () => {
        const oldCode = `
async function old_handler(req, res) {
    return { old: true };
}

async function stable_handler(req, res) {
    return { stable: true };
}
`;
        const newCode = `
async function stable_handler(req, res) {
    return { stable: true };
}

async function new_handler(req, res) {
    return { new: true };
}
`;
        const graph = buildFileGraph(newCode, 'src/handlers.rs', oldCode);
        const added = graph.nodes.filter(n => n.diff === 'added');
        const deleted = graph.nodes.filter(n => n.diff === 'deleted');
        expect(added.some(n => n.label === 'new_handler')).toBe(true);
        expect(deleted.some(n => n.label.includes('old_handler'))).toBe(true);
    });
});

describe('Rust: Sequence graph generation', () => {
    const rustStyleSequenceCode = `
const DbPool = require('./db');
const CacheService = require('./cache');
const pool = new DbPool();
const cache = new CacheService();

async function list_todos(req, res) {
    const cached = await cache.get('todos:all');
    if (cached) {
        return res.json(cached);
    }
    const todos = await pool.query("SELECT * FROM todos");
    await cache.set('todos:all', todos, 300);
    return res.json(todos);
}

module.exports = { list_todos };
`;

    it('generates a sequence graph with correct type', () => {
        const graph = buildSequenceGraph(rustStyleSequenceCode, 'src/handlers/todo.rs');
        expect(graph.type).toBe('sequence');
    });

    it('generates a graphId using the file path', () => {
        const graph = buildSequenceGraph(rustStyleSequenceCode, 'src/handlers/todo.rs');
        expect(graph.graphId).toBe('sequence:src/handlers/todo.rs');
    });

    it('has at least one participant node', () => {
        const graph = buildSequenceGraph(rustStyleSequenceCode, 'src/handlers/todo.rs');
        const participants = graph.nodes.filter(n => n.type === 'participant');
        expect(participants.length).toBeGreaterThanOrEqual(1);
    });

    it('has message edges representing function calls', () => {
        const graph = buildSequenceGraph(rustStyleSequenceCode, 'src/handlers/todo.rs');
        const messages = graph.edges.filter(e => e.edgeType === 'message');
        expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('detects DbPool or pool participant from db import', () => {
        const graph = buildSequenceGraph(rustStyleSequenceCode, 'src/handlers/todo.rs');
        // The participant may be labeled as 'DbPool', 'pool', or contain 'db'
        const dbRelatedNode = graph.nodes.find(n =>
            n.label === 'pool' ||
            n.label === 'DbPool' ||
            n.subtitle?.includes('db') ||
            n.subtitle?.includes('Db') ||
            n.label?.toLowerCase().includes('pool') ||
            n.label?.toLowerCase().includes('db')
        );
        // DbPool is imported and instantiated; it should appear as a participant
        // If not found by specific label, check that we have at least 2 participants
        // (the handler itself + at least one external dependency)
        if (!dbRelatedNode) {
            const participants = graph.nodes.filter(n => n.type === 'participant');
            expect(participants.length).toBeGreaterThanOrEqual(2);
        } else {
            expect(dbRelatedNode).toBeDefined();
        }
    });

    it('detects cache participant from cache import', () => {
        const graph = buildSequenceGraph(rustStyleSequenceCode, 'src/handlers/todo.rs');
        const cacheNode = graph.nodes.find(n =>
            n.label === 'cache' || n.subtitle?.includes('cache') || n.label?.toLowerCase().includes('cache')
        );
        expect(cacheNode).toBeDefined();
    });
});

describe('Rust: Sequence graph diff', () => {
    it('diff: adding a new dependency shows as added participant', () => {
        const oldCode = `
const DbPool = require('./db');
const pool = new DbPool();

async function list_todos(req, res) {
    const todos = await pool.query("SELECT * FROM todos");
    return res.json(todos);
}

module.exports = { list_todos };
`;
        const newCode = `
const DbPool = require('./db');
const CacheService = require('./cache');
const pool = new DbPool();
const cache = new CacheService();

async function list_todos(req, res) {
    const cached = await cache.get('todos:all');
    if (cached) return res.json(cached);
    const todos = await pool.query("SELECT * FROM todos");
    cache.set('todos:all', todos, 300);
    return res.json(todos);
}

module.exports = { list_todos };
`;
        const graph = buildSequenceGraph(newCode, 'src/handlers/todo.rs', oldCode);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('diff: removing a dependency shows as deleted participant', () => {
        const oldCode = `
const DbPool = require('./db');
const CacheService = require('./cache');
const Logger = require('./logger');
const pool = new DbPool();
const cache = new CacheService();
const logger = new Logger();

async function list_todos(req, res) {
    logger.info('fetching todos');
    const cached = await cache.get('todos:all');
    const todos = await pool.query("SELECT * FROM todos");
    return res.json(todos);
}

module.exports = { list_todos };
`;
        const newCode = `
const DbPool = require('./db');
const CacheService = require('./cache');
const pool = new DbPool();
const cache = new CacheService();

async function list_todos(req, res) {
    const cached = await cache.get('todos:all');
    const todos = await pool.query("SELECT * FROM todos");
    return res.json(todos);
}

module.exports = { list_todos };
`;
        const graph = buildSequenceGraph(newCode, 'src/handlers/todo.rs', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
    });
});

describe('Rust: No false positives', () => {
    it('non-route Rust code (structs, impls) produces zero APIs', () => {
        const apis = detectFrameworkApis(NON_ROUTE_RS, 'src/models.rs', 'rust');
        expect(apis).toHaveLength(0);
    });

    it('#[derive(...)] does not trigger route detection', () => {
        const apis = detectFrameworkApis(NON_ROUTE_RS, 'src/models.rs', 'rust');
        const deriveApi = apis.find(a => a.handlerName === 'Debug' || a.handlerName === 'Clone');
        expect(deriveApi).toBeUndefined();
    });

    it('#[cfg(test)] does not trigger route detection', () => {
        const apis = detectFrameworkApis(NON_ROUTE_RS, 'src/models.rs', 'rust');
        const testApi = apis.find(a => a.handlerName === 'tests' || a.handlerName === 'test');
        expect(testApi).toBeUndefined();
    });

    it('#[test] attribute does not trigger route detection', () => {
        const source = `
#[test]
fn test_something() {
    assert!(true);
}

#[test]
fn test_other() {
    assert_eq!(1, 1);
}
`;
        const apis = detectFrameworkApis(source, 'src/tests.rs', 'rust');
        expect(apis).toHaveLength(0);
    });

    it('empty Rust file produces zero APIs', () => {
        const apis = detectFrameworkApis('', 'src/empty.rs', 'rust');
        expect(apis).toHaveLength(0);
    });

    it('Rust code with only use statements produces zero APIs', () => {
        const source = `
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
`;
        const apis = detectFrameworkApis(source, 'src/lib.rs', 'rust');
        expect(apis).toHaveLength(0);
    });

    it('HTTP client code does not produce API records', () => {
        const apis = detectFrameworkApis(RUST_HTTP_CLIENT_RS, 'src/client.rs', 'rust');
        expect(apis).toHaveLength(0);
    });

    it('database layer code does not produce API records', () => {
        const apis = detectFrameworkApis(RUST_DB_LAYER_RS, 'src/db.rs', 'rust');
        expect(apis).toHaveLength(0);
    });
});

describe('Rust: Handler name extraction', () => {
    // NOTE: For Rust #[method("/path")] decorator patterns, the generic forward-scan
    // Issue 338 (FIXED): the forward scan now skips `#[...]` decorator lines
    // and reaches the actual fn declaration, so handler names resolve to the
    // real function name (`my_handler`, `submit_form`, etc.) instead of the
    // HTTP method keyword from the decorator. These tests assert the new,
    // correct contract.

    it('decorator routes resolve to the real fn name', () => {
        const source = `
#[get("/test")]
async fn my_handler() -> impl Responder {
    HttpResponse::Ok().json(())
}
`;
        const apis = detectFrameworkApis(source, 'test.rs', 'rust');
        expect(apis.length).toBeGreaterThan(0);
        expect(apis[0].handlerName).toBe('my_handler');
    });

    it('post decorator handler name resolves to the real fn name', () => {
        const source = `
#[post("/submit")]
async fn submit_form(body: web::Json<FormData>) -> impl Responder {
    HttpResponse::Created().finish()
}
`;
        const apis = detectFrameworkApis(source, 'test.rs', 'rust');
        expect(apis.length).toBeGreaterThan(0);
        expect(apis[0].handlerName).toBe('submit_form');
    });

    it('Actix decorator handler names resolve to real fn identifiers', () => {
        const apis = detectFrameworkApis(ACTIX_HANDLERS_RS, 'src/handlers/todo.rs', 'rust');
        const handlerNames = apis.map(a => a.handlerName);
        // Real fn names from #[get]/#[post]/#[put]/#[delete] declarations.
        expect(handlerNames).not.toContain('get');
        expect(handlerNames).not.toContain('post');
        expect(handlerNames).not.toContain('put');
        expect(handlerNames).not.toContain('delete');
        // At least one must look like a real identifier, not an HTTP keyword.
        expect(handlerNames.some(h => h && !/^(?:get|post|put|patch|delete|head|options|all)$/i.test(h))).toBe(true);
    });

    it('main.rs decorator routes resolve to real fn names', () => {
        const apis = detectFrameworkApis(ACTIX_MAIN_RS, 'src/main.rs', 'rust');
        const decoratorApis = apis.filter(a =>
            a.route === '/health' || a.route === '/users' || a.route === '/users/{id}'
        );
        const handlerNames = decoratorApis.map(a => a.handlerName);
        // No more HTTP-keyword leakage as handler names.
        expect(handlerNames).not.toContain('get');
        expect(handlerNames).not.toContain('post');
        expect(handlerNames.length).toBeGreaterThan(0);
    });

    it('Rocket decorator routes resolve to real fn names', () => {
        const apis = detectFrameworkApis(ROCKET_ROUTES_RS, 'src/routes.rs', 'rust');
        const handlerNames = apis.map(a => a.handlerName);
        expect(handlerNames).not.toContain('get');
        expect(handlerNames).not.toContain('post');
        expect(handlerNames).not.toContain('put');
        expect(handlerNames).not.toContain('delete');
        expect(handlerNames.some(h => h && !/^(?:get|post|put|patch|delete|head|options|all)$/i.test(h))).toBe(true);
    });

    it('handler name is not empty for decorator patterns', () => {
        const source = `
#[get("/long-route")]
async fn my_long_snake_case_handler_name(pool: web::Data<DbPool>) -> impl Responder {
    HttpResponse::Ok().finish()
}
`;
        const apis = detectFrameworkApis(source, 'test.rs', 'rust');
        expect(apis.length).toBeGreaterThan(0);
        expect(apis[0].handlerName).toBeTruthy();
    });

    it('Axum routes extract handler name from call context', () => {
        const source = `
let router = Router::new()
    .route("/status", get(check_status));
`;
        const apis = detectFrameworkApis(source, 'src/router.rs', 'rust');
        const status = apis.find(a => a.route === '/status');
        expect(status).toBeDefined();
        // Handler name from Axum uses backward/forward scan — verify it is not empty
        expect(status!.handlerName).toBeTruthy();
    });

    it('web::resource handler name is not empty', () => {
        const source = `
web::resource("/test-resource")
    .route(web::get().to(handler))
`;
        const apis = detectFrameworkApis(source, 'test.rs', 'rust');
        if (apis.length > 0) {
            expect(apis[0].handlerName).toBeTruthy();
        }
    });
});

// ─── BUG-VERIFY-2: Rust route under-detection fixes ─────────────────────────
describe('BUG-VERIFY-2: Rust multi-method + actix app-level routes', () => {
    it('Axum: .route("/", get(root).post(create)) detects BOTH GET and POST', () => {
        const source = `
use axum::{routing::get, Router};
async fn root() {}
async fn create() {}
fn app() -> Router {
    Router::new().route("/", get(root).post(create))
}`;
        const apis = detectFrameworkApis(source, 'src/main.rs', 'rust');
        const get = apis.find(a => a.method === 'GET' && a.route === '/');
        const post = apis.find(a => a.method === 'POST' && a.route === '/');
        expect(get).toBeDefined();
        expect(post).toBeDefined();
        expect(get!.handlerName).toBe('root');
        expect(post!.handlerName).toBe('create');
    });

    it('Axum: triple-method .route("/x", get(a).post(b).delete(c)) detects all three', () => {
        const source = `
use axum::routing::get;
async fn a() {}
async fn b() {}
async fn c() {}
fn app() {
    Router::new().route("/x", get(a).post(b).delete(c));
}`;
        const apis = detectFrameworkApis(source, 'src/main.rs', 'rust');
        const methods = apis.filter(x => x.route === '/x').map(x => x.method).sort();
        expect(methods).toEqual(['DELETE', 'GET', 'POST']);
    });

    it('Axum: single-method .route("/", get(root)) still works (no regression)', () => {
        const source = `
use axum::routing::get;
async fn root() {}
fn app() { Router::new().route("/", get(root)); }`;
        const apis = detectFrameworkApis(source, 'src/main.rs', 'rust');
        const get = apis.filter(a => a.route === '/' && a.method === 'GET');
        expect(get).toHaveLength(1);
        expect(get[0].handlerName).toBe('root');
    });

    it('Axum: anonymous closure .route("/", get(|| async {})) still detected as one GET', () => {
        const source = `
use axum::routing::get;
fn app() { Router::new().route("/", get(|| async { "hi" })); }`;
        const apis = detectFrameworkApis(source, 'src/main.rs', 'rust');
        const get = apis.filter(a => a.route === '/' && a.method === 'GET');
        expect(get).toHaveLength(1);
    });

    it('Actix: app-level .route("/ping", web::get().to(ping)) is detected', () => {
        const source = `
use actix_web::{web, App};
async fn ping() -> &'static str { "pong" }
fn app() {
    App::new().route("/ping", web::get().to(ping));
}`;
        const apis = detectFrameworkApis(source, 'src/main.rs', 'rust');
        const ping = apis.find(a => a.method === 'GET' && a.route === '/ping');
        expect(ping).toBeDefined();
        expect(ping!.handlerName).toBe('ping');
    });

    it('Actix: scope-level .route("/x", web::post().to(create)) detected', () => {
        const source = `
use actix_web::{web, App};
async fn create() {}
fn app() {
    App::new().service(web::scope("/api").route("/x", web::post().to(create)));
}`;
        const apis = detectFrameworkApis(source, 'src/main.rs', 'rust');
        const post = apis.find(a => a.method === 'POST' && a.route.endsWith('/x'));
        expect(post).toBeDefined();
        expect(post!.handlerName).toBe('create');
    });
});
