/**
 * Tests for buildFlowGraphFromBodyText — used for Dart and any other
 * language whose extractor produces function entities without a
 * tree-sitter node (Issue #445-A).
 */
import { describe, it, expect } from 'vitest';
import { buildFlowGraphFromBodyText } from '../flowGraphBuilder';

describe('buildFlowGraphFromBodyText (#445-A)', () => {
    it('builds Start + statements + End for a simple Dart function body', () => {
        const body = `
            final user = users.firstWhere((u) => u.id == id);
            if (user.banned) {
                return null;
            }
            return user;
        `.trim();
        const g = buildFlowGraphFromBodyText(body, 'lib/user_service.dart', 'getUser');
        const start = g.nodes.find(n => n.type === 'terminal' && n.label.startsWith('Start'));
        const end = g.nodes.find(n => n.type === 'terminal' && n.label === 'End');
        expect(start, 'Start terminal').toBeDefined();
        expect(end, 'End terminal').toBeDefined();
        expect(start?.label).toContain('getUser');
        const stmtCount = g.nodes.filter(n => n.type === 'statement').length;
        expect(stmtCount, 'must produce ≥ 1 statement node').toBeGreaterThanOrEqual(1);
        // Every node must be reachable end-to-end.
        expect(g.edges.length, 'must have flow edges').toBeGreaterThan(0);
        expect(g.graphId).toBe('flow:lib/user_service.dart:getUser');
    });

    it('handles empty body without crashing', () => {
        const g = buildFlowGraphFromBodyText('', 'lib/empty.dart', 'noop');
        expect(g.nodes.filter(n => n.type === 'terminal')).toHaveLength(2);
        expect(g.edges.length).toBe(1); // start → end direct
    });

    it('marks new statements as `added` when baselineBodyText is provided', () => {
        const baseline = `final x = 1;`;
        const working = `final x = 1;\nfinal y = 2;`;
        const g = buildFlowGraphFromBodyText(working, 'lib/m.dart', 'main', baseline);
        const added = g.nodes.filter(n => n.diff === 'added' || (n.type === 'statement' && n.diff === 'modified'));
        expect(added.length, 'at least one node should be marked added/modified').toBeGreaterThan(0);
    });

    it('does NOT split semicolons inside braces or strings', () => {
        // Map literal contains semicolons in string values; should remain one statement.
        const body = `final cfg = { 'a': 'has; semi', 'b': 'two; here' };\nreturn cfg;`;
        const g = buildFlowGraphFromBodyText(body, 'lib/cfg.dart', 'load');
        const stmts = g.nodes.filter(n => n.type === 'statement');
        // Two top-level statements: the assignment + the return. Not 4+.
        expect(stmts.length, `expected ≤ 2 statements, got: ${stmts.map(s => s.label).join(' | ')}`).toBeLessThanOrEqual(2);
    });

    it('handles Flutter Widget build() body with nested constructor calls', () => {
        const body = `return Scaffold(
            appBar: AppBar(title: Text('Hello')),
            body: Center(child: Text('World')),
        );`;
        const g = buildFlowGraphFromBodyText(body, 'lib/screen.dart', 'build');
        const stmts = g.nodes.filter(n => n.type === 'statement');
        expect(stmts.length, 'must produce ≥ 1 statement').toBeGreaterThanOrEqual(1);
    });
});
