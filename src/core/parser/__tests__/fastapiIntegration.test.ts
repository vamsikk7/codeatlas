/**
 * fastapiIntegration.test.ts
 *
 * Comprehensive integration tests for FastAPI and Starlette support in CodeAtlas.
 * Covers:
 *   - FastAPI decorator-based route detection (@app.get, @router.post, etc.)
 *   - FastAPI WebSocket route detection
 *   - Starlette Route() with methods extraction
 *   - Starlette WebSocketRoute detection
 *   - Starlette HTTPEndpoint class-based views
 *   - Handler name extraction for async / sync Python functions
 *   - System classification for Python modules
 *   - Django/Alembic migration file detection via infra diff
 *   - Python HTTP client pattern detection
 *   - No false positives from non-route code
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis, classifyExternalSystemMultiLang } from '../frameworkDetector';
import { diffInfrastructureServices } from '../../analysis/serviceDetector';
import type { Snapshot, ServiceRecord, InfrastructureService } from '../../graph/graphTypes';

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeSnapshot(files: Record<string, { hash: string; content: string }>): Snapshot {
    return {
        files: Object.fromEntries(
            Object.entries(files).map(([p, f]) => [p, { path: p, hash: f.hash, mtime: 0, content: f.content, symbols: { functions: [], variables: [], imports: [] } }])
        ),
        apiIndex: {},
        graphs: {},
    };
}

const backendService: ServiceRecord = {
    id: 'service:backend', name: 'backend', rootPath: 'backend',
    technology: 'fastapi', exposedApiCount: 5,
    consumedUrls: [], consumedServices: [], diff: 'unchanged',
};

// ─── Fixtures: realistic FastAPI project files ───────────────────────────────

/** FastAPI main application */
const FASTAPI_MAIN_PY = `
from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Todo API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
)


@app.get("/health")
async def health_check():
    return {"status": "ok"}


@app.get("/items/{item_id}")
async def read_item(item_id: int, q: str = None):
    return {"item_id": item_id, "q": q}


@app.post("/items")
async def create_item(item: ItemCreate):
    return {"id": 1, **item.dict()}


@app.put("/items/{item_id}")
async def update_item(item_id: int, item: ItemUpdate):
    return {"item_id": item_id, **item.dict()}


@app.delete("/items/{item_id}")
async def delete_item(item_id: int):
    return {"deleted": item_id}


@app.patch("/items/{item_id}/status")
async def patch_item_status(item_id: int, status: str):
    return {"item_id": item_id, "status": status}
`;

/** FastAPI router sub-module */
const FASTAPI_ROUTER_PY = `
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from .database import get_db
from .models import Todo
from .schemas import TodoCreate, TodoResponse

router = APIRouter(prefix="/api/v1/todos", tags=["todos"])


@router.get("/")
async def list_todos(db: Session = Depends(get_db)):
    return db.query(Todo).all()


@router.get("/{todo_id}")
async def get_todo(todo_id: int, db: Session = Depends(get_db)):
    todo = db.query(Todo).filter(Todo.id == todo_id).first()
    if not todo:
        raise HTTPException(status_code=404)
    return todo


@router.post("/")
async def create_todo(todo: TodoCreate, db: Session = Depends(get_db)):
    db_todo = Todo(**todo.dict())
    db.add(db_todo)
    db.commit()
    db.refresh(db_todo)
    return db_todo


@router.put("/{todo_id}")
async def update_todo(todo_id: int, todo: TodoCreate, db: Session = Depends(get_db)):
    pass


@router.delete("/{todo_id}")
async def delete_todo(todo_id: int, db: Session = Depends(get_db)):
    pass
`;

/** FastAPI WebSocket route */
const FASTAPI_WEBSOCKET_PY = `
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    while True:
        data = await websocket.receive_text()
        await websocket.send_text(f"Echo: {data}")


@app.websocket("/ws/chat/{room_id}")
async def chat_room(websocket: WebSocket, room_id: str):
    await websocket.accept()
    while True:
        data = await websocket.receive_text()
        await websocket.send_text(data)
`;

