import { describe, it, expect } from 'vitest';
import { buildFlowGraph, buildFlowGraphFromNode, appendNonJsDeletedNodes, normalizeForDiff } from '../flowGraphBuilder';
import type { DiagramGraph, GraphNode, GraphEdge } from '../graphTypes';

// ---------------------------------------------------------------------------
// Mock TSNode builder helpers — avoids loading real WASM grammar files
// ---------------------------------------------------------------------------

function makeNode(type: string, text: string, startIndex: number, children: any[] = [], fields: Record<string, any> = {}): any {
    return {
        type,
        text,
        startIndex,
        endIndex: startIndex + text.length,
        children,
        childForFieldName: (name: string) => fields[name] ?? null,
    };
}

function makeBlock(children: any[], startIndex: number): any {
    const inner = children.map((c: any, i: number) => c);
    return makeNode('block', '{...}', startIndex, [
        makeNode('{', '{', startIndex),
        ...inner,
        makeNode('}', '}', startIndex + 100),
    ]);
}

function makeReturn(text: string, startIndex: number): any {
    return makeNode('return_statement', text, startIndex);
}

function makeExprStmt(text: string, startIndex: number): any {
    return makeNode('expression_statement', text, startIndex);
}

describe('flowGraphBuilder', () => {
    it('should build a flow graph for a simple function', () => {
        const code = `function greet(name) {\n  return "Hello, " + name;\n}`;
        const graph = buildFlowGraph(code, 'file.js');

        expect(graph.type).toBe('flow');
        expect(graph.graphId).toContain('flow:');
        expect(graph.nodes.length).toBeGreaterThan(0);
        expect(graph.edges.length).toBeGreaterThan(0);
    });

    it('should create start and end terminal nodes', () => {
        const code = `function foo() {\n  return 42;\n}`;
        const graph = buildFlowGraph(code, 'file.js');

        const terminals = graph.nodes.filter((n) => n.type === 'terminal');
        expect(terminals).toHaveLength(2);
        expect(terminals.some((n) => n.label.includes('Start'))).toBe(true);
        expect(terminals.some((n) => n.label === 'End')).toBe(true);
    });

    it('should include function name and params in start node', () => {
        const code = `function calculate(a, b) {\n  return a + b;\n}`;
        const graph = buildFlowGraph(code, 'file.js');

        const startNode = graph.nodes.find((n) => n.label.includes('Start'));
        expect(startNode).toBeDefined();
        expect(startNode!.label).toContain('calculate');
        expect(startNode!.label).toContain('a, b');
    });

    it('should handle if/else branches', () => {
        const code = `function check(x) {\n  if (x > 0) {\n    return "positive";\n  } else {\n    return "non-positive";\n  }\n}`;
        const graph = buildFlowGraph(code, 'file.js');

        const decisions = graph.nodes.filter((n) => n.type === 'decision');
        expect(decisions).toHaveLength(1);
        expect(decisions[0].label).toContain('x > 0');

        // Should have Yes and No edges
        const yesEdge = graph.edges.find((e) => e.label === 'Yes' && e.source === decisions[0].id);
        const noEdge = graph.edges.find((e) => e.label === 'No' && e.source === decisions[0].id);
        expect(yesEdge).toBeDefined();
        expect(noEdge).toBeDefined();
    });

    it('should handle for loops', () => {
        const code = `function sum(arr) {\n  let total = 0;\n  for (let i = 0; i < arr.length; i++) {\n    total += arr[i];\n  }\n  return total;\n}`;
        const graph = buildFlowGraph(code, 'file.js');

        const loops = graph.nodes.filter((n) => n.type === 'loop');
        expect(loops).toHaveLength(1);
    });

    it('should handle while loops', () => {
        const code = `function wait(n) {\n  let i = 0;\n  while (i < n) {\n    i++;\n  }\n  return i;\n}`;
        const graph = buildFlowGraph(code, 'file.js');

        const loops = graph.nodes.filter((n) => n.type === 'loop');
        expect(loops).toHaveLength(1);
    });

    it('should handle arrow functions', () => {
        const code = `const greet = (name) => {\n  return "Hello, " + name;\n};`;
        const graph = buildFlowGraph(code, 'file.js');

        expect(graph.nodes.length).toBeGreaterThan(0);
        const startNode = graph.nodes.find((n) => n.label.includes('Start'));
        expect(startNode).toBeDefined();
        expect(startNode!.label).toContain('greet');
    });

    it('should handle return statements as terminals', () => {
        const code = `function abs(x) {\n  if (x < 0) {\n    return -x;\n  }\n  return x;\n}`;
        const graph = buildFlowGraph(code, 'file.js');

        const returnNodes = graph.nodes.filter((n) => n.type === 'return');
        expect(returnNodes).toHaveLength(2);
    });

    it('should handle differential mode', () => {
        const oldCode = `function calc(x) {\n  let y = x * 0.20;\n  return y;\n}`;
        const newCode = `function calc(x) {\n  let y = x * 0.25;\n  return y;\n}`;

        const graph = buildFlowGraph(newCode, 'file.js', undefined, oldCode);

        // The changed statement should be marked
        const diffNodes = graph.nodes.filter((n) => n.diff === 'modified' || n.diff === 'added');
        expect(diffNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('should connect all paths to end node', () => {
        const code = `function foo() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}`;
        const graph = buildFlowGraph(code, 'file.js');

        const endNode = graph.nodes.find((n) => n.label === 'End');
        expect(endNode).toBeDefined();

        // At least one edge should target the end node
        const toEnd = graph.edges.filter((e) => e.target === endNode!.id);
        expect(toEnd.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle nested if statements', () => {
        const code = `function classify(x) {\n  if (x > 0) {\n    if (x > 100) {\n      return "large";\n    }\n    return "small";\n  }\n  return "negative";\n}`;
        const graph = buildFlowGraph(code, 'file.js');

        const decisions = graph.nodes.filter((n) => n.type === 'decision');
        expect(decisions).toHaveLength(2);
    });

    it('should include anchors with spans', () => {
        const code = `function hello() {\n  return "world";\n}`;
        const graph = buildFlowGraph(code, 'src/hello.js');

        expect(graph.anchors).toBeDefined();
        const anchorValues = Object.values(graph.anchors);
        expect(anchorValues.length).toBeGreaterThan(0);
    });
    it('should diff arrow function when try block is added (raw slice format)', () => {
        // Simulates the real scenario: oldCode is a raw arrow function slice from baseline content,
        // newCode is the updated arrow function slice — both in arrow function form, no reconstruction.
        const oldCode = `(req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ user: req.user });
}`;
        const newCode = `(req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({ user: req.user });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}`;
        const graph = buildFlowGraph(newCode, 'file.js', 'getCurrentUser', oldCode);

        // The 'try' node should be marked as 'added' (new in new code)
        const tryNode = graph.nodes.find((n) => n.label === 'try');
        expect(tryNode).toBeDefined();
        expect(tryNode!.diff).toBe('added');

        // The unchanged if-check should still be unchanged
        const ifNode = graph.nodes.find((n) => n.type === 'decision' && n.label.includes('req.user'));
        expect(ifNode).toBeDefined();
        expect(ifNode!.diff).toBe('unchanged');
    });

    it('should mark externally modified call sites with cross-file modifier', () => {
        const code = `function handler(req, res) {
  const user = createUser(req.body);
  return res.json(user);
}`;
        const externallyModified = new Set(['createUser']);
        const graph = buildFlowGraph(code, 'file.js', 'handler', undefined, externallyModified);

        const callNode = graph.nodes.find((n) => n.label.includes('createUser('));
        expect(callNode).toBeDefined();
        expect(callNode!.diff).toBe('modified');
    });

    it('should handle try/catch statements as decision blocks', () => {
        const code = `function dangerous() {\n  try {\n    return performTask();\n  } catch (e) {\n    return handleError();\n  }\n}`;
        const graph = buildFlowGraph(code, 'file.js');

        const decisions = graph.nodes.filter((n) => n.type === 'decision');
        expect(decisions.length).toBeGreaterThanOrEqual(1);
        const tryDecision = decisions.find((n) => n.label === 'try');
        expect(tryDecision).toBeDefined();

        // Should have Try and Catch edges
        const tryEdge = graph.edges.find((e) => e.label === 'Try' && e.source === tryDecision!.id);
        const catchEdge = graph.edges.find((e) => e.label === 'Catch' && e.source === tryDecision!.id);
        expect(tryEdge).toBeDefined();
        expect(catchEdge).toBeDefined();
    });

    describe('deleted nodes — appendDeletedNodes', () => {
        it('marks a removed statement as deleted', () => {
            const oldCode = `function fetch(id) {
  const result = db.query(id);
  console.log('got result');
  return result;
}`;
            const newCode = `function fetch(id) {
  const result = db.query(id);
  return result;
}`;
            const graph = buildFlowGraph(newCode, 'file.js', undefined, oldCode);

            // The removed console.log should appear as deleted
            const deletedNode = graph.nodes.find(
                (n) => n.diff === 'deleted' && n.label?.includes('console.log')
            );
            expect(deletedNode).toBeDefined();
        });

        it('marks a removed try/catch block as deleted', () => {
            const oldCode = `(req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
}`;
            const newCode = `(req, res) => {
  return await User.findById(userId);
}`;
            const graph = buildFlowGraph(newCode, 'file.js', 'getCurrentUser', oldCode);

            // The try decision node should appear as deleted
            const deletedTry = graph.nodes.find(
                (n) => n.diff === 'deleted' && n.label === 'try'
            );
            expect(deletedTry).toBeDefined();

            // Deleted nodes should be connected via deleted edges
            const deletedEdges = graph.edges.filter((e) => e.diff === 'deleted');
            expect(deletedEdges.length).toBeGreaterThan(0);
        });

        it('deleted entry node is connected to start node via deleted edge', () => {
            const oldCode = `function handler(req, res) {
  const data = req.body;
  return res.json(data);
}`;
            const newCode = `function handler(req, res) {
  return res.json({});
}`;
            const graph = buildFlowGraph(newCode, 'file.js', undefined, oldCode);

            const startNode = graph.nodes.find((n) => n.label?.includes('Start'));
            expect(startNode).toBeDefined();

            const deletedNodes = graph.nodes.filter((n) => n.diff === 'deleted');
            expect(deletedNodes.length).toBeGreaterThan(0);

            // At least one deleted edge should originate from startNode
            const edgeFromStart = graph.edges.find(
                (e) => e.source === startNode!.id && e.diff === 'deleted'
            );
            expect(edgeFromStart).toBeDefined();
        });

        it('deleted terminal nodes are connected to end node via deleted edges', () => {
            const oldCode = `function validate(x) {
  if (x < 0) {
    throw new Error('negative');
  }
  return x;
}`;
            const newCode = `function validate(x) {
  return x;
}`;
            const graph = buildFlowGraph(newCode, 'file.js', undefined, oldCode);

            const endNode = graph.nodes.find((n) => n.label === 'End');
            expect(endNode).toBeDefined();

            // Some deleted edges should point to endNode
            const deletedToEnd = graph.edges.filter(
                (e) => e.target === endNode!.id && e.diff === 'deleted'
            );
            expect(deletedToEnd.length).toBeGreaterThan(0);
        });

        it('surviving nodes are NOT duplicated as deleted', () => {
            const oldCode = `function calc(x) {
  const a = x * 2;
  const b = x + 1;
  return a + b;
}`;
            const newCode = `function calc(x) {
  const a = x * 2;
  return a;
}`;
            const graph = buildFlowGraph(newCode, 'file.js', undefined, oldCode);

            // 'const a = x * 2' exists in both old and new — must not appear as deleted
            const duplicateDeleted = graph.nodes.filter(
                (n) => n.diff === 'deleted' && n.label?.includes('const a = x * 2')
            );
            expect(duplicateDeleted).toHaveLength(0);

            // 'const b = x + 1' only in old — must be deleted
            const deletedB = graph.nodes.find(
                (n) => n.diff === 'deleted' && n.label?.includes('const b')
            );
            expect(deletedB).toBeDefined();
        });

        it('no deleted nodes emitted when nothing was removed', () => {
            const oldCode = `function greet(name) { return 'hi ' + name; }`;
            const newCode = `function greet(name) { return 'hi ' + name; }`;

            const graph = buildFlowGraph(newCode, 'file.js', undefined, oldCode);

            const deletedNodes = graph.nodes.filter((n) => n.diff === 'deleted');
            expect(deletedNodes).toHaveLength(0);
        });
    });
});

describe('buildFlowGraphFromNode — mock TSNode (no WASM)', () => {
    // source string used as the backing text buffer; indices into it are used by readableTSLabel
    const source = 'return "hi";  if (val == null) { return "null"; } else { return val; }  for (String item : items) { doIt(); }  try { db.save(); } catch(Exception e) { log.error(); }';

    it('builds a flow graph with Start/End from a simple method node', () => {
        // method with just a return statement
        const retNode = makeReturn('return "hi";', 0);
        const body = makeBlock([retNode], 0);
        const method = makeNode('method_declaration', 'public String hello() {...}', 0, [], { body });

        const graph = buildFlowGraphFromNode(method, source, 'Foo.java', 'hello');
        expect(graph.graphId).toBe('flow:Foo.java:hello');
        expect(graph.type).toBe('flow');

        const terminals = graph.nodes.filter(n => n.type === 'terminal');
        expect(terminals).toHaveLength(2);
        expect(terminals.some(n => n.label.includes('Start'))).toBe(true);
        expect(terminals.some(n => n.label === 'End')).toBe(true);
    });

    it('builds decision node for if/else', () => {
        // source offset 14 holds "if (val == null) { return "null"; } else { return val; }"
        const src = 'if (val == null) { return "null"; } else { return val; }';
        const condNode = makeNode('parenthesized_expression', '(val == null)', 3);
        const thenBlock = makeBlock([makeReturn('return "null";', 19)], 17);
        const elseBlock = makeBlock([makeReturn('return val;', 42)], 40);
        const ifNode = makeNode('if_statement', src, 0, [
            condNode, thenBlock, makeNode('else', 'else', 35), elseBlock,
        ], { condition: condNode, consequence: thenBlock, alternative: elseBlock });

        const body = makeBlock([ifNode], 0);
        const method = makeNode('method_declaration', 'check', 0, [], { body });

        const graph = buildFlowGraphFromNode(method, src, 'Ctrl.java', 'check');
        const decisions = graph.nodes.filter(n => n.type === 'decision');
        expect(decisions).toHaveLength(1);
        expect(decisions[0].label).toMatch(/val == null/);

        const returns = graph.nodes.filter(n => n.type === 'return');
        expect(returns).toHaveLength(2);
    });

    it('builds loop node for enhanced for-each', () => {
        const src = 'for (String item : items) { doIt(); }';
        const bodyBlock = makeBlock([makeExprStmt('doIt();', 28)], 26);
        const forNode = makeNode('enhanced_for_statement', src, 0, [bodyBlock], { body: bodyBlock });

        const outerBody = makeBlock([forNode], 0);
        const method = makeNode('method_declaration', 'process', 0, [], { body: outerBody });

        const graph = buildFlowGraphFromNode(method, src, 'Svc.java', 'process');
        const loops = graph.nodes.filter(n => n.type === 'loop');
        expect(loops).toHaveLength(1);
        expect(loops[0].label).toMatch(/for/);
    });

    // #issue-rocket-client residual: rust-rocket's `client()` flow graph
    // showed up `modified` after revert because the `match` expression got
    // labeled `switch value` (synthetic placeholder — the field for the
    // matched value was named `value` in tree-sitter Rust, not `condition`).
    // The diff pass then failed to find `switch value` in baseline body text
    // (source has `match`, not `switch`) and marked it `added` → consolidation
    // propagated as `modified`. The fix adds `value`/`subject` field lookups
    // to `readableTSLabel` for match/when expressions.
    it('builds match-expression label from `value` field (Rust match)', () => {
        const src = 'match status { Ok(x) => x, Err(e) => panic!() }';
        const valueNode = makeNode('identifier', 'status', 6);
        const matchArmsBlock = makeBlock([], 13);
        const matchNode = makeNode('match_expression', src, 0, [valueNode, matchArmsBlock], {
            value: valueNode, body: matchArmsBlock,
        });
        const outerBody = makeBlock([matchNode], 0);
        const method = makeNode('method_declaration', 'client', 0, [], { body: outerBody });

        const graph = buildFlowGraphFromNode(method, src, 'routing.rs', 'client');
        const switches = graph.nodes.filter(n => n.type === 'decision' || n.type === 'statement');
        // The match label MUST include the matched value text — not the
        // generic placeholder `switch value`.
        const switchLabel = switches.map(n => n.label).find(l => l?.includes('switch'));
        expect(switchLabel, `got labels: ${switches.map(n => n.label).join(' | ')}`).toBeDefined();
        expect(switchLabel, 'match label must include the matched value text, not the synthetic placeholder').toBe('switch status');
    });

    it('diff pass does NOT mark Rust match nodes `added` when source is unchanged (#issue-rocket-client)', () => {
        // Build the same graph twice with identical baselineBodyText —
        // the synthetic `switch ` prefix on the match-label must not
        // cause a false `added` annotation because `switch` never
        // appears in Rust source (the keyword is `match`).
        const src = 'fn client() { match status { Ok(x) => x, Err(e) => panic!() } }';
        const baselineBodyText = src; // identical baseline + working
        const valueNode = makeNode('identifier', 'status', 20);
        const matchArms = makeBlock([], 27);
        const matchNode = makeNode('match_expression', src.slice(14, src.length - 2), 14, [valueNode, matchArms], {
            value: valueNode, body: matchArms,
        });
        const body = makeBlock([matchNode], 12);
        const method = makeNode('function_item', 'fn client() {...}', 0, [], { body });

        const graph = buildFlowGraphFromNode(method, src, 'routing.rs', 'client', baselineBodyText);
        const matchNodes = graph.nodes.filter(n => n.label?.startsWith('switch '));
        expect(matchNodes.length).toBeGreaterThan(0);
        // The diff pass MUST recognise the synthetic `switch ` prefix and
        // search for the inner value (`status`) — which IS in baseline.
        for (const n of matchNodes) {
            expect(n.diff, `match node "${n.label}" should be unchanged when source matches baseline`).toBe('unchanged');
        }
    });

    it('builds when-expression label from `subject` field (Kotlin when)', () => {
        const src = 'when (state) { State.OK -> 1, else -> 0 }';
        const subjectNode = makeNode('identifier', 'state', 6);
        const whenArmsBlock = makeBlock([], 13);
        const whenNode = makeNode('when_expression', src, 0, [subjectNode, whenArmsBlock], {
            subject: subjectNode, body: whenArmsBlock,
        });
        const outerBody = makeBlock([whenNode], 0);
        const method = makeNode('function_declaration', 'check', 0, [], { body: outerBody });

        const graph = buildFlowGraphFromNode(method, src, 'App.kt', 'check');
        const switches = graph.nodes.filter(n => n.type === 'decision' || n.type === 'statement');
        const switchLabel = switches.map(n => n.label).find(l => l?.includes('switch'));
        expect(switchLabel, 'Kotlin when must extract subject text').toBe('switch state');
    });

    it('builds try/catch decision node for try statement', () => {
        const src = 'try { db.save(); } catch(Exception e) { log.error(); }';
        const tryBody = makeBlock([makeExprStmt('db.save();', 6)], 4);
        const catchClause = makeNode('catch_clause', 'catch(Exception e) { log.error(); }', 19, [
            makeBlock([makeExprStmt('log.error();', 40)], 38),
        ]);
        const tryNode = makeNode('try_statement', src, 0, [tryBody, catchClause], { body: tryBody });

        const outerBody = makeBlock([tryNode], 0);
        const method = makeNode('method_declaration', 'save', 0, [], { body: outerBody });

        const graph = buildFlowGraphFromNode(method, src, 'Repo.java', 'save');
        const decisions = graph.nodes.filter(n => n.type === 'decision');
        expect(decisions).toHaveLength(1);
        expect(decisions[0].label).toBe('try');
    });
});

// ---------------------------------------------------------------------------
// Flow graph diff coloring — green=added, red=deleted, orange=modified
// ---------------------------------------------------------------------------
describe('buildFlowGraph — diff coloring (green/red/orange per statement)', () => {
    it('terminal nodes always unchanged regardless of diff', () => {
        const oldCode = `function foo() { return 1; }`;
        const newCode = `function foo() { return 2; }`;
        const graph = buildFlowGraph(newCode, 'f.js', 'foo', oldCode);

        const terminals = graph.nodes.filter(n => n.type === 'terminal');
        expect(terminals.length).toBeGreaterThanOrEqual(2);
        expect(terminals.every(n => n.diff === 'unchanged')).toBe(true);
    });

    it('added statement → diff "added" (green)', () => {
        const oldCode = `function process(x) {\n  return x * 2;\n}`;
        const newCode = `function process(x) {\n  const doubled = x * 2;\n  return doubled;\n}`;
        const graph = buildFlowGraph(newCode, 'f.js', 'process', oldCode);

        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('removed statement → diff "deleted" ghost node (red)', () => {
        const oldCode = `function process(x) {\n  const doubled = x * 2;\n  const tripled = x * 3;\n  return doubled;\n}`;
        const newCode = `function process(x) {\n  const doubled = x * 2;\n  return doubled;\n}`;
        const graph = buildFlowGraph(newCode, 'f.js', 'process', oldCode);

        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('modified statement → diff "modified" (orange)', () => {
        const oldCode = `function calc(x) {\n  let y = x * 0.10;\n  return y;\n}`;
        const newCode = `function calc(x) {\n  let y = x * 0.20;\n  return y;\n}`;
        const graph = buildFlowGraph(newCode, 'f.js', 'calc', oldCode);

        // Numeric literal changed → statement key matches (# placeholder) → 'modified'
        const modifiedNodes = graph.nodes.filter(n => n.diff === 'modified');
        expect(modifiedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('unchanged statement → diff "unchanged"', () => {
        const oldCode = `function foo() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}`;
        const newCode = `function foo() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}`;
        const graph = buildFlowGraph(newCode, 'f.js', 'foo', oldCode);

        const nonTerminals = graph.nodes.filter(n => n.type !== 'terminal');
        expect(nonTerminals.every(n => n.diff === 'unchanged')).toBe(true);
    });

    // #837 (2026-06-11) — live-verify repro: `module.exports.create = (…) => {…}`
    // (the Serverless-Framework handler form). parseFirstFunction only matched
    // arrows under ExpressionStatement / Program / VariableDeclarator parents,
    // so the AssignmentExpression form threw, buildDiffMap returned null, and
    // EVERY node silently stamped `unchanged` — the L5 diff badge never
    // appeared for any `module.exports.X = fn` handler.
    it('#837 — added statement in a module.exports-assigned arrow is stamped added', () => {
        const oldCode = `module.exports.create = (event, context, callback) => {\n  const timestamp = new Date().getTime()\n  const data = JSON.parse(event.body)\n  callback(null, data)\n}`;
        const newCode = `module.exports.create = (event, context, callback) => {\n  const _probe = 116\n  const timestamp = new Date().getTime()\n  const data = JSON.parse(event.body)\n  callback(null, data)\n}`;
        const graph = buildFlowGraph(newCode, 'todos/create.ts', 'create', oldCode);

        const dirty = graph.nodes.filter(n => n.diff === 'added' || n.diff === 'modified');
        expect(dirty.length).toBeGreaterThanOrEqual(1);
        const probeNode = graph.nodes.find(n => (n.label ?? '').includes('_probe'));
        expect(probeNode).toBeTruthy();
        expect(['added', 'modified']).toContain(probeNode!.diff);
    });

    it('#837 — mixed forms: old reconstructed as function decl, new as module.exports assignment', () => {
        // rebuildFile reconstructs oldFnCode from signature+bodyText as a
        // plain function declaration while the new side is the raw slice.
        const oldCode = `function create(event, context, callback) {\n  const timestamp = new Date().getTime()\n  callback(null, timestamp)\n}`;
        const newCode = `module.exports.create = (event, context, callback) => {\n  const _probe = 116\n  const timestamp = new Date().getTime()\n  callback(null, timestamp)\n}`;
        const graph = buildFlowGraph(newCode, 'todos/create.ts', 'create', oldCode);

        const dirty = graph.nodes.filter(n => n.diff === 'added' || n.diff === 'modified');
        expect(dirty.length).toBeGreaterThanOrEqual(1);
    });

    it('#837 — exports.X = function expression form also diffs', () => {
        const oldCode = `exports.handler = function (req, res) {\n  res.send('ok')\n}`;
        const newCode = `exports.handler = function (req, res) {\n  const _probe = 1\n  res.send('ok')\n}`;
        const graph = buildFlowGraph(newCode, 'h.js', 'handler', oldCode);
        expect(graph.nodes.filter(n => n.diff === 'added' || n.diff === 'modified').length).toBeGreaterThanOrEqual(1);
    });

    it('adding a log statement shows ONLY the log as added (not all nodes)', () => {
        const oldCode = `function addTodo(title) {\n  if (!title) return null;\n  return db.save(title);\n}`;
        const newCode = `function addTodo(title) {\n  log.info("addTodo called");\n  if (!title) return null;\n  return db.save(title);\n}`;
        const graph = buildFlowGraph(newCode, 'f.js', 'addTodo', oldCode);

        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        const modifiedNodes = graph.nodes.filter(n => n.diff === 'modified');
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');

        // Only the log statement should be added — not every node
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
        // The if-condition should remain unchanged (or the same decision)
        const ifNode = graph.nodes.find(n => n.type === 'decision' && n.label.includes('title'));
        if (ifNode) {
            expect(ifNode.diff).toBe('unchanged');
        }
        // NOT all non-terminal nodes should be 'modified' — that was the original bug
        const nonTerminals = graph.nodes.filter(n => n.type !== 'terminal');
        const allModified = nonTerminals.every(n => n.diff === 'modified');
        expect(allModified).toBe(false);
        // No spurious deletions
        expect(deletedNodes.length).toBe(0);
    });

    it('condition change → decision node "modified"', () => {
        const oldCode = `function check(x) {\n  if (x > 0) {\n    return "positive";\n  }\n  return "other";\n}`;
        const newCode = `function check(x) {\n  if (x >= 0) {\n    return "positive";\n  }\n  return "other";\n}`;
        const graph = buildFlowGraph(newCode, 'f.js', 'check', oldCode);

        // The decision node with changed condition should be modified
        const decisionNodes = graph.nodes.filter(n => n.type === 'decision');
        expect(decisionNodes.length).toBeGreaterThanOrEqual(1);
        // At least one decision changed
        const changedDecisions = decisionNodes.filter(n => n.diff === 'modified' || n.diff === 'added');
        expect(changedDecisions.length).toBeGreaterThanOrEqual(1);
    });

    it('no diff mode — all non-terminal nodes are unchanged', () => {
        const code = `function foo() {\n  const x = 1;\n  if (x > 0) return x;\n  return 0;\n}`;
        const graph = buildFlowGraph(code, 'f.js');

        const nonTerminals = graph.nodes.filter(n => n.type !== 'terminal');
        expect(nonTerminals.every(n => n.diff === 'unchanged')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// normalizeForDiff — export test
// ---------------------------------------------------------------------------
describe('normalizeForDiff', () => {
    it('strips extra whitespace', () => {
        expect(normalizeForDiff('  foo   bar  ')).toBe('foo bar');
    });
    it('removes curly braces', () => {
        // Braces removed; surrounding spaces collapsed
        expect(normalizeForDiff('if (x) { return x; }')).toContain('return x');
        expect(normalizeForDiff('if (x) { return x; }')).not.toContain('{');
    });
    it('lowercases', () => {
        expect(normalizeForDiff('TodoService.save()')).toBe('todoservice.save()');
    });
});

// ---------------------------------------------------------------------------
// appendNonJsDeletedNodes — ghost nodes for non-JS (Java/Kotlin/Go/…) flow graphs
// ---------------------------------------------------------------------------

/** Helper: build a minimal DiagramGraph for testing appendNonJsDeletedNodes */
function makeFlowGraph(nodes: GraphNode[], edges: GraphEdge[]): DiagramGraph {
    const anchors: Record<string, string> = {};
    return {
        graphId: 'flow:Foo.java:test',
        type: 'flow',
        nodes,
        edges,
        anchors: anchors as any,
        meta: { filePath: 'Foo.java', functionName: 'test' },
    };
}

function termNode(id: string, label: string): GraphNode {
    return { id, type: 'terminal', label, diff: 'unchanged' };
}
function stmtNode(id: string, label: string, diff: GraphNode['diff'] = 'unchanged'): GraphNode {
    return { id, type: 'statement', label, diff };
}
function flowEdge(id: string, src: string, tgt: string): GraphEdge {
    return { id, source: src, target: tgt, edgeType: 'flow', diff: 'unchanged' };
}

describe('appendNonJsDeletedNodes', () => {
    it('appends ghost nodes for deleted baseline statements', () => {
        // Baseline: Start → stmt-A → stmt-B → End
        const baselineNodes: GraphNode[] = [
            termNode('start_1', 'Start\ntest()'),
            stmtNode('stmt_1', 'doA()'),
            stmtNode('stmt_2', 'doB()'),
            termNode('end_1', 'End'),
        ];
        const baselineEdges: GraphEdge[] = [
            flowEdge('e1', 'start_1', 'stmt_1'),
            flowEdge('e2', 'stmt_1', 'stmt_2'),
            flowEdge('e3', 'stmt_2', 'end_1'),
        ];
        const baseline = makeFlowGraph(baselineNodes, baselineEdges);

        // Current (stmt-B removed): Start → stmt-A → End
        const currentNodes: GraphNode[] = [
            termNode('start_2', 'Start\ntest()'),
            stmtNode('stmt_3', 'doA()'),
            termNode('end_2', 'End'),
        ];
        const currentEdges: GraphEdge[] = [
            flowEdge('e10', 'start_2', 'stmt_3'),
            flowEdge('e11', 'stmt_3', 'end_2'),
        ];
        const current = makeFlowGraph(currentNodes, currentEdges);

        appendNonJsDeletedNodes(current, baseline);

        // A ghost node for doB() should appear
        const ghost = current.nodes.find(n => n.diff === 'deleted' && n.label === 'doB()');
        expect(ghost).toBeDefined();

        // At least one deleted edge
        const deletedEdges = current.edges.filter(e => e.diff === 'deleted');
        expect(deletedEdges.length).toBeGreaterThan(0);
    });

    it('does NOT create ghost nodes for statements that survive in current graph', () => {
        const baselineNodes: GraphNode[] = [
            termNode('s1', 'Start\ntest()'),
            stmtNode('n1', 'doA()'),
            stmtNode('n2', 'doB()'),
            termNode('e1', 'End'),
        ];
        const baselineEdges: GraphEdge[] = [
            flowEdge('ed1', 's1', 'n1'),
            flowEdge('ed2', 'n1', 'n2'),
            flowEdge('ed3', 'n2', 'e1'),
        ];
        const baseline = makeFlowGraph(baselineNodes, baselineEdges);

        // Current still has both statements
        const currentNodes: GraphNode[] = [
            termNode('s2', 'Start\ntest()'),
            stmtNode('n3', 'doA()'),
            stmtNode('n4', 'doB()'),
            termNode('e2', 'End'),
        ];
        const currentEdges: GraphEdge[] = [
            flowEdge('ce1', 's2', 'n3'),
            flowEdge('ce2', 'n3', 'n4'),
            flowEdge('ce3', 'n4', 'e2'),
        ];
        const current = makeFlowGraph(currentNodes, currentEdges);

        appendNonJsDeletedNodes(current, baseline);

        const deletedNodes = current.nodes.filter(n => n.diff === 'deleted');
        expect(deletedNodes).toHaveLength(0);
    });

    it('no-op when baseline has no non-terminal nodes', () => {
        const baseline = makeFlowGraph(
            [termNode('s1', 'Start\ntest()'), termNode('e1', 'End')],
            [flowEdge('ed1', 's1', 'e1')],
        );
        const current = makeFlowGraph(
            [termNode('s2', 'Start\ntest()'), termNode('e2', 'End')],
            [flowEdge('ce1', 's2', 'e2')],
        );
        const nodesBefore = current.nodes.length;
        appendNonJsDeletedNodes(current, baseline);
        expect(current.nodes).toHaveLength(nodesBefore);
    });

    it('deleted node edges are remapped to current graph IDs for surviving endpoints', () => {
        // Baseline: Start → survives → deleted → End
        const baseline = makeFlowGraph(
            [
                termNode('bs', 'Start\ntest()'),
                stmtNode('bn1', 'keep()'),
                stmtNode('bn2', 'gone()'),
                termNode('be', 'End'),
            ],
            [
                flowEdge('bed1', 'bs', 'bn1'),
                flowEdge('bed2', 'bn1', 'bn2'),
                flowEdge('bed3', 'bn2', 'be'),
            ],
        );

        // Current: Start → keep() → End (gone() removed)
        const current = makeFlowGraph(
            [
                termNode('cs', 'Start\ntest()'),
                stmtNode('cn1', 'keep()'),
                termNode('ce', 'End'),
            ],
            [
                flowEdge('ced1', 'cs', 'cn1'),
                flowEdge('ced2', 'cn1', 'ce'),
            ],
        );

        appendNonJsDeletedNodes(current, baseline);

        const ghost = current.nodes.find(n => n.diff === 'deleted' && n.label === 'gone()');
        expect(ghost).toBeDefined();

        // The edge from 'keep()' (surviving) to 'gone()' (ghost) should be remapped:
        // source = cn1 (current ID for keep()), target = ghost ID
        const deletedEdge = current.edges.find(
            e => e.diff === 'deleted' && e.source === 'cn1' && e.target === ghost!.id
        );
        expect(deletedEdge).toBeDefined();
    });

    it('handles multiple deleted nodes', () => {
        const baseline = makeFlowGraph(
            [
                termNode('bs', 'Start\ntest()'),
                stmtNode('bn1', 'step1()'),
                stmtNode('bn2', 'step2()'),
                stmtNode('bn3', 'step3()'),
                termNode('be', 'End'),
            ],
            [
                flowEdge('e1', 'bs', 'bn1'),
                flowEdge('e2', 'bn1', 'bn2'),
                flowEdge('e3', 'bn2', 'bn3'),
                flowEdge('e4', 'bn3', 'be'),
            ],
        );

        // Current: only step1() remains
        const current = makeFlowGraph(
            [termNode('cs', 'Start\ntest()'), stmtNode('cn1', 'step1()'), termNode('ce', 'End')],
            [flowEdge('ce1', 'cs', 'cn1'), flowEdge('ce2', 'cn1', 'ce')],
        );

        appendNonJsDeletedNodes(current, baseline);

        const ghost2 = current.nodes.find(n => n.diff === 'deleted' && n.label === 'step2()');
        const ghost3 = current.nodes.find(n => n.diff === 'deleted' && n.label === 'step3()');
        expect(ghost2).toBeDefined();
        expect(ghost3).toBeDefined();
    });
});

// ─── Issue 253: Anonymous route handler flow charts ──────────────────────────

describe('Anonymous route handler flow charts', () => {
    it('builds flow graph from wrapped anonymous arrow function with middleware', () => {
        // Simulates extraction from: router.get('/articles', auth.optional, async (req, res) => {...})
        // The callback is wrapped as: const __handler = async (req, res, next) => { ... }
        const code = `const __handler = async (req, res, next) => {
            try {
                const result = await getArticles(req.query);
                res.json(result);
            } catch (error) {
                next(error);
            }
        }`;
        const graph = buildFlowGraph(code, 'article.controller.ts', 'anonymous@GET:/articles');
        expect(graph).toBeDefined();
        expect(graph.nodes.length).toBeGreaterThan(0);
        expect(graph.graphId).toBe('flow:article.controller.ts:anonymous@GET:/articles');
        // Should have try/catch structure
        const tryNode = graph.nodes.find(n => n.label === 'try');
        expect(tryNode).toBeDefined();
    });

    it('builds flow graph from wrapped anonymous function expression', () => {
        const code = `const __handler = function(req, res) {
            const data = fetchData();
            res.send(data);
        }`;
        const graph = buildFlowGraph(code, 'handler.ts', 'anonymous@POST:/data');
        expect(graph).toBeDefined();
        expect(graph.nodes.length).toBeGreaterThan(0);
    });

    it('fails gracefully for bare block (no function wrapper)', () => {
        // A bare { ... } block is NOT a valid function — should throw
        const code = `{ const x = 1; console.log(x); }`;
        expect(() => buildFlowGraph(code, 'test.ts', 'test')).toThrow('No JavaScript function found');
    });

    it('builds flow graph with if/else in anonymous handler', () => {
        const code = `const __handler = async (req, res) => {
            if (req.auth) {
                const user = await getCurrentUser(req.auth.id);
                res.json(user);
            } else {
                res.status(401).json({ error: 'Unauthorized' });
            }
        }`;
        const graph = buildFlowGraph(code, 'auth.controller.ts', 'anonymous@GET:/user');
        expect(graph).toBeDefined();
        // Should have decision node for the if statement
        const decisions = graph.nodes.filter(n => n.type === 'decision');
        expect(decisions.length).toBeGreaterThanOrEqual(1);
    });
});

// Issue 209 — generator function semantics in flow graphs
describe('flowGraphBuilder — generator functions (Issue 209)', () => {
    it('marks generator function start node and graph meta', () => {
        const code = `function* counter() {\n  yield 1;\n  yield 2;\n  return 3;\n}`;
        const graph = buildFlowGraph(code, 'gen.js');

        // Graph meta carries the generator flag
        expect((graph.meta as any).generator).toBe(true);

        // Start node label is prefixed with * to mirror function* syntax
        const start = graph.nodes.find((n) => n.type === 'terminal' && n.label.startsWith('Start'));
        expect(start).toBeDefined();
        expect(start!.label).toContain('*counter');
        expect((start!.meta as any)?.generator).toBe(true);
    });

    it('tags statements containing yield expressions with meta.yields', () => {
        // Use distinct surrounding statements so consolidation doesn't merge.
        // (Three consecutive bare yields would collapse into one block node.)
        const code = `function* counter() {\n  if (true) yield 1;\n  if (true) yield* other();\n  if (true) { const v = yield 2; void v; }\n}`;
        const graph = buildFlowGraph(code, 'gen.js');

        // Collect every line that yielded, whether standalone or absorbed into
        // a merged block node's meta.statements[].
        let valueYields = 0;
        let delegateYields = 0;
        for (const n of graph.nodes) {
            if ((n.meta as any)?.yieldKind === 'value') valueYields++;
            if ((n.meta as any)?.yieldKind === 'delegate') delegateYields++;
            const subs = (n.meta as any)?.statements as Array<{ yieldKind?: string }> | undefined;
            if (subs) {
                for (const s of subs) {
                    if (s.yieldKind === 'value') valueYields++;
                    if (s.yieldKind === 'delegate') delegateYields++;
                }
            }
        }
        expect(valueYields).toBe(2);
        expect(delegateYields).toBe(1);
    });

    it('does NOT mark a regular (non-generator) function as generator', () => {
        const code = `function plain() {\n  return 1;\n}`;
        const graph = buildFlowGraph(code, 'plain.js');
        expect((graph.meta as any).generator).toBeUndefined();
        const start = graph.nodes.find((n) => n.type === 'terminal' && n.label.startsWith('Start'));
        expect(start!.label).not.toContain('*plain');
        expect((start!.meta as any)?.generator).toBeUndefined();
    });

    it('does NOT cross function boundaries when scanning for yields', () => {
        // Outer generator with a `forEach((x) => { x + 1; })` callback in between
        // two top-level yields. Even though the callback is in source between the
        // two yields, the outer flow should report yields ONLY at the top-level
        // statements `yield 1` and `yield 99`, never anything from the lambda body.
        const code = `function* outer() {\n  yield 1;\n  if (true) [1,2].forEach((x) => { const y = x + 1; });\n  yield 99;\n}`;
        const graph = buildFlowGraph(code, 'gen.js');

        // Count yielding statements across standalone + merged-block carriers.
        let totalYields = 0;
        for (const n of graph.nodes) {
            if ((n.meta as any)?.yields === true && !(n.meta as any)?.statements) totalYields++;
            const subs = (n.meta as any)?.statements as Array<{ yields?: boolean }> | undefined;
            if (subs) {
                for (const s of subs) {
                    if (s.yields === true) totalYields++;
                }
            }
        }
        expect(totalYields).toBe(2);
    });
});
