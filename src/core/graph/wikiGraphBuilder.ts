/**
 * wikiGraphBuilder.ts — Issue #712 wiki / knowledge-base graph.
 *
 * Composes the workspace's markdown / ADR / runbook files into a
 * single force-directed graph. Nodes are docs; edges fall into two
 * buckets:
 *   - doc→doc (`type: 'uses'`) — wikilinks + relative markdown links.
 *   - doc→code (`type: 'depends'`) — when a doc references a code path.
 *
 * Builds from a `Record<string, InfraRecord>` (wiki-doc kind) that the
 * upstream scanner produced via `parseMarkdown`. Independent from the
 * existing infra graph wiring so the wiki view can ship without
 * disturbing the L1 microservice + L2a feature pipelines.
 */

import type {
    DiagramGraph,
    GraphNode,
    GraphEdge,
    Anchor,
    InfraRecord,
} from './graphTypes';

export const WIKI_GRAPH_ID = 'wiki:workspace';

let idCounter = 0;
function nextId(prefix = 'node'): string {
    return `${prefix}_${++idCounter}`;
}
function resetIds(): void {
    idCounter = 0;
}

/**
 * Build the wiki graph from a flat list of `wiki-doc` records.
 *
 * The records carry outbound references (via the parser's
 * `dependencies` field) keyed by either the wikilink slug or a relative
 * file path resolved against the doc's location. We resolve each
 * reference back to the corresponding record id (if known) or emit it
 * as an "unresolved" placeholder node so the user can see the link
 * dangling — useful for "this ADR refers to a doc that doesn't exist
 * yet" prompts.
 */
export function buildWikiGraph(docs: readonly InfraRecord[]): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};

    // Filter to wiki-doc records only — other infra kinds don't belong here.
    const wikiDocs = docs.filter(d => d.kind === 'wiki-doc');
    if (wikiDocs.length === 0) {
        return emptyGraph();
    }

    // Build address resolution map. Each record is reachable by its
    // record id OR (a) its file path (so `[label](path.md)` matches) OR
    // (b) its slugified title (so `[[Title]]` matches).
    const idByRecord = new Map<string, GraphNode>();
    const idByPath = new Map<string, GraphNode>();
    const idBySlug = new Map<string, GraphNode>();

    for (const doc of wikiDocs) {
        const id = nextId('wiki');
        const node: GraphNode = {
            id,
            type: 'file', // re-use the existing file kind — the renderer keys off `meta.layer`
            label: doc.name,
            subtitle: `${(doc.meta?.wordCount ?? 0)} words · ${doc.filePath}`,
            anchor: doc.anchor,
            meta: {
                layer: 'wiki',
                wikiId: doc.id,
                filePath: doc.filePath,
                headings: doc.meta?.headings ?? [],
                wordCount: doc.meta?.wordCount ?? 0,
                codeRefs: doc.meta?.codeRefs ?? [],
                drillDownGraphId: `file:${doc.filePath}`,
            },
        };
        nodes.push(node);
        anchors[id] = doc.anchor;
        idByRecord.set(doc.id, node);
        idByPath.set(doc.filePath, node);
        const slug = slugify(doc.name);
        if (slug) idBySlug.set(slug, node);
    }

    // Walk outbound references and emit edges.
    for (const doc of wikiDocs) {
        const sourceNode = idByRecord.get(doc.id);
        if (!sourceNode) continue;
        for (const ref of doc.dependencies ?? []) {
            // The parser emits references as `infra:wiki-doc:<address>`
            // where address is either a slug or a path. Try both lookups.
            const address = ref.replace(/^infra:wiki-doc:/, '');
            const target = idByPath.get(address) ?? idBySlug.get(address);
            if (target) {
                edges.push({
                    id: nextId('edge'),
                    source: sourceNode.id,
                    target: target.id,
                    label: 'links',
                    edgeType: 'uses',
                });
            } else {
                // Unresolved wikilink — synthesise a tombstone node so
                // the user sees the dangling reference. Wikilink-style
                // grouping prevents the "Future Doc" from appearing 4
                // times when 4 different docs reference it.
                const placeholderId = `wiki-placeholder::${address}`;
                let placeholder = nodes.find(n => n.meta?.placeholderId === placeholderId);
                if (!placeholder) {
                    const ph: GraphNode = {
                        id: nextId('wiki'),
                        type: 'file',
                        label: humanizeAddress(address),
                        subtitle: '(referenced but not yet authored)',
                        diff: 'deleted', // visual cue: dimmed
                        meta: {
                            layer: 'wiki',
                            placeholderId,
                            address,
                            unresolved: true,
                        },
                    };
                    nodes.push(ph);
                    placeholder = ph;
                }
                edges.push({
                    id: nextId('edge'),
                    source: sourceNode.id,
                    target: placeholder.id,
                    label: 'links',
                    edgeType: 'uses',
                });
            }
        }
        // Code references → emit special edges so the UI can offer a
        // "jump to code" affordance. The target is a synthetic
        // representation; the renderer reads `meta.targetFilePath`
        // and dispatches a `requestRoute` for `file:<path>`.
        for (const codeRef of (doc.meta?.codeRefs as string[] | undefined) ?? []) {
            const codeId = `wiki-coderef::${codeRef}`;
            let codeNode = nodes.find(n => n.meta?.coderefId === codeId);
            if (!codeNode) {
                const cn: GraphNode = {
                    id: nextId('wiki'),
                    type: 'file',
                    label: codeRef,
                    subtitle: 'code reference',
                    meta: {
                        layer: 'wiki-code',
                        coderefId: codeId,
                        targetFilePath: codeRef,
                        drillDownGraphId: `file:${codeRef}`,
                    },
                };
                nodes.push(cn);
                codeNode = cn;
            }
            edges.push({
                id: nextId('edge'),
                source: sourceNode.id,
                target: codeNode.id,
                label: 'references',
                edgeType: 'depends',
            });
        }
    }

    return {
        graphId: WIKI_GRAPH_ID,
        type: 'wiki',
        nodes,
        edges,
        anchors,
        meta: {
            label: 'Knowledge Base',
            docCount: wikiDocs.length,
            placeholderCount: nodes.filter(n => n.meta?.unresolved).length,
            codeRefCount: nodes.filter(n => n.meta?.layer === 'wiki-code').length,
        },
    };
}

function emptyGraph(): DiagramGraph {
    return {
        graphId: WIKI_GRAPH_ID,
        type: 'wiki',
        nodes: [],
        edges: [],
        anchors: {},
        meta: { label: 'Knowledge Base', docCount: 0 },
    };
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
}

function humanizeAddress(address: string): string {
    // `path/to/note.md` → `note`; `slug-name` → `Slug Name`.
    if (address.endsWith('.md') || address.endsWith('.mdx') || address.endsWith('.markdown')) {
        const last = address.includes('/') ? address.slice(address.lastIndexOf('/') + 1) : address;
        return last.replace(/\.(md|mdx|markdown)$/i, '');
    }
    return address
        .split(/[\s-]+/)
        .filter(Boolean)
        .map(s => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');
}
