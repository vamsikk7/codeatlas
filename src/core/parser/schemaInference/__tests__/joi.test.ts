/**
 * joi.test.ts — Issue #600 Phase 0 Joi schema inference.
 */

import { describe, it, expect } from 'vitest';
import { parseJoiExpression, parseJoiExport, parseJoiInferredApiSchema } from '../joi';

describe('parseJoiExpression — primitives', () => {
    it('Joi.string()', () => expect(parseJoiExpression('Joi.string()')).toEqual({ type: 'string' }));
    it('Joi.number()', () => expect(parseJoiExpression('Joi.number()')).toEqual({ type: 'number' }));
    it('Joi.boolean()', () => expect(parseJoiExpression('Joi.boolean()')).toEqual({ type: 'boolean' }));
    it('Joi.date() → date-time', () => expect(parseJoiExpression('Joi.date()')).toEqual({ type: 'string', format: 'date-time' }));
    it('lowercase joi.string()', () => expect(parseJoiExpression('joi.string()')).toEqual({ type: 'string' }));
});

describe('parseJoiExpression — composites', () => {
    it('Joi.array().items(Joi.string())', () => {
        expect(parseJoiExpression('Joi.array().items(Joi.string())')).toEqual({
            type: 'array',
            items: { type: 'string' },
        });
    });

    it('Joi.object — fields require explicit .required()', () => {
        const out = parseJoiExpression('Joi.object({ id: Joi.string().required(), name: Joi.string() })');
        expect(out?.type).toBe('object');
        expect(out?.properties).toEqual({
            id: { type: 'string' },
            name: { type: 'string' },
        });
        expect(out?.required).toEqual(['id']);
    });

    it('Joi.string().valid("a","b","c") → enum', () => {
        const out = parseJoiExpression('Joi.string().valid("a","b","c")');
        expect(out).toEqual({ type: 'string', enum: ['a', 'b', 'c'] });
    });
});

describe('parseJoiExpression — chain operators', () => {
    it('.optional() flips nullable', () => {
        const out = parseJoiExpression('Joi.string().optional()');
        expect(out?.nullable).toBe(true);
    });

    it('.allow(null) flips nullable', () => {
        const out = parseJoiExpression('Joi.string().allow(null)');
        expect(out?.nullable).toBe(true);
    });

    it('.description("…") sets description', () => {
        const out = parseJoiExpression('Joi.string().description("user id")');
        expect(out?.description).toBe('user id');
    });

    it('.email() sets format=email', () => {
        const out = parseJoiExpression('Joi.string().email()');
        expect(out?.format).toBe('email');
    });

    it('.uuid() sets format=uuid', () => {
        const out = parseJoiExpression('Joi.string().uuid()');
        expect(out?.format).toBe('uuid');
    });

    it('.default("foo") sets example', () => {
        const out = parseJoiExpression('Joi.string().default("foo")');
        expect(out?.example).toBe('foo');
    });

    it('strips unknown chain calls like .min(3).max(255)', () => {
        const out = parseJoiExpression('Joi.string().min(3).max(255)');
        expect(out).toEqual({ type: 'string' });
    });
});

describe('parseJoiExport', () => {
    it('extracts an exported Joi schema by name', () => {
        const source = `
            const Joi = require('joi');
            export const CreateUser = Joi.object({
                email: Joi.string().email().required(),
                name:  Joi.string().required(),
                bio:   Joi.string().optional(),
            });
        `;
        const out = parseJoiExport(source, 'CreateUser');
        expect(out?.type).toBe('object');
        expect(out?.properties?.email?.format).toBe('email');
        expect(out?.required?.sort()).toEqual(['email', 'name']);
    });

    it('returns undefined when export not found', () => {
        expect(parseJoiExport('export const other = 1;', 'Missing')).toBeUndefined();
    });
});

describe('parseJoiInferredApiSchema', () => {
    it('wraps an object expression into a request-schema payload', () => {
        const result = parseJoiInferredApiSchema('Joi.object({ id: Joi.string().required() })');
        expect(result.requestSchema?.kind).toBe('json');
        expect(result.requestSchema?.source).toBe('joi');
        expect(result.requestSchema?.schema?.properties?.id?.type).toBe('string');
    });

    it('returns empty when expression is unrecognised', () => {
        expect(parseJoiInferredApiSchema('SomeOtherThing()')).toEqual({});
    });
});