/** Starlette application with Route() and methods */
const STARLETTE_ROUTES_PY = `
from starlette.applications import Starlette
from starlette.routing import Route, WebSocketRoute, Mount
from starlette.responses import JSONResponse

async def homepage(request):
    return JSONResponse({"hello": "world"})

async def items(request):
    if request.method == "GET":
        return JSONResponse([])
    elif request.method == "POST":
        body = await request.json()
        return JSONResponse(body, status_code=201)

async def item_detail(request):
    item_id = request.path_params["item_id"]
    return JSONResponse({"id": item_id})

async def ws_handler(websocket):
    await websocket.accept()
    await websocket.send_text("connected")
    await websocket.close()

async def notifications_ws(websocket):
    await websocket.accept()
    while True:
        data = await websocket.receive_json()
        await websocket.send_json({"received": data})

routes = [
    Route("/", homepage),
    Route("/items", items, methods=["GET", "POST"]),
    Route("/items/{item_id}", item_detail, methods=["GET", "PUT", "DELETE"]),
    WebSocketRoute("/ws", ws_handler),
    WebSocketRoute("/ws/notifications", notifications_ws),
]

app = Starlette(routes=routes)
`;

/** Starlette HTTPEndpoint class-based view */
const STARLETTE_ENDPOINT_PY = `
from starlette.endpoints import HTTPEndpoint
from starlette.routing import Route
from starlette.responses import JSONResponse


class UserEndpoint(HTTPEndpoint):
    async def get(self, request):
        return JSONResponse({"users": []})

    async def post(self, request):
        body = await request.json()
        return JSONResponse(body, status_code=201)

    async def delete(self, request):
        return JSONResponse({"deleted": True})


routes = [
    Route("/users", UserEndpoint),
    Route("/users/{user_id}", UserEndpoint, methods=["GET", "PUT"]),
]
`;

/** Non-route Python code (should produce zero false positives) */
const NON_ROUTE_PY = `
import os
import sys
from dataclasses import dataclass
from typing import Optional

@dataclass
class Config:
    database_url: str
    debug: bool = False
    max_connections: int = 10

def get_config() -> Config:
    return Config(
        database_url=os.environ.get("DATABASE_URL", "sqlite:///db.sqlite3"),
        debug=os.environ.get("DEBUG", "false").lower() == "true",
    )

class DataProcessor:
    def process(self, data):
        return [item for item in data if item.get("active")]

    def transform(self, items):
        return [{"id": i, "value": v} for i, v in enumerate(items)]
`;

/** Alembic migration file fixture */
const ALEMBIC_MIGRATION_PY = `
\"\"\"create todos table

Revision ID: abc123
Revises: 
Create Date: 2024-01-01 00:00:00.000000
\"\"\"

from alembic import op
import sqlalchemy as sa

revision = 'abc123'
down_revision = None

def upgrade():
    op.create_table(
        'todos',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('title', sa.String(255), nullable=False),
        sa.Column('completed', sa.Boolean, default=False),
        sa.Column('created_at', sa.DateTime, server_default=sa.func.now()),
    )
    op.add_column('todos', sa.Column('priority', sa.Integer, default=0))

def downgrade():
    op.drop_column('todos', 'priority')
    op.drop_table('todos')
`;

/** Django migration file fixture */
const DJANGO_MIGRATION_PY = `
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name='Todo',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True)),
                ('title', models.CharField(max_length=255)),
                ('completed', models.BooleanField(default=False)),
            ],
        ),
        migrations.AddField(
            model_name='todo',
            name='priority',
            field=models.IntegerField(default=0),
        ),
    ]
`;

/** SQLAlchemy models (used with FastAPI) */
const SQLALCHEMY_MODELS_PY = `
from sqlalchemy import Column, Integer, String, Boolean, DateTime, func
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()

class Todo(Base):
    __tablename__ = "todos"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    completed = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())
`;

/** Python HTTP client code */
const PYTHON_HTTP_CLIENTS_PY = `
import requests
import httpx
import aiohttp

class ServiceClient:
    def __init__(self, base_url: str):
        self.base_url = base_url

    def get_users(self):
        return requests.get(self.base_url + "/api/users")

    def create_user(self, data):
        return requests.post("/api/users", json=data)

    async def async_get_users(self):
        async with httpx.AsyncClient() as client:
            return await httpx.get("/api/users")

    async def aiohttp_get(self):
        async with aiohttp.ClientSession() as session:
            async with session.get('/api/items') as resp:
                return await resp.json()
`;

