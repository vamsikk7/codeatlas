import { parseJSAuto } from '../parser/jsParser';
import { srcText, normalizeSpace } from '../parser/symbolExtractor';
import type { DiagramGraph, GraphNode, GraphEdge, Anchor, DiffStatus } from './graphTypes';
import _traverse from '@babel/traverse';

const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

let idCounter = 0;
function nextId(prefix: string = 'node'): string {
    return `${prefix}_${++idCounter}`;
}
function resetIds(): void {
    idCounter = 0;
}

/**
 * Get a readable label for a statement AST node
 */
function readableNodeText(stmt: any, source: string): string {
    const raw = normalizeSpace(srcText(stmt, source));

    switch (stmt.type) {
        case 'VariableDeclaration':
        case 'ExpressionStatement':
        case 'ReturnStatement':
        case 'ThrowStatement':
        case 'BreakStatement':
        case 'ContinueStatement':
            return raw || stmt.type;
        case 'IfStatement':
            return `is ${normalizeSpace(srcText(stmt.test, source)) || 'condition'}?`;
        case 'ForStatement':
            return `for (${normalizeSpace(srcText(stmt.init, source) || '')}; ${normalizeSpace(srcText(stmt.test, source) || '')}; ${normalizeSpace(srcText(stmt.update, source) || '')})`;
        case 'WhileStatement':
            return `while (${normalizeSpace(srcText(stmt.test, source)) || 'condition'})`;
        case 'ForOfStatement':
        case 'ForInStatement':
            return normalizeSpace(srcText(stmt, source).split('{')[0]) || stmt.type;
        case 'TryStatement':
            return 'try';
        case 'SwitchStatement':
            return `switch (${normalizeSpace(srcText(stmt.discriminant, source))})`;
        default:
            return raw || stmt.type;
    }
}

/**
 * Generate a stable key for a statement, used for diffing
 */
function statementKey(stmt: any, source: string): string {
    const text = readableNodeText(stmt, source)
        .replace(/;$/, '')
        .replace(/\b\d+(\.\d+)?\b/g, '#')
        .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"STR"');
    return `${stmt.type}:${text}`;
}

/**
 * Issue 209: detect whether a statement's top-level expression(s) contain a
 * YieldExpression so the renderer can mark generator-yield points distinctly.
 * Returns the kind of yield encountered ('delegate' for `yield*`, 'value' for
 * `yield expr`, undefined if no yield is present at a meaningful depth).
 *
 * Search depth is intentionally shallow — we only flag top-level statement
 * yields (`yield x;`, `const y = yield z;`, `return yield foo();`). Yields
 * buried inside nested arrow functions or lambdas belong to a different
 * function and are intentionally skipped.
 */
function detectTopLevelYield(stmt: any): 'delegate' | 'value' | undefined {
    if (!stmt) return undefined;
    const visit = (node: any): 'delegate' | 'value' | undefined => {
        if (!node || typeof node !== 'object') return undefined;
        if (node.type === 'YieldExpression') {
            return node.delegate ? 'delegate' : 'value';
        }
        // Don't cross function boundaries — yields inside nested functions belong
        // to that function's flow graph, not this one.
        if (
            node.type === 'FunctionDeclaration' ||
            node.type === 'FunctionExpression' ||
            node.type === 'ArrowFunctionExpression' ||
            node.type === 'ClassMethod' ||
            node.type === 'ObjectMethod'
        ) {
            return undefined;
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'range' || key === 'start' || key === 'end' || key === 'type') continue;
            const child = (node as any)[key];
            if (Array.isArray(child)) {
                for (const c of child) {
                    const r = visit(c);
                    if (r) return r;
                }
            } else if (child && typeof child === 'object') {
                const r = visit(child);
                if (r) return r;
            }
        }
        return undefined;
    };
    return visit(stmt);
}

/**
 * Extract the first function from code (for flowchart generation).
 * Handles: FunctionDeclaration, VariableDeclarator with arrow/function expression,
 * and bare ArrowFunctionExpression / FunctionExpression (from sliced code).
 */
function parseFirstFunction(code: string, filePath?: string): { fn: any; bodyStatements: any[] } {
    const ast = parseJSAuto(code, filePath);
    let targetFn: any = null;

    traverse(ast, {
        FunctionDeclaration(path: any) {
            if (!targetFn) targetFn = path.node;
        },
        VariableDeclarator(path: any) {
            if (targetFn) return;
            const init = path.node.init;
            if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
                targetFn = { ...init, id: path.node.id };
            }
        },
        ArrowFunctionExpression(path: any) {
            if (targetFn) return;
            // Match top-level arrow expressions (ExpressionStatement or
            // Program body) AND member-assignment handlers like
            // `module.exports.create = (…) => {…}` / `exports.handler = …`,
            // where the arrow's parent is an AssignmentExpression (#837 —
            // without this the diff map silently returned null and every
            // flow node stamped `unchanged` for the whole handler form).
            const parent = path.parent;
            if (
                parent.type === 'ExpressionStatement' ||
                parent.type === 'Program' ||
                (parent.type === 'AssignmentExpression' && parent.right === path.node)
            ) {
                targetFn = path.node;
            }
        },
        FunctionExpression(path: any) {
            if (targetFn) return;
            const parent = path.parent;
            if (
                parent.type === 'ExpressionStatement' ||
                parent.type === 'Program' ||
                (parent.type === 'AssignmentExpression' && parent.right === path.node)
            ) {
                targetFn = path.node;
            }
        },
    });

    if (!targetFn) {
        throw new Error('No JavaScript function found.');
    }

    const bodyStatements =
        targetFn.body.type === 'BlockStatement'
            ? targetFn.body.body
            : [
                {
                    type: 'ReturnStatement',
                    argument: targetFn.body,
                    start: targetFn.body.start,
                    end: targetFn.body.end,
                },
            ];

    return { fn: targetFn, bodyStatements };
}

interface FlowBuildResult {
    entryId: string | null;
    exits: Array<{ id: string; label?: string }>;
    terminals: string[];
}

/**
 * Build diff map between old and new function code
 */
function buildDiffMap(oldCode: string, newCode: string): {
    exactAddedToDeleted: Map<string, string>;
    addedExactSet: Set<string>;
} | null {
    try {
        const oldFn = parseFirstFunction(oldCode);
        const newFn = parseFirstFunction(newCode);

        const flattenStatements = (statements: any[], out: any[] = []): any[] => {
            for (const stmt of statements) {
                if (!stmt) continue;
                out.push(stmt);
                if (stmt.type === 'BlockStatement') flattenStatements(stmt.body, out);
                else if (stmt.type === 'IfStatement') {
                    flattenStatements([stmt.consequent], out);
                    if (stmt.alternate) flattenStatements([stmt.alternate], out);
                } else if (stmt.type === 'ForStatement' || stmt.type === 'WhileStatement') {
                    flattenStatements([stmt.body], out);
                } else if (stmt.type === 'TryStatement') {
                    // Flatten try block, catch handler, and finally block
                    if (stmt.block?.body) flattenStatements(stmt.block.body, out);
                    if (stmt.handler?.body?.body) flattenStatements(stmt.handler.body.body, out);
                    if (stmt.finalizer?.body) flattenStatements(stmt.finalizer.body, out);
                }
            }
            return out;
        };

        const oldFlat = flattenStatements(oldFn.bodyStatements).filter((s: any) => s.type !== 'BlockStatement');
        const newFlat = flattenStatements(newFn.bodyStatements).filter((s: any) => s.type !== 'BlockStatement');

        const oldTexts = oldFlat.map((s: any) => readableNodeText(s, oldCode)).filter(Boolean);
        const newTexts = newFlat.map((s: any) => readableNodeText(s, newCode)).filter(Boolean);

        const oldSet = new Set(oldTexts);
        const newSet = new Set(newTexts);

        const keyToDeleted = new Map<string, string[]>();
        oldFlat.forEach((stmt: any) => {
            const txt = readableNodeText(stmt, oldCode);
            if (!txt || newSet.has(txt)) return;
            const key = statementKey(stmt, oldCode);
            if (!keyToDeleted.has(key)) keyToDeleted.set(key, []);
            keyToDeleted.get(key)!.push(txt);
        });

        const exactAddedToDeleted = new Map<string, string>();
        newFlat.forEach((stmt: any) => {
            const addedText = readableNodeText(stmt, newCode);
            if (!addedText || oldSet.has(addedText)) return;
            const key = statementKey(stmt, newCode);
            const deletedBucket = keyToDeleted.get(key);
            if (deletedBucket && deletedBucket.length) {
                const deleted = deletedBucket.shift()!;
                exactAddedToDeleted.set(addedText, deleted);
            }
        });

        const addedExactSet = new Set(
            newFlat
                .map((s: any) => readableNodeText(s, newCode))
                .filter((txt: string) => txt && !oldSet.has(txt) && !exactAddedToDeleted.has(txt))
        );

        return { exactAddedToDeleted, addedExactSet };
    } catch {
        return null;
    }
}

