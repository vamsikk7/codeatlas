/**
 * djangoIntegration.test.ts
 *
 * Comprehensive integration tests for Python/Django support in CodeAtlas.
 * Simulates real Django project patterns across all diagram layers:
 *   - API detection (FBV, CBV, DRF ViewSets, urls.py)
 *   - Service/infra detection (ORM, Celery, Redis, Channels)
 *   - File graph generation + diff coloring
 *   - Sequence graph generation from Django views
 *   - Handler name extraction
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis, classifyExternalSystemMultiLang } from '../frameworkDetector';
import { buildFileGraph } from '../../graph/fileGraphBuilder';
import { buildSequenceGraph } from '../../graph/sequenceGraphBuilder';

// ─── Fixtures: realistic Django project files ────────────────────────────────

/** Django models.py — ORM models */
const MODELS_PY = `
from django.db import models
from django.contrib.auth.models import User


class Todo(models.Model):
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    completed = models.BooleanField(default=False)
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name='todos')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.title

    def mark_complete(self):
        self.completed = True
        self.save()


class Tag(models.Model):
    name = models.CharField(max_length=100, unique=True)
    todos = models.ManyToManyField(Todo, related_name='tags', blank=True)

    def __str__(self):
        return self.name
`;

/** Django serializers.py — DRF serializers */
const SERIALIZERS_PY = `
from rest_framework import serializers
from .models import Todo, Tag


class TagSerializer(serializers.ModelSerializer):
    class Meta:
        model = Tag
        fields = ['id', 'name']


class TodoSerializer(serializers.ModelSerializer):
    tags = TagSerializer(many=True, read_only=True)
    owner_name = serializers.CharField(source='owner.username', read_only=True)

    class Meta:
        model = Todo
        fields = ['id', 'title', 'description', 'completed', 'owner_name', 'tags', 'created_at']
        read_only_fields = ['created_at', 'owner_name']

    def validate_title(self, value):
        if not value.strip():
            raise serializers.ValidationError("Title cannot be blank.")
        return value.strip()
`;

/** Django services.py — service layer */
const SERVICES_PY = `
import redis
from django.core.cache import cache
from django.db import transaction
from .models import Todo, Tag


class TodoService:
    CACHE_TTL = 300  # 5 minutes

    def list_todos(self, user):
        cache_key = f"todos:user:{user.pk}"
        cached = cache.get(cache_key)
        if cached:
            return cached
        todos = Todo.objects.filter(owner=user).prefetch_related('tags')
        result = list(todos.values('id', 'title', 'completed', 'created_at'))
        cache.set(cache_key, result, self.CACHE_TTL)
        return result

    def create_todo(self, user, data):
        with transaction.atomic():
            todo = Todo.objects.create(owner=user, **data)
            cache.delete(f"todos:user:{user.pk}")
            return todo

    def delete_todo(self, user, todo_id):
        todo = Todo.objects.get(pk=todo_id, owner=user)
        todo.delete()
        cache.delete(f"todos:user:{user.pk}")

    def mark_complete(self, todo_id):
        todo = Todo.objects.get(pk=todo_id)
        todo.mark_complete()
        return todo
`;

/** Django function-based views with DRF @api_view */
const VIEWS_FBV_PY = `
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from .serializers import TodoSerializer
from .services import TodoService

_service = TodoService()


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def todo_list(request):
    if request.method == 'GET':
        todos = _service.list_todos(request.user)
        serializer = TodoSerializer(todos, many=True)
        return Response(serializer.data)
    elif request.method == 'POST':
        serializer = TodoSerializer(data=request.data)
        if serializer.is_valid():
            todo = _service.create_todo(request.user, serializer.validated_data)
            return Response(TodoSerializer(todo).data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


@api_view(['GET', 'DELETE'])
@permission_classes([IsAuthenticated])
def todo_detail(request, pk):
    if request.method == 'GET':
        todo = Todo.objects.get(pk=pk, owner=request.user)
        return Response(TodoSerializer(todo).data)
    elif request.method == 'DELETE':
        _service.delete_todo(request.user, pk)
        return Response(status=status.HTTP_204_NO_CONTENT)
`;

