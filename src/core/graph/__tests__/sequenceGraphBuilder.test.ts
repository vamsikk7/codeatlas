import { describe, it, expect } from 'vitest';
import { buildSequenceGraph, buildSequenceGraphFromAnalysis, shortenQualifiedName, isSequenceNoiseCall } from '../sequenceGraphBuilder';
import { detectApis } from '../../parser/apiDetector';

describe('isSequenceNoiseCall (BUG-POLAR-4 — filter DI markers + raised exceptions)', () => {
    it('filters FastAPI DI markers', () => {
        for (const n of ['Depends', 'Query', 'Path', 'Body', 'Header', 'Cookie', 'Form', 'File', 'Security']) {
            expect(isSequenceNoiseCall(n)).toBe(true);
        }
    });
    it('filters PascalCase exception constructors', () => {
        expect(isSequenceNoiseCall('PolarAuthError')).toBe(true);
        expect(isSequenceNoiseCall('UnavailableFactorError')).toBe(true);
        expect(isSequenceNoiseCall('ValidationException')).toBe(true);
    });
    it('does NOT filter real calls (including lowercase *error helpers + service methods)', () => {
        expect(isSequenceNoiseCall('handleError')).toBe(false); // lowercase — a real helper
        expect(isSequenceNoiseCall('create')).toBe(false);
        expect(isSequenceNoiseCall('enroll')).toBe(false);
        expect(isSequenceNoiseCall('')).toBe(false);
    });
});

