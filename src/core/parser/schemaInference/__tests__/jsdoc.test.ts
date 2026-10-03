/**
 * jsdoc.test.ts — Issue #600 Phase 0 JSDoc schema inference.
 */

import { describe, it, expect } from 'vitest';
import { parseJsdocSchema } from '../jsdoc';

describe('parseJsdocSchema', () => {
    it('returns empty when no recognised tags are present', () => {
        const src = '/**\n * Boring handler.\n * @returns void\n */';
        expect(parseJsdocSchema(src)).toEqual({});
    });

    it('extracts a request body schema from @param body tags', () => {
        const src = [
            '/**',
            ' * Create an article.',
            ' * @param {string}  body.title       Title of the article.',
            ' * @param {string=} body.description  Optional summary blurb.',
            ' * @param {boolean} body.published   Whether the article is visible.',
            ' */',
        ].join('\n');
        const result = parseJsdocSchema(src);
        expect(result.requestSchema?.kind).toBe('json');
        expect(result.requestSchema?.source).toBe('jsdoc');
        const props = result.requestSchema?.schema?.properties ?? {};
        expect(Object.keys(props).sort()).toEqual(['description', 'published', 'title']);
        expect(props.title.type).toBe('string');
        expect(props.title.description).toBe('Title of the article.');
        expect(props.published.type).toBe('boolean');
        // Optional property dropped from required[].
        expect(result.requestSchema?.schema?.required ?? []).toEqual(expect.arrayContaining(['title', 'published']));
        expect(result.requestSchema?.schema?.required ?? []).not.toContain('description');
    });

    it('captures query + path params separately', () => {
        const src = [
            '/**',
            ' * @param {string} path.id       Article id.',
            ' * @param {string} query.lang    Language code.',
            ' * @param {number=} query.page   Pagination page.',
            ' */',
        ].join('\n');
        const result = parseJsdocSchema(src);
        expect(result.pathParams).toEqual([
            { name: 'id', type: 'string', required: true, description: 'Article id.' },
        ]);
        expect(result.queryParams).toEqual([
            { name: 'lang', type: 'string', required: true, description: 'Language code.' },
            { name: 'page', type: 'number', required: false, description: 'Pagination page.' },
        ]);
    });

    it('captures responses by status code', () => {
        const src = [
            '/**',
            ' * @response 201 Created — returns the article.',
            ' * @response 422 Validation error.',
            ' */',
        ].join('\n');
        const result = parseJsdocSchema(src);
        expect(result.responseSchema).toEqual([
            { status: 201, source: 'jsdoc', description: 'Created — returns the article.' },
            { status: 422, source: 'jsdoc', description: 'Validation error.' },
        ]);
    });

    it('treats `string | null` as nullable', () => {
        const src = [
            '/**',
            ' * @param {string | null} body.bio  Biography text or null.',
            ' */',
        ].join('\n');
        const result = parseJsdocSchema(src);
        const props = result.requestSchema?.schema?.properties ?? {};
        expect(props.bio.type).toBe('string');
        // `| null` flips optional → bio drops out of required[].
        expect(result.requestSchema?.schema?.required ?? []).not.toContain('bio');
    });

    it('supports the @requestBody alternative spelling', () => {
        const src = [
            '/**',
            ' * @requestBody {string} body.email   User email.',
            ' */',
        ].join('\n');
        const result = parseJsdocSchema(src);
        expect(result.requestSchema?.schema?.properties?.email?.type).toBe('string');
    });

    it('handles array suffix types', () => {
        const src = [
            '/**',
            ' * @param {string[]} body.tags   Tag list.',
            ' */',
        ].join('\n');
        const result = parseJsdocSchema(src);
        const props = result.requestSchema?.schema?.properties ?? {};
        expect(props.tags.type).toBe('array');
        expect(props.tags.items?.type).toBe('string');
    });

    // Issue #761: shorthand `@bodyparam <name> <Type>` style used by the
    // express-realworld example app and similar codebases.
    it('extracts a request body schema from @bodyparam shorthand tags', () => {
        const src = [
            '/**',
            ' * Create an user',
            ' * @auth none',
            ' * @route {POST} /users',
            ' * @bodyparam user User',
            ' * @bodyparam captcha string',
            ' * @returns user User',
            ' */',
        ].join('\n');
        const result = parseJsdocSchema(src);
        expect(result.requestSchema?.source).toBe('jsdoc');
        const props = result.requestSchema?.schema?.properties ?? {};
        expect(Object.keys(props).sort()).toEqual(['captcha', 'user']);
        // "User" is a type alias (not a primitive) — normalizeSchema lowers
        // it to type=string + description=(User) so the testing UI can
        // surface the alias name without losing the JSON type.
        expect(props.user.type).toBe('string');
        expect(props.user.description).toContain('User');
        expect(props.captcha.type).toBe('string');
    });

    it('extracts query + path params from @queryparam and @pathparam shorthand tags', () => {
        const src = [
            '/**',
            ' * @queryparam limit number',
            ' * @pathparam id number',
            ' * @routeparam slug string',
            ' */',
        ].join('\n');
        const result = parseJsdocSchema(src);
        expect(result.queryParams).toEqual([{ name: 'limit', type: 'number', required: true }]);
        // Both `@pathparam` and `@routeparam` land in the path bucket.
        expect((result.pathParams ?? []).map(p => p.name).sort()).toEqual(['id', 'slug']);
    });
});