/** Django class-based views with DRF APIView */
const VIEWS_CBV_PY = `
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework import status
from .serializers import TodoSerializer
from .services import TodoService


class TodoListView(APIView):
    permission_classes = [IsAuthenticated]

    def __init__(self, service: TodoService = None):
        super().__init__()
        self.service = service or TodoService()

    def get(self, request):
        todos = self.service.list_todos(request.user)
        serializer = TodoSerializer(todos, many=True)
        return Response(serializer.data)

    def post(self, request):
        serializer = TodoSerializer(data=request.data)
        if serializer.is_valid():
            todo = self.service.create_todo(request.user, serializer.validated_data)
            return Response(TodoSerializer(todo).data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class TodoDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        from .models import Todo
        todo = Todo.objects.get(pk=pk, owner=request.user)
        return Response(TodoSerializer(todo).data)

    def put(self, request, pk):
        from .models import Todo
        todo = Todo.objects.get(pk=pk, owner=request.user)
        serializer = TodoSerializer(todo, data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def delete(self, request, pk):
        service = TodoService()
        service.delete_todo(request.user, pk)
        return Response(status=status.HTTP_204_NO_CONTENT)
`;

/** DRF ModelViewSet */
const VIEWS_VIEWSET_PY = `
from rest_framework import viewsets, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import Todo
from .serializers import TodoSerializer


class TodoViewSet(viewsets.ModelViewSet):
    serializer_class = TodoSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Todo.objects.filter(owner=self.request.user)

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    @action(detail=True, methods=['post'])
    def complete(self, request, pk=None):
        todo = self.get_object()
        todo.mark_complete()
        return Response({'status': 'completed'})

    @action(detail=False, methods=['get'])
    def stats(self, request):
        total = self.get_queryset().count()
        done = self.get_queryset().filter(completed=True).count()
        return Response({'total': total, 'completed': done})
`;

/** Django urls.py */
const URLS_PY = `
from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views
from .views_cbv import TodoListView, TodoDetailView
from .views_viewset import TodoViewSet

router = DefaultRouter()
router.register(r'viewset/todos', TodoViewSet, basename='todo-viewset')

urlpatterns = [
    # Function-based views
    path('api/todos/', views.todo_list, name='todo-list'),
    path('api/todos/<int:pk>/', views.todo_detail, name='todo-detail'),
    # Class-based views
    path('api/cbv/todos/', TodoListView.as_view(), name='cbv-todo-list'),
    path('api/cbv/todos/<int:pk>/', TodoDetailView.as_view(), name='cbv-todo-detail'),
    # Router-registered ViewSet
    path('api/', include(router.urls)),
]
`;

/** Django settings.py with database + cache config */
const SETTINGS_PY = `
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = 'django-insecure-secret-key'
DEBUG = True
ALLOWED_HOSTS = []

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'rest_framework',
    'todos',
]

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': 'tododb',
        'USER': 'postgres',
        'PASSWORD': 'password',
        'HOST': 'localhost',
        'PORT': '5432',
    }
}

CACHES = {
    'default': {
        'BACKEND': 'django_redis.cache.RedisCache',
        'LOCATION': 'redis://127.0.0.1:6379/1',
    }
}

CELERY_BROKER_URL = 'redis://localhost:6379/0'
CELERY_RESULT_BACKEND = 'redis://localhost:6379/0'

CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {'hosts': [('127.0.0.1', 6379)]},
    }
}
`;