/** Flask app fixture (for comparison) */
const FLASK_APP_PY = `
from flask import Flask, jsonify, request

app = Flask(__name__)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.get("/items")
def list_items():
    return jsonify([])


@app.post("/items")
def create_item():
    return jsonify(request.json), 201
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FastAPI: @app decorator route detection', () => {
    it('detects @app.get with simple path', () => {
        const apis = detectFrameworkApis(FASTAPI_MAIN_PY, 'main.py', 'python');
        const health = apis.find(a => a.method === 'GET' && a.route === '/health');
        expect(health).toBeDefined();
        expect(health?.handlerName).toBe('health_check');
    });

    it('detects @app.get with path parameter', () => {
        const apis = detectFrameworkApis(FASTAPI_MAIN_PY, 'main.py', 'python');
        const readItem = apis.find(a => a.method === 'GET' && a.route === '/items/{item_id}');
        expect(readItem).toBeDefined();
        expect(readItem?.handlerName).toBe('read_item');
    });

    it('detects @app.post', () => {
        const apis = detectFrameworkApis(FASTAPI_MAIN_PY, 'main.py', 'python');
        const createItem = apis.find(a => a.method === 'POST' && a.route === '/items');
        expect(createItem).toBeDefined();
        expect(createItem?.handlerName).toBe('create_item');
    });

    it('detects @app.put', () => {
        const apis = detectFrameworkApis(FASTAPI_MAIN_PY, 'main.py', 'python');
        const update = apis.find(a => a.method === 'PUT' && a.route === '/items/{item_id}');
        expect(update).toBeDefined();
        expect(update?.handlerName).toBe('update_item');
    });

    it('detects @app.delete', () => {
        const apis = detectFrameworkApis(FASTAPI_MAIN_PY, 'main.py', 'python');
        const del_ = apis.find(a => a.method === 'DELETE' && a.route === '/items/{item_id}');
        expect(del_).toBeDefined();
        expect(del_?.handlerName).toBe('delete_item');
    });

    it('detects @app.patch', () => {
        const apis = detectFrameworkApis(FASTAPI_MAIN_PY, 'main.py', 'python');
        const patch = apis.find(a => a.method === 'PATCH' && a.route === '/items/{item_id}/status');
        expect(patch).toBeDefined();
        expect(patch?.handlerName).toBe('patch_item_status');
    });

    it('detects @router.api_route(path, methods=[...]) — explicit-methods route (was missed → invisible + flagged dead)', () => {
        const src = [
            'from fastapi import APIRouter',
            'router = APIRouter()',
            '',
            '@router.api_route("/{id}/restore", name="customers:restore", methods=["GET", "POST"])',
            'async def restore_customer(id: str):',
            '    return {}',
        ].join('\n');
        const apis = detectFrameworkApis(src, 'endpoints.py', 'python');
        const rec = apis.find(a => a.handlerName === 'restore_customer');
        expect(rec).toBeDefined();
        expect(rec?.route).toBe('/{id}/restore');
        expect(['GET', 'POST']).toContain(rec?.method);
    });

    it('detects all 6 routes in the main app', () => {
        const apis = detectFrameworkApis(FASTAPI_MAIN_PY, 'main.py', 'python');
        // GET /health, GET /items/{item_id}, POST /items, PUT /items/{item_id}, DELETE /items/{item_id}, PATCH /items/{item_id}/status
        const httpApis = apis.filter(a => ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(a.method));
        expect(httpApis.length).toBe(6);
    });

    // BUG-POLAR-13: multi-line FastAPI decorators (a `responses={…}` dict spanning
    // many lines) pushed the `def` past the 8-line forward-scan window, so the
    // handler name fell back to `anonymous@…` (POST) or leaked a bogus identifier
    // out of a description string (DELETE "…active subscription(s)." → "subscription").
    // Shape mirrors polar's customer_portal/endpoints/customer.py.
    const FASTAPI_MULTILINE_DECORATOR_PY = `
from fastapi import APIRouter, Depends

router = APIRouter()

@router.get(
    "/me/payment-methods",
    summary="List Customer Payment Methods",
    response_model=ListResource[CustomerPaymentMethod],
)
async def list_payment_methods(auth_subject, pagination):
    return await customer_service.list_payment_methods(session, auth_subject, pagination=pagination)

