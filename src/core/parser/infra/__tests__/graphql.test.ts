/**
 * graphql.test.ts — Issue #705 GraphQL SDL parser.
 */

import { describe, it, expect } from 'vitest';
import { canParseGraphql, parseGraphql } from '../graphql';

describe('canParseGraphql', () => {
    it('matches SDL file extensions', () => {
        expect(canParseGraphql('schema.graphql')).toBe(true);
        expect(canParseGraphql('apps/api/Schema.gql')).toBe(true);
        expect(canParseGraphql('schema.graphqls')).toBe(true);
    });
    it('rejects other files', () => {
        expect(canParseGraphql('package.json')).toBe(false);
        expect(canParseGraphql('openapi.yaml')).toBe(false);
    });
});

describe('parseGraphql', () => {
    it('returns no records on empty source', () => {
        expect(parseGraphql('schema.graphql', '')).toEqual([]);
    });

    it('emits one record per type/input/enum block', () => {
        const src = [
            'type Article {',
            '  id: ID!',
            '  title: String!',
            '}',
            '',
            'input CreateArticleInput {',
            '  title: String!',
            '}',
            '',
            'enum ArticleState {',
            '  DRAFT',
            '  PUBLISHED',
            '}',
        ].join('\n');
        const recs = parseGraphql('schema.graphql', src);
        const names = recs.map(r => r.name).sort();
        expect(names).toEqual(['Article', 'ArticleState', 'CreateArticleInput']);
        const article = recs.find(r => r.name === 'Article')!;
        expect(article.kind).toBe('graphql-type');
        expect(article.meta?.keyword).toBe('type');
    });

    it('explodes Query fields into separate graphql-query records', () => {
        const src = [
            'type Query {',
            '  article(id: ID!): Article',
            '  articles(limit: Int = 10, tag: String): [Article!]!',
            '}',
        ].join('\n');
        const recs = parseGraphql('schema.graphql', src);
        expect(recs).toHaveLength(2);
        expect(recs.every(r => r.kind === 'graphql-query')).toBe(true);
        const article = recs.find(r => r.name === 'QUERY article')!;
        expect(article.meta?.operation).toBe('query');
        expect(article.meta?.field).toBe('article');
        expect(article.meta?.returnType).toBe('Article');
        expect(article.meta?.args).toEqual([{ name: 'id', type: 'ID!' }]);
        const articles = recs.find(r => r.name === 'QUERY articles')!;
        expect(articles.meta?.returnType).toBe('[Article!]!');
        expect(articles.meta?.args).toEqual([
            { name: 'limit', type: 'Int' },
            { name: 'tag', type: 'String' },
        ]);
    });

    it('handles Mutation + Subscription roots', () => {
        const src = [
            'type Mutation {',
            '  createArticle(input: CreateArticleInput!): Article',
            '}',
            'type Subscription {',
            '  articleCreated: Article',
            '}',
        ].join('\n');
        const recs = parseGraphql('schema.graphql', src);
        expect(recs.map(r => r.name).sort()).toEqual([
            'MUTATION createArticle',
            'SUBSCRIPTION articleCreated',
        ]);
    });

    it('strips line + block descriptions before scanning', () => {
        const src = [
            '# this comment should not affect parsing',
            '"""',
            'A block description with the word type Foo inside.',
            '"""',
            'type Real {',
            '  id: ID!',
            '}',
        ].join('\n');
        const recs = parseGraphql('s.graphql', src);
        expect(recs.map(r => r.name)).toEqual(['Real']);
    });

    it('tracks extend type Query as a separate record', () => {
        const src = [
            'type Query {',
            '  hello: String',
            '}',
            'extend type Query {',
            '  goodbye: String',
            '}',
        ].join('\n');
        const recs = parseGraphql('schema.graphql', src);
        // Both Query blocks emit fields → 2 query records (hello, goodbye).
        expect(recs.filter(r => r.kind === 'graphql-query').map(r => r.name).sort()).toEqual(['QUERY goodbye', 'QUERY hello']);
    });
});
