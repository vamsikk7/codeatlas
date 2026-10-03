/**
 * specs/__tests__/_mock.ts — Mock TSNode factory shared across spec unit tests.
 *
 * Mirrors the pattern in `treeSitterExtractor.test.ts` (the integration tests
 * already exercise the full `extractSymbols → walkNode → spec.getX` path).
 * Per-spec unit tests use the same factory to construct focused fixtures and
 * call individual spec accessors (`getImports`, `getClassHierarchy`,
 * `getFieldDependencies`, etc.) in isolation — useful for proving that an
 * edge case is handled at the spec level without round-tripping through the
 * dispatcher.
 *
 * Tree-sitter offers two ways to reach a child:
 *   - by type (`for child of node.children`)
 *   - by field name (`childForFieldName('name')`)
 * Specs use both; the mock factory supports both via the `_fieldName` shim
 * attached by `withField(...)`.
 */

import type { TSNode } from '../_shared';

export interface MockNodeOpts {
    type: string;
    text: string;
    children?: MockNodeOpts[];
    startIndex?: number;
    endIndex?: number;
    /** Field name used by tree-sitter's `childForFieldName(name)` lookup. */
    _fieldName?: string;
}

export function mockNode(opts: MockNodeOpts, parent: TSNode | null = null): TSNode {
    const children: TSNode[] = [];
    const node: TSNode & { _fieldName?: string } = {
        type: opts.type,
        text: opts.text,
        startIndex: opts.startIndex ?? 0,
        endIndex: opts.endIndex ?? opts.text.length,
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 0, column: opts.text.length },
        children,
        parent,
        previousSibling: null,
        nextSibling: null,
        _fieldName: opts._fieldName,
        childForFieldName: (name: string): TSNode | null => {
            return (children as Array<TSNode & { _fieldName?: string }>)
                .find(c => c._fieldName === name) ?? null;
        },
        descendantsOfType: (types: string | string[]): TSNode[] => {
            const typeArr = Array.isArray(types) ? types : [types];
            const result: TSNode[] = [];
            function walk(n: TSNode) {
                if (typeArr.includes(n.type)) result.push(n);
                for (const c of n.children) walk(c);
            }
            walk(node);
            return result;
        },
    };
    if (opts.children) {
        for (let i = 0; i < opts.children.length; i++) {
            const child = mockNode(opts.children[i], node) as TSNode & { previousSibling: TSNode | null; nextSibling: TSNode | null };
            if (i > 0) {
                child.previousSibling = children[i - 1];
                (children[i - 1] as TSNode & { nextSibling: TSNode | null }).nextSibling = child;
            }
            children.push(child);
        }
    }
    return node;
}

/** Attach a field name to a mock node so `childForFieldName(name)` finds it. */
export function withField(name: string, opts: MockNodeOpts): MockNodeOpts {
    return { ...opts, _fieldName: name };
}
