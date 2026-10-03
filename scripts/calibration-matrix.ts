#!/usr/bin/env npx tsx
/**
 * calibration-matrix.ts — Issue 610
 *
 * Computes a 5×5 confusion matrix between human-labelled and
 * LLM-predicted severity, with off-by-one cells worth 0.5 (matching the
 * methodology documented in `docs/code-review-calibration-matrix.md`).
 *
 * Usage:
 *   npx tsx scripts/calibration-matrix.ts \
 *     --dataset e2e/llm-quality/fixtures/calibration-dataset.json \
 *     --predictions /tmp/cal-run.json \
 *     [--out docs/code-review-calibration-matrix.md]
 *
 * The dataset rows must carry `id` and `severityHuman`. The predictions
 * file (output of `captureRawFindings.ts`) must carry matching `id` and
 * `severity`. Rows without a prediction are skipped + counted as missing
 * in the summary.
 */
import * as fs from 'fs';
import * as path from 'path';

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function getArg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
    return fallback;
}

function isSeverity(s: any): s is Severity {
    return ORDER.includes(s);
}

function normaliseSeverity(s: any): Severity | null {
    if (s == null) return null;
    const v = String(s).toLowerCase();
    if (v === 'error') return 'high';
    if (v === 'warning') return 'medium';
    return isSeverity(v) ? v : null;
}

interface DatasetItem { id: string; severityHuman: Severity; title?: string }
interface PredictionItem { id: string; severity: Severity }

function loadJson<T>(p: string): T {
    return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
}

/**
 * Build the 5×5 confusion matrix. Cells are weighted: exact match = 1.0,
 * off-by-one (adjacent severity bucket) = 0.5, off-by-two-or-more = 0.0.
 */
function buildMatrix(human: Severity[], llm: Severity[]): number[][] {
    if (human.length !== llm.length) throw new Error('arrays unequal');
    const grid: number[][] = ORDER.map(() => ORDER.map(() => 0));
    for (let i = 0; i < human.length; i++) {
        const h = RANK[human[i]];
        const l = RANK[llm[i]];
        const diff = Math.abs(h - l);
        const weight = diff === 0 ? 1.0 : diff === 1 ? 0.5 : 0.0;
        grid[h][l] += weight;
    }
    return grid;
}

function renderMarkdown(grid: number[][], totals: number[], rawCounts: number[][]): string {
    const headerRow = '| Human \\ LLM | ' + ORDER.join(' | ') + ' | total | agreement |';
    const sep = '|---|' + ORDER.map(() => '---').join('|') + '|---|---|';
    const rows = ORDER.map((sev, i) => {
        const cells = grid[i].map((v) => v.toFixed(1)).join(' | ');
        const total = totals[i];
        const sum = grid[i].reduce((a, b) => a + b, 0);
        const pct = total === 0 ? '—' : `**${Math.round((sum / total) * 100)} %**`;
        return `| **${sev}** | ${cells} | ${total} | ${pct} |`;
    });
    return [headerRow, sep, ...rows].join('\n');
}

function aggregateAgreement(grid: number[][], totals: number[]): number {
    let weighted = 0, count = 0;
    for (let i = 0; i < ORDER.length; i++) {
        weighted += grid[i].reduce((a, b) => a + b, 0);
        count += totals[i];
    }
    return count === 0 ? 0 : Math.round((weighted / count) * 100);
}

function main(): number {
    const dsPath = getArg('dataset');
    const predPath = getArg('predictions');
    const outPath = getArg('out');
    if (!dsPath || !predPath) {
        console.error('usage: calibration-matrix.ts --dataset <file.json> --predictions <file.json> [--out <md>]');
        return 2;
    }
    const ds = loadJson<{ items: DatasetItem[] }>(dsPath);
    const pred = loadJson<{ findings?: any[]; items?: PredictionItem[] }>(predPath);
    const byId = new Map<string, Severity>();
    const predRows = (pred.items ?? pred.findings ?? []) as any[];
    for (const p of predRows) {
        const s = normaliseSeverity(p.severity);
        if (p.id && s) byId.set(String(p.id), s);
    }
    const human: Severity[] = [];
    const llm: Severity[] = [];
    let missing = 0;
    for (const item of ds.items) {
        const got = byId.get(item.id);
        if (!got) { missing += 1; continue; }
        human.push(item.severityHuman);
        llm.push(got);
    }
    if (human.length === 0) {
        console.error('no graded items — check the prediction file ids match the dataset');
        return 1;
    }
    const grid = buildMatrix(human, llm);
    const totals = ORDER.map((_, i) => human.filter((s) => RANK[s] === i).length);
    const rawCounts = ORDER.map(() => ORDER.map(() => 0));
    for (let i = 0; i < human.length; i++) {
        rawCounts[RANK[human[i]]][RANK[llm[i]]] += 1;
    }
    const table = renderMarkdown(grid, totals, rawCounts);
    const agg = aggregateAgreement(grid, totals);
    const report = [
        `## Confusion matrix (computed ${new Date().toISOString().slice(0, 10)})`,
        '',
        `Dataset: \`${dsPath}\` · Predictions: \`${predPath}\` · Graded: ${human.length} · Missing predictions: ${missing}`,
        '',
        table,
        '',
        `**Aggregate agreement: ${agg} %**. GA floor: ≥ 60 % per row.`,
        '',
    ].join('\n');
    if (outPath) {
        // Replace section between markers if present; otherwise append.
        const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
        const startMark = '<!-- calibration-matrix:start -->';
        const endMark = '<!-- calibration-matrix:end -->';
        let next: string;
        if (existing.includes(startMark) && existing.includes(endMark)) {
            const a = existing.indexOf(startMark);
            const b = existing.indexOf(endMark) + endMark.length;
            next = existing.slice(0, a) + startMark + '\n\n' + report + '\n' + endMark + existing.slice(b);
        } else {
            next = existing + (existing.endsWith('\n') ? '' : '\n') + '\n' + startMark + '\n\n' + report + '\n' + endMark + '\n';
        }
        fs.writeFileSync(outPath, next);
        console.log(`wrote ${outPath}`);
    } else {
        console.log(report);
    }
    return 0;
}

const code = main();
process.exit(code);