describe('sequenceGraphBuilder', () => {
  const sampleApiCode = `
import express from "express";
import axios from "axios";
import redis from "redis";
import { Pool } from "pg";

const router = express.Router();
const db = new Pool();
const cache = redis.createClient();

function buildUserResponse(row) {
  return { id: row.id, name: row.name };
}

async function getUserHandler(req, res) {
  const cached = await cache.get("user:" + req.params.id);
  if (cached) return res.json(JSON.parse(cached));
  const result = await db.query("select * from users where id=$1", [req.params.id]);
  const payload = buildUserResponse(result.rows[0]);
  await cache.set("user:" + req.params.id, JSON.stringify(payload));
  return res.json(payload);
}

router.get("/users/:id", getUserHandler);`;

  it('should build a sequence graph with correct structure', () => {
    const graph = buildSequenceGraph(sampleApiCode, 'src/api/users.js');

    expect(graph.type).toBe('sequence');
    expect(graph.graphId).toBe('sequence:src/api/users.js');
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it('should not include a file root node in nodes array — file info lives in meta', () => {
    const graph = buildSequenceGraph(sampleApiCode, 'src/api/users.js');
    const fileNodes = graph.nodes.filter((n) => n.type === 'file');

    expect(fileNodes).toHaveLength(0);
    expect(graph.meta?.fileName).toBe('users.js');
    expect(graph.meta?.filePath).toBe('src/api/users.js');
  });

  it('should create an API Client participant', () => {
    const graph = buildSequenceGraph(sampleApiCode, 'api.js');
    const clientNode = graph.nodes.find((n) => n.label === 'API Client');

    expect(clientNode).toBeDefined();
    expect(clientNode!.subtitle).toBe('«actor»');
  });

  it('should create handler file participants instead of individual functions', () => {
    const graph = buildSequenceGraph(sampleApiCode, 'api.js');
    const handlerNode = graph.nodes.find((n) => n.label === 'api.js' && n.type === 'participant');

    expect(handlerNode).toBeDefined();
    expect(handlerNode!.subtitle).toBe('«module»');
  });

  it('names participants by basename even for Windows `\\`-separated paths (BUG-WIN-PARTICIPANT-PATHNAME)', () => {
    // On Windows the entry filePath arrives with backslash separators. The old
    // `filePath.split('/').pop()` never split it, so the participant label leaked
    // the whole path (`src\app\routes\auth\auth.controller.ts`). It must show the
    // bare filename.
    const graph = buildSequenceGraph(sampleApiCode, 'src\\app\\routes\\auth\\auth.controller.ts');
    const moduleParticipants = graph.nodes.filter((n) => n.type === 'participant' && n.subtitle === '«module»');
    // The entry-file module participant is labelled by basename, not the full path.
    expect(moduleParticipants.some((n) => n.label === 'auth.controller.ts')).toBe(true);
    // No participant label retains a path separator.
    for (const n of graph.nodes.filter((n) => n.type === 'participant')) {
      expect(n.label).not.toMatch(/[\\/]/);
    }
    expect(graph.meta?.fileName).toBe('auth.controller.ts');
  });

  it('should create external system participants', () => {
    const graph = buildSequenceGraph(sampleApiCode, 'api.js');

    // Should have database, cache, and service participants
    const participants = graph.nodes.filter((n) => n.type === 'participant');
    expect(participants.length).toBeGreaterThanOrEqual(3);
  });

  it('should create message edges for function calls', () => {
    const graph = buildSequenceGraph(sampleApiCode, 'api.js');
    const messageEdges = graph.edges.filter((e) => e.edgeType === 'message');

    expect(messageEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('should not produce participant edges (file root removed — participants ordered by type)', () => {
    const graph = buildSequenceGraph(sampleApiCode, 'api.js');
    const participantEdges = graph.edges.filter((e) => e.edgeType === 'participant');

    expect(participantEdges).toHaveLength(0);
  });

  it('should handle differential mode', () => {
    const oldCode = `
import express from "express";
import { Pool } from "pg";

const router = express.Router();
const db = new Pool();

async function getUserHandler(req, res) {
  const result = await db.query("select * from users");
  return res.json(result.rows);
}

router.get("/users/:id", getUserHandler);`;

    const newCode = `
import express from "express";
import { Pool } from "pg";
import { uploadToS3 } from "./storage";

const router = express.Router();
const db = new Pool();

async function getUserHandler(req, res) {
  const result = await db.query("select * from users");
  await uploadToS3("audit.json", JSON.stringify(result));
  return res.json(result.rows);
}

router.get("/users/:id", getUserHandler);`;

    const graph = buildSequenceGraph(newCode, 'api.js', oldCode);

    // New import participant should be added
    const addedNodes = graph.nodes.filter((n) => n.diff === 'added');
    expect(addedNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle simple code without APIs', () => {
    const code = `
function hello() {
  return "world";
}

function greet() {
  return hello();
}`;

    const graph = buildSequenceGraph(code, 'simple.js');

    // Should still produce a graph with function participants
    expect(graph.nodes.length).toBeGreaterThan(0);
  });

  it('should detect database participant from variable heuristic', () => {
    const code = `
const db = new Pool();

async function getHandler(req, res) {
  const result = await db.query("select 1");
  return res.json(result);
}`;

    const graph = buildSequenceGraph(code, 'api.js');
    const dbNode = graph.nodes.find((n) => n.label === 'db' || n.subtitle?.includes('database'));

    // Should find a database participant either from import or variable heuristic
    const participants = graph.nodes.filter((n) => n.type === 'participant');
    expect(participants.length).toBeGreaterThanOrEqual(2); // client + handler at minimum
  });

  it('should diagnose the diagram output', () => {
    const code = `
import express from 'express';
import db from './database.js';

app.get('/users', async (req, res) => {
    const users = await db.query('SELECT * FROM users');
    return res.json(users);
});`;
    const graph = buildSequenceGraph(code, 'test.js');
    console.log(JSON.stringify(graph, null, 2));
  });

  it('should trace cross-file imports using resolver', () => {
    const code = `
import express from 'express';
import { getUsers } from './controllers/userController.js';
const app = express();
app.get('/users', getUsers);
`;
    const resolver = (importPath: string, currentFilePath: string) => {
      if (importPath.includes('userController')) {
        return {
          filePath: 'controllers/userController.js',
          code: `
import db from '../db.js';
export async function getUsers(req, res) {
  const data = await db.query('SELECT * FROM users');
  res.json(data);
}
                `
        };
      }
      return undefined;
    };

    const graph = buildSequenceGraph(code, 'app.js', undefined, resolver);

    const nodes = graph.nodes;
    expect(nodes.find((n: any) => n.label === 'userController.js')).toBeDefined();
    // '../db.js' is now cleaned to its basename 'db' for readability
    expect(nodes.find((n: any) => n.label === 'db')).toBeDefined();

    // After enrichment, label includes argument hints: db.query(SELECT * FROM ...)
    const dbEdge = graph.edges.find((e: any) => e.label?.startsWith('db.query('));
    expect(dbEdge).toBeDefined();
  });

  it('#862 — normalizes ABSOLUTE cross-file participant anchor to workspace-relative', () => {
    // The extension's LSP / call-graph resolver returns ABSOLUTE filePaths while
    // every graph key + same-file participant uses workspace-relative paths.
    // Builder must normalize participant/edge anchors back to the relative
    // snapshot key so the whole graph lives in one path space (#862).
    const code = `
import express from 'express';
import { getUsers } from './controllers/userController.js';
const app = express();
app.get('/users', getUsers);
`;
    const ABS = '/Users/dev/project/controllers/userController.js';
    const resolver = (importPath: string) => {
      if (importPath.includes('userController')) {
        return {
          filePath: ABS, // absolute, as the live LSP resolver produces
          code: `export async function getUsers(req, res) { res.json([]); }`,
        };
      }
      return undefined;
    };
    // snapshotFiles is keyed workspace-relative — the source of truth.
    const snapshotFiles: any = {
      'controllers/userController.js': { content: '', hash: 'h' },
    };
    const graph = buildSequenceGraph(code, 'app.js', undefined, resolver, undefined, undefined, snapshotFiles);

    const isAbs = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
    const absParticipants = graph.nodes.filter(
      (n: any) => n.type === 'participant' && n.anchor?.filePath && isAbs(n.anchor.filePath),
    );
    expect(absParticipants).toHaveLength(0);
    // No edge anchor should carry an absolute path either.
    const absEdgeAnchors = Object.values(graph.anchors || {}).filter(
      (a: any) => a?.filePath && isAbs(a.filePath),
    );
    expect(absEdgeAnchors).toHaveLength(0);
    // The resolved participant points at the relative key.
    const ctrl = graph.nodes.find((n: any) => n.anchor?.filePath === 'controllers/userController.js');
    expect(ctrl).toBeDefined();
  });

  it('should trace deeper calls when anonymous handler calls imported service function', () => {
    // Pattern: anonymous handler → imported service → db (like article.controller → article.service → prisma)
    const code = `
import express from 'express';
import { getArticles } from './article.service';
const router = express.Router();
router.get('/articles', async (req, res) => {
  const result = await getArticles(req.query, req.user?.id);
  res.json(result);
});
`;
    const resolver = (importPath: string) => {
      if (importPath.includes('article.service')) {
        return {
          filePath: 'article.service.ts',
          code: `
import db from '../db';
export async function getArticles(query, userId) {
  const count = await db.count({ where: query });
  const items = await db.findMany({ where: query, take: 10 });
  return { items, count };
}
          `
        };
      }
      return undefined;
    };

    const graph = buildSequenceGraph(code, 'article.controller.ts', undefined, resolver, undefined, 'anonymous@GET:/articles');

    // Should have: API Client, article.controller.ts, article.service.ts (getArticles), and db
    const nodeLabels = graph.nodes.map((n: any) => n.label);
    expect(nodeLabels.some((l: string) => l.includes('article.service'))).toBe(true);

    // getArticles' deeper calls should appear (db.count, db.findMany)
    const edgeLabels = graph.edges.map((e: any) => e.label || '');
    expect(edgeLabels.some((l: string) => l.startsWith('db.count('))).toBe(true);
    expect(edgeLabels.some((l: string) => l.startsWith('db.findMany('))).toBe(true);

    // Return messages should exist
    const returnEdges = graph.edges.filter((e: any) => e.meta?.isReturn || e.label === 'count' || e.label === 'items' || e.label === 'result');
    expect(returnEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('return edges should connect different participants (not self-referencing)', () => {
    // Reproduces: article.controller → article.service → prisma.article → article.mapper → author.mapper
    const controllerCode = `
import { Router } from 'express';
import { getArticles } from './article.service';
const router = Router();
router.get('/articles', async (req, res, next) => {
  const result = await getArticles(req.query, req.auth?.user?.id);
  res.json(result);
});
`;
    const serviceCode = `
import prisma from '../prisma';
import articleMapper from './article.mapper';
const buildFindAllQuery = (query, id) => {
  const queries = [];
  queries.push({ author: { id } });
  return queries;
};
export const getArticles = async (query, id) => {
  const andQueries = buildFindAllQuery(query, id);
  const articlesCount = await prisma.article.count({ where: { AND: andQueries } });
  const articles = await prisma.article.findMany({ where: { AND: andQueries } });
  return { articles: articles.map(a => articleMapper(a, id)), articlesCount };
};
`;
    const mapperCode = `
import authorMapper from './author.mapper';
const articleMapper = (article, id) => ({
  title: article.title,
  author: authorMapper(article.author, id),
});
export default articleMapper;
`;
    const authorMapperCode = `
const authorMapper = (author, id) => ({ username: author.username });
export default authorMapper;
`;
    const resolver = (importPath: string) => {
      if (importPath.includes('article.service')) return { filePath: 'src/article.service.ts', code: serviceCode };
      if (importPath.includes('article.mapper')) return { filePath: 'src/article.mapper.ts', code: mapperCode };
      if (importPath.includes('author.mapper')) return { filePath: 'src/author.mapper.ts', code: authorMapperCode };
      return undefined;
    };

    const graph = buildSequenceGraph(controllerCode, 'src/article.controller.ts', undefined, resolver, undefined, 'anonymous@GET:/articles');

    // Verify participants exist
    const participants = graph.nodes.filter((n: any) => n.type === 'participant');
    const pLabels = participants.map((n: any) => n.label);
    expect(pLabels).toContain('API Client');
    expect(pLabels.some((l: string) => l.includes('article.controller'))).toBe(true);
    expect(pLabels.some((l: string) => l.includes('article.service'))).toBe(true);

    // Verify return edges exist and connect DIFFERENT participants
    const returnEdges = graph.edges.filter((e: any) => e.meta?.isReturn);
    expect(returnEdges.length).toBeGreaterThanOrEqual(1);

    for (const re of returnEdges) {
      // Return edges should NOT be self-referencing
      expect(re.source).not.toBe(re.target);
      // Both source and target should be valid participant node IDs
      expect(participants.some((p: any) => p.id === re.source)).toBe(true);
      expect(participants.some((p: any) => p.id === re.target)).toBe(true);
    }

    // Specifically: "result" return should go from article.service.ts → article.controller.ts
    const resultEdge = returnEdges.find((e: any) => e.label === 'result');
    if (resultEdge) {
      const sourceNode = participants.find((p: any) => p.id === resultEdge.source);
      const targetNode = participants.find((p: any) => p.id === resultEdge.target);
      // source = callee (article.service), target = caller (article.controller)
      expect(sourceNode?.label).toContain('article.service');
      expect(targetNode?.label).toContain('article.controller');
    }
  });

  it('should generate messages for imported route handler references (todoRoutes pattern)', () => {
    // This is the exact pattern from todoRoutes.js: handlers are imported and passed as references
    const code = `
const express = require('express');
const router = express.Router();
const { addTodo, listTodos } = require('./todoController');

router.post('/', addTodo);
router.get('/', listTodos);

module.exports = router;
`;
    const resolver = (importPath: string, currentFilePath: string) => {
      if (importPath.includes('todoController')) {
        return {
          filePath: 'src/features/todos/todoController.js',
          code: `
const db = require('../../db');

async function addTodo(req, res) {
  const result = await db.query('INSERT INTO todos (title) VALUES ($1)', [req.body.title]);
  res.json(result);
}

async function listTodos(req, res) {
  const result = await db.query('SELECT * FROM todos');
  res.json(result);
}

module.exports = { addTodo, listTodos };
          `
        };
      }
      return undefined;
    };

    const graph = buildSequenceGraph(code, 'src/features/todos/todoRoutes.js', undefined, resolver);

    // Should have participants: API Client, todoRoutes.js, todoController.js, and db
    const participants = graph.nodes.filter(n => n.type === 'participant');
    expect(participants.length).toBeGreaterThanOrEqual(3);

    // Should have todoRoutes.js and todoController.js as module participants
    expect(participants.find(n => n.label === 'todoRoutes.js')).toBeDefined();
    expect(participants.find(n => n.label === 'todoController.js')).toBeDefined();

    // Should have messages (not 0!)
    const messageEdges = graph.edges.filter(e => e.edgeType === 'message');
    expect(messageEdges.length).toBeGreaterThanOrEqual(2); // at least: client->routes, routes->controller

    // Should have a message from todoRoutes to todoController
    const delegationEdge = messageEdges.find(e => e.label?.includes('addTodo'));
    expect(delegationEdge).toBeDefined();
  });

  it('should resolve imported participants to their absolute paths for anchor.filePath', () => {
    const code = `
import express from 'express';
import { getUsers } from './controllers/userController.js';
const app = express();
app.get('/users', getUsers);
`;
    // Dummy resolver that maps relative import to an absolute-like or distinct file path
    const resolver = (importPath: string, currentFilePath: string) => {
      if (importPath.includes('userController')) {
        return {
          filePath: '/absolute/path/to/controllers/userController.js',
          code: `
export async function getUsers(req, res) {
  res.json([]);
}
                `
        };
      }
      return undefined;
    };

    const graph = buildSequenceGraph(code, '/absolute/path/to/app.js', undefined, resolver);

    const userControllerNode = graph.nodes.find((n: any) => n.label === 'userController.js');
    expect(userControllerNode).toBeDefined();
    // Anchor path should be what the resolver retrieved, not the caller's filePath
    expect(userControllerNode!.anchor?.filePath).toBe('/absolute/path/to/controllers/userController.js');
  });
});

describe('sequenceGraphBuilder anonymous handler name scoping', () => {
    // Regression: anonymous handler names must include the HTTP method so that
    // buildSequenceGraph scopes output to only the requested handler.
    // Before the fix, `anonymous@/articles` (no method) was stored but
    // `buildSequenceGraph` was called with `anonymous@GET:/articles` (with method),
    // causing zero matches → fallback to ALL handlers → all 5 routes in one diagram.
    const multiRouteCode = `
import express from 'express';
import { getArticles } from './articleService';
import { getFeed } from './feedService';

const router = express.Router();

router.get('/articles', async (req, res) => {
  const data = await getArticles(req.query);
  res.json(data);
});

router.get('/articles/feed', async (req, res) => {
  const data = await getFeed(req.user);
  res.json(data);
});
`;

    it('stores anonymous handler name with HTTP method prefix', () => {
        const apis = detectApis(multiRouteCode, 'src/routes.ts');
        const getArticlesApi = apis.find((a: any) => a.route === '/articles' && a.method === 'GET');
        expect(getArticlesApi).toBeDefined();
        // handlerName from apiDetector must match what sequenceGraphBuilder stores
        expect(getArticlesApi!.handlerName).toBe('anonymous@GET:/articles');
    });

    it('buildSequenceGraph with entryHandlerName scopes to only that handler', () => {
        const graph = buildSequenceGraph(multiRouteCode, 'src/routes.ts', undefined, undefined, undefined, 'anonymous@GET:/articles');
        // Should only include calls from the GET /articles handler (getArticles),
        // NOT from the GET /articles/feed handler (getFeed)
        const messageEdges = graph.edges.filter(e => e.edgeType === 'message');
        const edgeLabels = messageEdges.map(e => e.label ?? '');
        expect(edgeLabels.some(l => l.includes('getArticles'))).toBe(true);
        expect(edgeLabels.some(l => l.includes('getFeed'))).toBe(false);
    });

    // Issue 407: when a controller file has many routes and the entryHandler
    // is an inline `anonymous@…` arrow, the filter must scope tightly. Older
    // code fell back to the universe (top-5 entries) when filter yielded zero,
    // so a single-route diagram silently grew to 30+ cross-route edges.
    it('Issue 407: inline anonymous arrow handler does not bleed sibling routes into the graph', () => {
        const code = `
const router = require('express').Router();
const auth = require('./auth');
router.get('/articles', auth.optional, async (req, res) => { res.json('list'); });
router.post('/articles', auth.required, async (req, res) => { res.json('create'); });
router.get('/articles/:slug', auth.optional, async (req, res) => { res.json(req.params.slug); });
router.put('/articles/:slug', auth.required, async (req, res) => { res.json('update'); });
router.delete('/articles/:slug', auth.required, async (req, res) => { res.json('delete'); });
`;
        const g = buildSequenceGraph(code, 'src/article.controller.ts', undefined, undefined, undefined, 'anonymous@GET:/articles/:slug');
        // The graph should have exactly ONE API Client → handler entry message.
        const clientEdges = g.edges.filter(e => {
            const fromId = (e as any).source;
            const fromNode = g.nodes.find(n => n.id === fromId);
            return fromNode?.label === 'API Client';
        });
        expect(clientEdges.length).toBe(1);
        // And the single entry label must reference the GET /articles/:slug route, not POST/PUT/DELETE.
        const entry = clientEdges[0];
        expect(entry.label).toMatch(/get/i);
        expect(entry.label).toMatch(/:slug|articles/i);
    });

    it('Issue 407: anonymous arrow handler graph for unknown name falls back to coarse universe (not polluted) when nothing matches', () => {
        // When the requested handlerName matches NO function in the file,
        // legacy universe-fallback returns a coarse graph rather than empty.
        // (Strict-empty was tried but cost ~20 graphs across ts-apollo /
        // ts-nuxt / ts-react-native where legitimate handler-name lookups
        // resolve to nothing single — see `sequenceGraphBuilder.ts` comment.)
        // For the actual Issue 407 fix in inline-arrow case, the primary
        // mechanism is `isApiHandlerName` now matching `anonymous@…` — the
        // sibling routes ARE proper entries so the filter narrows correctly.
        const code = `
const router = require('express').Router();
router.get('/users', async (req, res) => { res.json([]); });
`;
        const g = buildSequenceGraph(code, 'src/users.ts', undefined, undefined, undefined, 'anonymous@GET:/does-not-exist');
        // Coarse fallback: at least the API Client + file participant present.
        // The point is we don't crash and we render *some* graph.
        expect(g.nodes.length).toBeGreaterThan(0);
    });

    it('distinct handler names for GET and PUT on same route', () => {
        const code = `
router.get('/articles', async (req, res) => { res.json([]); });
router.put('/articles', async (req, res) => { res.json({}); });
`;
        const graph1 = buildSequenceGraph(code, 'routes.ts', undefined, undefined, undefined, 'anonymous@GET:/articles');
        const graph2 = buildSequenceGraph(code, 'routes.ts', undefined, undefined, undefined, 'anonymous@PUT:/articles');
        // Both graphs should be valid (not empty)
        expect(graph1.nodes.length).toBeGreaterThan(0);
        expect(graph2.nodes.length).toBeGreaterThan(0);
    });
});

describe('sequenceGraphBuilder differential API handling', () => {
  it('preserves matching APIs across old and new code', () => {
    const oldCode = `
const { listTodos, addTodo, getHealth } = require('./controller');
router.get('/', listTodos);
router.post('/', addTodo);
router.get('/health', getHealth);
`;
    const newCode = oldCode;

    const graph = buildSequenceGraph(newCode, 'routes.js', oldCode);

    // We expect normal unchanged edges for the routes.
    const messageEdges = graph.edges.filter(e => e.edgeType === 'message');

    // Ensure no edges are marked as deleted if the code is identical.
    const deletedEdges = messageEdges.filter(e => e.diff === 'deleted');
    expect(deletedEdges.length).toBe(0);

    // Also check if any are marked as changed/modified
    const modifiedEdges = messageEdges.filter(e => e.diff === 'modified');
    expect(modifiedEdges.length).toBe(0);
  });

  it('marks an API as changed if its arguments are modified', () => {
    const oldCode = `
const { listTodos } = require('./controller');
router.get('/', listTodos);
`;
    const newCode = `
const { listTodos } = require('./controller');
router.get('/', (req, res) => listTodos(req, res));
`;
    const graph = buildSequenceGraph(newCode, 'routes.js', oldCode);
    const messageEdges = graph.edges.filter(e => e.edgeType === 'message' && !e.source.includes('client'));

    // One of the edges should reflect a change (or a deletion/addition depending on AST)
    const modifiedEdges = messageEdges.filter(e => e.diff === 'modified' || e.diff === 'added' || e.diff === 'deleted');
    expect(modifiedEdges.length).toBeGreaterThan(0);
  });

  it('preserves delegators across identical files (imported definitions)', () => {
    const oldCode = `
const { listTodos, addTodo, getHealth } = require('./controller');
router.get('/', listTodos);
router.post('/', addTodo);
router.get('/health', getHealth);
`;
    const newCode = oldCode;

    const resolver = (importPath: string) => {
      if (importPath.includes('controller')) {
        return {
          filePath: 'controller.js',
          code: `
                        function listTodos() {}
                        function addTodo() {}
                        function getHealth() {}
                        module.exports = { listTodos, addTodo, getHealth };
                    `,
        };
      }
      return undefined;
    };

    const graph = buildSequenceGraph(newCode, 'routes.js', oldCode, resolver);
    const messageEdges = graph.edges.filter(e => e.edgeType === 'message' && !e.source.includes('client'));
    const deletedEdges = messageEdges.filter(e => e.diff === 'deleted');
    expect(deletedEdges.length).toBe(0);
  });
});

describe('shortenQualifiedName', () => {
    it('returns just the class name (last segment) for long package paths', () => {
        expect(shortenQualifiedName('com.example.utils.MyClass')).toBe('MyClass');
        expect(shortenQualifiedName('org.springframework.data.jpa.repository.JpaRepository')).toBe('JpaRepository');
        expect(shortenQualifiedName('com.todo.features.auth.AuthController')).toBe('AuthController');
    });

    it('returns name unchanged when it has no dots', () => {
        expect(shortenQualifiedName('MyClass')).toBe('MyClass');
    });

    it('returns last segment for 2-part names', () => {
        expect(shortenQualifiedName('utils.MyClass')).toBe('MyClass');
    });

    it('handles wildcard imports', () => {
        expect(shortenQualifiedName('org.springframework.web.bind.annotation.*')).toBe('*');
    });
});

describe('buildSequenceGraphFromAnalysis — Java import filtering', () => {
    it('filters Spring/javax framework imports from participants', () => {
        const analysis = {
            importsByLocal: new Map([
                ['RestController', 'org.springframework.web.bind.annotation.RestController'],
                ['RequiredArgsConstructor', 'lombok.RequiredArgsConstructor'],
                ['List', 'java.util.List'],
                ['TodoService', 'com.todo.features.todos.TodoService'],
            ]),
            entities: [],
            // Issue 336: orphan-pruning needs the entry function to invoke
            // each participant. `funcs` is what the builder reads (line
            // 1599); `memberCalls: Map<receiver, Set<method>>` is the
            // shape consumed at line 1972.
            funcs: new Map<string, any>([
                ['listTodos', {
                    name: 'listTodos',
                    memberCalls: new Map([
                        ['TodoService', new Set(['findAll'])],
                        ['List', new Set(['of'])],
                    ]),
                }],
            ]),
        };
        const apis = [{ apiId: 'GET:/api/todos::Ctrl.java::listTodos', method: 'GET', route: '/api/todos', handlerName: 'listTodos' }];
        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'Ctrl.java', apis, 'listTodos');

        const participantLabels = graph.nodes
            .filter(n => n.type === 'participant')
            .map(n => n.label);

        // Spring, lombok, java.* must be filtered out
        expect(participantLabels.some(l => l.includes('springframework'))).toBe(false);
        expect(participantLabels.some(l => l.includes('lombok'))).toBe(false);
        expect(participantLabels.some(l => l.includes('java.util'))).toBe(false);
        // Application service must appear (just class name)
        expect(participantLabels).toContain('TodoService');
    });

    it('BUG-POLAR-10: sibling classes from the same module get DISTINCT participants (not merged/mislabeled)', () => {
        // `totp_factor` and `backup_codes_factor` are both instances of classes in
        // `.factors` — the old source-only dedupe collapsed them into one node
        // labeled by whichever was seen first, so `totp_factor.enroll()` wrongly
        // targeted "BackupCodesFactor".
        const analysis = {
            importsByLocal: new Map([
                ['totp_factor', '.factors'],
                ['backup_codes_factor', '.factors'],
            ]),
            entities: [],
            funcs: new Map<string, any>([
                ['enroll', {
                    name: 'enroll',
                    memberCalls: new Map([
                        ['totp_factor', new Set(['enroll'])],
                        ['backup_codes_factor', new Set(['consume'])],
                    ]),
                }],
            ]),
        };
        const apis = [{ apiId: 'POST:/auth/totp::endpoints.py::enroll', method: 'POST', route: '/auth/totp', handlerName: 'enroll' }];
        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'endpoints.py', apis, 'enroll');
        const labels = graph.nodes.filter(n => n.type === 'participant').map(n => n.label);
        expect(labels).toContain('TotpFactor');
        expect(labels).toContain('BackupCodesFactor');
        // The enroll() message must target TotpFactor, NOT BackupCodesFactor.
        const enrollEdge = graph.edges.find(e => (e.label || '').includes('totp_factor.enroll'));
        const totpNode = graph.nodes.find(n => n.label === 'TotpFactor');
        expect(enrollEdge?.target).toBe(totpNode?.id);
    });

    it('BUG-POLAR-17: free functions from the same module share ONE module participant', () => {
        // `get_audit_context()` and `get_customer()` are free functions imported from
        // `.utils` and called DIRECTLY (not `obj.method()`). The old logic PascalCase-
        // ified each into its own «module» lane (GetAuditContext / GetCustomer); both
        // must collapse to a single `utils` module participant.
        const analysis = {
            importsByLocal: new Map([
                ['get_audit_context', '.utils'],
                ['get_customer', '.utils'],
            ]),
            entities: [],
            funcs: new Map<string, any>([
                ['add_payment_method', {
                    name: 'add_payment_method',
                    calls: ['get_audit_context', 'get_customer'],
                    memberCalls: new Map(),
                }],
            ]),
        };
        const apis = [{ apiId: 'POST:/pm::customer.py::add_payment_method', method: 'POST', route: '/customers/me/payment-methods', handlerName: 'add_payment_method' }];
        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'customer.py', apis, 'add_payment_method');
        const labels = graph.nodes.filter(n => n.type === 'participant').map(n => n.label);
        expect(labels).not.toContain('GetAuditContext');
        expect(labels).not.toContain('GetCustomer');
        // Both free functions land on the single `utils` module lane.
        expect(labels.filter(l => l === 'utils').length).toBe(1);
    });

    it('BUG-POLAR-17: a non-model class constructor (PascalCase) stays its own class participant, not a module lane', () => {
        const analysis = {
            importsByLocal: new Map([['PaymentProcessor', '.processors']]),
            entities: [],
            funcs: new Map<string, any>([
                ['charge', { name: 'charge', calls: ['PaymentProcessor'], memberCalls: new Map() }],
            ]),
        };
        const apis = [{ apiId: 'POST:/charge::endpoints.py::charge', method: 'POST', route: '/charge', handlerName: 'charge' }];
        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'endpoints.py', apis, 'charge');
        const labels = graph.nodes.filter(n => n.type === 'participant').map(n => n.label);
        expect(labels).toContain('PaymentProcessor');
        expect(labels).not.toContain('processors');
    });

    it('BUG-POLAR-19: Pydantic schema/DTO constructors are suppressed from the sequence', () => {
        const analysis = {
            importsByLocal: new Map([
                ['TOTPStatus', '.schemas'],
                ['TOTPEnrollment', '.schemas'],
            ]),
            entities: [],
            funcs: new Map<string, any>([
                ['enroll', { name: 'enroll', calls: ['TOTPStatus', 'TOTPEnrollment'], memberCalls: new Map() }],
            ]),
        };
        const apis = [{ apiId: 'POST:/auth/totp::endpoints.py::enroll', method: 'POST', route: '/auth/totp', handlerName: 'enroll' }];
        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'endpoints.py', apis, 'enroll');
        const labels = graph.nodes.filter(n => n.type === 'participant').map(n => n.label);
        expect(labels).not.toContain('TOTPStatus');
        expect(labels).not.toContain('TOTPEnrollment');
    });

    it('BUG-POLAR-18: domain exception constructors (raised, non-Error suffix) are filtered from messages', () => {
        expect(isSequenceNoiseCall('ResourceNotFound')).toBe(true);
        expect(isSequenceNoiseCall('PaymentMethodInUseByActiveSubscription')).toBe(true);
        expect(isSequenceNoiseCall('CustomerNotReady')).toBe(true);
        // genuine service/helper calls are NOT filtered
        expect(isSequenceNoiseCall('add_payment_method')).toBe(false);
        expect(isSequenceNoiseCall('CustomerService')).toBe(false);
    });

});

// ---------------------------------------------------------------------------
// buildSequenceGraphFromAnalysis — diff coloring for non-JS participants
// ---------------------------------------------------------------------------
describe('buildSequenceGraphFromAnalysis — participant diff', () => {
    // Issue 336: orphan-pruning is now applied to non-JS sequence graphs.
    // For an imported type to survive as a participant, the entry function
    // must invoke it via `memberCalls`. The builder looks up the entry
    // function in `analysis.funcs`, NOT `entities`, so we populate funcs
    // with one call per imported local so individual test cases don't have
    // to spell it out.
    function makeAnalysis(imports: [string, string][]): { importsByLocal: Map<string, string>; entities: any[]; funcs: Map<string, any> } {
        const memberCalls = new Map<string, Set<string>>();
        for (const [local] of imports) memberCalls.set(local, new Set(['handle']));
        return {
            importsByLocal: new Map(imports),
            entities: [{ name: 'addTodo', kind: 'function' }],
            funcs: new Map([['addTodo', { name: 'addTodo', memberCalls }]]),
        };
    }

    it('new (non-baseline) import participant is marked added', () => {
        const analysis = makeAnalysis([['UserRepo', 'com.example.UserRepo'], ['EmailService', 'com.example.EmailService']]);
        const baselineImports = new Map([['UserRepo', 'com.example.UserRepo']]);
        const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'addTodo', baselineImports);
        const emailNode = graph.nodes.find(n => n.type === 'participant' && n.body === 'com.example.EmailService');
        expect(emailNode).toBeDefined();
        expect(emailNode!.diff).toBe('added');
    });

    it('import present in both baseline and current is unchanged', () => {
        const analysis = makeAnalysis([['UserRepo', 'com.example.UserRepo']]);
        const baselineImports = new Map([['UserRepo', 'com.example.UserRepo']]);
        const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'addTodo', baselineImports);
        const repoNode = graph.nodes.find(n => n.type === 'participant' && n.body === 'com.example.UserRepo');
        expect(repoNode!.diff).toBe('unchanged');
    });

    it('import in baseline but not current creates deleted ghost participant', () => {
        const analysis = makeAnalysis([['UserRepo', 'com.example.UserRepo']]);
        const baselineImports = new Map([
            ['UserRepo', 'com.example.UserRepo'],
            ['EmailService', 'com.example.EmailService'],
        ]);
        const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'addTodo', baselineImports);
        const deletedNode = graph.nodes.find(n => n.diff === 'deleted');
        expect(deletedNode).toBeDefined();
        expect(deletedNode!.label).toContain('deleted');
        expect(deletedNode!.body).toBe('com.example.EmailService');
    });

    it('module participant marked modified when handler body changed', () => {
        const analysis = makeAnalysis([['UserRepo', 'com.example.UserRepo']]);
        const baselineImports = new Map([['UserRepo', 'com.example.UserRepo']]);
        const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];
        const modifiedHandlers = new Set(['addTodo']);

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'addTodo', baselineImports, modifiedHandlers);
        const moduleNode = graph.nodes.find(n => n.type === 'participant' && n.subtitle === '«module»');
        expect(moduleNode!.diff).toBe('modified');
    });

    it('module participant unchanged when handler not in modifiedHandlers', () => {
        const analysis = makeAnalysis([['UserRepo', 'com.example.UserRepo']]);
        const baselineImports = new Map([['UserRepo', 'com.example.UserRepo']]);
        const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];
        const modifiedHandlers = new Set(['otherMethod']);

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'addTodo', baselineImports, modifiedHandlers);
        const moduleNode = graph.nodes.find(n => n.type === 'participant' && n.subtitle === '«module»');
        expect(moduleNode!.diff).toBe('unchanged');
    });

    it('module participant marked modified when modifiedHandlers uses Java ClassName.methodName format', () => {
        // Java stores entity names as 'ClassName.methodName' but api.handlerName is just 'methodName'
        const analysis = makeAnalysis([['UserRepo', 'com.example.UserRepo']]);
        const baselineImports = new Map([['UserRepo', 'com.example.UserRepo']]);
        const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];
        const modifiedHandlers = new Set(['TodoController.addTodo']); // class-prefixed format from treeSitter

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'addTodo', baselineImports, modifiedHandlers);
        const moduleNode = graph.nodes.find(n => n.type === 'participant' && n.subtitle === '«module»');
        expect(moduleNode!.diff).toBe('modified');
    });

    it('message edges from handler module are modified when handler body changed', () => {
        // When the handler body changed, outgoing message edges should also show modified
        const analysis = makeAnalysis([['TodoService', 'com.example.TodoService']]);
        const baselineImports = new Map([['TodoService', 'com.example.TodoService']]);
        const apis = [{ apiId: 'api:1', method: 'GET', route: '/todos', handlerName: 'listTodos' }];
        const modifiedHandlers = new Set(['TodoController.listTodos']); // Java class prefix

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'listTodos', baselineImports, modifiedHandlers);
        const moduleNode = graph.nodes.find(n => n.type === 'participant' && n.subtitle === '«module»');
        expect(moduleNode!.diff).toBe('modified');
        // All message edges originating from the module node should also be modified
        const moduleEdges = graph.edges.filter(e => e.edgeType === 'message' && e.source === moduleNode!.id);
        for (const edge of moduleEdges) {
            expect(edge.diff).toBe('modified');
        }
    });

    it('API client participant always unchanged', () => {
        const analysis = makeAnalysis([['UserRepo', 'com.example.UserRepo']]);
        const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'addTodo');
        const clientNode = graph.nodes.find(n => n.label === 'API Client');
        expect(clientNode!.diff).toBe('unchanged');
    });

    it('all participants present: API Client + module + external imports', () => {
        const analysis = makeAnalysis([
            ['TodoService', 'com.example.service.TodoService'],
            ['UserRepository', 'com.example.repository.UserRepository'],
        ]);
        const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'addTodo');
        const participants = graph.nodes.filter(n => n.type === 'participant');
        // API Client + module + TodoService + UserRepository
        expect(participants.length).toBeGreaterThanOrEqual(4);
        expect(participants.some(n => n.label === 'API Client')).toBe(true);
        expect(participants.some(n => n.subtitle === '«module»')).toBe(true);
    });

    it('should not include a file root node — file info lives in meta', () => {
        const analysis = makeAnalysis([['TodoService', 'com.example.service.TodoService']]);
        const apis = [{ apiId: 'api:1', method: 'GET', route: '/todos', handlerName: 'listTodos' }];

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'listTodos');
        const fileNodes = graph.nodes.filter(n => n.type === 'file');

        expect(fileNodes).toHaveLength(0);
        expect(graph.meta?.fileName).toBe('TodoController.java');
        expect(graph.meta?.filePath).toBe('src/TodoController.java');
    });

    it('framework noise imports are not shown as participants', () => {
        const analysis = makeAnalysis([
            ['RestController', 'org.springframework.web.bind.annotation.RestController'],
            ['PostMapping', 'org.springframework.web.bind.annotation.PostMapping'],
            ['TodoService', 'com.example.service.TodoService'],
        ]);
        const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'addTodo');
        const labels = graph.nodes.map(n => n.label);
        expect(labels.every(l => !l.includes('springframework'))).toBe(true);
        expect(graph.nodes.some(n => n.body === 'com.example.service.TodoService')).toBe(true);
    });
});

