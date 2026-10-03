/**
 * zod.test.ts — Issue #600 Phase 0 Zod schema inference.
 */

import { describe, it, expect } from 'vitest';
import { parseZodExpression, parseZodExport, parseZodInferredApiSchema } from '../zod';

describe('parseZodExpression — primitives', () => {
    it('z.string()', () => {
        expect(parseZodExpression('z.string()')).toEqual({ type: 'string' });
    });
    it('z.number()', () => {
        expect(parseZodExpression('z.number()')).toEqual({ type: 'number' });
    });
    it('z.boolean()', () => {
        expect(parseZodExpression('z.boolean()')).toEqual({ type: 'boolean' });
    });
    it('z.null()', () => {
        expect(parseZodExpression('z.null()')).toEqual({ type: 'null', nullable: true });
    });
    it('z.bigint() → integer', () => {
        expect(parseZodExpression('z.bigint()')).toEqual({ type: 'integer' });
    });
});

describe('parseZodExpression — composites', () => {
    it('z.array(z.string())', () => {
        expect(parseZodExpression('z.array(z.string())')).toEqual({
            type: 'array',
            items: { type: 'string' },
        });
    });

    it('z.object({ name: z.string(), age: z.number() })', () => {
        const out = parseZodExpression('z.object({ name: z.string(), age: z.number() })');
        expect(out?.type).toBe('object');
        expect(out?.properties).toEqual({
            name: { type: 'string' },
            age: { type: 'number' },
        });
        expect(out?.required?.sort()).toEqual(['age', 'name']);
    });

    it('z.enum(["a","b","c"]) → string enum', () => {
        expect(parseZodExpression('z.enum(["a","b","c"])')).toEqual({
            type: 'string',
            enum: ['a', 'b', 'c'],
        });
    });

    it('z.literal("x") → enum-of-one', () => {
        expect(parseZodExpression('z.literal("x")')).toEqual({ enum: ['x'] });
    });
});

describe('parseZodExpression — chain operators', () => {
    it('.optional() flips nullable + drops from required', () => {
        const out = parseZodExpression('z.object({ a: z.string().optional() })');
        expect(out?.properties?.a.nullable).toBe(true);
        expect(out?.required ?? []).not.toContain('a');
    });

    it('.nullable() sets nullable', () => {
        const out = parseZodExpression('z.string().nullable()');
        expect(out?.nullable).toBe(true);
    });

    it('.describe("…") sets description', () => {
        const out = parseZodExpression('z.string().describe("user id")');
        expect(out?.description).toBe('user id');
    });

    it('.email() sets format=email', () => {
        const out = parseZodExpression('z.string().email()');
        expect(out?.format).toBe('email');
    });

    it('.uuid() sets format=uuid', () => {
        const out = parseZodExpression('z.string().uuid()');
        expect(out?.format).toBe('uuid');
    });

    it('.default("foo") sets example', () => {
        const out = parseZodExpression('z.string().default("foo")');
        expect(out?.example).toBe('foo');
    });

    it('strips unknown chain calls like .min()/.max()', () => {
        const out = parseZodExpression('z.string().min(3).max(255)');
        expect(out).toEqual({ type: 'string' });
    });
});

describe('parseZodExport', () => {
    it('extracts an exported schema from source by name', () => {
        const source = `
            import { z } from 'zod';
            export const CreateArticle = z.object({
                title: z.string(),
                tags:  z.array(z.string()).optional(),
            });
            export const handler = (req) => ({});
        `;
        const out = parseZodExport(source, 'CreateArticle');
        expect(out?.type).toBe('object');
        expect(out?.properties?.title?.type).toBe('string');
        expect(out?.properties?.tags?.type).toBe('array');
        expect(out?.required?.sort()).toEqual(['title']);
    });

    it('returns undefined when the export is missing', () => {
        const source = 'export const other = 1;';
        expect(parseZodExport(source, 'Missing')).toBeUndefined();
    });
});

describe('parseZodInferredApiSchema', () => {
    it('wraps an object expression into a request-schema payload', () => {
        const result = parseZodInferredApiSchema('z.object({ id: z.string() })');
        expect(result.requestSchema?.kind).toBe('json');
        expect(result.requestSchema?.source).toBe('zod');
        expect(result.requestSchema?.schema?.properties?.id?.type).toBe('string');
    });

    it('returns empty when expression is unrecognised', () => {
        const result = parseZodInferredApiSchema('SomeOtherThing()');
        expect(result).toEqual({});
    });
});
