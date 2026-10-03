/**
 * wikiGraphBuilder.test.ts — Issue #712.
 */

import { describe, it, expect } from 'vitest';
import { buildWikiGraph, WIKI_GRAPH_ID } from '../wikiGraphBuilder';
import type { InfraRecord } from '../graphTypes';

function doc(filePath: string, name: string, overrides: Partial<InfraRecord> = {}): InfraRecord {
    return {
        id: `infra:wiki-doc:${filePath}`,
        kind: 'wiki-doc',
        name,
        filePath,
        anchor: { filePath, span: { start: 0, end: 1 } },
        meta: { wordCount: 100, headings: [] },
        ...overrides,
    };
}

describe('buildWikiGraph', () => {
    it('returns an empty graph when no wiki-doc records exist', () => {
        const g = buildWikiGraph([]);
        expect(g.graphId).toBe(WIKI_GRAPH_ID);
        expect(g.type).toBe('wiki');
        expect(g.nodes).toEqual([]);
        expect(g.meta.docCount).toBe(0);
    });

    it('emits one node per wiki doc', () => {
        const docs = [
            doc('docs/auth.md', 'Authentication'),
            doc('docs/billing.md', 'Billing'),
        ];
        const g = buildWikiGraph(docs);
        expect(g.nodes).toHaveLength(2);
        expect(g.meta.docCount).toBe(2);
    });

    it('resolves doc→doc edges by file path', () => {
        const docs = [
            doc('docs/index.md', 'Index', { dependencies: ['infra:wiki-doc:docs/auth.md'] }),
            doc('docs/auth.md', 'Authentication'),
        ];
        const g = buildWikiGraph(docs);
        expect(g.edges).toHaveLength(1);
        expect(g.edges[0].label).toBe('links');
        const sourceNode = g.nodes.find(n => n.label === 'Index')!;
        const targetNode = g.nodes.find(n => n.label === 'Authentication')!;
        expect(g.edges[0].source).toBe(sourceNode.id);
        expect(g.edges[0].target).toBe(targetNode.id);
    });

    it('resolves doc→doc edges by wikilink slug', () => {
        const docs = [
            doc('docs/index.md', 'Index', { dependencies: ['infra:wiki-doc:authentication'] }),
            doc('docs/auth.md', 'Authentication'),
        ];
        const g = buildWikiGraph(docs);
        expect(g.edges).toHaveLength(1);
    });

    it('emits a placeholder node for unresolved wikilinks', () => {
        const docs = [
            doc('docs/index.md', 'Index', { dependencies: ['infra:wiki-doc:future-doc'] }),
        ];
        const g = buildWikiGraph(docs);
        const ph = g.nodes.find(n => n.meta?.unresolved === true);
        expect(ph).toBeDefined();
        expect(ph?.label).toBe('Future Doc');
        expect(ph?.diff).toBe('deleted');
        expect(g.meta.placeholderCount).toBe(1);
    });

    it('dedup placeholders — N docs referencing same slug → one placeholder', () => {
        const docs = [
            doc('docs/a.md', 'A', { dependencies: ['infra:wiki-doc:phantom'] }),
            doc('docs/b.md', 'B', { dependencies: ['infra:wiki-doc:phantom'] }),
            doc('docs/c.md', 'C', { dependencies: ['infra:wiki-doc:phantom'] }),
        ];
        const g = buildWikiGraph(docs);
        // Three docs + one shared placeholder = 4 nodes total.
        expect(g.nodes).toHaveLength(4);
        // Three edges from each doc to the same placeholder.
        const placeholder = g.nodes.find(n => n.meta?.unresolved === true)!;
        const edgesToPlaceholder = g.edges.filter(e => e.target === placeholder.id);
        expect(edgesToPlaceholder).toHaveLength(3);
    });

    it('emits code-ref nodes + edges from meta.codeRefs', () => {
        const docs = [
            doc('docs/x.md', 'X', { meta: { wordCount: 10, codeRefs: ['src/auth/login.ts'] } }),
        ];
        const g = buildWikiGraph(docs);
        const codeNode = g.nodes.find(n => n.meta?.layer === 'wiki-code');
        expect(codeNode).toBeDefined();
        expect(codeNode?.label).toBe('src/auth/login.ts');
        expect(codeNode?.meta?.drillDownGraphId).toBe('file:src/auth/login.ts');
        const e = g.edges.find(ed => ed.target === codeNode!.id);
        expect(e?.label).toBe('references');
        expect(g.meta.codeRefCount).toBe(1);
    });

    it('drills down to the file graph for normal wiki docs', () => {
        const docs = [doc('docs/auth.md', 'Authentication')];
        const g = buildWikiGraph(docs);
        expect(g.nodes[0].meta?.drillDownGraphId).toBe('file:docs/auth.md');
    });

    it('skips records whose kind is not wiki-doc', () => {
        const records: InfraRecord[] = [
            doc('docs/a.md', 'A'),
            {
                id: 'infra:terraform-resource:main.tf::aws_lambda.x',
                kind: 'terraform-resource',
                name: 'aws_lambda.x',
                filePath: 'main.tf',
                anchor: { filePath: 'main.tf', span: { start: 0, end: 1 } },
            },
        ];
        const g = buildWikiGraph(records);
        expect(g.nodes).toHaveLength(1);
    });
});
