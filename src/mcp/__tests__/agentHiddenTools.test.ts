import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AGENT_HIDDEN_TOOLS } from '../mcp-tools';

// #857 — guard the agent tool surface: every hidden name must be a real
// registered tool (catch typos/renames), and the filter must shrink the list.
describe('AGENT_HIDDEN_TOOLS (#857)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'mcp-tools.ts'), 'utf-8');
    const registered = new Set([...src.matchAll(/name: '([a-z_]+)',\s*\n\s*description:/g)].map((m) => m[1]));

    it('every hidden tool is actually registered (no typos / stale names)', () => {
        const ghosts = [...AGENT_HIDDEN_TOOLS].filter((n) => !registered.has(n));
        expect(ghosts).toEqual([]);
    });

    it('hides the interactive/UI/triage surface but keeps core code-intel tools', () => {
        for (const n of ['connect_websocket', 'run_api_chain', 'get_tour', 'clear_findings', 'list_saved_views']) {
            expect(AGENT_HIDDEN_TOOLS.has(n)).toBe(true);
        }
        for (const n of ['get_impact_analysis', 'get_entrypoint_pack', 'review_diff_with_baseline', 'trace_call_path', 'get_regression_scope', 'search_workspace']) {
            expect(AGENT_HIDDEN_TOOLS.has(n)).toBe(false);
        }
    });

    it('surfaced count is meaningfully smaller than the full registry', () => {
        const surfaced = [...registered].filter((n) => !AGENT_HIDDEN_TOOLS.has(n));
        expect(registered.size).toBeGreaterThan(surfaced.length);
        expect(surfaced.length).toBe(registered.size - AGENT_HIDDEN_TOOLS.size);
    });
});
