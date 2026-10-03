#!/usr/bin/env node
/**
 * replayModel.mjs — #940. Replay the collected CodeAtlas LLM inputs (all-calls.json)
 * against an OpenRouter model WITHOUT re-running the CodeAtlas pipeline. Fires calls
 * with configurable parallelism; model/key/reasoning come from llm.config.json.
 * Per-call cached (resumable). Aggregates findings per PR for judging.
 *
 * Usage:
 *   node replayModel.mjs [all-calls.json]
 *   REPLAY_CONCURRENCY=10 CODEATLAS_LLM_MODEL=anthropic/claude-opus-4.5 node replayModel.mjs
 * Config precedence: env > llm.config.json > default.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const inputPath = process.argv[2] || path.join(HERE, 'results/input-collection/all-calls.json');
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'llm.config.json'), 'utf-8'));
const MODEL = process.env.CODEATLAS_LLM_MODEL || cfg.model;
const API_KEY = process.env.OPENROUTER_API_KEY || cfg.apiKey;
const REASONING = process.env.CODEATLAS_LLM_REASONING_EFFORT || cfg.reasoning || '';
const CONCURRENCY = Number(process.env.REPLAY_CONCURRENCY) || Number(cfg.concurrency) || 10;
const TIMEOUT_MS = Number(process.env.REPLAY_TIMEOUT_MS) || 300_000;
const TEMP = process.env.REPLAY_TEMPERATURE !== undefined ? Number(process.env.REPLAY_TEMPERATURE) : 0.3;
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// #940 — per-PR de-dup phase: after collecting a PR's findings, an LLM consolidation
// call merges same-root-cause restatements (incl. cross-file) into distinct defects,
// which sharply lifts precision. On by default; REPLAY_DEDUP=0 disables. Defaults to the
// same model but NO reasoning (dedup is cheap clustering — xhigh would just be slow).
const DEDUP = process.env.REPLAY_DEDUP !== '0';
const DEDUP_MODEL = process.env.REPLAY_DEDUP_MODEL || MODEL;
const DEDUP_EFFORT = process.env.REPLAY_DEDUP_EFFORT || '';

if (!API_KEY) { console.error('No apiKey in llm.config.json / OPENROUTER_API_KEY'); process.exit(2); }
const calls = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
const slug = (s) => s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
const outDir = path.join(HERE, 'results', `replay-${slug(process.env.REPLAY_OUT_SLUG || MODEL)}`);
const cacheDir = path.join(outDir, 'calls');
const dedupCacheDir = path.join(outDir, 'dedup');
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(dedupCacheDir, { recursive: true });

/** One OpenRouter chat call → {content, usage, error}. Shared by review + dedup. */
async function chat(model, messages, effort) {
    const body = JSON.stringify({ model, messages, temperature: TEMP, ...(effort ? { reasoning: { effort } } : {}) });
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            const r = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body, signal: ctrl.signal });
            clearTimeout(timer);
            if (!r.ok) { const txt = await r.text(); if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 2000 * attempt)); continue; } return { content: '', usage: null, error: `HTTP ${r.status}: ${txt.slice(0, 160)}` }; }
            const j = await r.json();
            return { content: j.choices?.[0]?.message?.content ?? '', usage: j.usage || null, error: null };
        } catch (e) { clearTimeout(timer); if (attempt < 3) await new Promise((res) => setTimeout(res, 2000 * attempt)); else return { content: '', usage: null, error: String(e.message || e) }; }
    }
    return { content: '', usage: null, error: 'exhausted retries' };
}

console.error(`Replaying ${calls.length} calls · model=${MODEL} · reasoning=${REASONING || 'off'} · concurrency=${CONCURRENCY} → ${path.relative(HERE, outDir)}`);

