import { describe, it, expect } from 'vitest';
import { collectTopLevelEntities, normalizeSpace, srcText } from '../symbolExtractor';

describe('symbolExtractor', () => {
    describe('normalizeSpace', () => {
        it('should collapse whitespace', () => {
            expect(normalizeSpace('  hello   world  ')).toBe('hello world');
        });

        it('should handle empty string', () => {
            expect(normalizeSpace('')).toBe('');
        });

        it('should handle tabs and newlines', () => {
            expect(normalizeSpace('hello\n\tworld')).toBe('hello world');
        });
    });

    describe('collectTopLevelEntities', () => {
        it('should extract ES module imports', () => {
            const code = `import express from 'express';\nimport { Pool } from 'pg';`;
            const result = collectTopLevelEntities(code);

            const imports = result.entities.filter((e) => e.kind === 'import');
            expect(imports).toHaveLength(2);
            expect(imports[0].name).toBe('express');
            expect(imports[1].name).toBe('pg');
        });

        it('should extract function declarations', () => {
            const code = `function hello(name) {\n  return "Hi, " + name;\n}`;
            const result = collectTopLevelEntities(code);

            const funcs = result.entities.filter((e) => e.kind === 'function');
            expect(funcs).toHaveLength(1);
            expect(funcs[0].name).toBe('hello');
            expect(funcs[0].signature).toContain('function hello(name)');
        });

        it('should extract arrow functions assigned to variables', () => {
            const code = `const greet = (name) => {\n  return "Hi, " + name;\n};`;
            const result = collectTopLevelEntities(code);

            const funcs = result.entities.filter((e) => e.kind === 'function');
            expect(funcs).toHaveLength(1);
            expect(funcs[0].name).toBe('greet');
        });

        it('should extract function expressions assigned to variables', () => {
            const code = `const greet = function(name) {\n  return "Hi, " + name;\n};`;
            const result = collectTopLevelEntities(code);

            const funcs = result.entities.filter((e) => e.kind === 'function');
            expect(funcs).toHaveLength(1);
            expect(funcs[0].name).toBe('greet');
        });

        it('should extract top-level variables', () => {
            const code = `const config = { port: 3000 };\nlet counter = 0;`;
            const result = collectTopLevelEntities(code);

            const vars = result.entities.filter((e) => e.kind === 'variable');
            expect(vars).toHaveLength(2);
            expect(vars[0].name).toBe('config');
            expect(vars[1].name).toBe('counter');
        });

        it('should extract CommonJS require as import', () => {
            const code = `const express = require('express');`;
            const result = collectTopLevelEntities(code);

            // A require variable + import entity
            const imports = result.entities.filter((e) => e.kind === 'import');
            expect(imports.length).toBeGreaterThanOrEqual(1);
            expect(result.importsByLocal.has('express')).toBe(true);
        });

        it('should populate importsByLocal map', () => {
            const code = `import axios from 'axios';\nimport { Pool } from 'pg';`;
            const result = collectTopLevelEntities(code);

            expect(result.importsByLocal.get('axios')).toBe('axios');
            expect(result.importsByLocal.get('Pool')).toBe('pg');
        });

        it('should detect function calls from other functions', () => {
            const code = `
function buildUrl(path) {
  return "/api" + path;
}

function fetchUsers() {
  const url = buildUrl("/users");
  return url;
}`;
            const result = collectTopLevelEntities(code);
            const fetchUsers = result.funcs.get('fetchUsers');

            expect(fetchUsers).toBeDefined();
            expect(fetchUsers!.calls!.has('buildUrl')).toBe(true);
        });

        it('should detect variable usage in functions', () => {
            const code = `
const baseUrl = "https://api.example.com";

function buildUrl(path) {
  return baseUrl + path;
}`;
            const result = collectTopLevelEntities(code);
            const buildUrl = result.funcs.get('buildUrl');

            expect(buildUrl).toBeDefined();
            expect(buildUrl!.usesVars!.has('baseUrl')).toBe(true);
        });

        it('should detect import usage in functions', () => {
            const code = `
import http from 'http';

function fetchData() {
  return http.get("/data");
}`;
            const result = collectTopLevelEntities(code);
            const fetchData = result.funcs.get('fetchData');

            expect(fetchData).toBeDefined();
            expect(fetchData!.usesImports!.has('http')).toBe(true);
        });

        it('should extract exported arrow functions (export const fn = async () => {})', () => {
            const code = `
export const getArticles = async (query: any) => {
  return [];
};
export const updateArticle = async (slug: string, data: any) => {
  return null;
};`;
            const result = collectTopLevelEntities(code);
            const funcs = result.entities.filter((e) => e.kind === 'function');
            expect(funcs).toHaveLength(2);
            expect(funcs.map(f => f.name)).toContain('getArticles');
            expect(funcs.map(f => f.name)).toContain('updateArticle');
        });

        it('should extract exported function declarations', () => {
            const code = `
export function doSomething(x: number) {
  return x * 2;
}`;
            const result = collectTopLevelEntities(code);
            const funcs = result.entities.filter((e) => e.kind === 'function');
            expect(funcs).toHaveLength(1);
            expect(funcs[0].name).toBe('doSomething');
        });

        it('should extract exported const variables', () => {
            const code = `export const BASE_URL = 'https://api.example.com';`;
            const result = collectTopLevelEntities(code);
            const vars = result.entities.filter((e) => e.kind === 'variable');
            expect(vars).toHaveLength(1);
            expect(vars[0].name).toBe('BASE_URL');
        });

        it('should extract mix of exported and non-exported declarations', () => {
            const code = `
export const getArticles = async () => [];
export const createArticle = async (data: any) => null;
function buildFindAllQuery(opts: any) { return {}; }
const disconnectTags = async (id: string) => {};`;
            const result = collectTopLevelEntities(code);
            const funcNames = result.entities.filter(e => e.kind === 'function').map(e => e.name);
            expect(funcNames).toContain('getArticles');
            expect(funcNames).toContain('createArticle');
            expect(funcNames).toContain('buildFindAllQuery');
            expect(funcNames).toContain('disconnectTags');
            expect(funcNames).toHaveLength(4);
        });

        it('should handle a complete Express-like file', () => {
            const code = `
import express from 'express';
import { Pool } from 'pg';

const router = express.Router();
const db = new Pool();

function buildUserResponse(row) {
  return { id: row.id, name: row.name };
}

async function getUserHandler(req, res) {
  const result = await db.query("select * from users");
  const payload = buildUserResponse(result.rows[0]);
  return res.json(payload);
}

router.get("/users/:id", getUserHandler);`;

            const result = collectTopLevelEntities(code);

            const imports = result.entities.filter((e) => e.kind === 'import');
            expect(imports).toHaveLength(2);

            const vars = result.entities.filter((e) => e.kind === 'variable');
            expect(vars.length).toBeGreaterThanOrEqual(2);

            const funcs = result.entities.filter((e) => e.kind === 'function');
            expect(funcs).toHaveLength(2);
        });

        // Issue 409: inline arrow handlers passed to `router.METHOD(path, ..., arrow)`
        // must surface as function EntityRecords so file-hash changes from
        // editing the arrow body cascade through L4 (file diagram) and L5
        // (flow graph) via stableKey-keyed bodyText diff.
        // Issue 414: template-literal route inside a for-loop produces a
        // single parameterized entity (`anonymous@GET:/random/:i`), not N.
        it('Issue 414: synthesises a parameterized entity for a for-loop with template-literal route', () => {
            const code = `
const router = require('express').Router();
for (let i = 1; i <= 25; i++) {
  router.get(\`/random/\${i}\`, (req, res) => res.json({}));
}
`;
            const result = collectTopLevelEntities(code);
            const funcs = result.entities.filter((e) => e.kind === 'function');
            const random = funcs.filter(f => f.name.startsWith('anonymous@GET:/random'));
            // Exactly one entity for the shared arrow body
            expect(random).toHaveLength(1);
            expect(random[0].name).toBe('anonymous@GET:/random/:i');
        });

        it('Issue 409: synthesises an anonymous@METHOD:route function entity for inline arrow handlers', () => {
            const code = `
const router = require('express').Router();
const auth = require('./auth');
router.get('/articles', auth.optional, async (req, res) => { res.json([]); });
router.put('/articles/:slug', auth.required, async (req, res) => { res.json({}); });
`;
            const result = collectTopLevelEntities(code);
            const funcs = result.entities.filter((e) => e.kind === 'function');
            const names = funcs.map(f => f.name);
            expect(names).toContain('anonymous@GET:/articles');
            expect(names).toContain('anonymous@PUT:/articles/:slug');
        });

        it('Issue 409: arrow body changes between snapshots produce different bodyText for diff', () => {
            const codeBefore = `router.get('/x', async (req, res) => { res.json([]); });`;
            const codeAfter = `router.get('/x', async (req, res) => { res.json([1,2,3]); });`;
            const a = collectTopLevelEntities(codeBefore).entities.find(e => e.name === 'anonymous@GET:/x');
            const b = collectTopLevelEntities(codeAfter).entities.find(e => e.name === 'anonymous@GET:/x');
            expect(a).toBeDefined();
            expect(b).toBeDefined();
            expect(a!.bodyText).not.toEqual(b!.bodyText);
        });

        it('Issue 409: handles synchronous arrow handlers and unwraps middleware args correctly', () => {
            const code = `
router.post('/login', (req, res) => { res.json('ok'); });
router.delete('/x', mw1, mw2, (req, res) => { res.end(); });
`;
            const result = collectTopLevelEntities(code);
            const funcs = result.entities.filter((e) => e.kind === 'function');
            const names = funcs.map(f => f.name);
            expect(names).toContain('anonymous@POST:/login');
            expect(names).toContain('anonymous@DELETE:/x');
        });

        it('Issue 409: does not synthesise an entity when the last arg is an identifier (handler is named)', () => {
            const code = `router.get('/users', listUsers);`;
            const result = collectTopLevelEntities(code);
            const funcs = result.entities.filter((e) => e.kind === 'function');
            const synthetic = funcs.filter(f => f.name.startsWith('anonymous@'));
            expect(synthetic).toHaveLength(0);
        });
    });
});