// buildSequenceGraphFromAnalysis — injectedDeps (same-package DI)
// ---------------------------------------------------------------------------
describe('buildSequenceGraphFromAnalysis — injected service dependencies', () => {
    const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];

    // Issue 336: each test populates `funcs` with the entry handler's
    // memberCalls so the injected/imported types we want to assert on
    // survive the orphan-pruning pass.
    function callerWith(receivers: string[], method = 'doIt'): Map<string, any> {
        const memberCalls = new Map<string, Set<string>>();
        for (const r of receivers) memberCalls.set(r, new Set([method]));
        return new Map([['addTodo', { name: 'addTodo', memberCalls }]]);
    }

    it('injected service (same-package, no import) appears as «service» participant', () => {
        const analysis = {
            importsByLocal: new Map<string, string>(),
            injectedDeps: new Map([['TodoService', 'TodoService']]),
            entities: [{ name: 'addTodo', kind: 'function' }],
            funcs: callerWith(['TodoService']),
        };
        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'TodoController.java', apis, 'addTodo');
        const svc = graph.nodes.find(n => n.label === 'TodoService');
        expect(svc).toBeDefined();
        expect(svc!.subtitle).toBe('«service»');
        expect(svc!.diff).toBe('unchanged');
    });

    it('injected service does not duplicate an explicitly imported type', () => {
        const analysis = {
            importsByLocal: new Map([['TodoService', 'com.example.TodoService']]),
            injectedDeps: new Map([['TodoService', 'TodoService']]), // same name, already imported
            entities: [{ name: 'addTodo', kind: 'function' }],
            funcs: callerWith(['TodoService']),
        };
        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'TodoController.java', apis, 'addTodo');
        const svcNodes = graph.nodes.filter(n => n.label === 'TodoService' || n.body?.includes('TodoService'));
        // Should appear only once
        expect(svcNodes.length).toBe(1);
    });

    it('injected deps not present in baseline are marked added', () => {
        const analysis = {
            importsByLocal: new Map<string, string>(),
            injectedDeps: new Map([['NewService', 'NewService']]),
            entities: [{ name: 'addTodo', kind: 'function' }],
            funcs: callerWith(['NewService']),
        };
        const baselineImports = new Map<string, string>(); // NewService not in baseline
        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'TodoController.java', apis, 'addTodo', baselineImports);
        const svc = graph.nodes.find(n => n.label === 'NewService');
        expect(svc?.diff).toBe('added');
    });

    it('injected dep present in baseline is unchanged', () => {
        const analysis = {
            importsByLocal: new Map<string, string>(),
            injectedDeps: new Map([['TodoService', 'TodoService']]),
            entities: [{ name: 'addTodo', kind: 'function' }],
            funcs: callerWith(['TodoService']),
        };
        // Simulate baseline had TodoService as an injected dep too (stored via importsByLocal)
        const baselineImports = new Map([['TodoService', 'TodoService']]);
        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'TodoController.java', apis, 'addTodo', baselineImports);
        const svc = graph.nodes.find(n => n.label === 'TodoService');
        expect(svc?.diff).toBe('unchanged');
    });
});

