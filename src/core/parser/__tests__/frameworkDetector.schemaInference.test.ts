/**
 * frameworkDetector.schemaInference.test.ts — Issue #600 Phase 0.5 wiring.
 *
 * Integration test: end-to-end through `detectFrameworkApis`, asserting
 * that the JSDoc + TS-type inference passes do populate
 * `ApiRecord.meta.requestSchema` / `pathParams` / `queryParams` /
 * `responseSchema` on the emitted record.
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';

describe('detectFrameworkApis — Phase 0.5 schema inference wiring', () => {
    it('populates requestSchema + responseSchema from JSDoc on an Express route', () => {
        const source = `
const express = require('express');
const router = express.Router();

/**
 * Create an article.
 * @param {string}  body.title       Title of the article.
 * @param {string=} body.description  Optional summary.
 * @response 201 Created — returns the new article.
 * @response 422 Validation error.
 */
router.post('/articles', (req, res) => {
    res.json({ ok: true });
});

module.exports = router;
        `;
        const apis = detectFrameworkApis(source, 'routes/articles.ts', 'typescript');
        const post = apis.find(a => a.method === 'POST' && a.route === '/articles');
        expect(post).toBeDefined();
        const schema = post!.meta?.requestSchema?.schema;
        expect(post!.meta?.requestSchema?.source).toBe('jsdoc');
        expect(schema?.type).toBe('object');
        expect(schema?.properties?.title?.type).toBe('string');
        expect(schema?.properties?.description?.type).toBe('string');
        expect(schema?.required ?? []).toContain('title');
        expect(post!.meta?.responseSchema?.map(r => r.status).sort()).toEqual([201, 422]);
    });

    it('populates requestSchema from a TS handler parameter type', () => {
        const source = `
import express from 'express';
const router = express.Router();

router.put('/users/:id', (req: { body: { email: string; bio?: string } }, res) => {
    res.json({ ok: true });
});
        `;
        const apis = detectFrameworkApis(source, 'routes/users.ts', 'typescript');
        const put = apis.find(a => a.method === 'PUT' && a.route === '/users/:id');
        expect(put).toBeDefined();
        expect(put!.meta?.requestSchema?.source).toBe('ts-type');
        const props = put!.meta?.requestSchema?.schema?.properties ?? {};
        expect(props.email?.type).toBe('string');
        expect(props.bio?.type).toBe('string');
        expect(put!.meta?.requestSchema?.schema?.required ?? []).toContain('email');
    });

    it('JSDoc wins over TS-type when both are present', () => {
        const source = `
import express from 'express';
const router = express.Router();

/**
 * @param {string} body.title  Title with description.
 */
router.post('/posts', (req: { body: { title: string; ignored: number } }, res) => {});
        `;
        const apis = detectFrameworkApis(source, 'r.ts', 'typescript');
        const post = apis.find(a => a.method === 'POST' && a.route === '/posts')!;
        expect(post.meta?.requestSchema?.source).toBe('jsdoc');
        // JSDoc-only field, not what the TS-type inferred.
        const props = post.meta?.requestSchema?.schema?.properties ?? {};
        expect(props.title?.description).toBe('Title with description.');
        expect(props.ignored).toBeUndefined();
    });

    it('handlers with no schema metadata leave meta unchanged', () => {
        const source = `
import express from 'express';
const router = express.Router();
router.get('/health', (req, res) => res.json({ ok: true }));
        `;
        const apis = detectFrameworkApis(source, 'r.ts', 'typescript');
        const get = apis.find(a => a.method === 'GET' && a.route === '/health');
        expect(get).toBeDefined();
        expect(get!.meta?.requestSchema).toBeUndefined();
    });
});

describe('detectFrameworkApis — Phase 0.6 validator-library wiring', () => {
    it('lifts a Zod schema referenced via `Schema.parse(req.body)`', () => {
        const source = `
import { z } from 'zod';
import express from 'express';
const router = express.Router();

export const CreateArticle = z.object({
    title: z.string(),
    tags:  z.array(z.string()).optional(),
});

router.post('/articles', (req, res) => {
    const data = CreateArticle.parse(req.body);
    res.json(data);
});
        `;
        const apis = detectFrameworkApis(source, 'routes/articles.ts', 'typescript');
        const post = apis.find(a => a.method === 'POST' && a.route === '/articles')!;
        expect(post.meta?.requestSchema?.source).toBe('zod');
        const schema = post.meta?.requestSchema?.schema;
        expect(schema?.type).toBe('object');
        expect(schema?.properties?.title?.type).toBe('string');
        expect(schema?.properties?.tags?.type).toBe('array');
        expect(schema?.required).toEqual(['title']);
    });

    it('lifts a Zod schema referenced via `validate(Schema)` middleware', () => {
        const source = `
import { z } from 'zod';
import express from 'express';
const router = express.Router();

export const LoginInput = z.object({
    email:    z.string().email(),
    password: z.string(),
});