/** Django celery tasks */
const TASKS_PY = `
from celery import Celery
from celery import shared_task
from django.core.mail import send_mail
from .models import Todo


app = Celery('todos')


@shared_task
def send_todo_reminder(user_email: str, todo_id: int):
    todo = Todo.objects.get(pk=todo_id)
    send_mail(
        subject=f'Reminder: {todo.title}',
        message='You have a pending todo item.',
        from_email='noreply@example.com',
        recipient_list=[user_email],
    )
    return f'Sent reminder for todo {todo_id}'


@shared_task
def cleanup_completed_todos():
    deleted_count, _ = Todo.objects.filter(completed=True).delete()
    return f'Deleted {deleted_count} completed todos'
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Django: Function-Based Views (FBV) with @api_view', () => {
    it('detects @api_view GET as first method', () => {
        const apis = detectFrameworkApis(VIEWS_FBV_PY, 'views.py', 'python');
        const getApis = apis.filter(a => a.method === 'GET');
        expect(getApis.length).toBeGreaterThanOrEqual(1);
    });

    it('fan-out: @api_view([\'GET\', \'POST\']) emits both GET and POST', () => {
        const apis = detectFrameworkApis(VIEWS_FBV_PY, 'views.py', 'python');
        const listApis = apis.filter(a => a.handlerName === 'todo_list');
        const methods = listApis.map(a => a.method);
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
    });

    it('fan-out: @api_view([\'GET\', \'DELETE\']) emits GET and DELETE', () => {
        const apis = detectFrameworkApis(VIEWS_FBV_PY, 'views.py', 'python');
        const detailApis = apis.filter(a => a.handlerName === 'todo_detail');
        const methods = detailApis.map(a => a.method);
        expect(methods).toContain('GET');
        expect(methods).toContain('DELETE');
    });

    it('extracts correct handler names from function definitions after decorator', () => {
        const apis = detectFrameworkApis(VIEWS_FBV_PY, 'views.py', 'python');
        const handlerNames = apis.map(a => a.handlerName);
        expect(handlerNames).toContain('todo_list');
        expect(handlerNames).toContain('todo_detail');
    });

    it('produces valid ApiRecord shape', () => {
        const apis = detectFrameworkApis(VIEWS_FBV_PY, 'views.py', 'python');
        for (const api of apis) {
            expect(api.apiId).toBeTruthy();
            expect(api.method).toBeTruthy();
            expect(api.handlerName).toBeTruthy();
            expect(api.filePath).toBe('views.py');
            expect(api.anchor).toBeDefined();
        }
    });
});

describe('Django: Class-Based Views (CBV) with APIView', () => {
    // CBV method bodies (def get/post/...) in views files are NOT detected as standalone routes.
    // Routes are detected via path() / as_view() in urls.py files.
    // The HTTP method resolution happens at sequence-graph build time by inspecting the view class body.
    it('does not create standalone routes from CBV method bodies in views file', () => {
        const apis = detectFrameworkApis(VIEWS_CBV_PY, 'views_cbv.py', 'python');
        // No route records with bare route='/' and handler matching HTTP verb should exist
        const spurious = apis.filter(a => a.route === '/' && ['GET','POST','PUT','PATCH','DELETE'].includes(a.method)
            && a.handlerName === a.method.toLowerCase());
        expect(spurious.length).toBe(0);
    });

    it('detects CBV routes via path() + as_view() in urls.py', () => {
        const urlSource = `
from django.urls import path
from .views import TodoListView, TodoDetailView

urlpatterns = [
    path('todos/', TodoListView.as_view()),
    path('todos/<int:pk>/', TodoDetailView.as_view()),
]
`;
        const apis = detectFrameworkApis(urlSource, 'urls.py', 'python');
        expect(apis.find(a => a.handlerName === 'TodoListView')).toBeDefined();
        expect(apis.find(a => a.handlerName === 'TodoDetailView')).toBeDefined();
    });

    it('detects PUT and DELETE methods as CBV routes via urls.py', () => {
        const urlSource = `
from django.urls import path
from .views import TodoDetailView

urlpatterns = [
    path('todos/<int:pk>/', TodoDetailView.as_view()),
]
`;
        const apis = detectFrameworkApis(urlSource, 'urls.py', 'python');
        expect(apis.find(a => a.handlerName === 'TodoDetailView')).toBeDefined();
    });

    it('CBV view file produces no API records (routes come from urls.py)', () => {
        const apis = detectFrameworkApis(VIEWS_CBV_PY, 'views_cbv.py', 'python');
        expect(apis.length).toBe(0);
    });

    it('#898 — path() to admin.site.urls is NOT a phantom route; real FBV still detected', () => {
        const urlSource = `
from django.contrib import admin
from django.urls import path
from . import views

