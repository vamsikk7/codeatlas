/**
 * tsType.test.ts — Issue #600 Phase 0 TypeScript-type inference.
 */

import { describe, it, expect } from 'vitest';
import { parseTsHandlerSchema } from '../tsType';

describe('parseTsHandlerSchema — inline body type', () => {
    it('lifts a simple `body: { … }` annotation', () => {
        const handler = '(req: { body: { title: string; tags?: string[] } }) => void';
        const result = parseTsHandlerSchema('', handler);
        expect(result.requestSchema?.kind).toBe('json');
        expect(result.requestSchema?.source).toBe('ts-type');
        const props = result.requestSchema?.schema?.properties ?? {};
        expect(props.title.type).toBe('string');
        expect(props.tags.type).toBe('array');
        expect(props.tags.items?.type).toBe('string');
        expect(result.requestSchema?.schema?.required ?? []).toContain('title');
        expect(result.requestSchema?.schema?.required ?? []).not.toContain('tags');
    });

    it('lifts a destructured request signature', () => {
        const handler = '({ body }: { body: { email: string } }) => void';
        const result = parseTsHandlerSchema('', handler);
        expect(result.requestSchema?.schema?.properties?.email?.type).toBe('string');
    });
});

describe('parseTsHandlerSchema — Express Request<…> generic', () => {
    it('extracts the third type parameter (ReqBody)', () => {
        const handler = '(req: Request<{}, never, { name: string }, {}>, res) => void';
        const result = parseTsHandlerSchema('', handler);
        expect(result.requestSchema?.schema?.properties?.name?.type).toBe('string');
    });

    it('falls through when ReqBody is `never`/`any`', () => {
        const handler = '(req: Request<{}, never, never, {}>) => void';
        const result = parseTsHandlerSchema('', handler);
        expect(result.requestSchema).toBeUndefined();
    });
});

describe('parseTsHandlerSchema — tRPC `input` form', () => {
    it('uses the `input` argument when no body container exists', () => {
        const handler = '(input: { id: string; name?: string }) => void';
        const result = parseTsHandlerSchema('', handler);
        expect(result.requestSchema?.schema?.properties?.id?.type).toBe('string');
        expect(result.requestSchema?.schema?.required).toEqual(['id']);
    });
});

describe('parseTsHandlerSchema — interface resolution', () => {
    it('resolves an interface declared in the same file', () => {
        const source = `
            interface CreateArticleInput {
                title: string;
                tags?: string[];
            }
        `;
        const handler = '(req: { body: CreateArticleInput }) => void';
        const result = parseTsHandlerSchema(source, handler);
        expect(result.requestSchema?.schema?.properties?.title?.type).toBe('string');
        expect(result.requestSchema?.schema?.properties?.tags?.type).toBe('array');
        expect(result.requestSchema?.schema?.required).toEqual(['title']);
    });

    it('falls back to a type-hint when reference is unresolved', () => {
        const handler = '(req: { body: ExternalDto }) => void';
        const result = parseTsHandlerSchema('', handler);
        expect(result.requestSchema?.schema?.type).toBe('object');
        expect(result.requestSchema?.schema?.description).toBe('type ExternalDto');
    });
});

describe('parseTsHandlerSchema — union types', () => {
    it('treats `string | null` as nullable string', () => {
        const handler = '(req: { body: { bio: string | null } }) => void';
        const result = parseTsHandlerSchema('', handler);
        const bio = result.requestSchema?.schema?.properties?.bio;
        expect(bio?.type).toBe('string');
        expect(bio?.nullable).toBe(true);
    });

    it("treats `'a' | 'b' | 'c'` as string enum", () => {
        const handler = "(req: { body: { state: 'draft' | 'published' | 'archived' } }) => void";
        const result = parseTsHandlerSchema('', handler);
        const state = result.requestSchema?.schema?.properties?.state;
        expect(state?.type).toBe('string');
        expect(state?.enum).toEqual(['draft', 'published', 'archived']);
    });
});

describe('parseTsHandlerSchema — no match', () => {
    it('returns empty for a handler with no annotated body', () => {
        expect(parseTsHandlerSchema('', '(req, res) => void')).toEqual({});
    });
});