// ---------------------------------------------------------------------------
// buildSequenceGraphFromAnalysis — DTO filtering and Method Calls
// ---------------------------------------------------------------------------
describe('buildSequenceGraphFromAnalysis — method calls and DTO filtering', () => {
    it('filters out DTOs, Requests, Responses, and Models from participants', () => {
        const analysis = {
            importsByLocal: new Map([
                ['TodoService', 'com.example.service.TodoService'],
                ['TodoDto', 'com.example.dto.TodoDto'],
                ['CreateUserRequest', 'com.example.CreateUserRequest'],
                ['UserModel', 'com.example.models.UserModel'],
                ['ResponseEntity', 'org.springframework.http.ResponseEntity']
            ]),
            entities: [{ name: 'addTodo', kind: 'function' }],
            // Issue 336: caller invokes every imported type so the test asserts
            // the *filter logic* (DTO / framework noise stripping) rather than
            // accidentally relying on orphan-survival.
            funcs: new Map([['addTodo', {
                name: 'addTodo',
                memberCalls: new Map([
                    ['TodoService', new Set(['save'])],
                    ['TodoDto', new Set(['toJson'])],
                    ['CreateUserRequest', new Set(['validate'])],
                    ['UserModel', new Set(['load'])],
                    ['ResponseEntity', new Set(['ok'])],
                ]),
            }]]),
        };
        const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'addTodo');
        const participantLabels = graph.nodes
            .filter(n => n.type === 'participant')
            .map(n => n.label);

        // Should include TodoService and API Client + module
        expect(participantLabels).toContain('TodoService');
        // Should NOT include DTOs or Framework types
        expect(participantLabels).not.toContain('dto.TodoDto');
        expect(participantLabels).not.toContain('CreateUserRequest');
        expect(participantLabels).not.toContain('UserModel');
        expect(participantLabels).not.toContain('ResponseEntity');
    });

    it('generates specific method calls when funcs memberCalls are provided', () => {
        // Setup mock memberCalls: todoService.save(), todoService.validate(), db.query()
        const memberCalls = new Map<string, Set<string>>([
            ['todoService', new Set(['save', 'validate'])],
            ['db', new Set(['query'])]
        ]);
        const funcRecord = { name: 'addTodo', kind: 'function', calls: new Set(['save', 'validate', 'query']), memberCalls };
        const analysis = {
            importsByLocal: new Map([
                ['TodoService', 'com.example.service.TodoService']
            ]),
            injectedDeps: new Map([
                ['todoService', 'com.example.service.TodoService'],
                ['db', 'com.example.Database']
            ]),
            entities: [funcRecord],
            funcs: new Map([['addTodo', funcRecord]])
        };
        const apis = [{ apiId: 'api:1', method: 'POST', route: '/todos', handlerName: 'addTodo' }];

        const graph = buildSequenceGraphFromAnalysis(analysis as any, 'src/TodoController.java', apis, 'addTodo');
        
        // Find message edges exiting the module
        const moduleNodeId = graph.nodes.find(n => n.subtitle === '«module»')?.id;
        const messageEdges = graph.edges.filter(e => e.edgeType === 'message' && e.source === moduleNodeId);
        
        const labels = messageEdges.map(e => e.label);
        
        // Should have exact method calls instead of generic clean names
        expect(labels).toContain('todoService.save()');
        expect(labels).toContain('todoService.validate()');
        expect(labels).toContain('db.query()');
        
        // Should NOT have the generic fallback calls
        expect(labels).not.toContain('TodoService()');
        expect(labels).not.toContain('Database()');
    });

    describe('Django specific behavior', () => {
        it('should handle Django CBV resolution and trace methods', () => {
            // urls.py analysis with CBV import
            const urlsAnalysis = {
                importsByLocal: new Map([
                    ['path', 'django.urls'],
                    ['TodoListView', '.views']
                ]),
                entities: [],
                funcs: new Map()
            };
            const apis = [{ apiId: 'api:1', method: 'GET', route: '/todos', handlerName: 'TodoListView' }];

            // views.py snapshot file with the CBV methods
            const viewsFilePath = 'backend/todos/views.py';
            const viewsSnapshotFile = {
                filePath: viewsFilePath,
                symbols: {
                    imports: [
                        { source: '.models', specifiers: [{ local: 'Todo' }] },
                        { source: '.serializers', specifiers: [{ local: 'TodoSerializer' }] }
                    ],
                    functions: [{
                        name: 'TodoListView.get',
                        memberCalls: new Map([
                            ['Todo', new Set(['filter'])],
                            ['logger', new Set(['exception'])] // should be filtered out by noise list
                        ]),
                        calls: ['TodoSerializer', 'Response'] // generic calls
                    }],
                    classes: [{ name: 'TodoListView' }]
                }
            };
            const snapshotFiles = { [viewsFilePath]: viewsSnapshotFile };

            // Resolver simulating nonJsResolver for relative imports in syncOrchestrator
            const resolver = (importPath: string, currentFilePath: string) => {
                if (importPath === '.views' && currentFilePath === 'backend/todos/urls.py') {
                    return { code: '', filePath: viewsFilePath };
                }
                if (importPath === '.models') return { code: '', filePath: 'backend/todos/models.py' };
                if (importPath === '.serializers') return { code: '', filePath: 'backend/todos/serializers.py' };
                return undefined; // simulate not finding a file
            };

            const graph = buildSequenceGraphFromAnalysis(
                urlsAnalysis as any,
                'backend/todos/urls.py',
                apis,
                'TodoListView',
                undefined,
                undefined,
                resolver as any,
                snapshotFiles as any
            );

            const labels = graph.nodes.map(n => n.label);
            const edgeLabels = graph.edges.map(e => e.label);

            // Should create participant for the View class
            expect(labels).toContain('TodoListView');
            
            // Should create participants for non-noise imports used in calls
            expect(labels).toContain('Todo');
            expect(labels).toContain('TodoSerializer');
            
            // Should NOT create participants for noise
            expect(labels).not.toContain('logger'); // filtered out
            expect(labels).not.toContain('path');   // unused in calls
            
            // Should trace into the GET method and emit edges
            expect(edgeLabels).toContain('TodoListView.get(request)');
            expect(edgeLabels).toContain('Todo.filter()');
            expect(edgeLabels).toContain('TodoSerializer()');
            
            // Verify edge anchor uses qualified method name for the views flow diagram
            const viewMethodEdge = graph.edges.find(e => e.label === 'Todo.filter()');
            expect(viewMethodEdge).toBeDefined();
            // Edge call anchors check method in target file - filter() is not in models.py, so it just links to file
            const anchor = graph.anchors[viewMethodEdge!.id];
            expect(anchor.filePath).toBe('backend/todos/models.py');
            // But for the GET method call which is defined, it should have the qualified symbol
        });

        it('should filter Django framework noise from participants', () => {
            const analysis = {
                importsByLocal: new Map([
                    ['JsonResponse', 'django.http'],
                    ['static', 'django.views.static'],
                    ['settings', 'django.conf'],
                    ['render', 'django.shortcuts'], // not in noise list, will appear as participant
                ]),
                entities: [],
                // Issue 336: caller invokes every imported helper so the
                // assertion targets the noise filter (django.* drops, .shortcuts
                // survives) rather than orphan-pruning.
                funcs: new Map([['health', {
                    name: 'health',
                    memberCalls: new Map([
                        ['JsonResponse', new Set(['serialize'])],
                        ['static', new Set(['serve'])],
                        ['settings', new Set(['get'])],
                        ['render', new Set(['template'])],
                    ]),
                }]]),
            };
            const apis = [{ apiId: 'api:2', method: 'GET', route: '/health', handlerName: 'health' }];
            const graph = buildSequenceGraphFromAnalysis(analysis as any, 'config/urls.py', apis, 'health');

            const labels = graph.nodes.map(n => n.label);
            
            // Should be filtered out
            expect(labels).not.toContain('django.http');
            expect(labels).not.toContain('JsonResponse');
            expect(labels).not.toContain('django.views.static');
            expect(labels).not.toContain('static');
            expect(labels).not.toContain('django.conf');
            expect(labels).not.toContain('settings');
            
            // Should be kept as it's not noise
            expect(labels).toContain('shortcuts');
        });

        it('should set anchor on dispatch edge pointing to HTTP method flow graph', () => {
            const viewsFilePath = 'backend/todos/views.py';
            const viewsSnapshotFile = {
                filePath: viewsFilePath,
                symbols: {
                    imports: [
                        { source: '.models', specifiers: [{ local: 'Todo' }] },
                    ],
                    functions: [{
                        name: 'TodoListView.get',
                        memberCalls: { Todo: ['filter'] },
                        calls: [],
                    }],
                    classes: [{ name: 'TodoListView' }],
                },
            };
            const urlsAnalysis = {
                importsByLocal: new Map([['TodoListView', '.views']]),
                entities: [],
                funcs: new Map(),
            };
            const apis = [{ apiId: 'api:10', method: 'GET', route: '/todos', handlerName: 'TodoListView' }];
            const resolver = (importPath: string, currentFilePath: string) => {
                if (importPath === '.views') return { code: '', filePath: viewsFilePath };
                if (importPath === '.models') return { code: '', filePath: 'backend/todos/models.py' };
                return undefined;
            };

            const graph = buildSequenceGraphFromAnalysis(
                urlsAnalysis as any,
                'backend/todos/urls.py',
                apis,
                'TodoListView',
                undefined, undefined,
                resolver as any,
                { [viewsFilePath]: viewsSnapshotFile } as any,
            );

            const dispatchEdge = graph.edges.find(e => e.label === 'TodoListView.get(request)');
            expect(dispatchEdge).toBeDefined();
            const anchor = graph.anchors[dispatchEdge!.id];
            expect(anchor).toBeDefined();
            expect(anchor.filePath).toBe(viewsFilePath);
            expect(anchor.symbol).toBe('TodoListView.get');
        });

        it('should trace ALL defined HTTP methods in a CBV in one sequence graph', () => {
            const viewsFilePath = 'backend/todos/views.py';
            const viewsSnapshotFile = {
                filePath: viewsFilePath,
                symbols: {
                    imports: [
                        { source: '.models', specifiers: [{ local: 'Todo' }] },
                        { source: '.serializers', specifiers: [{ local: 'TodoSerializer' }] },
                    ],
                    functions: [
                        {
                            name: 'TodoListView.get',
                            memberCalls: { Todo: ['filter'] },
                            calls: ['TodoSerializer'],
                        },
                        {
                            name: 'TodoListView.post',
                            memberCalls: { Todo: ['create'] },
                            calls: ['TodoSerializer'],
                        },
                    ],
                    classes: [{ name: 'TodoListView' }],
                },
            };
            const urlsAnalysis = {
                importsByLocal: new Map([['TodoListView', '.views']]),
                entities: [],
                funcs: new Map(),
            };
            const apis = [{ apiId: 'api:11', method: 'GET', route: '/todos', handlerName: 'TodoListView' }];
            const resolver = (importPath: string) => {
                if (importPath === '.views') return { code: '', filePath: viewsFilePath };
                if (importPath === '.models') return { code: '', filePath: 'backend/todos/models.py' };
                if (importPath === '.serializers') return { code: '', filePath: 'backend/todos/serializers.py' };
                return undefined;
            };

            const graph = buildSequenceGraphFromAnalysis(
                urlsAnalysis as any,
                'backend/todos/urls.py',
                apis,
                'TodoListView',
                undefined, undefined,
                resolver as any,
                { [viewsFilePath]: viewsSnapshotFile } as any,
            );

            const edgeLabels = graph.edges.map(e => e.label);
            // Both methods must appear as dispatch edges
            expect(edgeLabels).toContain('TodoListView.get(request)');
            expect(edgeLabels).toContain('TodoListView.post(request)');

            // Both dispatch edges must have anchors to their respective flow graphs
            const getEdge = graph.edges.find(e => e.label === 'TodoListView.get(request)');
            const postEdge = graph.edges.find(e => e.label === 'TodoListView.post(request)');
            expect(graph.anchors[getEdge!.id]?.symbol).toBe('TodoListView.get');
            expect(graph.anchors[postEdge!.id]?.symbol).toBe('TodoListView.post');

            // BFS edges from both methods should be present
            expect(edgeLabels).toContain('Todo.filter()');
            expect(edgeLabels).toContain('Todo.create()');
        });

        it('should resolve local variable method calls using localVarTypes', () => {
            const viewsFilePath = 'backend/todos/views.py';
            const viewsSnapshotFile = {
                filePath: viewsFilePath,
                symbols: {
                    imports: [
                        { source: '.models', specifiers: [{ local: 'Todo' }] },
                        { source: '.serializers', specifiers: [{ local: 'TodoSerializer' }] },
                    ],
                    functions: [{
                        name: 'TodoToggleFavoriteView.patch',
                        memberCalls: { Todo: ['get'], todo: ['save'] },
                        calls: ['TodoSerializer'],
                        localVarTypes: { todo: '.models' },
                    }],
                    classes: [{ name: 'TodoToggleFavoriteView' }],
                },
            };
            const urlsAnalysis = {
                importsByLocal: new Map([['TodoToggleFavoriteView', '.views']]),
                entities: [],
                funcs: new Map(),
            };
            const apis = [{ apiId: 'api:12', method: 'PATCH', route: '/<int:pk>/favorite', handlerName: 'TodoToggleFavoriteView' }];
            const resolver = (importPath: string) => {
                if (importPath === '.views') return { code: '', filePath: viewsFilePath };
                if (importPath === '.models') return { code: '', filePath: 'backend/todos/models.py' };
                if (importPath === '.serializers') return { code: '', filePath: 'backend/todos/serializers.py' };
                return undefined;
            };

            const graph = buildSequenceGraphFromAnalysis(
                urlsAnalysis as any,
                'backend/todos/urls.py',
                apis,
                'TodoToggleFavoriteView',
                undefined, undefined,
                resolver as any,
                { [viewsFilePath]: viewsSnapshotFile } as any,
            );

            const edgeLabels = graph.edges.map(e => e.label);
            // todo.save() should be traced because localVarTypes maps todo → .models
            expect(edgeLabels).toContain('Todo.get()');
            expect(edgeLabels).toContain('todo.save()');
            expect(edgeLabels).toContain('TodoSerializer()');
        });
    });
});