urlpatterns = [
    path('admin/', admin.site.urls),
    path('users/', views.list_users),
    path('home/', home_view),
]
`;
        const apis = detectFrameworkApis(urlSource, 'urls.py', 'python');
        // The admin-site aggregator must NOT produce a route.
        expect(apis.find(a => a.route === '/admin/')).toBeUndefined();
        expect(apis.find(a => a.handlerName === 'site')).toBeUndefined();
        expect(apis.find(a => a.handlerName === 'urls')).toBeUndefined();
        // Real FBV routes ARE still detected.
        expect(apis.find(a => a.handlerName === 'list_users' && a.route === '/users/')).toBeDefined();
        expect(apis.find(a => a.handlerName === 'home_view' && a.route === '/home/')).toBeDefined();
    });
});

describe('Django: DRF ModelViewSet', () => {
    it('ignores non-action methods like get_queryset', () => {
        const apis = detectFrameworkApis(VIEWS_VIEWSET_PY, 'views_viewset.py', 'python');
        const illegalGet = apis.find(a => a.handlerName === 'get_queryset');
        expect(illegalGet).toBeUndefined();
    });

    it('detects @action decorated methods and their HTTP verbs', () => {
        const apis = detectFrameworkApis(VIEWS_VIEWSET_PY, 'views_viewset.py', 'python');
        
        const completeAction = apis.find(a => a.handlerName === 'complete');
        expect(completeAction).toBeDefined();
        expect(completeAction?.method).toBe('POST');
        expect(completeAction?.route).toBe('/complete');

        const statsAction = apis.find(a => a.handlerName === 'stats');
        expect(statsAction).toBeDefined();
        expect(statsAction?.method).toBe('GET');
        expect(statsAction?.route).toBe('/stats');
    });
});

describe('Django: urls.py pattern detection', () => {
    it('detects path() with function view', () => {
        const apis = detectFrameworkApis(URLS_PY, 'urls.py', 'python');
        const todoList = apis.find(a => a.route === '/api/todos/');
        expect(todoList).toBeDefined();
        expect(todoList?.method).toBe('GET');
    });

    it('extracts view function name as handlerName from path()', () => {
        const apis = detectFrameworkApis(URLS_PY, 'urls.py', 'python');
        const todoList = apis.find(a => a.route === '/api/todos/');
        expect(todoList?.handlerName).toBe('todo_list');
    });

    it('detects path() with class-based view .as_view()', () => {
        const apis = detectFrameworkApis(URLS_PY, 'urls.py', 'python');
        const cbvList = apis.find(a => a.route === '/api/cbv/todos/');
        expect(cbvList).toBeDefined();
        expect(cbvList?.handlerName).toBe('TodoListView');
    });

    it('extracts class name from TodoDetailView.as_view()', () => {
        const apis = detectFrameworkApis(URLS_PY, 'urls.py', 'python');
        const cbvDetail = apis.find(a => a.route === '/api/cbv/todos/<int:pk>/');
        expect(cbvDetail?.handlerName).toBe('TodoDetailView');
    });

    it('detects router.register() for DRF ViewSet', () => {
        const apis = detectFrameworkApis(URLS_PY, 'urls.py', 'python');
        const viewsetApi = apis.find(a => a.route.includes('viewset/todos'));
        expect(viewsetApi).toBeDefined();
        expect(viewsetApi?.method).toBe('RESOURCE');
        expect(viewsetApi?.handlerName).toBe('TodoViewSet');
    });

    it('detects parameterized path() with <int:pk>', () => {
        const apis = detectFrameworkApis(URLS_PY, 'urls.py', 'python');
        const detail = apis.find(a => a.route === '/api/todos/<int:pk>/');
        expect(detail).toBeDefined();
        expect(detail?.handlerName).toBe('todo_detail');
    });

    it('returns correct file path in all records', () => {
        const apis = detectFrameworkApis(URLS_PY, 'urls.py', 'python');
        for (const api of apis) {
            expect(api.filePath).toBe('urls.py');
        }
    });
});

describe('Django: Flask / FastAPI decorator patterns (Python)', () => {
    it('detects @app.get FastAPI pattern', () => {
        const source = `
from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
async def health_check():
    return {"status": "ok"}

@app.post("/todos")
async def create_todo(todo: TodoCreate):
    pass
`;
        const apis = detectFrameworkApis(source, 'main.py', 'python');
        const get = apis.find(a => a.method === 'GET');
        const post = apis.find(a => a.method === 'POST');
        expect(get?.route).toBe('/health');
        expect(get?.handlerName).toBe('health_check');
        expect(post?.route).toBe('/todos');
        expect(post?.handlerName).toBe('create_todo');
    });

    it('detects @blueprint.route Flask pattern', () => {
        const source = `
from flask import Blueprint, jsonify
bp = Blueprint('todos', __name__)