/** Tolerant {"findings":[...]} extractor — strips fences, finds the JSON object. */
function parseFindings(text) {
    if (!text) return [];
    let t = String(text).replace(/```(?:json)?/gi, '').trim();
    // direct parse
    try { const o = JSON.parse(t); if (Array.isArray(o.findings)) return o.findings; if (Array.isArray(o)) return o; } catch { /* fall through */ }
    // find the findings array
    const m = t.match(/"findings"\s*:\s*(\[[\s\S]*\])/);
    if (m) { try { return JSON.parse(m[1]); } catch { /* */ } }
    // first balanced object containing findings
    const i = t.indexOf('{');
    if (i >= 0) { try { const o = JSON.parse(t.slice(i)); if (Array.isArray(o.findings)) return o.findings; } catch { /* */ } }
    return [];
}

async function fireOne(call) {
    const cacheFile = path.join(cacheDir, `${slug(call.key)}__${call.idx}.json`);
    if (fs.existsSync(cacheFile)) { try { return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')); } catch { /* refetch */ } }
    const body = JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: call.system }, { role: 'user', content: call.user }],
        temperature: TEMP,
        ...(REASONING ? { reasoning: { effort: REASONING } } : {}),
    });
    let out = { key: call.key, pr: call.pr, repo: call.repo, idx: call.idx, pass: call.pass, ok: false, findings: [], usage: null, error: null };
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            const r = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body, signal: ctrl.signal });
            clearTimeout(timer);
            if (!r.ok) { const txt = await r.text(); if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 2000 * attempt)); continue; } out.error = `HTTP ${r.status}: ${txt.slice(0, 160)}`; break; }
            const j = await r.json();
            const content = j.choices?.[0]?.message?.content ?? '';
            out = { ...out, ok: true, findings: parseFindings(content), usage: j.usage || null, error: null };
            break;
        } catch (e) { clearTimeout(timer); out.error = String(e.message || e); if (attempt < 3) await new Promise((res) => setTimeout(res, 2000 * attempt)); }
    }
    // Cache ONLY successful calls — so a re-run retries failures (e.g. after a key fix)
    // instead of returning a cached 401.
    if (out.ok) fs.writeFileSync(cacheFile, JSON.stringify(out));
    return out;
}

const DEDUP_SYS = 'You consolidate code-review findings into DISTINCT defects. Two findings are the SAME defect if they share the same ROOT CAUSE — even when reported across different files/lines (e.g. the same unawaited-async-in-forEach pattern in 5 files = ONE defect), OR the same defect re-described across SIBLING IMPLEMENTATIONS of a shared interface (#953 — parallel adapters/services, "Office365 has the same bug as Lark", "UserPermissionsV2 mirrors GroupPermissionsV2") = ONE defect. Merge all restatements; keep genuinely different root causes separate. Preserve the strongest wording. Return ONLY JSON: {"defects":[{"title":"...","severity":"info|warning|error","file":"...","body":"...","mergedFrom":[1,6,9]}]} where mergedFrom lists the 1-based finding numbers merged. No prose, no fences.';

/** Consolidate one PR's raw findings into distinct defects via an LLM clustering call. */
async function dedupPR(key, findings) {
    if (findings.length <= 1) return { defects: findings.map((f, i) => ({ title: f.title || '', severity: f.severity || '', file: f.anchor?.filePath || f.filePath || '', body: f.body || '', mergedFrom: [i + 1] })), usage: null, error: null, raw: findings.length };
    const cacheFile = path.join(dedupCacheDir, `${slug(key)}.json`);
    if (fs.existsSync(cacheFile)) { try { return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')); } catch { /* refetch */ } }
    const list = findings.map((f, i) => `#${i + 1} [${f.severity || ''}] (${f.anchor?.filePath || f.filePath || ''}) ${f.title || ''} — ${String(f.body || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
    const { content, usage, error } = await chat(DEDUP_MODEL, [{ role: 'system', content: DEDUP_SYS }, { role: 'user', content: `Findings for this PR:\n${list}` }], DEDUP_EFFORT);
    let defects = [];
    if (!error) { try { const t = content.replace(/```(?:json)?/gi, '').trim(); const o = JSON.parse(t.slice(t.indexOf('{'))); if (Array.isArray(o.defects)) defects = o.defects; } catch { /* keep raw on parse fail */ } }
    // On dedup failure, fall back to raw findings (never lose data).
    if (!defects.length) defects = findings.map((f, i) => ({ title: f.title || '', severity: f.severity || '', file: f.anchor?.filePath || f.filePath || '', body: f.body || '', mergedFrom: [i + 1] }));
    const out = { defects, usage, error, raw: findings.length };
    if (!error) fs.writeFileSync(cacheFile, JSON.stringify(out));
    return out;
}

// Bounded-concurrency pool.
let done = 0, failed = 0;
async function run() {
    const results = new Array(calls.length);
    let next = 0;
    async function worker() {
        while (next < calls.length) {
            const i = next++;
            const r = await fireOne(calls[i]);
            results[i] = r;
            done++; if (!r.ok) failed++;
            if (done % 10 === 0 || done === calls.length) console.error(`  ${done}/${calls.length} (${failed} failed)`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, calls.length) }, worker));
    // Aggregate per PR.
    const byPr = {};
    for (const r of results) {
        const k = r.key; (byPr[k] ??= { repo: r.repo, pr: r.pr, findings: [], calls: 0, promptTokens: 0, completionTokens: 0, errors: 0 });
        byPr[k].calls++;
        if (r.usage) { byPr[k].promptTokens += r.usage.prompt_tokens || 0; byPr[k].completionTokens += r.usage.completion_tokens || 0; }
        if (r.error) byPr[k].errors++;
        for (const f of (r.findings || [])) byPr[k].findings.push({ ...f, _pass: r.pass });
    }
    // #940 — DEDUP PHASE: consolidate each PR's raw findings into distinct defects (parallel).
    if (DEDUP) {
        const keys = Object.keys(byPr);
        console.error(`\nDe-duplicating ${keys.length} PRs (model=${DEDUP_MODEL}, effort=${DEDUP_EFFORT || 'off'})…`);
        let di = 0, ddone = 0;
        async function dworker() {
            while (di < keys.length) {
                const k = keys[di++];
                const r = await dedupPR(k, byPr[k].findings);
                byPr[k].dedupedDefects = r.defects;
                byPr[k].rawFindings = byPr[k].findings.length;
                byPr[k].dedupCollapsed = byPr[k].findings.length - r.defects.length;
                if (r.usage) byPr[k].completionTokens += r.usage.completion_tokens || 0, byPr[k].promptTokens += r.usage.prompt_tokens || 0;
                ddone++; if (ddone % 5 === 0 || ddone === keys.length) console.error(`  dedup ${ddone}/${keys.length}`);
            }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, dworker));
    }
    fs.writeFileSync(path.join(outDir, 'findings.json'), JSON.stringify({ model: MODEL, reasoning: REASONING, concurrency: CONCURRENCY, dedup: DEDUP, dedupModel: DEDUP ? DEDUP_MODEL : null, perPR: byPr }, null, 2));
    const T = Object.values(byPr);
    const rawTot = T.reduce((a, p) => a + p.findings.length, 0);
    const ddTot = T.reduce((a, p) => a + (p.dedupedDefects?.length ?? p.findings.length), 0);
    console.error(`\nDONE → ${path.relative(HERE, outDir)}/findings.json`);
    console.error(`PRs: ${T.length} · raw findings: ${rawTot}${DEDUP ? ` → ${ddTot} distinct defects (${rawTot - ddTot} merged)` : ''} · prompt tok: ${T.reduce((a, p) => a + p.promptTokens, 0).toLocaleString()} · completion tok: ${T.reduce((a, p) => a + p.completionTokens, 0).toLocaleString()} · call errors: ${T.reduce((a, p) => a + p.errors, 0)}`);
}
run().catch((e) => { console.error('replay failed:', e); process.exit(1); });