/**
 * Get diff detail for a statement
 */
function diffLabelForStatement(
    stmt: any,
    source: string,
    diffMap: { exactAddedToDeleted: Map<string, string>; addedExactSet: Set<string> } | null
): { deleted?: string; added?: string } | null {
    if (!diffMap) return null;
    const exact = readableNodeText(stmt, source);
    if (!exact) return null;

    if (diffMap.exactAddedToDeleted.has(exact)) {
        return { deleted: diffMap.exactAddedToDeleted.get(exact)!, added: exact };
    }
    if (diffMap.addedExactSet.has(exact)) {
        return { added: exact };
    }
    return null;
}

function getDiffStatusFromDetail(detail: { deleted?: string; added?: string } | null): DiffStatus {
    if (!detail) return 'unchanged';
    if (detail.added && detail.deleted) return 'modified';
    if (detail.added) return 'added';
    return 'deleted';
}

/**
 * Recursively build flow nodes/edges from a statement
 */
function buildStatement(
    stmt: any,
    source: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
    diffMap: ReturnType<typeof buildDiffMap>,
    filePath: string,
): FlowBuildResult {
    if (!stmt) return { entryId: null, exits: [], terminals: [] };

    if (stmt.type === 'BlockStatement') {
        return buildBlock(stmt.body, source, nodes, edges, diffMap, filePath);
    }

    if (stmt.type === 'IfStatement') {
        const label = readableNodeText(stmt, source);
        const diffDetail = diffLabelForStatement(stmt, source, diffMap);
        const diffStatus = getDiffStatusFromDetail(diffDetail);
        const decisionNode: GraphNode = {
            id: nextId('decision'),
            type: 'decision',
            label,
            diff: diffStatus,
            diffDetail: diffDetail ?? undefined,
            anchor: { filePath, span: { start: stmt.start ?? 0, end: stmt.end ?? 0 } },
        };
        nodes.push(decisionNode);

        const cons = buildStatement(stmt.consequent, source, nodes, edges, diffMap, filePath);
        if (cons.entryId) {
            edges.push({ id: nextId('edge'), source: decisionNode.id, target: cons.entryId, label: 'Yes', edgeType: 'flow', diff: 'unchanged' });
        }

        let alt: FlowBuildResult | null = null;
        if (stmt.alternate) {
            alt = buildStatement(stmt.alternate, source, nodes, edges, diffMap, filePath);
            if (alt.entryId) {
                edges.push({ id: nextId('edge'), source: decisionNode.id, target: alt.entryId, label: 'No', edgeType: 'flow', diff: 'unchanged' });
            }
        }

        const exits: Array<{ id: string; label?: string }> = [];
        const terminals = [...cons.terminals];
        cons.exits.forEach((e) => exits.push(e));

        if (alt) {
            alt.exits.forEach((e) => exits.push(e));
            terminals.push(...alt.terminals);
        } else {
            exits.push({ id: decisionNode.id, label: 'No' });
        }

        return { entryId: decisionNode.id, exits, terminals };
    }

    if (stmt.type === 'ForStatement' || stmt.type === 'WhileStatement' || stmt.type === 'ForOfStatement' || stmt.type === 'ForInStatement') {
        const label = readableNodeText(stmt, source);
        const diffDetail = diffLabelForStatement(stmt, source, diffMap);
        const diffStatus = getDiffStatusFromDetail(diffDetail);
        const loopNode: GraphNode = {
            id: nextId('loop'),
            type: 'loop',
            label,
            diff: diffStatus,
            diffDetail: diffDetail ?? undefined,
            anchor: { filePath, span: { start: stmt.start ?? 0, end: stmt.end ?? 0 } },
        };
        nodes.push(loopNode);

        const bodyBuilt = buildStatement(stmt.body, source, nodes, edges, diffMap, filePath);
        if (bodyBuilt.entryId) {
            edges.push({ id: nextId('edge'), source: loopNode.id, target: bodyBuilt.entryId, label: 'Yes', edgeType: 'flow', diff: 'unchanged' });
        }
        bodyBuilt.exits.forEach((ex) => {
            edges.push({ id: nextId('edge'), source: ex.id, target: loopNode.id, edgeType: 'flow', diff: 'unchanged', meta: { loopBack: true } });
        });

        return {
            entryId: loopNode.id,
            exits: [{ id: loopNode.id, label: 'No' }],
            terminals: [...bodyBuilt.terminals],
        };
    }

    if (stmt.type === 'TryStatement') {
        const label = readableNodeText(stmt, source);
        const diffDetail = diffLabelForStatement(stmt, source, diffMap);
        const diffStatus = getDiffStatusFromDetail(diffDetail);
        const decisionNode: GraphNode = {
            id: nextId('decision'),
            type: 'decision',
            label,
            diff: diffStatus,
            diffDetail: diffDetail ?? undefined,
            anchor: { filePath, span: { start: stmt.start ?? 0, end: stmt.end ?? 0 } },
        };
        nodes.push(decisionNode);

        const tryBuilt = buildBlock(stmt.block.body, source, nodes, edges, diffMap, filePath);
        if (tryBuilt.entryId) {
            edges.push({ id: nextId('edge'), source: decisionNode.id, target: tryBuilt.entryId, label: 'Try', edgeType: 'flow', diff: 'unchanged' });
        }

        let catchBuilt: FlowBuildResult | null = null;
        if (stmt.handler?.body) {
            catchBuilt = buildBlock(stmt.handler.body.body, source, nodes, edges, diffMap, filePath);
            if (catchBuilt.entryId) {
                edges.push({ id: nextId('edge'), source: decisionNode.id, target: catchBuilt.entryId, label: 'Catch', edgeType: 'flow', diff: 'unchanged' });
            }
        }

        const preFinally: Array<{ id: string; label?: string }> = [];
        const terminals = [...tryBuilt.terminals];

        if (tryBuilt.entryId) {
            tryBuilt.exits.forEach((e) => preFinally.push(e));
        } else {
            preFinally.push({ id: decisionNode.id, label: 'Try' });
        }

        if (catchBuilt) {
            if (catchBuilt.entryId) {
                catchBuilt.exits.forEach((e) => preFinally.push(e));
            } else {
                preFinally.push({ id: decisionNode.id, label: 'Catch' });
            }
            terminals.push(...catchBuilt.terminals);
        } else {
            preFinally.push({ id: decisionNode.id, label: 'Catch' });
        }

        // Finally block — all try/catch exits flow through it
        if (stmt.finalizer?.body) {
            const finallyBuilt = buildBlock(stmt.finalizer.body, source, nodes, edges, diffMap, filePath);
            if (finallyBuilt.entryId) {
                for (const ex of preFinally) {
                    edges.push({ id: nextId('edge'), source: ex.id, target: finallyBuilt.entryId, label: 'Finally', edgeType: 'flow', diff: 'unchanged' });
                }
                return { entryId: decisionNode.id, exits: finallyBuilt.exits, terminals: [...terminals, ...finallyBuilt.terminals] };
            }
        }

        return { entryId: decisionNode.id, exits: preFinally, terminals };
    }

    // Issue 197: Switch statement — render as decision node with case branches
    if (stmt.type === 'SwitchStatement') {
        const switchLabel = readableNodeText(stmt, source);
        const switchDiffDetail = diffLabelForStatement(stmt, source, diffMap);
        const switchDiff = getDiffStatusFromDetail(switchDiffDetail);
        const switchNode: GraphNode = {
            id: nextId('decision'),
            type: 'decision',
            label: switchLabel,
            diff: switchDiff,
            diffDetail: switchDiffDetail || undefined,
            anchor: { filePath, span: { start: stmt.start ?? 0, end: stmt.end ?? 0 } },
        };
        nodes.push(switchNode);

        const caseExits: Array<{ id: string; label?: string }> = [];
        const caseTerminals: string[] = [];
        const cases = (stmt as any).cases ?? [];
        for (const sc of cases) {
            const caseLabel = sc.test ? normalizeSpace(srcText(sc.test, source)).slice(0, 40) : 'default';
            const caseBlock = buildBlock(sc.consequent ?? [], source, nodes, edges, diffMap, filePath);
            if (caseBlock.entryId) {
                edges.push({
                    id: nextId('edge'), source: switchNode.id, target: caseBlock.entryId,
                    label: caseLabel, edgeType: 'flow', diff: switchDiff,
                });
                caseExits.push(...caseBlock.exits);
                caseTerminals.push(...caseBlock.terminals);
            } else {
                caseExits.push({ id: switchNode.id, label: caseLabel });
            }
        }
        if (cases.length === 0) caseExits.push({ id: switchNode.id });
        return { entryId: switchNode.id, exits: caseExits.length ? caseExits : [{ id: switchNode.id }], terminals: caseTerminals };
    }

    // Regular statements
    const label = readableNodeText(stmt, source);
    const diffDetail = diffLabelForStatement(stmt, source, diffMap);
    const diffStatus = getDiffStatusFromDetail(diffDetail);
    const nodeType = stmt.type === 'ReturnStatement' || stmt.type === 'ThrowStatement' ? 'return' : 'statement';

    const actionNode: GraphNode = {
        id: nextId('stmt'),
        type: nodeType,
        label,
        diff: diffStatus,
        diffDetail: diffDetail || undefined,
        anchor: { filePath, span: { start: stmt.start ?? 0, end: stmt.end ?? 0 } },
    };

    // Issue 209: tag statements that yield inside a generator function so the
    // renderer can mark them with a generator badge. We don't change the node
    // *type* here because the diff/key/consolidation passes downstream key off
    // 'statement' vs 'decision'/'loop' — meta is the safe channel.
    const yieldKind = detectTopLevelYield(stmt);
    if (yieldKind) {
        actionNode.meta = { ...(actionNode.meta ?? {}), yields: true, yieldKind };
    }

    nodes.push(actionNode);

    if (stmt.type === 'ReturnStatement' || stmt.type === 'ThrowStatement') {
        return { entryId: actionNode.id, exits: [], terminals: [actionNode.id] };
    }

    return { entryId: actionNode.id, exits: [{ id: actionNode.id }], terminals: [] };
}