@bp.route('/api/todos', methods=['GET'])
def get_todos():
    return jsonify([])

@bp.route('/api/todos/<int:id>', methods=['DELETE'])
def delete_todo(id):
    return '', 204
`;
        const apis = detectFrameworkApis(source, 'routes.py', 'python');
        const get = apis.find(a => a.method === 'GET');
        expect(get?.route).toBe('/api/todos');
        expect(get?.handlerName).toBe('get_todos');
    });
});

describe('Django: Service / Infra detection in serviceDetector context', () => {
    // Test via classifyExternalSystemMultiLang (which is used for sequence graph participants)
    it('classifies django.db as database', () => {
        expect(classifyExternalSystemMultiLang('django.db', 'python')).toBe('database');
    });

    it('classifies sqlalchemy as database', () => {
        expect(classifyExternalSystemMultiLang('sqlalchemy', 'python')).toBe('database');
    });

    it('classifies redis (Python) as cache', () => {
        expect(classifyExternalSystemMultiLang('redis', 'python')).toBe('cache');
    });

    it('classifies celery as queue', () => {
        expect(classifyExternalSystemMultiLang('celery', 'python')).toBe('queue');
    });

    it('classifies requests as service', () => {
        expect(classifyExternalSystemMultiLang('requests', 'python')).toBe('service');
    });

    it('classifies httpx as service', () => {
        expect(classifyExternalSystemMultiLang('httpx', 'python')).toBe('service');
    });

    it('classifies aiohttp as service', () => {
        expect(classifyExternalSystemMultiLang('aiohttp', 'python')).toBe('service');
    });

    it('classifies boto3 (S3) as storage', () => {
        expect(classifyExternalSystemMultiLang('boto3', 'python')).toBe('storage');
    });
});

describe('Django: File graph generation from Django models', () => {
    // The JS file graph builder is used directly for JS; for Python we use buildFileGraphFromAnalysis.
    // Since tests don't have a live Tree-sitter WASM, we test the diff logic via the JS builder
    // with equivalent structure, and verify that the Django-specific patterns flow correctly.

    it('models.py generates a valid file graph from JS-equivalent structure', () => {
        // Use JS-compatible syntax to simulate a model file structure and verify graph shape
        const jsEquivalent = `
const models = require('django.db');

class Todo extends models.Model {
    constructor() {
        this.title = "";
        this.completed = false;
    }

    markComplete() {
        this.completed = true;
    }
}

class Tag extends models.Model {
    constructor() {
        this.name = "";
    }
}
`;
        const graph = buildFileGraph(jsEquivalent, 'todos/models.py');
        expect(graph.type).toBe('file');
        expect(graph.graphId).toBe('file:todos/models.py');
        expect(graph.nodes.some(n => n.type === 'import')).toBe(true);
    });

    it('diff: adding a new model field shows as "modified" on the class', () => {
        const oldCode = `
function Todo() {
    this.title = "";
    this.completed = false;
}
`;
        const newCode = `
function Todo() {
    this.title = "";
    this.description = "";
    this.completed = false;
    this.priority = 0;
}
`;
        const graph = buildFileGraph(newCode, 'models.py', oldCode);
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        // Todo function body changed → should be modified
        const todoNode = funcNodes.find(n => n.label === 'Todo');
        expect(todoNode?.diff).toBe('modified');
    });

    it('diff: adding a new model shows as "added"', () => {
        const oldCode = `function Todo() { this.title = ""; }`;
        const newCode = `
function Todo() { this.title = ""; }
function Tag() { this.name = ""; }
`;
        const graph = buildFileGraph(newCode, 'models.py', oldCode);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
        expect(addedNodes.some(n => n.label === 'Tag')).toBe(true);
    });

    it('diff: removing a model shows as "deleted"', () => {
        const oldCode = `
function Todo() { this.title = ""; }
function OldModel() { this.data = null; }
`;
        const newCode = `function Todo() { this.title = ""; }`;
        const graph = buildFileGraph(newCode, 'models.py', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
        expect(deletedNodes.some(n => n.label.includes('OldModel'))).toBe(true);
    });

    it('diff: unchanged models remain "unchanged"', () => {
        const code = `function Todo() { this.title = ""; }`;
        const graph = buildFileGraph(code, 'models.py', code);
        const funcNodes = graph.nodes.filter(n => n.type === 'function');
        expect(funcNodes.every(n => n.diff === 'unchanged')).toBe(true);
    });
});

describe('Django: File graph diff — views.py scenarios', () => {
    const oldViews = `