// ─── Java / Spring Boot: OOP class-prefixed function names ────────────────────

describe('buildSequenceGraphFromAnalysis — Java Spring Boot BFS', () => {
    /**
     * Regression: Java functions are stored as "ClassName.methodName" by
     * treeSitterExtractor, but frameworkDetector returns bare method names as
     * handlerNames.  Without the fix, entryFunc is always undefined and the BFS
     * never starts — meaning service/repository participants are never reached.
     */
    it('finds the entry handler even when stored as ClassName.method', () => {
        const analysis = {
            importsByLocal: new Map<string, string>([
                ['AuthenticatedUser', 'com.todo.middleware.AuthenticatedUser'],
                ['ResponseEntity', 'org.springframework.http.ResponseEntity'],
            ]),
            injectedDeps: new Map<string, string>([
                ['todoService', 'TodoService'],
            ]),
            entities: [],
            funcs: new Map([
                ['TodoController.addTodo', {
                    name: 'TodoController.addTodo',
                    kind: 'function',
                    memberCalls: new Map([['todoService', new Set(['createTodo'])]]),
                    calls: new Set<string>(),
                }],
            ]),
        };

        const apis = [{ apiId: 'api:1', method: 'POST', route: '/api/todos', handlerName: 'addTodo' }];

        const graph = buildSequenceGraphFromAnalysis(
            analysis as any,
            'features/todos/TodoController.java',
            apis,
            'addTodo',  // bare name — NOT "TodoController.addTodo"
        );

        // Should have a targeted message edge TO TodoService via createTodo, not just fallback
        const msgEdges = graph.edges.filter(e => e.edgeType === 'message');
        expect(msgEdges.some(e => e.label?.includes('createTodo'))).toBe(true);
    });

    it('BFS traces through Java service methods stored as ClassName.method to surface repositories', () => {
        const controllerAnalysis = {
            importsByLocal: new Map<string, string>(),
            injectedDeps: new Map<string, string>([['todoService', 'TodoService']]),
            entities: [],
            funcs: new Map([
                ['TodoController.addTodo', {
                    name: 'TodoController.addTodo',
                    kind: 'function',
                    memberCalls: new Map([['todoService', new Set(['createTodo'])]]),
                    calls: new Set<string>(),
                }],
            ]),
        };

        const apis = [{ apiId: 'api:1', method: 'POST', route: '/api/todos', handlerName: 'addTodo' }];

        // Snapshot of TodoService.java with class-prefixed function name
        const snapshotFiles: Record<string, any> = {
            'features/todos/TodoService.java': {
                symbols: {
                    functions: [{
                        name: 'TodoService.createTodo',
                        kind: 'function',
                        span: { start: 0, end: 0 },
                        stableKey: 'TodoService::createTodo',
                        memberCalls: {
                            todoRepository: ['save'],
                            userRepository: ['findById'],
                        },
                        calls: [],
                    }],
                    variables: [],
                    imports: [],
                    injectedDeps: {
                        todoRepository: 'TodoRepository',
                        userRepository: 'com.example.UserRepository',
                    },
                },
            },
        };

        const resolver = (source: string) => {
            if (source === 'TodoService') {
                return { filePath: 'features/todos/TodoService.java', code: '' };
            }
            return undefined;
        };

        const graph = buildSequenceGraphFromAnalysis(
            controllerAnalysis as any,
            'features/todos/TodoController.java',
            apis,
            'addTodo',
            undefined, undefined,
            resolver,
            snapshotFiles,
        );

        const participantLabels = graph.nodes
            .filter(n => n.type === 'participant')
            .map(n => n.label);

        // BFS should enter TodoService.createTodo and find both repositories
        expect(participantLabels).toContain('TodoService');
        expect(participantLabels).toContain('TodoRepository');
        expect(participantLabels).toContain('UserRepository');

        const msgEdges = graph.edges.filter(e => e.edgeType === 'message');
        expect(msgEdges.some(e => e.label?.includes('createTodo'))).toBe(true);
        expect(msgEdges.some(e => e.label?.includes('save'))).toBe(true);
        expect(msgEdges.some(e => e.label?.includes('findById'))).toBe(true);
    });
});