/**
 * Build flow nodes/edges from a block of statements
 */
function buildBlock(
    statements: any[],
    source: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
    diffMap: ReturnType<typeof buildDiffMap>,
    filePath: string,
): FlowBuildResult {
    let entryId: string | null = null;
    let openExits: Array<{ id: string; label?: string }> = [];
    let terminals: string[] = [];

    for (const stmt of statements) {
        const built = buildStatement(stmt, source, nodes, edges, diffMap, filePath);
        if (!built.entryId) continue;

        if (!entryId) entryId = built.entryId;

        openExits.forEach((ex) => {
            // Issue 200: Derive edge diff from connected nodes instead of hardcoding 'unchanged'
            const srcNode = nodes.find(n => n.id === ex.id);
            const tgtNode = nodes.find(n => n.id === built.entryId);
            const eDiff = (srcNode?.diff && srcNode.diff !== 'unchanged') || (tgtNode?.diff && tgtNode.diff !== 'unchanged')
                ? 'modified' : 'unchanged';
            edges.push({ id: nextId('edge'), source: ex.id, target: built.entryId!, label: ex.label, edgeType: 'flow', diff: eDiff });
        });

        openExits = built.exits;
        terminals = terminals.concat(built.terminals);
    }

    return { entryId, exits: openExits, terminals };
}

/**
 * Append ghost nodes/edges for statements that existed in oldCode but are absent from the
 * already-built new graph. Ghost nodes carry diff:'deleted' so the webview renders them red.
 *
 * Strategy:
 *  1. Parse oldCode and build its body graph into separate arrays (IDs are fresh/distinct
 *     because the global counter was NOT reset between the two builds).
 *  2. Map old node IDs → effective IDs: surviving nodes get remapped to their new-graph
 *     counterpart (same label); deleted nodes keep their own IDs.
 *  3. Push deleted nodes (diff:'deleted') into the main nodes array.
 *  4. Push edges that touch at least one deleted endpoint into main edges array (diff:'deleted').
 *  5. Connect the deleted entry to startNode and deleted terminals/exits to endNode.
 */
function appendDeletedNodes(
    oldCode: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
    anchors: Record<string, Anchor>,
    startNodeId: string,
    endNodeId: string,
    filePath: string
): void {
    let oldFn: ReturnType<typeof parseFirstFunction>;
    try {
        oldFn = parseFirstFunction(oldCode, filePath);
    } catch {
        return;
    }

    const oldNodes: GraphNode[] = [];
    const oldEdges: GraphEdge[] = [];

    // Build old graph body — counter continues from where new graph left off, so IDs are unique
    const oldBuilt = buildBlock(oldFn.bodyStatements, oldCode, oldNodes, oldEdges, null, filePath);

    if (oldNodes.length === 0) return;

    // Build label → new node ID map for surviving nodes (skip terminal Start/End nodes)
    const newLabelToId = new Map<string, string>();
    for (const node of nodes) {
        if (node.type !== 'terminal' && node.label) {
            newLabelToId.set(node.label, node.id);
        }
    }

    // Classify old nodes: deleted (not in new graph) vs surviving
    const deletedOldIds = new Set<string>();
    for (const oldNode of oldNodes) {
        if (!newLabelToId.has(oldNode.label)) {
            deletedOldIds.add(oldNode.id);
        }
    }

    if (deletedOldIds.size === 0) return;

    // Build remapping: old node ID → effective ID in the merged graph
    const oldIdToEffective = new Map<string, string>();
    for (const oldNode of oldNodes) {
        if (!deletedOldIds.has(oldNode.id)) {
            oldIdToEffective.set(oldNode.id, newLabelToId.get(oldNode.label)!);
        } else {
            oldIdToEffective.set(oldNode.id, oldNode.id); // keep deleted node's own ID
        }
    }

    // Add deleted nodes with diff:'deleted' to main array
    for (const oldNode of oldNodes) {
        if (deletedOldIds.has(oldNode.id)) {
            nodes.push({ ...oldNode, diff: 'deleted' });
            if (oldNode.anchor) anchors[oldNode.id] = oldNode.anchor;
        }
    }

    // Add edges involving at least one deleted endpoint (remapped to effective IDs)
    for (const oldEdge of oldEdges) {
        const srcEff = oldIdToEffective.get(oldEdge.source) ?? oldEdge.source;
        const tgtEff = oldIdToEffective.get(oldEdge.target) ?? oldEdge.target;
        if (deletedOldIds.has(oldEdge.source) || deletedOldIds.has(oldEdge.target)) {
            edges.push({ ...oldEdge, id: nextId('edge'), source: srcEff, target: tgtEff, diff: 'deleted' });
        }
    }

    // Wire deleted entry to startNode
    if (oldBuilt.entryId && deletedOldIds.has(oldBuilt.entryId)) {
        edges.push({ id: nextId('edge'), source: startNodeId, target: oldBuilt.entryId, edgeType: 'flow', diff: 'deleted' });
    }

    // Wire deleted terminals to endNode
    for (const termId of oldBuilt.terminals) {
        if (deletedOldIds.has(termId)) {
            edges.push({ id: nextId('edge'), source: termId, target: endNodeId, edgeType: 'flow', diff: 'deleted' });
        }
    }

    // Wire deleted exits to endNode
    for (const ex of oldBuilt.exits) {
        if (deletedOldIds.has(ex.id)) {
            edges.push({ id: nextId('edge'), source: ex.id, target: endNodeId, label: ex.label, edgeType: 'flow', diff: 'deleted' });
        }
    }
}