router.post('/login', validate(LoginInput), (req, res) => {
    res.json({ ok: true });
});
        `;
        const apis = detectFrameworkApis(source, 'auth.ts', 'typescript');
        const post = apis.find(a => a.route === '/login')!;
        expect(post.meta?.requestSchema?.source).toBe('zod');
        expect(post.meta?.requestSchema?.schema?.properties?.email?.format).toBe('email');
    });

    it('lifts a Joi schema referenced via `validate(Schema)`', () => {
        const source = `
const Joi = require('joi');
const express = require('express');
const router = express.Router();

const CreateUser = Joi.object({
    email: Joi.string().email().required(),
    name:  Joi.string().required(),
});

router.post('/users', validateBody(CreateUser), (req, res) => res.json({}));
        `;
        const apis = detectFrameworkApis(source, 'users.ts', 'typescript');
        const post = apis.find(a => a.route === '/users')!;
        expect(post.meta?.requestSchema?.source).toBe('joi');
        expect(post.meta?.requestSchema?.schema?.required?.sort()).toEqual(['email', 'name']);
    });

    it('lifts a Yup schema referenced via inline `Schema.validateSync(req.body)`-like middleware', () => {
        const source = `
import * as yup from 'yup';
import express from 'express';
const router = express.Router();

const CreatePost = yup.object({
    title: yup.string().required(),
    body:  yup.string(),
});

router.post('/posts', validate(CreatePost), (req, res) => res.json({}));
        `;
        const apis = detectFrameworkApis(source, 'posts.ts', 'typescript');
        const post = apis.find(a => a.route === '/posts')!;
        expect(post.meta?.requestSchema?.source).toBe('yup');
        expect(post.meta?.requestSchema?.schema?.properties?.title?.type).toBe('string');
    });

    it('lifts a class-validator DTO referenced via `validate(DtoClass)`', () => {
        const source = `
import { IsString, IsBoolean, IsOptional } from 'class-validator';
import express from 'express';
const router = express.Router();

export class CreateArticleDto {
    @IsString()
    title: string;

    @IsBoolean()
    @IsOptional()
    published?: boolean;
}

router.post('/dtos', validate(CreateArticleDto), (req, res) => res.json({}));
        `;
        const apis = detectFrameworkApis(source, 'd.ts', 'typescript');
        const post = apis.find(a => a.route === '/dtos')!;
        expect(post.meta?.requestSchema?.source).toBe('class-validator');
        expect(post.meta?.requestSchema?.schema?.properties?.title?.type).toBe('string');
        expect(post.meta?.requestSchema?.schema?.required).toEqual(['title']);
    });

    it('Hono `zValidator("json", Schema, …)` middleware', () => {
        const source = `
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

const CreateOrder = z.object({ id: z.string(), qty: z.number() });

app.post('/orders', zValidator('json', CreateOrder), (c) => c.json({}));
        `;
        const apis = detectFrameworkApis(source, 'orders.ts', 'typescript');
        const post = apis.find(a => a.route === '/orders')!;
        expect(post.meta?.requestSchema?.source).toBe('zod');
        expect(post.meta?.requestSchema?.schema?.properties?.qty?.type).toBe('number');
    });

    it('still falls back to TS-type when the Schema cant be resolved', () => {
        const source = `
import express from 'express';
const router = express.Router();
router.post('/x', (req: { body: { tag: string } }, res) => {
    UnknownSchema.parse(req.body);
});
        `;
        const apis = detectFrameworkApis(source, 'x.ts', 'typescript');
        const post = apis.find(a => a.route === '/x')!;
        expect(post.meta?.requestSchema?.source).toBe('ts-type');
        expect(post.meta?.requestSchema?.schema?.properties?.tag?.type).toBe('string');
    });

    // Issue #761: the express-realworld example app uses `@bodyparam <name> <Type>`
    // shorthand. Verify end-to-end through detectFrameworkApis that the
    // shorthand-derived requestSchema lands on the emitted ApiRecord.
    it('populates requestSchema from @bodyparam JSDoc shorthand on an Express route', () => {
        const source = `
import { Router, Request, Response, NextFunction } from 'express';
const router = Router();

/**
 * Create an user
 * @auth none
 * @route {POST} /users
 * @bodyparam user User
 * @returns user User
 */
router.post('/users', async (req: Request, res: Response, next: NextFunction) => {
    res.json({ ok: true });
});
        `;
        const apis = detectFrameworkApis(source, 'routes/users.ts', 'typescript');
        const post = apis.find(a => a.method === 'POST' && a.route === '/users');
        expect(post).toBeDefined();
        const schema = post!.meta?.requestSchema?.schema;
        expect(post!.meta?.requestSchema?.source).toBe('jsdoc');
        expect(schema?.type).toBe('object');
        expect(schema?.properties?.user?.type).toBe('string');
        expect(schema?.properties?.user?.description).toContain('User');
        expect(schema?.required).toContain('user');
    });
});
