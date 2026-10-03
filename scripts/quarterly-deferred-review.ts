#!/usr/bin/env tsx
/**
 * quarterly-deferred-review.ts — ADR-026 follow-up
 *
 * Run quarterly (or whenever) to re-evaluate deferred ADRs against their
 * revisit triggers. Outputs a checklist the maintainer can review and
 * decide whether each deferred item now warrants action.
 *
 * Triggers (from ADR-026):
 *   358 — God modules                  →  irreconcilable merge conflict
 *   361 — Persisted file content       →  schema_version v2 soaks 30+ days
 *                                          OR another redaction-corruption bug
 *   362 — graphId routing scheme       →  third back-button bug
 *   373 — Comment convention           →  next major-version cleanup
 *   355 — Telemetry gating             →  first marketplace listing rejection
 *
 * Usage:
 *   npx tsx scripts/quarterly-deferred-review.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..');
const today = new Date().toISOString().slice(0, 10);

interface DeferredItem {
    issue: string;
    title: string;
    adr: string;
    trigger: string;
    /** Function returning auto-detected status. Returns null when the
     *  trigger needs human judgment (we just remind). */
    autoCheck: () => string | null;
}

function fileLineCount(rel: string): number {
    try { return fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n').length; } catch { return 0; }
}

function gitLogSince(daysAgo: number): string {
    try {
        const since = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
        return execSync(`git log --oneline --since="${since}"`, { cwd: ROOT, encoding: 'utf-8' });
    } catch { return ''; }
}

const ITEMS: DeferredItem[] = [
    {
        issue: '358',
        title: 'God modules (extension.ts: 3,086 lines)',
        adr: 'ADR-026',
        trigger: 'First irreconcilable merge conflict in these files',
        autoCheck: () => {
            const sizes = [
                ['src/extension.ts', fileLineCount('src/extension.ts')],
                ['src/core/sync/syncOrchestrator.ts', fileLineCount('src/core/sync/syncOrchestrator.ts')],
                ['src/core/graph/sequenceGraphBuilder.ts', fileLineCount('src/core/graph/sequenceGraphBuilder.ts')],
            ];
            const parts = sizes.map(([f, n]) => `  ${f}: ${n} lines`);
            return `Current sizes:\n${parts.join('\n')}`;
        },
    },
    {
        issue: '361',
        title: 'Stop persisting file content in state.json',
        adr: 'ADR-026',
        trigger: 'schema_version v2 soaks 30+ days OR redaction-corruption bug recurs',
        autoCheck: () => {
            const log = gitLogSince(30);
            const redactionCommits = log.split('\n').filter(l => /redact|sanitize|secret/i.test(l));
            return `Redaction-related commits in last 30 days: ${redactionCommits.length}\n` +
                (redactionCommits.length > 0 ? redactionCommits.map(c => `  ${c}`).join('\n') : '  (none)');
        },
    },
    {
        issue: '362',
        title: 'graphId routing scheme overhaul',
        adr: 'ADR-026',
        trigger: 'Third back-button bug from colon-overload (2 of 3 so far)',
        autoCheck: () => {
            const log = gitLogSince(90);
            const backNavCommits = log.split('\n').filter(l => /back.button|nav.*regression|graphId/i.test(l));
            return `Back-nav / graphId-related commits in last 90 days: ${backNavCommits.length}`;
        },
    },
    {
        issue: '373',
        title: '`// Issue N:` comment convention mass-rename',
        adr: 'ADR-026',
        trigger: 'Next major-version cleanup',
        autoCheck: () => {
            try {
                const out = execSync(`grep -rn "Issue [0-9]\\+:" src/ | wc -l`, { cwd: ROOT, encoding: 'utf-8' }).trim();
                return `Inline "// Issue N:" comments remaining: ${out}`;
            } catch { return null; }
        },
    },
    {
        issue: '355',
        title: 'Telemetry gating on `vscode.env.isTelemetryEnabled`',
        adr: 'ADR-015 (deferred by user)',
        trigger: 'First marketplace listing rejection',
        autoCheck: () => null,  // human signal only
    },
];

function main(): void {
    console.log(`# CodeAtlas — Quarterly Deferred-ADR Review (${today})`);
    console.log();
    console.log('Per ADR-026, re-evaluate each deferred item against its revisit trigger.');
    console.log('When a trigger fires, prioritize the issue for the next sprint.');
    console.log();

    for (const item of ITEMS) {
        console.log(`## Issue ${item.issue} — ${item.title}`);
        console.log(`**ADR:** ${item.adr}`);
        console.log(`**Trigger:** ${item.trigger}`);
        const auto = item.autoCheck();
        if (auto) {
            console.log();
            console.log('### Auto-detected signal');
            console.log('```');
            console.log(auto);
            console.log('```');
        }
        console.log();
        console.log('### Decision');
        console.log('- [ ] Trigger fired → escalate to next sprint');
        console.log('- [ ] Still defer; revisit again next quarter');
        console.log();
        console.log('---');
        console.log();
    }

    console.log(`Next review: ${new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)}`);
}

main();