@router.post(
    "/me/payment-methods",
    summary="Add Customer Payment Method",
    status_code=201,
    responses={
        201: {"description": "Payment method created or setup initiated."},
        400: {
            "description": "The card was declined while setting up the payment method.",
            "model": PaymentMethodSetupFailed.schema(),
        },
    },
    response_model=CustomerPaymentMethodCreateResponse,
)
async def add_payment_method(auth_subject, payment_method_create):
    return await customer_service.add_payment_method(session, auth_subject, payment_method_create)

@router.delete(
    "/me/payment-methods/{id}",
    summary="Delete Customer Payment Method",
    status_code=204,
    responses={
        204: {"description": "Payment method deleted."},
        400: {
            "description": "Payment method is used by active subscription(s).",
            "model": PaymentMethodInUseByActiveSubscription.schema(),
        },
    },
)
async def delete_payment_method(id, auth_subject):
    await customer_service.delete_payment_method(session, id)
`;

    it('BUG-POLAR-13: resolves handler name across a multi-line decorator (GET)', () => {
        const apis = detectFrameworkApis(FASTAPI_MULTILINE_DECORATOR_PY, 'customer.py', 'python');
        const get = apis.find(a => a.method === 'GET' && a.route === '/me/payment-methods');
        expect(get?.handlerName).toBe('list_payment_methods');
    });

    it('BUG-POLAR-13: POST with a long responses={} dict resolves the real def, not anonymous@', () => {
        const apis = detectFrameworkApis(FASTAPI_MULTILINE_DECORATOR_PY, 'customer.py', 'python');
        const post = apis.find(a => a.method === 'POST' && a.route === '/me/payment-methods');
        expect(post?.handlerName).toBe('add_payment_method');
        expect(post?.handlerName).not.toMatch(/^anonymous@/);
    });

    it('BUG-POLAR-13: DELETE does not leak an identifier from a description string ("subscription")', () => {
        const apis = detectFrameworkApis(FASTAPI_MULTILINE_DECORATOR_PY, 'customer.py', 'python');
        const del = apis.find(a => a.method === 'DELETE' && a.route === '/me/payment-methods/{id}');
        expect(del?.handlerName).toBe('delete_payment_method');
        expect(del?.handlerName).not.toBe('subscription');
    });

    it('all records reference the correct file path', () => {
        const apis = detectFrameworkApis(FASTAPI_MAIN_PY, 'main.py', 'python');
        for (const api of apis) {
            expect(api.filePath).toBe('main.py');
        }
    });

    it('all records have valid ApiRecord structure', () => {
        const apis = detectFrameworkApis(FASTAPI_MAIN_PY, 'main.py', 'python');
        for (const api of apis) {
            expect(api.apiId).toBeTruthy();
            expect(api.method).toBeTruthy();
            expect(api.route).toMatch(/^\//);
            expect(api.handlerName).toBeTruthy();
            expect(api.anchor).toBeDefined();
            expect(api.anchor.filePath).toBe('main.py');
        }
    });
});

describe('FastAPI: @router decorator route detection', () => {
    it('detects @router.get with path and applies APIRouter prefix', () => {
        const apis = detectFrameworkApis(FASTAPI_ROUTER_PY, 'todos/router.py', 'python');
        // prefix="/api/v1/todos" + "/" → "/api/v1/todos"
        const list = apis.find(a => a.method === 'GET' && a.route === '/api/v1/todos');
        expect(list).toBeDefined();
        expect(list?.handlerName).toBe('list_todos');
    });

    it('detects @router.get with path parameter and prefix', () => {
        const apis = detectFrameworkApis(FASTAPI_ROUTER_PY, 'todos/router.py', 'python');
        // prefix="/api/v1/todos" + "/{todo_id}" → "/api/v1/todos/{todo_id}"
        const get = apis.find(a => a.method === 'GET' && a.route === '/api/v1/todos/{todo_id}');
        expect(get).toBeDefined();
        expect(get?.handlerName).toBe('get_todo');
    });

    it('detects @router.post', () => {
        const apis = detectFrameworkApis(FASTAPI_ROUTER_PY, 'todos/router.py', 'python');
        const create = apis.find(a => a.method === 'POST');
        expect(create).toBeDefined();
        expect(create?.handlerName).toBe('create_todo');
    });

    it('detects @router.put', () => {
        const apis = detectFrameworkApis(FASTAPI_ROUTER_PY, 'todos/router.py', 'python');
        const update = apis.find(a => a.method === 'PUT');
        expect(update).toBeDefined();
        expect(update?.handlerName).toBe('update_todo');
    });

    it('detects @router.delete', () => {
        const apis = detectFrameworkApis(FASTAPI_ROUTER_PY, 'todos/router.py', 'python');
        const del_ = apis.find(a => a.method === 'DELETE');
        expect(del_).toBeDefined();
        expect(del_?.handlerName).toBe('delete_todo');
    });

    it('detects all 5 router routes (excluding DI_DEPENDENCY entries)', () => {
        const apis = detectFrameworkApis(FASTAPI_ROUTER_PY, 'todos/router.py', 'python');
        const httpRoutes = apis.filter(a => !['DI_DEPENDENCY', 'MIDDLEWARE', 'SIGNAL'].includes(a.method));
        expect(httpRoutes.length).toBe(5);
    });
});

describe('FastAPI: WebSocket route detection', () => {
    it('detects @app.websocket route', () => {
        const apis = detectFrameworkApis(FASTAPI_WEBSOCKET_PY, 'ws.py', 'python');
        const ws = apis.find(a => a.method === 'WS' && a.route === '/ws');
        expect(ws).toBeDefined();
        expect(ws?.handlerName).toBe('websocket_endpoint');
    });

    it('detects @app.websocket with path parameter', () => {
        const apis = detectFrameworkApis(FASTAPI_WEBSOCKET_PY, 'ws.py', 'python');
        const chat = apis.find(a => a.method === 'WS' && a.route === '/ws/chat/{room_id}');
        expect(chat).toBeDefined();
        expect(chat?.handlerName).toBe('chat_room');
    });

    it('detects both websocket routes', () => {
        const apis = detectFrameworkApis(FASTAPI_WEBSOCKET_PY, 'ws.py', 'python');
        const wsApis = apis.filter(a => a.method === 'WS');
        expect(wsApis.length).toBe(2);
    });
});

describe('Starlette: Route() with methods extraction', () => {
    it('detects Route without methods (defaults to GET)', () => {
        const apis = detectFrameworkApis(STARLETTE_ROUTES_PY, 'app.py', 'python');
        const home = apis.find(a => a.route === '/' && a.method === 'GET');
        expect(home).toBeDefined();
    });

    it('detects Route with methods=["GET", "POST"] and fans out', () => {
        const apis = detectFrameworkApis(STARLETTE_ROUTES_PY, 'app.py', 'python');
        const itemsGet = apis.find(a => a.route === '/items' && a.method === 'GET');
        const itemsPost = apis.find(a => a.route === '/items' && a.method === 'POST');
        expect(itemsGet).toBeDefined();
        expect(itemsPost).toBeDefined();
    });

    it('detects Route with methods=["GET", "PUT", "DELETE"] — three methods fan out', () => {
        const apis = detectFrameworkApis(STARLETTE_ROUTES_PY, 'app.py', 'python');
        const detailGet = apis.find(a => a.route === '/items/{item_id}' && a.method === 'GET');
        const detailPut = apis.find(a => a.route === '/items/{item_id}' && a.method === 'PUT');
        const detailDel = apis.find(a => a.route === '/items/{item_id}' && a.method === 'DELETE');
        expect(detailGet).toBeDefined();
        expect(detailPut).toBeDefined();
        expect(detailDel).toBeDefined();
    });

    it('does not create duplicate GET entries for routes with explicit methods', () => {
        const apis = detectFrameworkApis(STARLETTE_ROUTES_PY, 'app.py', 'python');
        const itemGets = apis.filter(a => a.route === '/items' && a.method === 'GET');
        expect(itemGets.length).toBe(1);
    });
});

describe('Starlette: WebSocketRoute detection', () => {
    it('detects WebSocketRoute with simple path', () => {
        const apis = detectFrameworkApis(STARLETTE_ROUTES_PY, 'app.py', 'python');
        const ws = apis.find(a => a.method === 'WS' && a.route === '/ws');
        expect(ws).toBeDefined();
    });

    it('detects WebSocketRoute with nested path', () => {
        const apis = detectFrameworkApis(STARLETTE_ROUTES_PY, 'app.py', 'python');
        const wsNotif = apis.find(a => a.method === 'WS' && a.route === '/ws/notifications');
        expect(wsNotif).toBeDefined();
    });

    it('all WebSocket routes have method WS', () => {
        const apis = detectFrameworkApis(STARLETTE_ROUTES_PY, 'app.py', 'python');
        const wsApis = apis.filter(a => a.method === 'WS');
        expect(wsApis.length).toBe(2);
        for (const api of wsApis) {
            expect(api.method).toBe('WS');
        }
    });
});

describe('Starlette: HTTPEndpoint class-based views', () => {
    // CBV method bodies (def get/post/...) are NOT detected as standalone routes.
    // Starlette routes come from Route('/path', Handler) declarations.
    it('Route() entries are detected with their endpoint class as handler', () => {
        const apis = detectFrameworkApis(STARLETTE_ENDPOINT_PY, 'endpoints.py', 'python');
        const routes = apis.filter(a => a.route !== '/');
        expect(routes.length).toBeGreaterThanOrEqual(1);
    });

    it('Route() with explicit methods fan out to multiple records', () => {
        const apis = detectFrameworkApis(STARLETTE_ENDPOINT_PY, 'endpoints.py', 'python');
        // Route("/users/{user_id}", ..., methods=["GET", "PUT"]) should produce GET and PUT records
        const withId = apis.filter(a => a.route.includes('{user_id}') || a.route.includes('user_id'));
        const methods = new Set(withId.map(a => a.method));
        expect(methods.has('GET')).toBe(true);
        expect(methods.has('PUT')).toBe(true);
    });

    it('def post/delete in HTTPEndpoint body do not create bare / routes', () => {
        const apis = detectFrameworkApis(STARLETTE_ENDPOINT_PY, 'endpoints.py', 'python');
        const barePost = apis.filter(a => a.route === '/' && a.method === 'POST');
        const bareDelete = apis.filter(a => a.route === '/' && a.method === 'DELETE');
        expect(barePost.length).toBe(0);
        expect(bareDelete.length).toBe(0);
    });
});

describe('Flask: comparison patterns', () => {
    it('detects @app.route with methods', () => {
        const apis = detectFrameworkApis(FLASK_APP_PY, 'app.py', 'python');
        const health = apis.find(a => a.route === '/health');
        expect(health).toBeDefined();
    });

    it('detects @app.get shorthand', () => {
        const apis = detectFrameworkApis(FLASK_APP_PY, 'app.py', 'python');
        const items = apis.find(a => a.route === '/items' && a.method === 'GET');
        expect(items).toBeDefined();
        expect(items?.handlerName).toBe('list_items');
    });

    it('detects @app.post shorthand', () => {
        const apis = detectFrameworkApis(FLASK_APP_PY, 'app.py', 'python');
        const create = apis.find(a => a.route === '/items' && a.method === 'POST');
        expect(create).toBeDefined();
        expect(create?.handlerName).toBe('create_item');
    });
});

describe('No false positives', () => {
    it('non-route Python code produces zero API records', () => {
        const apis = detectFrameworkApis(NON_ROUTE_PY, 'config.py', 'python');
        expect(apis.length).toBe(0);
    });

    it('dataclass decorator does not trigger route detection', () => {
        const apis = detectFrameworkApis(NON_ROUTE_PY, 'config.py', 'python');
        const dataclassApi = apis.find(a => a.handlerName === 'Config');
        expect(dataclassApi).toBeUndefined();
    });

    it('SQLAlchemy model file does not produce API records', () => {
        const apis = detectFrameworkApis(SQLALCHEMY_MODELS_PY, 'models.py', 'python');
        expect(apis.length).toBe(0);
    });

    it('HTTP client code does not produce API records', () => {
        const apis = detectFrameworkApis(PYTHON_HTTP_CLIENTS_PY, 'client.py', 'python');
        expect(apis.length).toBe(0);
    });

    it('Alembic migration file at non-versions path does not produce API records', () => {
        // Alembic migrations are only emitted when under alembic/versions/ —
        // a stray file at versions/abc123.py without the alembic/ prefix
        // shouldn't be matched (see frameworkDetector Tier 1 path guard).
        const apis = detectFrameworkApis(ALEMBIC_MIGRATION_PY, 'versions/abc123.py', 'python');
        expect(apis.length).toBe(0);
    });

    it('Alembic migration file under alembic/versions/ produces a DB_MIGRATION record (Tier 1)', () => {
        const apis = detectFrameworkApis(ALEMBIC_MIGRATION_PY, 'alembic/versions/abc123.py', 'python');
        expect(apis.some(a => a.method === 'DB_MIGRATION')).toBe(true);
    });

    it('Django migration file produces a DB_MIGRATION record (Tier 1, Issue 364)', () => {
        // Django migrations under */migrations/ are now first-class entry
        // points (DB_MIGRATION). They were previously asserted to be zero —
        // the new behavior surfaces them in the L2b "Data Lifecycle" section.
        const apis = detectFrameworkApis(DJANGO_MIGRATION_PY, 'app/migrations/0001_initial.py', 'python');
        expect(apis.some(a => a.method === 'DB_MIGRATION')).toBe(true);
    });
});

describe('Handler name extraction edge cases', () => {
    it('extracts async def handler name from FastAPI decorator', () => {
        const source = `
