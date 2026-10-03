/**
 * yup.test.ts — Issue #600 Phase 0 Yup schema inference.
 */

import { describe, it, expect } from 'vitest';
import { parseYupExpression, parseYupExport, parseYupInferredApiSchema } from '../yup';

describe('parseYupExpression — primitives', () => {
    it('yup.string()', () => expect(parseYupExpression('yup.string()')).toEqual({ type: 'string' }));
    it('yup.number()', () => expect(parseYupExpression('yup.number()')).toEqual({ type: 'number' }));
    it('yup.boolean()', () => expect(parseYupExpression('yup.boolean()')).toEqual({ type: 'boolean' }));
    it('yup.bool() alias', () => expect(parseYupExpression('yup.bool()')).toEqual({ type: 'boolean' }));
    it('yup.date()', () => expect(parseYupExpression('yup.date()')).toEqual({ type: 'string', format: 'date-time' }));
    it('uppercase Yup.string()', () => expect(parseYupExpression('Yup.string()')).toEqual({ type: 'string' }));
});

describe('parseYupExpression — composites', () => {
    it('yup.array().of(yup.string())', () => {
        expect(parseYupExpression('yup.array().of(yup.string())')).toEqual({
            type: 'array',
            items: { type: 'string' },
        });
    });

    it('yup.array() with no .of() → generic array', () => {
        expect(parseYupExpression('yup.array()')).toEqual({ type: 'array' });
    });

    it('yup.object({ a: yup.string(), b: yup.number() }) — constructor form', () => {
        const out = parseYupExpression('yup.object({ a: yup.string(), b: yup.number() })');
        expect(out?.type).toBe('object');
        expect(out?.properties).toEqual({
            a: { type: 'string' },
            b: { type: 'number' },
        });
        expect(out?.required?.sort()).toEqual(['a', 'b']);
    });

    it('yup.object().shape({...}) — chained form', () => {
        const out = parseYupExpression('yup.object().shape({ a: yup.string() })');
        expect(out?.type).toBe('object');
        expect(out?.properties?.a?.type).toBe('string');
    });

    it('.oneOf(["a","b"]) → enum', () => {
        const out = parseYupExpression('yup.string().oneOf(["a","b","c"])');
        expect(out).toEqual({ type: 'string', enum: ['a', 'b', 'c'] });
    });
});

describe('parseYupExpression — chain operators', () => {
    it('.optional() flips nullable', () => {
        const out = parseYupExpression('yup.string().optional()');
        expect(out?.nullable).toBe(true);
    });

    it('.notRequired() flips nullable', () => {
        const out = parseYupExpression('yup.string().notRequired()');
        expect(out?.nullable).toBe(true);
    });

    it('.nullable() flips nullable', () => {
        const out = parseYupExpression('yup.string().nullable()');
        expect(out?.nullable).toBe(true);
    });

    it('.required() does not break the chain', () => {
        const out = parseYupExpression('yup.string().required()');
        expect(out).toEqual({ type: 'string' });
    });

    it('.label("…") sets description', () => {
        const out = parseYupExpression('yup.string().label("user id")');
        expect(out?.description).toBe('user id');
    });

    it('.email() / .url() / .uuid() set format', () => {
        expect(parseYupExpression('yup.string().email()')?.format).toBe('email');
        expect(parseYupExpression('yup.string().url()')?.format).toBe('url');
        expect(parseYupExpression('yup.string().uuid()')?.format).toBe('uuid');
    });

    it('.default("foo") sets example', () => {
        expect(parseYupExpression('yup.string().default("foo")')?.example).toBe('foo');
    });

    it('strips unknown chain calls like .min(3).max(255).matches(/abc/)', () => {
        const out = parseYupExpression('yup.string().min(3).max(255).matches(/abc/)');
        expect(out).toEqual({ type: 'string' });
    });
});

describe('parseYupExport', () => {
    it('extracts an exported schema by name', () => {
        const source = `
            import * as yup from 'yup';
            export const CreateArticle = yup.object({
                title: yup.string().required(),
                tags:  yup.array().of(yup.string()).optional(),
            });
        `;
        const out = parseYupExport(source, 'CreateArticle');
        expect(out?.type).toBe('object');
        expect(out?.properties?.title?.type).toBe('string');
        expect(out?.properties?.tags?.type).toBe('array');
        // `.optional()` chain on `tags` flips it out of required[].
        expect(out?.required?.sort()).toEqual(['title']);
    });
});

describe('parseYupInferredApiSchema', () => {
    it('wraps an object expression into a request-schema payload', () => {
        const result = parseYupInferredApiSchema('yup.object({ id: yup.string() })');
        expect(result.requestSchema?.kind).toBe('json');
        expect(result.requestSchema?.source).toBe('yup');
        expect(result.requestSchema?.schema?.properties?.id?.type).toBe('string');
    });
});