// ─── Tree-sitter Flow Graph Builder ─────────────────────────────────────────

/**
 * Node types that represent block containers across languages.
 */
// Block-container node types across languages.
// Kotlin nests `statements` inside `function_body` / `lambda_literal`;
// Ruby uses `body_statement` inside method/begin/if/etc;
// Rust async/loop bodies wrap an inner `block`.
const TS_BLOCK_TYPES = new Set([
    'block', 'statement_block', 'compound_statement', 'suite', 'function_body',
    'statements', 'body_statement',
]);

/**
 * Node types to skip when walking a block's children.
 */
const TS_SKIP_TYPES = new Set([
    '{', '}', '(', ')', ';', ',', 'else', ':',
    'line_comment', 'block_comment', 'comment',
    'import_declaration', 'field_declaration',
    'import_statement', 'import_from_statement',
    'annotation', 'marker_annotation',
]);

function tsTruncate(s: string, max: number = 80): string {
    const n = s.replace(/\s+/g, ' ').trim();
    return n.length > max ? n.slice(0, max - 3) + '...' : n;
}

function readableTSLabel(node: any, source: string): string {
    const text = source.slice(node.startIndex, node.endIndex);
    const type = node.type;

    if (type === 'if_statement' || type === 'if_expression' || type === 'if') {
        const condNode = node.childForFieldName?.('condition')
            ?? node.children?.find((c: any) => c.type === 'parenthesized_expression');
        const cond = condNode ? source.slice(condNode.startIndex, condNode.endIndex) : 'condition';
        return tsTruncate(`is ${cond}?`);
    }
    if (type === 'for_statement' || type === 'enhanced_for_statement' || type === 'foreach_statement') {
        if (text.includes('{')) {
            // Java/C-style: use header before brace
            return tsTruncate(text.split('{')[0]);
        }
        // Python/Go-style: no braces — extract loop header via field nodes
        const left = node.childForFieldName?.('left');
        const right = node.childForFieldName?.('right');
        if (left && right) {
            return tsTruncate(`for ${source.slice(left.startIndex, left.endIndex)} in ${source.slice(right.startIndex, right.endIndex)}`);
        }
        // Fallback: first line only (strip trailing colon)
        return tsTruncate(text.split('\n')[0].replace(/:$/, '').trim());
    }
    if (
        type === 'while_statement' || type === 'do_statement' || type === 'do_while_statement' ||
        type === 'while_expression' || type === 'loop_expression' || type === 'for_expression'
    ) {
        const condNode = node.childForFieldName?.('condition')
            ?? node.children?.find((c: any) => c.type === 'parenthesized_expression');
        const cond = condNode ? source.slice(condNode.startIndex, condNode.endIndex) : 'condition';
        const kw =
            type === 'loop_expression' ? 'loop' :
            type === 'for_expression' ? 'for' :
            type.startsWith('do') ? 'do...while' : 'while';
        return tsTruncate(`${kw} ${cond}`);
    }
    if (type === 'try_statement') return 'try';
    if (type === 'switch_statement' || type === 'switch_expression' || type === 'match_expression' || type === 'when_expression') {
        // Tree-sitter exposes the matched value on different field names per
        // language — `condition` (Java/Go switch), `value` (Rust
        // match_expression, Kotlin when), or as the first non-keyword
        // sibling. Without the value text, we fall back to the literal
        // string `value`, which yields the synthetic label `switch value`
        // — that string never appears in source, so the diff-pass marks
        // the node as `added` on every rebuild and propagates as `modified`
        // through the consolidation pass (#issue-rocket-client residual,
        // tracked under #439 follow-up).
        const condNode = node.childForFieldName?.('condition')
            ?? node.childForFieldName?.('value')
            ?? node.childForFieldName?.('subject')
            ?? node.children?.find((c: any) => c.type === 'parenthesized_expression');
        const cond = condNode ? source.slice(condNode.startIndex, condNode.endIndex) : 'value';
        return tsTruncate(`switch ${cond}`);
    }
    return tsTruncate(text);
}