// #837 (2026-06-11) — bodySrc: raw newline-preserving function source for
// flow-diff reconstruction. bodyText is whitespace-collapsed, which is
// unparseable for semicolon-less code; bodySrc must keep newlines.
describe('bodySrc capture (#837)', () => {
    it('module.exports.X = arrow keeps newlines in bodySrc while bodyText stays collapsed', () => {
        const code = "module.exports.create = (event, context, callback) => {\n  const timestamp = new Date().getTime()\n  const data = JSON.parse(event.body)\n  callback(null, data)\n}\n";
        const fn = collectTopLevelEntities(code).entities.find(e => e.kind === 'function' && e.name === 'create');
        expect(fn).toBeDefined();
        expect(fn!.bodyText.includes('\n')).toBe(false);
        expect(fn!.bodySrc).toBeDefined();
        expect(fn!.bodySrc!.includes('\n')).toBe(true);
        expect(fn!.bodySrc).toContain('module.exports.create =');
    });

    it('function declarations carry the full declaration in bodySrc', () => {
        const code = "function go(a) {\n  const x = a + 1\n  return x\n}";
        const fn = collectTopLevelEntities(code).entities.find(e => e.name === 'go');
        expect(fn!.bodySrc).toContain('function go(a)');
        expect(fn!.bodySrc!.includes('\n')).toBe(true);
    });

    it('const-assigned arrows carry the declarator in bodySrc', () => {
        const code = "const fly = async (x) => {\n  return x * 2\n}";
        const fn = collectTopLevelEntities(code).entities.find(e => e.name === 'fly');
        expect(fn!.bodySrc).toContain('fly = async (x) =>');
    });

    it('bodySrc truncates very long functions to a bounded size', () => {
        const long = 'function big() {\n' + Array.from({length: 2000}, (_, i) => `  const x${i} = 1`).join('\n') + '\n}';
        const fn = collectTopLevelEntities(long).entities.find(e => e.name === 'big');
        expect(fn!.bodySrc!.length).toBeLessThanOrEqual(6000);
    });
});