import express from 'express';
const router = express.Router();

function todo_list(req, res) {
    return res.json([]);
}

function todo_detail(req, res) {
    return res.json({});
}

router.get('/api/todos/', todo_list);
router.get('/api/todos/:pk/', todo_detail);
`;

    it('adding a new view function shows as "added"', () => {
        const newViews = oldViews + `
function todo_complete(req, res) {
    return res.json({ status: 'completed' });
}
router.post('/api/todos/:pk/complete/', todo_complete);
`;
        const graph = buildFileGraph(newViews, 'views.py', oldViews);
        const added = graph.nodes.filter(n => n.diff === 'added');
        expect(added.some(n => n.label === 'todo_complete')).toBe(true);
    });

    it('modifying a view function body shows as "modified"', () => {
        const newViews = oldViews.replace(
            'return res.json([]);',
            'const todos = [{ id: 1, title: "Test" }];\n    return res.json(todos);'
        );
        const graph = buildFileGraph(newViews, 'views.py', oldViews);
        const modified = graph.nodes.filter(n => n.diff === 'modified');
        expect(modified.length).toBeGreaterThanOrEqual(1);
    });

    it('deleting a view function shows as "deleted"', () => {
        const newViews = `
import express from 'express';
const router = express.Router();

function todo_list(req, res) {
    return res.json([]);
}

router.get('/api/todos/', todo_list);
`;
        const graph = buildFileGraph(newViews, 'views.py', oldViews);
        const deleted = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deleted.length).toBeGreaterThanOrEqual(1);
        expect(deleted.some(n => n.label.includes('todo_detail'))).toBe(true);
    });
});

describe('Django: Sequence graph generation', () => {
    // buildSequenceGraph uses the JS Babel parser internally, so we write JS-equivalent
    // Django-style code to test sequence diagram generation paths.

    const djangoStyleSequenceCode = `
const cache = require('django.cache');
const Todo = require('./models');
const TodoSerializer = require('./serializers');

async function todo_list(request, response) {
    const cached = await cache.get('todos:' + request.user);
    if (cached) {
        return response.json(cached);
    }
    const todos = await Todo.objects.filter({ owner: request.user });
    const data = TodoSerializer.serialize(todos);
    await cache.set('todos:' + request.user, data, 300);
    return response.json(data);
}

module.exports = { todo_list };
`;

    it('generates a sequence graph with correct type', () => {
        const graph = buildSequenceGraph(djangoStyleSequenceCode, 'todos/views.py');
        expect(graph.type).toBe('sequence');
    });

    it('generates a graphId using the file path', () => {
        const graph = buildSequenceGraph(djangoStyleSequenceCode, 'todos/views.py');
        expect(graph.graphId).toBe('sequence:todos/views.py');
    });

    it('has at least one participant node', () => {
        const graph = buildSequenceGraph(djangoStyleSequenceCode, 'todos/views.py');
        const participants = graph.nodes.filter(n => n.type === 'participant');
        expect(participants.length).toBeGreaterThanOrEqual(1);
    });

    it('has message edges representing function calls', () => {
        const graph = buildSequenceGraph(djangoStyleSequenceCode, 'todos/views.py');
        const messages = graph.edges.filter(e => e.edgeType === 'message');
        expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('detects cache participant from django.cache import', () => {
        const graph = buildSequenceGraph(djangoStyleSequenceCode, 'todos/views.py');
        const cacheNode = graph.nodes.find(n =>
            n.label === 'cache' || n.subtitle?.includes('cache') || n.label?.toLowerCase().includes('cache')
        );
        expect(cacheNode).toBeDefined();
    });

    it('diff mode: new cache interaction shows as added participant', () => {
        const oldCode = `
const Todo = require('./models');

async function todo_list(request, response) {
    const todos = await Todo.objects.filter({ owner: request.user });
    return response.json(todos);
}
`;
        const newCode = `
const Todo = require('./models');
const cache = require('django.cache');