function buildTSStatement(
    node: any,
    source: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
    filePath: string,
): FlowBuildResult {
    if (!node) return { entryId: null, exits: [], terminals: [] };
    const type = node.type;
    if (TS_SKIP_TYPES.has(type) || (type.length === 1 && !node.childCount)) {
        return { entryId: null, exits: [], terminals: [] };
    }

    if (TS_BLOCK_TYPES.has(type)) {
        return buildTSBlock(node.children, source, nodes, edges, filePath);
    }

    // Unwrap expression-statement / property_declaration / property_definition
    // wrappers so control-flow nodes inside them are visible to the if/loop/
    // switch handlers below. Without this, Rust expression_statement → if_expression,
    // Java property_declaration → method_invocation, etc., all collapse into
    // single text-truncated nodes.
    const CONTROL_FLOW_WRAPPER_TYPES = new Set([
        'expression_statement', 'expression_expression',
        // Some Kotlin / Java statement wrappers
        'simple_statement', 'statement',
    ]);
    if (CONTROL_FLOW_WRAPPER_TYPES.has(type) && node.childCount > 0) {
        const inner = node.children?.find((c: any) => !TS_SKIP_TYPES.has(c.type) && c.type.length > 1);
        if (inner) {
            const innerType: string = inner.type;
            // Only unwrap when the inner node is a recognized control-flow shape;
            // otherwise the parent statement is the right granularity.
            if (
                innerType === 'if_statement' || innerType === 'if_expression' || innerType === 'if' ||
                innerType === 'match_expression' || innerType === 'switch_expression' || innerType === 'switch_statement' ||
                innerType === 'for_statement' || innerType === 'for_expression' || innerType === 'while_statement' ||
                innerType === 'while_expression' || innerType === 'loop_expression' ||
                innerType === 'try_statement' || innerType === 'try_expression' ||
                innerType === 'return_statement' || innerType === 'return_expression' ||
                innerType === 'when_expression' /* Kotlin */
            ) {
                return buildTSStatement(inner, source, nodes, edges, filePath);
            }
        }
    }

    if (type === 'if_statement' || type === 'if_expression' || type === 'if') {
        const label = readableTSLabel(node, source);
        const decisionNode: GraphNode = {
            id: nextId('decision'), type: 'decision', label, diff: 'unchanged',
            anchor: { filePath, span: { start: node.startIndex, end: node.endIndex } },
        };
        nodes.push(decisionNode);

        const consequenceNode = node.childForFieldName?.('consequence')
            ?? node.children?.find((c: any) => TS_BLOCK_TYPES.has(c.type));

        // Java/Go: 'alternative' field; Python: else_clause/elif_clause child
        let alternativeNode = node.childForFieldName?.('alternative');
        if (!alternativeNode) {
            const elseClause = node.children?.find((c: any) =>
                c.type === 'else_clause' || c.type === 'elif_clause');
            if (elseClause) {
                alternativeNode = elseClause.childForFieldName?.('body')
                    ?? elseClause.children?.find((c: any) =>
                        TS_BLOCK_TYPES.has(c.type) || c.type === 'if_statement');
            }
        }

        const cons = consequenceNode
            ? buildTSStatement(consequenceNode, source, nodes, edges, filePath)
            : { entryId: null, exits: [], terminals: [] };
        if (cons.entryId) {
            edges.push({ id: nextId('edge'), source: decisionNode.id, target: cons.entryId, label: 'Yes', edgeType: 'flow', diff: 'unchanged' });
        }

        let alt: FlowBuildResult | null = null;
        if (alternativeNode) {
            alt = buildTSStatement(alternativeNode, source, nodes, edges, filePath);
            if (alt.entryId) {
                edges.push({ id: nextId('edge'), source: decisionNode.id, target: alt.entryId, label: 'No', edgeType: 'flow', diff: 'unchanged' });
            }
        }

        const exits: Array<{ id: string; label?: string }> = [];
        const terminals = [...cons.terminals];
        cons.exits.forEach(e => exits.push(e));
        if (alt) {
            alt.exits.forEach(e => exits.push(e));
            terminals.push(...alt.terminals);
        } else {
            exits.push({ id: decisionNode.id, label: 'No' });
        }
        return { entryId: decisionNode.id, exits, terminals };
    }

    if (type === 'for_statement' || type === 'enhanced_for_statement' ||
        type === 'foreach_statement' || type === 'while_statement' ||
        type === 'for_in_statement' || type === 'for_range_loop' ||
        type === 'for_expression' || type === 'while_expression' ||
        type === 'loop_expression') {
        const label = readableTSLabel(node, source);
        const loopNode: GraphNode = {
            id: nextId('loop'), type: 'loop', label, diff: 'unchanged',
            anchor: { filePath, span: { start: node.startIndex, end: node.endIndex } },
        };
        nodes.push(loopNode);

        const body = node.childForFieldName?.('body')
            ?? node.children?.findLast?.((c: any) => TS_BLOCK_TYPES.has(c.type))
            ?? node.children?.find((c: any) => TS_BLOCK_TYPES.has(c.type));
        const bodyBuilt = body
            ? buildTSStatement(body, source, nodes, edges, filePath)
            : { entryId: null, exits: [], terminals: [] };
        if (bodyBuilt.entryId) {
            edges.push({ id: nextId('edge'), source: loopNode.id, target: bodyBuilt.entryId, label: 'Yes', edgeType: 'flow', diff: 'unchanged' });
        }
        bodyBuilt.exits.forEach(ex => {
            edges.push({ id: nextId('edge'), source: ex.id, target: loopNode.id, edgeType: 'flow', diff: 'unchanged' });
        });
        return { entryId: loopNode.id, exits: [{ id: loopNode.id, label: 'No' }], terminals: [...bodyBuilt.terminals] };
    }

    if (type === 'do_statement' || type === 'do_while_statement') {
        const label = readableTSLabel(node, source);
        const loopNode: GraphNode = {
            id: nextId('loop'), type: 'loop', label, diff: 'unchanged',
            anchor: { filePath, span: { start: node.startIndex, end: node.endIndex } },
        };
        nodes.push(loopNode);
        const body = node.children?.find((c: any) => TS_BLOCK_TYPES.has(c.type));
        const bodyBuilt = body
            ? buildTSBlock(body.children, source, nodes, edges, filePath)
            : { entryId: null, exits: [], terminals: [] };
        if (bodyBuilt.entryId) {
            edges.push({ id: nextId('edge'), source: loopNode.id, target: bodyBuilt.entryId, label: 'loop body', edgeType: 'flow', diff: 'unchanged' });
        }
        bodyBuilt.exits.forEach(ex => {
            edges.push({ id: nextId('edge'), source: ex.id, target: loopNode.id, edgeType: 'flow', diff: 'unchanged' });
        });
        return { entryId: loopNode.id, exits: [{ id: loopNode.id, label: 'No' }], terminals: [...bodyBuilt.terminals] };
    }

    if (type === 'try_statement') {
        const decisionNode: GraphNode = {
            id: nextId('decision'), type: 'decision', label: 'try', diff: 'unchanged',
            anchor: { filePath, span: { start: node.startIndex, end: node.endIndex } },
        };
        nodes.push(decisionNode);

        const tryBody = node.childForFieldName?.('body')
            ?? node.children?.find((c: any) => TS_BLOCK_TYPES.has(c.type));
        const tryBuilt = tryBody
            ? buildTSBlock(tryBody.children, source, nodes, edges, filePath)
            : { entryId: null, exits: [], terminals: [] };
        if (tryBuilt.entryId) {
            edges.push({ id: nextId('edge'), source: decisionNode.id, target: tryBuilt.entryId, label: 'Try', edgeType: 'flow', diff: 'unchanged' });
        }

        const catchClauses = node.children?.filter((c: any) =>
            c.type === 'catch_clause' || c.type === 'except_clause' || c.type === 'rescue_clause') ?? [];
        let catchBuilt: FlowBuildResult | null = null;
        for (const cc of catchClauses) {
            const catchBody = cc.childForFieldName?.('body')
                ?? cc.children?.find((c: any) => TS_BLOCK_TYPES.has(c.type));
            if (catchBody) {
                catchBuilt = buildTSBlock(catchBody.children, source, nodes, edges, filePath);
                if (catchBuilt.entryId) {
                    edges.push({ id: nextId('edge'), source: decisionNode.id, target: catchBuilt.entryId, label: 'Catch', edgeType: 'flow', diff: 'unchanged' });
                }
                break;
            }
        }

        const exits: Array<{ id: string; label?: string }> = [];
        const terminals = [...tryBuilt.terminals];
        if (tryBuilt.entryId) tryBuilt.exits.forEach(e => exits.push(e));
        else exits.push({ id: decisionNode.id, label: 'Try' });
        if (catchBuilt) {
            if (catchBuilt.entryId) catchBuilt.exits.forEach(e => exits.push(e));
            else exits.push({ id: decisionNode.id, label: 'Catch' });
            terminals.push(...catchBuilt.terminals);
        } else {
            exits.push({ id: decisionNode.id, label: 'Catch' });
        }
        return { entryId: decisionNode.id, exits, terminals };
    }

    if (type === 'return_statement' || type === 'throw_statement' || type === 'raise_statement') {
        const label = readableTSLabel(node, source);
        const returnNode: GraphNode = {
            id: nextId('stmt'), type: 'return', label, diff: 'unchanged',
            anchor: { filePath, span: { start: node.startIndex, end: node.endIndex } },
        };
        nodes.push(returnNode);
        return { entryId: returnNode.id, exits: [], terminals: [returnNode.id] };
    }

    // Skip class/annotation declarations nested inside a method (shouldn't happen but guard)
    if (type === 'class_declaration' || type === 'interface_declaration') {
        return { entryId: null, exits: [], terminals: [] };
    }

    const label = readableTSLabel(node, source);
    if (!label) return { entryId: null, exits: [], terminals: [] };

    const actionNode: GraphNode = {
        id: nextId('stmt'), type: 'statement', label, diff: 'unchanged',
        anchor: { filePath, span: { start: node.startIndex, end: node.endIndex } },
    };
    nodes.push(actionNode);
    return { entryId: actionNode.id, exits: [{ id: actionNode.id }], terminals: [] };
}

function buildTSBlock(
    children: any[],
    source: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
    filePath: string,
): FlowBuildResult {
    let entryId: string | null = null;
    let openExits: Array<{ id: string; label?: string }> = [];
    let terminals: string[] = [];

    for (const child of children) {
        if (!child || TS_SKIP_TYPES.has(child.type) || child.type.length === 1) continue;
        const built = buildTSStatement(child, source, nodes, edges, filePath);
        if (!built.entryId) continue;
        if (!entryId) entryId = built.entryId;
        openExits.forEach(ex => {
            edges.push({ id: nextId('edge'), source: ex.id, target: built.entryId!, label: ex.label, edgeType: 'flow', diff: 'unchanged' });
        });
        openExits = built.exits;
        terminals = terminals.concat(built.terminals);
    }
    return { entryId, exits: openExits, terminals };
}

/**
 * Normalize a statement label for baseline comparison.
 * Strips whitespace/braces so text-based comparison is robust.
 */
export function normalizeForDiff(text: string): string {
    return text.replace(/\s+/g, ' ').replace(/[{}]/g, '').trim().toLowerCase();
}

/**
 * Return the search key used to match a node label against baseline text.
 * Decision nodes use "is (condition)?" format; we extract just the condition part.
 */