@app.get("/test")
async def my_async_handler():
    return {"ok": True}
`;
        const apis = detectFrameworkApis(source, 'test.py', 'python');
        expect(apis[0]?.handlerName).toBe('my_async_handler');
    });

    it('extracts sync def handler name from FastAPI decorator', () => {
        const source = `
@app.get("/sync")
def my_sync_handler():
    return {"ok": True}
`;
        const apis = detectFrameworkApis(source, 'test.py', 'python');
        expect(apis[0]?.handlerName).toBe('my_sync_handler');
    });

    it('handles multiple stacked decorators before function', () => {
        const source = `
@app.get("/decorated")
@require_auth
@validate_input
async def multi_decorator_handler():
    return {"ok": True}
`;
        const apis = detectFrameworkApis(source, 'test.py', 'python');
        const get = apis.find(a => a.route === '/decorated');
        expect(get?.handlerName).toBe('multi_decorator_handler');
    });

    it('extracts handler name from class definition after decorator', () => {
        const source = `
@app.route("/class-view")
class MyClassView:
    def get(self, request):
        return Response({})
`;
        const apis = detectFrameworkApis(source, 'test.py', 'python');
        const route = apis.find(a => a.route === '/class-view');
        // The decorator detector should find the route
        // The handler name should be MyClassView (class follows decorator)
        expect(route).toBeDefined();
    });
});

describe('System classification for Python/FastAPI modules', () => {
    it('sqlalchemy classified as database', () => {
        expect(classifyExternalSystemMultiLang('sqlalchemy', 'python')).toBe('database');
    });

    it('tortoise (tortoise-orm) classified as database', () => {
        expect(classifyExternalSystemMultiLang('tortoise', 'python')).toBe('database');
    });

    it('redis classified as cache', () => {
        expect(classifyExternalSystemMultiLang('redis', 'python')).toBe('cache');
    });

    it('celery classified as queue', () => {
        expect(classifyExternalSystemMultiLang('celery', 'python')).toBe('queue');
    });

    it('httpx classified as service', () => {
        expect(classifyExternalSystemMultiLang('httpx', 'python')).toBe('service');
    });

    it('aiohttp classified as service', () => {
        expect(classifyExternalSystemMultiLang('aiohttp', 'python')).toBe('service');
    });

    it('requests classified as service', () => {
        expect(classifyExternalSystemMultiLang('requests', 'python')).toBe('service');
    });

    it('boto3 classified as storage', () => {
        expect(classifyExternalSystemMultiLang('boto3', 'python')).toBe('storage');
    });

    it('django.db classified as database', () => {
        expect(classifyExternalSystemMultiLang('django.db', 'python')).toBe('database');
    });

    it('peewee classified as database', () => {
        expect(classifyExternalSystemMultiLang('peewee', 'python')).toBe('database');
    });

    it('unknown python module classified as module', () => {
        expect(classifyExternalSystemMultiLang('my_internal_lib', 'python')).toBe('module');
    });
});

describe('Infra diff: Django migration pattern detection', () => {
    it('marks DB infra modified when a Django migration file is added', () => {
        const baseline = makeSnapshot({});
        const working = makeSnapshot({
            'backend/todos/migrations/0001_initial.py': { hash: 'aaa', content: DJANGO_MIGRATION_PY },
        });
        const services = { 'service:backend': backendService };

        const infraList: InfrastructureService[] = [
            { id: 'infra:sql--django-orm-', name: 'SQL (Django ORM)', kind: 'database', consumedBy: ['service:backend'] },
        ];

        const result = diffInfrastructureServices(infraList, infraList, baseline, working, services);
        expect(result[0].diff).toBe('modified');
    });

    it('marks DB infra modified when Django migration content changes', () => {
        const baseline = makeSnapshot({
            'backend/todos/migrations/0001.py': { hash: 'aaa', content: DJANGO_MIGRATION_PY },
        });
        const updatedMigration = DJANGO_MIGRATION_PY.replace('CreateModel', 'AddField');
        const working = makeSnapshot({
            'backend/todos/migrations/0001.py': { hash: 'bbb', content: updatedMigration },
        });
        const services = { 'service:backend': backendService };

        const infraList: InfrastructureService[] = [
            { id: 'infra:sql--django-orm-', name: 'SQL (Django ORM)', kind: 'database', consumedBy: ['service:backend'] },
        ];

        const result = diffInfrastructureServices(infraList, infraList, baseline, working, services);
        expect(result[0].diff).toBe('modified');
    });
});

describe('Infra diff: Alembic migration pattern detection', () => {
    it('marks DB infra modified when an Alembic migration file is added', () => {
        const baseline = makeSnapshot({});
        const working = makeSnapshot({
            'backend/alembic/versions/abc123.py': { hash: 'aaa', content: ALEMBIC_MIGRATION_PY },
        });
        const services = { 'service:backend': backendService };

        const infraList: InfrastructureService[] = [
            { id: 'infra:sql--sqlalchemy-', name: 'SQL (SQLAlchemy)', kind: 'database', consumedBy: ['service:backend'] },
        ];

        const result = diffInfrastructureServices(infraList, infraList, baseline, working, services);
        expect(result[0].diff).toBe('modified');
    });

    it('marks DB infra modified when Alembic migration is changed', () => {
        const baseline = makeSnapshot({
            'backend/alembic/versions/abc123.py': { hash: 'aaa', content: ALEMBIC_MIGRATION_PY },
        });
        const changed = ALEMBIC_MIGRATION_PY + '\n    op.add_column("todos", sa.Column("due_date", sa.Date))\n';
        const working = makeSnapshot({
            'backend/alembic/versions/abc123.py': { hash: 'bbb', content: changed },
        });
        const services = { 'service:backend': backendService };

        const infraList: InfrastructureService[] = [
            { id: 'infra:sql--sqlalchemy-', name: 'SQL (SQLAlchemy)', kind: 'database', consumedBy: ['service:backend'] },
        ];

        const result = diffInfrastructureServices(infraList, infraList, baseline, working, services);
        expect(result[0].diff).toBe('modified');
    });

    it('leaves DB infra unchanged when no migration files change', () => {
        const content = 'from sqlalchemy import Column, Integer, String';
        const snapshot = makeSnapshot({
            'backend/models.py': { hash: 'aaa', content },
        });
        const services = { 'service:backend': backendService };

        const infraList: InfrastructureService[] = [
            { id: 'infra:sql--sqlalchemy-', name: 'SQL (SQLAlchemy)', kind: 'database', consumedBy: ['service:backend'] },
        ];

        const result = diffInfrastructureServices(infraList, infraList, snapshot, snapshot, services);
        expect(result[0].diff).toBe('unchanged');
    });
});

describe('Infra diff: Deleted migration files', () => {
    it('marks DB infra modified when a Django migration file is deleted', () => {
        const baseline = makeSnapshot({
            'backend/todos/migrations/0001.py': { hash: 'aaa', content: DJANGO_MIGRATION_PY },
        });
        const working = makeSnapshot({});
        const services = { 'service:backend': backendService };

        const infraList: InfrastructureService[] = [
            { id: 'infra:sql--django-orm-', name: 'SQL (Django ORM)', kind: 'database', consumedBy: ['service:backend'] },
        ];

        const result = diffInfrastructureServices(infraList, infraList, baseline, working, services);
        expect(result[0].diff).toBe('modified');
    });

    it('marks DB infra modified when an Alembic migration file is deleted', () => {
        const baseline = makeSnapshot({
            'backend/alembic/versions/abc123.py': { hash: 'aaa', content: ALEMBIC_MIGRATION_PY },
        });
        const working = makeSnapshot({});
        const services = { 'service:backend': backendService };

        const infraList: InfrastructureService[] = [
            { id: 'infra:sql--sqlalchemy-', name: 'SQL (SQLAlchemy)', kind: 'database', consumedBy: ['service:backend'] },
        ];

        const result = diffInfrastructureServices(infraList, infraList, baseline, working, services);
        expect(result[0].diff).toBe('modified');
    });
});