async function todo_list(request, response) {
    const cached = await cache.get('todos:list');
    if (cached) return response.json(cached);
    const todos = await Todo.objects.filter({ owner: request.user });
    cache.set('todos:list', todos, 300);
    return response.json(todos);
}
`;
        const graph = buildSequenceGraph(newCode, 'todos/views.py', oldCode);
        // cache is newly added
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('diff mode: removing a service call shows as deleted edge or node', () => {
        const oldCode = `
const Todo = require('./models');
const cache = require('django.cache');
const Celery = require('celery');

async function todo_list(request, response) {
    const cached = await cache.get('todos:list');
    const todos = await Todo.objects.filter({ owner: request.user });
    Celery.send_task('refresh_cache');
    return response.json(todos);
}
`;
        const newCode = `
const Todo = require('./models');
const cache = require('django.cache');

async function todo_list(request, response) {
    const cached = await cache.get('todos:list');
    const todos = await Todo.objects.filter({ owner: request.user });
    return response.json(todos);
}
`;
        const graph = buildSequenceGraph(newCode, 'todos/views.py', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        // Celery participant should be marked deleted
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
    });
});

describe('Django: re_path / url() pattern detection', () => {
    it('detects re_path with regex patterns', () => {
        const source = `
from django.urls import re_path
from . import views

urlpatterns = [
    re_path(r'^articles/(?P<year>[0-9]{4})/$', views.year_archive, name='year'),
    re_path(r'^articles/(?P<year>[0-9]{4})/(?P<month>[0-9]{2})/$', views.month_archive),
]
`;
        const apis = detectFrameworkApis(source, 'urls.py', 'python');
        expect(apis.length).toBeGreaterThanOrEqual(1);
        // Routes should have anchors (^/$) stripped
        for (const api of apis) {
            expect(api.route).not.toContain('^');
            expect(api.route).not.toContain('$');
        }
    });

    it('detects legacy url() pattern', () => {
        const source = `
from django.conf.urls import url
from . import views

urlpatterns = [
    url(r'^api/users/$', views.user_list, name='user-list'),
    url(r'^api/users/(?P<pk>[0-9]+)/$', views.user_detail),
]
`;
        const apis = detectFrameworkApis(source, 'urls.py', 'python');
        expect(apis.length).toBeGreaterThanOrEqual(1);
    });
});

describe('Django: Celery tasks detection', () => {
    it('@shared_task decorator marks handler name correctly', () => {
        const apis = detectFrameworkApis(TASKS_PY, 'tasks.py', 'python');
        // @shared_task is not an HTTP route, so should not be detected as API
        // The celery Celery() class-level detection is for infra, not routes
        // Verify: no false-positive HTTP methods from celery code
        const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        for (const api of apis) {
            if (httpMethods.includes(api.method)) {
                // Should not have HTTP routes from tasks.py
                throw new Error(`Unexpected HTTP route detected in tasks.py: ${api.method} ${api.route}`);
            }
        }
    });
});

describe('Django: Handler name extraction edge cases', () => {
    it('extracts async def function name after @api_view', () => {
        const source = `
from rest_framework.decorators import api_view

@api_view(['GET'])
async def async_todo_list(request):
    return Response([])
`;
        const apis = detectFrameworkApis(source, 'views.py', 'python');
        const get = apis.find(a => a.method === 'GET');
        expect(get?.handlerName).toBe('async_todo_list');
    });

    it('extracts class name from CBV route via urls.py path()', () => {
        const source = `
from django.urls import path
from .views import MyApiView

urlpatterns = [
    path('items/', MyApiView.as_view()),
]
`;
        const apis = detectFrameworkApis(source, 'urls.py', 'python');
        const route = apis.find(a => a.handlerName === 'MyApiView');
        expect(route).toBeDefined();
    });

    it('Issue 332: nested path() with include() now emits INCLUDE entries with the included module as handler', () => {
        const source = `
from django.urls import path, include

urlpatterns = [
    path('api/v1/', include('todos.urls')),
    path('api/v2/', include('todos_v2.urls')),
]
`;
        const apis = detectFrameworkApis(source, 'urls.py', 'python');
        // The include() URLConf aggregator is now surfaced as a method=INCLUDE
        // record with the module string as handlerName, so the verifier knows
        // those routes' real handlers live in another file.
        const includes = apis.filter(a => a.method === 'INCLUDE');
        expect(includes.length).toBe(2);
        expect(includes.find(a => a.handlerName === 'todos.urls')).toBeDefined();
        expect(includes.find(a => a.handlerName === 'todos_v2.urls')).toBeDefined();
    });

    it('handles multiple decorators stacked on a view', () => {
        const source = `
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated

@api_view(['GET', 'POST', 'PUT'])
@permission_classes([IsAuthenticated])
def multi_method_view(request):
    pass
`;
        const apis = detectFrameworkApis(source, 'views.py', 'python');
        const methods = apis.map(a => a.method);
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        // All should point to same handler
        const handlers = [...new Set(apis.filter(a => ['GET', 'POST', 'PUT'].includes(a.method)).map(a => a.handlerName))];
        expect(handlers).toHaveLength(1);
        expect(handlers[0]).toBe('multi_method_view');
    });
});

describe('Django: System classification for Python modules', () => {
    it('peewee classified as database', () => {
        expect(classifyExternalSystemMultiLang('peewee', 'python')).toBe('database');
    });

    it('tortoise (tortoise-orm) classified as database', () => {
        expect(classifyExternalSystemMultiLang('tortoise', 'python')).toBe('database');
    });

    it('urllib classified as service (HTTP client)', () => {
        expect(classifyExternalSystemMultiLang('urllib', 'python')).toBe('service');
    });

    it('unknown python package classified as module', () => {
        expect(classifyExternalSystemMultiLang('my_custom_lib', 'python')).toBe('module');
    });
});

// ─── Issue 158: Django Middleware Detection ──────────────────────────────────

describe('Django Middleware Detection', () => {
    it('detects middleware class with process_request', () => {
        const source = `
class AuthMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def process_request(self, request):
        if not request.user.is_authenticated:
            return HttpResponseForbidden()

    def process_response(self, request, response):
        return response
`;
        const apis = detectFrameworkApis(source, 'middleware/auth.py', 'python');
        const mw = apis.find(a => a.method === 'MIDDLEWARE');
        expect(mw).toBeDefined();
        expect(mw!.handlerName).toBe('AuthMiddleware');
    });

    it('detects middleware class with __call__', () => {
        const source = `
class TimingMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        start = time.time()
        response = self.get_response(request)
        return response
`;
        const apis = detectFrameworkApis(source, 'middleware/timing.py', 'python');
        expect(apis.find(a => a.method === 'MIDDLEWARE')).toBeDefined();
    });
});

// ─── Issue 159: Django Signals Detection ────────────────────────────────────

describe('Django Signals Detection', () => {
    it('detects @receiver(post_save, sender=Model)', () => {
        const source = `
from django.db.models.signals import post_save
from django.dispatch import receiver

@receiver(post_save, sender=User)
def create_user_profile(sender, instance, created, **kwargs):
    if created:
        Profile.objects.create(user=instance)
`;
        const apis = detectFrameworkApis(source, 'signals.py', 'python');
        const sig = apis.find(a => a.method === 'SIGNAL');
        expect(sig).toBeDefined();
        expect(sig!.route).toBe('/post_save:User');
    });

    it('detects @receiver without sender', () => {
        const source = `
@receiver(pre_delete)
def cleanup_files(sender, instance, **kwargs):
    instance.file.delete(save=False)
`;
        const apis = detectFrameworkApis(source, 'signals.py', 'python');
        const sig = apis.find(a => a.method === 'SIGNAL');
        expect(sig).toBeDefined();
        expect(sig!.route).toBe('/pre_delete:Any');
    });
});

// ─── Issue 161: FastAPI Depends() Detection ─────────────────────────────────

describe('FastAPI Depends() Detection', () => {
    // BUG-POLAR-12: `Depends(provider)` targets are DI wiring, NOT first-class
    // entry points — they inflated real apps (polar) with 283 `/depends:*`
    // pseudo-routes (~34% of entry points). They are no longer emitted.
    it('does NOT register Depends() providers as DI_DEPENDENCY entry points', () => {
        const source = `
from fastapi import Depends
from sqlalchemy.orm import Session

def get_todos(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return db.query(Todo).all()
`;
        const apis = detectFrameworkApis(source, 'routes/todos.py', 'python');
        expect(apis.some(a => a.method === 'DI_DEPENDENCY' || (a.route || '').includes('depends:'))).toBe(false);
    });
});