function labelSearchKey(normalizedLabel: string): string {
    return normalizedLabel.startsWith('is ') && normalizedLabel.endsWith('?')
        ? normalizedLabel.slice(3, -1).trim()
        : normalizedLabel;
}

/**
 * Append ghost nodes/edges for statements that existed in the baseline flow graph
 * but are absent from the current (already-built) flow graph.
 *
 * Used for non-JS languages (Java, Kotlin, Go, Python …) where the old source
 * cannot be re-parsed with Babel. The stored baseline DiagramGraph is used instead.
 *
 * Ghost nodes carry diff:'deleted' so the webview renders them red.
 */
export function appendNonJsDeletedNodes(
    currentGraph: DiagramGraph,
    baselineGraph: DiagramGraph,
): void {
    const startNode = currentGraph.nodes.find(n => n.type === 'terminal' && n.label.startsWith('Start'));
    const endNode = currentGraph.nodes.find(n => n.type === 'terminal' && n.label === 'End');
    if (!startNode || !endNode) return;

    const baselineStartId = baselineGraph.nodes.find(n => n.type === 'terminal' && n.label.startsWith('Start'))?.id;
    const baselineEndId = baselineGraph.nodes.find(n => n.type === 'terminal' && n.label === 'End')?.id;

    // Build search-key → current node ID map for non-terminal nodes
    const currentKeyToId = new Map<string, string>();
    for (const node of currentGraph.nodes) {
        if (node.type !== 'terminal' && node.label) {
            currentKeyToId.set(labelSearchKey(normalizeForDiff(node.label)), node.id);
        }
    }

    // Map baseline node ID → effective ID in the merged graph:
    //   surviving nodes → remapped to the matching current node ID
    //   deleted nodes   → a fresh unique ID
    const baselineIdToEffective = new Map<string, string>();
    const deletedBaselineIds = new Set<string>();

    for (const node of baselineGraph.nodes) {
        if (node.type === 'terminal') {
            // Wire baseline Start/End through to the current Start/End
            if (node.id === baselineStartId) { baselineIdToEffective.set(node.id, startNode.id); continue; }
            if (node.id === baselineEndId) { baselineIdToEffective.set(node.id, endNode.id); continue; }
            baselineIdToEffective.set(node.id, node.id);
            continue;
        }
        const key = node.label ? labelSearchKey(normalizeForDiff(node.label)) : '';
        const existingId = key ? currentKeyToId.get(key) : undefined;
        if (existingId) {
            baselineIdToEffective.set(node.id, existingId);
        } else {
            const freshId = nextId('del');
            baselineIdToEffective.set(node.id, freshId);
            deletedBaselineIds.add(node.id);
        }
    }

    if (deletedBaselineIds.size === 0) return;

    // Add deleted nodes (with fresh IDs) to the current graph
    for (const node of baselineGraph.nodes) {
        if (!deletedBaselineIds.has(node.id)) continue;
        const effectiveId = baselineIdToEffective.get(node.id)!;
        currentGraph.nodes.push({ ...node, id: effectiveId, diff: 'deleted' });
        if (node.anchor && currentGraph.anchors) {
            currentGraph.anchors[effectiveId] = node.anchor;
        }
    }

    // Add edges that involve at least one deleted endpoint (remapped)
    for (const edge of baselineGraph.edges) {
        const srcEff = baselineIdToEffective.get(edge.source);
        const tgtEff = baselineIdToEffective.get(edge.target);
        if (!srcEff || !tgtEff) continue;
        if (deletedBaselineIds.has(edge.source) || deletedBaselineIds.has(edge.target)) {
            currentGraph.edges.push({ ...edge, id: nextId('edge'), source: srcEff, target: tgtEff, diff: 'deleted' });
        }
    }
}

/**
 * Build a flow diagram from a Tree-sitter method/function node.
 * Used for Java, Python, Go, Kotlin, and other non-JS languages.
 *
 * @param methodNode - TSNode for method_declaration, function_declaration, etc.
 * @param source     - Full source file text
 * @param filePath   - Relative file path (for anchors and graphId)
 * @param functionName - Short function/method name
 * @param baselineBodyText - Optional: text of the same function from baseline snapshot.
 *   When provided, nodes whose label text does not appear in the baseline are marked 'added'.
 */
export function buildFlowGraphFromNode(
    methodNode: any,
    source: string,
    filePath: string,
    functionName: string,
    baselineBodyText?: string,
): DiagramGraph {
    const body = methodNode.childForFieldName?.('body')
        ?? methodNode.children?.find((c: any) => TS_BLOCK_TYPES.has(c.type));
    return buildFlowGraphFromBody(body, source, filePath, functionName, baselineBodyText);
}

/**
 * Build a flow diagram from raw body TEXT (no AST). Used for languages
 * whose extractor doesn't produce tree-sitter nodes — currently Dart via
 * the regex fallback when tree-sitter-dart can't parse Dart 3.x syntax
 * (Issue #445-A).
 *
 * Splits the body into statements by top-level `;` and `\n` (ignoring
 * statements inside nested braces / brackets / parens), and emits one
 * `statement` node per top-level statement. Decisions (`if`, `while`,
 * `for`, `switch`, `try`) are kept as simple statement nodes — we don't
 * branch the flow since we don't have a real AST.
 */
export function buildFlowGraphFromBodyText(
    bodyText: string,
    filePath: string,
    functionName: string,
    baselineBodyText?: string,
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};

    const startNode: GraphNode = {
        id: nextId('start'), type: 'terminal',
        label: `Start\n${functionName}()`, diff: 'unchanged',
        anchor: { filePath, symbol: functionName },
    };
    const endNode: GraphNode = {
        id: nextId('end'), type: 'terminal',
        label: 'End', diff: 'unchanged',
        anchor: { filePath, symbol: functionName },
    };
    nodes.push(startNode, endNode);
    anchors[startNode.id] = startNode.anchor!;
    anchors[endNode.id] = endNode.anchor!;

    // Split body into top-level statements: walk character by character,
    // tracking depth of `{`/`[`/`(`. Statement boundary = `;` at depth 0
    // OR `\n` immediately after `}` at depth 0 (block statement end).
    const statements: string[] = [];
    let depth = 0;
    let buf = '';
    for (let i = 0; i < bodyText.length; i++) {
        const c = bodyText[i];
        if (c === '"' || c === "'") {
            // Skip string literal content
            buf += c;
            i++;
            while (i < bodyText.length && bodyText[i] !== c) {
                if (bodyText[i] === '\\' && i + 1 < bodyText.length) {
                    buf += bodyText[i] + bodyText[i + 1];
                    i += 2;
                } else {
                    buf += bodyText[i];
                    i++;
                }
            }
            if (i < bodyText.length) buf += bodyText[i];
            continue;
        }
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') {
            depth--;
            buf += c;
            if (depth === 0 && c === '}') {
                // Block statement complete.
                const trimmed = buf.trim();
                if (trimmed) statements.push(trimmed);
                buf = '';
                continue;
            }
            continue;
        }
        if (c === ';' && depth === 0) {
            const trimmed = (buf + c).trim();
            if (trimmed && trimmed !== ';') statements.push(trimmed);
            buf = '';
            continue;
        }
        buf += c;
    }
    if (buf.trim()) statements.push(buf.trim());

    let prevId: string | null = startNode.id;
    for (const stmt of statements) {
        const label = stmt.length > 100 ? stmt.slice(0, 97) + '...' : stmt;
        const node: GraphNode = {
            id: nextId('stmt'), type: 'statement', label, diff: 'unchanged',
            anchor: { filePath, symbol: functionName },
        };
        nodes.push(node);
        anchors[node.id] = node.anchor!;
        edges.push({ id: nextId('edge'), source: prevId!, target: node.id, edgeType: 'flow', diff: 'unchanged' });
        prevId = node.id;
    }
    edges.push({ id: nextId('edge'), source: prevId!, target: endNode.id, edgeType: 'flow', diff: 'unchanged' });

    // Diff pass — mirror the one in buildFlowGraphFromBody. Same truncation
    // skip as below (Issues #719 / #721).
    if (baselineBodyText && !baselineBodyText.endsWith('…')) {
        const normalizedBaseline = normalizeForDiff(baselineBodyText);
        for (const node of nodes) {
            if (node.type === 'terminal') continue;
            let textToSearch = normalizeForDiff(node.label);
            if (textToSearch.endsWith('...')) {
                textToSearch = textToSearch.slice(0, -3).trim();
            }
            if (textToSearch && !normalizedBaseline.includes(textToSearch)) {
                node.diff = 'added';
            }
        }
    }

    consolidateStatements(nodes, edges, anchors);

    return {
        graphId: `flow:${filePath}:${functionName}`,
        type: 'flow',
        nodes,
        edges,
        anchors,
        meta: { filePath, functionName },
    };
}

/**
 * Build a flow diagram from a body node directly. Use this for anonymous
 * lambdas/closures whose AST shape varies by language (Kotlin lambda_literal
 * has a `statements` child, not `block`; Ruby do_block has `body_statement`).
 *
 * @param bodyNode - tree-sitter node whose `.children` are statement nodes,
 *   or null/undefined for an empty body. Pass the actual body container
 *   (block / statements / body_statement / compound_statement) — this function
 *   does not search for one.
 */
export function buildFlowGraphFromBody(
    bodyNode: any | null,
    source: string,
    filePath: string,
    functionName: string,
    baselineBodyText?: string,
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};

    const startNode: GraphNode = {
        id: nextId('start'), type: 'terminal',
        label: `Start\n${functionName}()`, diff: 'unchanged',
        anchor: { filePath, symbol: functionName },
    };
    const endNode: GraphNode = {
        id: nextId('end'), type: 'terminal',
        label: 'End', diff: 'unchanged',
        anchor: { filePath, symbol: functionName },
    };
    nodes.push(startNode, endNode);
    anchors[startNode.id] = startNode.anchor!;
    anchors[endNode.id] = endNode.anchor!;

    if (!bodyNode) {
        edges.push({ id: nextId('edge'), source: startNode.id, target: endNode.id, edgeType: 'flow', diff: 'unchanged' });
    } else {
        const built = buildTSBlock(bodyNode.children, source, nodes, edges, filePath);
        if (built.entryId) {
            edges.push({ id: nextId('edge'), source: startNode.id, target: built.entryId, edgeType: 'flow', diff: 'unchanged' });
        } else {
            edges.push({ id: nextId('edge'), source: startNode.id, target: endNode.id, edgeType: 'flow', diff: 'unchanged' });
        }
        built.exits.forEach(ex => edges.push({ id: nextId('edge'), source: ex.id, target: endNode.id, label: ex.label, edgeType: 'flow', diff: 'unchanged' }));
        built.terminals.forEach(id => edges.push({ id: nextId('edge'), source: id, target: endNode.id, edgeType: 'flow', diff: 'unchanged' }));
    }

    for (const node of nodes) {
        if (node.anchor) anchors[node.id] = node.anchor;
    }

    // Diff pass: mark nodes whose label text is absent from the baseline as 'added'.
    //
    // Issues #719 / #721 — treeSitterExtractor truncates `bodyText` at 3000
    // chars and appends `…` to signal truncation. Comparing labels against
    // a truncated baseline marks every statement past the cut-off as
    // 'added' on every rebuild — including reverts — so the markers never
    // clear and the user sees a permanently "modified" L5 graph. Skip the
    // diff pass when the baseline was truncated; long functions lose
    // per-statement 'added' badges (they still show file-level diff via
    // L4) but reverts cascade clean.
    if (baselineBodyText && !baselineBodyText.endsWith('…')) {
        const normalizedBaseline = normalizeForDiff(baselineBodyText);
        for (const node of nodes) {
            if (node.type === 'terminal') continue; // Start/End are always 'unchanged'
            const normalizedLabel = normalizeForDiff(node.label);
            // Decision nodes use "is (condition)?" format but baseline code has "if (condition)" —
            // extract just the condition part (the parenthesised expression) for matching.
            let textToSearch = normalizedLabel.startsWith('is ') && normalizedLabel.endsWith('?')
                ? normalizedLabel.slice(3, -1).trim() // "(condition)" substring
                : normalizedLabel;
            // The flow-builder synthesizes consistent labels across languages
            // (`switch <value>` for match/when/switch, `for <iter> in <range>`
            // for foreach loops, `do…while <cond>` for do-loops). These
            // keyword prefixes don't appear in source for languages whose
            // actual keyword differs (Rust `match`, Kotlin `when`, Python
            // `for x in xs`). Without stripping them, the substring search
            // marks a node `added` on every rebuild and propagates as
            // `modified` through the consolidation pass (rust-rocket
            // `flow:.../routing.rs:client` residual).
            const SYNTHETIC_PREFIXES = ['switch ', 'do...while ', 'do…while '];
            for (const pref of SYNTHETIC_PREFIXES) {
                if (textToSearch.startsWith(pref)) {
                    textToSearch = textToSearch.slice(pref.length).trim();
                    break;
                }
            }
            // If the label was truncated (ends in '...'), strip suffix so we search for the
            // prefix that IS present in baseline code — avoids false 'added' on long statements.
            if (textToSearch.endsWith('...')) {
                textToSearch = textToSearch.slice(0, -3).trim();
            }
            if (textToSearch && !normalizedBaseline.includes(textToSearch)) {
                node.diff = 'added';
            }
        }
    }

    // Consolidation pass: merge consecutive statement nodes into blocks
    consolidateStatements(nodes, edges, anchors);

    return {
        graphId: `flow:${filePath}:${functionName}`,
        type: 'flow',
        nodes,
        edges,
        anchors,
        meta: { filePath, functionName },
    };
}

/**
 * Build a function control flow diagram.
 *
 * Nodes: Start, End, statements, decisions, loops
 * Edges: flow connections between nodes
 * No recursive expansion into called functions.
 */
/**
 * Post-processing pass: merge consecutive linear statement nodes into single block nodes.
 * Reduces visual clutter by grouping `const a = ...; const b = ...; foo();` into one rectangle.
 *
 * Only merges nodes of type 'statement' that are connected by single linear edges
 * (no branching). Decision, loop, return, and terminal nodes are never merged.
 *
 * Each merged node stores individual statements in `meta.statements[]` so the renderer
 * can show per-line diff indicators and enable click-to-line navigation.
 */
function consolidateStatements(
    nodes: GraphNode[],
    edges: GraphEdge[],
    anchors: Record<string, Anchor>,
): void {
    // Build adjacency: for each node, who are its outgoing/incoming targets?
    const outgoing = new Map<string, GraphEdge[]>();
    const incoming = new Map<string, GraphEdge[]>();
    for (const e of edges) {
        if (!outgoing.has(e.source)) outgoing.set(e.source, []);
        outgoing.get(e.source)!.push(e);
        if (!incoming.has(e.target)) incoming.set(e.target, []);
        incoming.get(e.target)!.push(e);
    }

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const isMergeable = (id: string) => {
        const n = nodeMap.get(id);
        return n && n.type === 'statement';
    };

    // Find runs of consecutive mergeable nodes
    const visited = new Set<string>();
    const mergeGroups: string[][] = [];

    for (const node of nodes) {
        if (visited.has(node.id) || !isMergeable(node.id)) continue;

        // Start a run from this node
        const run: string[] = [node.id];
        visited.add(node.id);

        // Extend forward: follow single outgoing edge to next statement
        let current = node.id;
        while (true) {
            const outs = outgoing.get(current) ?? [];
            if (outs.length !== 1) break;
            const nextId = outs[0].target;
            if (visited.has(nextId) || !isMergeable(nextId)) break;
            // The next node must have exactly 1 incoming edge (from current)
            const ins = incoming.get(nextId) ?? [];
            if (ins.length !== 1) break;
            run.push(nextId);
            visited.add(nextId);
            current = nextId;
        }

        if (run.length >= 2) {
            mergeGroups.push(run);
        }
    }

    if (mergeGroups.length === 0) return;

    // Merge each run into a single node
    const removedNodeIds = new Set<string>();
    const removedEdgeIds = new Set<string>();

    for (const run of mergeGroups) {
        const runNodes = run.map(id => nodeMap.get(id)!);
        const firstNode = runNodes[0];
        const lastNode = runNodes[runNodes.length - 1];

        // Build merged label and meta.statements. Preserve per-statement
        // generator-yield markers (Issue 209) so the renderer can still show
        // a yield indicator at the right line of a merged block.
        const statements = runNodes.map(n => ({
            label: n.label,
            diff: n.diff,
            diffDetail: (n as any).diffDetail,
            span: n.anchor?.span,
            yields: (n.meta as any)?.yields === true ? true : undefined,
            yieldKind: (n.meta as any)?.yieldKind,
        }));

        // Determine overall diff: if any statement has a diff, the block is modified
        const hasDiff = statements.some(s => s.diff !== 'unchanged');
        const overallDiff: DiffStatus = hasDiff ? 'modified' : 'unchanged';

        // Aggregate generator-yield markers: if any statement in the run yields,
        // the merged block-level node carries the flag for badge rendering.
        const anyYields = statements.some(s => s.yields === true);

        // Create merged node (reuse first node's ID)
        const mergedNode: GraphNode = {
            id: firstNode.id,
            type: 'statement',
            label: runNodes.map(n => n.label).join('\n'),
            diff: overallDiff,
            anchor: {
                filePath: firstNode.anchor?.filePath ?? '',
                span: {
                    start: firstNode.anchor?.span?.start ?? 0,
                    end: lastNode.anchor?.span?.end ?? 0,
                },
            },
            meta: {
                statements,
                nodeKind: 'block',
                ...(anyYields ? { yields: true } : {}),
            },
        };

        // Replace first node with merged node
        const idx = nodes.indexOf(firstNode);
        if (idx >= 0) nodes[idx] = mergedNode;
        anchors[mergedNode.id] = mergedNode.anchor!;

        // Mark other nodes in the run for removal
        for (let i = 1; i < run.length; i++) {
            removedNodeIds.add(run[i]);
        }

        // Mark internal edges for removal
        for (let i = 0; i < run.length - 1; i++) {
            const outs = outgoing.get(run[i]) ?? [];
            for (const e of outs) {
                if (e.target === run[i + 1]) {
                    removedEdgeIds.add(e.id);
                }
            }
        }

        // Rewire: edges that targeted nodes[1..n] in the run → point to merged node
        // (shouldn't happen since they have single incoming, but be safe)
        // Edges that sourced from last node → now source from merged node
        const lastOuts = outgoing.get(lastNode.id) ?? [];
        for (const e of lastOuts) {
            e.source = mergedNode.id;
        }
    }

    // Remove merged nodes and internal edges
    for (let i = nodes.length - 1; i >= 0; i--) {
        if (removedNodeIds.has(nodes[i].id)) {
            delete anchors[nodes[i].id];
            nodes.splice(i, 1);
        }
    }
    for (let i = edges.length - 1; i >= 0; i--) {
        if (removedEdgeIds.has(edges[i].id)) {
            edges.splice(i, 1);
        }
    }
}

export function buildFlowGraph(
    code: string,
    filePath: string,
    functionName?: string,
    oldCode?: string,
    externallyModifiedFunctions?: Set<string>,
    /** Character offset of the function in the full file (for converting span offsets) */
    sourceOffset?: number,
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};

    const diffMap = oldCode ? buildDiffMap(oldCode, code) : null;

    // Bug 7 follow-up: pass filePath so parseJSAuto picks the correct
    // plugin combo (.ts gets typescript-only, no jsx ambiguity). Without
    // this, TS-specific syntax in route-handler bodies like generics or
    // type assertions would parse-fail and the inline flow diff would be
    // dropped silently.
    const { fn, bodyStatements } = parseFirstFunction(code, filePath);
    // Issue 253: If functionName is an anonymous handler ID, use it as-is (don't use wrapper name)
    const fnName = (functionName && functionName.startsWith('anonymous@'))
        ? functionName
        : (fn.id?.name || functionName || 'anonymous');
    const params = (fn.params || [])
        .map((p: any) => (p.type === 'Identifier' ? p.name : 'arg'))
        .join(', ');

    // Issue 209: surface generator-function semantics. Babel sets `generator: true`
    // on FunctionDeclaration / FunctionExpression / ClassMethod / ObjectMethod for
    // both `function* foo() {}` and shorthand `*foo() {}`. We prefix the start
    // label with `*` to mirror the source syntax and tag the start node + graph
    // meta so the webview can render a small `gen` badge.
    const isGenerator = !!fn.generator;
    const displayName = isGenerator ? `*${fnName}` : fnName;

    // Start node
    const startNode: GraphNode = {
        id: nextId('start'),
        type: 'terminal',
        label: `Start\n${displayName}(${params})`,
        diff: 'unchanged',
        anchor: { filePath, symbol: fnName },
        ...(isGenerator ? { meta: { generator: true } } : {}),
    };

    // End node
    const endNode: GraphNode = {
        id: nextId('end'),
        type: 'terminal',
        label: 'End',
        diff: 'unchanged',
        anchor: { filePath, symbol: fnName },
    };

    nodes.push(startNode, endNode);
    anchors[startNode.id] = startNode.anchor!;
    anchors[endNode.id] = endNode.anchor!;

    const built = buildBlock(bodyStatements, code, nodes, edges, diffMap, filePath);

    if (built.entryId) {
        edges.push({ id: nextId('edge'), source: startNode.id, target: built.entryId, edgeType: 'flow', diff: 'unchanged' });
    } else {
        edges.push({ id: nextId('edge'), source: startNode.id, target: endNode.id, edgeType: 'flow', diff: 'unchanged' });
    }

    built.exits.forEach((ex) => {
        edges.push({ id: nextId('edge'), source: ex.id, target: endNode.id, label: ex.label, edgeType: 'flow', diff: 'unchanged' });
    });
    built.terminals.forEach((id) => {
        edges.push({ id: nextId('edge'), source: id, target: endNode.id, edgeType: 'flow', diff: 'unchanged' });
    });

    // Add anchors for all nodes
    for (const node of nodes) {
        if (node.anchor) anchors[node.id] = node.anchor;
    }

    // Mark unchanged statement nodes that call externally-modified functions
    if (externallyModifiedFunctions && externallyModifiedFunctions.size > 0) {
        for (const node of nodes) {
            if (node.diff !== 'unchanged' || !node.label) continue;
            for (const fnName of externallyModifiedFunctions) {
                if (new RegExp(`\\b${fnName}\\s*\\(`).test(node.label)) {
                    node.diff = 'modified';
                    break;
                }
            }
        }
    }

    // Append ghost nodes/edges for statements deleted relative to baseline
    if (oldCode) {
        appendDeletedNodes(oldCode, nodes, edges, anchors, startNode.id, endNode.id, filePath);
    }

    // Consolidation pass: merge consecutive statement nodes into blocks
    consolidateStatements(nodes, edges, anchors);

    // Adjust all spans from function-relative to full-file offsets
    if (sourceOffset && sourceOffset > 0) {
        for (const node of nodes) {
            if (node.anchor?.span) {
                node.anchor.span.start += sourceOffset;
                if (node.anchor.span.end) node.anchor.span.end += sourceOffset;
            }
            if (node.meta?.statements) {
                for (const stmt of node.meta.statements as any[]) {
                    if (stmt.span) {
                        stmt.span.start += sourceOffset;
                        if (stmt.span.end) stmt.span.end += sourceOffset;
                    }
                }
            }
        }
    }

    return {
        graphId: `flow:${filePath}:${fnName}`,
        type: 'flow',
        nodes,
        edges,
        anchors,
        meta: { filePath, functionName: fnName, ...(isGenerator ? { generator: true } : {}) },
    };
}
