#!/usr/bin/env node
/**
 * runRawLlmArm.mjs — #849 (2026-06-12).
 *
 * The "raw LLM" benchmark arm: SAME model, SAME comment schema, but the
 * input is just the PR's unified diff (plus file context the model asks
 * for is deliberately NOT provided in v1 — disclose this in the writeup;
 * a file-read-tool variant is the planned fairness follow-up).
 *
 * For each case: fetch the PR diff from GitHub → one chat call asking for
 * review comments as strict JSON [{path, line, body}] → record usage +
 * wall-clock → results/raw_llm_reviews.json (same shape as the CodeAtlas
 * arm, tool: "raw-llm").
 *
 * Usage:
 *   OPENROUTER_API_KEY=… [BENCH_MODEL=anthropic/claude-sonnet-4.5] \
 *   GITHUB_TOKEN=… node e2e/benchmark/runRawLlmArm.mjs [--limit N] [--case <substr>] [--runs N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// BENCH_RESULTS_DIR override — keep run outputs out of the repo (e.g. /tmp) for pre-publish review.
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR || path.join(HERE, 'results');
const CASES_PATH = path.join(RESULTS_DIR, 'cases.json');
const OUT_PATH = path.join(RESULTS_DIR, 'raw_llm_reviews.json');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const LIMIT = parseInt(flag('limit', '0'), 10) || 0;
const CASE_FILTER = flag('case', '');
const RUNS = Math.max(1, parseInt(flag('runs', '1'), 10) || 1);
const MODEL = process.env.BENCH_MODEL ?? 'anthropic/claude-sonnet-4.5';
const OR_KEY = process.env.OPENROUTER_API_KEY ?? '';
const GH_TOKEN = process.env.GITHUB_TOKEN ?? '';
// Endpoint: OpenRouter by default; set RAW_LLM_BASE_URL to point at a local
// OpenAI-compatible server (e.g. ollama: http://localhost:11434/v1/chat/completions)
// for the "raw local model, no CodeAtlas" arm. Local endpoints need no key.
const BASE_URL = process.env.RAW_LLM_BASE_URL ?? 'https://openrouter.ai/api/v1/chat/completions';
const IS_LOCAL = !BASE_URL.includes('openrouter.ai');
// Diff cap — diffs beyond this are truncated WITH a marker (recorded in the
// result so truncated cases can be excluded or disclosed).
const DIFF_CHAR_CAP = 360_000; // ~90k tokens

if (!OR_KEY && !IS_LOCAL) { console.error('OPENROUTER_API_KEY required (or set RAW_LLM_BASE_URL for local)'); process.exit(2); }
if (!fs.existsSync(CASES_PATH)) { console.error('run fetchCorpus.mjs first'); process.exit(2); }

const SYSTEM = `You are an expert code reviewer. Review the pull request diff and report real issues only:
bugs, race conditions, security problems, data loss, broken error handling, API misuse.
Do NOT report style nits, formatting, or speculative concerns without evidence in the diff.
Respond with STRICT JSON: an array of {"path": string, "line": number|null, "body": string}.
"path" is the new-file path from the diff; "line" is the new-side line number your comment
targets (null if it applies to the whole file/PR). "body" explains the issue and the fix.
Return [] if you find no real issues. No prose outside the JSON.`;

async function fetchDiff(c) {
    const res = await fetch(`https://api.github.com/repos/${c.repoSlug}/pulls/${c.prNumber}`, {
        headers: {
            'Accept': 'application/vnd.github.v3.diff',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'codeatlas-benchmark',
            ...(GH_TOKEN ? { 'Authorization': `Bearer ${GH_TOKEN}` } : {}),
        },
    });
    if (!res.ok) throw new Error(`diff fetch ${res.status}`);
    return res.text();
}

async function callModel(diff) {
    // Local servers (ollama) can take minutes on a big diff — use undici with
    // a long timeout so the request isn't killed at ~300s like Node fetch.
    const { Agent, fetch: undiciFetch } = IS_LOCAL ? await import('undici') : { Agent: null, fetch };
    const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(OR_KEY ? { 'Authorization': `Bearer ${OR_KEY}` } : {}) },
        body: JSON.stringify({
            model: MODEL,
            temperature: 0,
            // Reasoning models (e.g. gemma-heretic) spend completion budget on
            // reasoning before the JSON; without a high cap the array gets
            // truncated ("Unexpected end of JSON input"). Local ollama maps
            // this to num_predict.
            max_tokens: 8000,
            messages: [
                { role: 'system', content: SYSTEM },
                { role: 'user', content: `Review this pull request diff:\n\n\`\`\`diff\n${diff}\n\`\`\`` },
            ],
        }),
        ...(IS_LOCAL ? { dispatcher: new Agent({ headersTimeout: 1800000, bodyTimeout: 1800000 }) } : {}),
    };
    const res = await (IS_LOCAL ? undiciFetch : fetch)(BASE_URL, opts);
    if (!res.ok) throw new Error(`model call ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return { text: json.choices?.[0]?.message?.content ?? '[]', usage: json.usage ?? null };
}

function parseComments(text) {
    // Strip ```json fences some models wrap output in.
    let t = text.replace(/```(?:json)?/gi, '').trim();
    // Accept a bare array OR an object with a findings/comments/issues array.
    let arr;
    const am = t.match(/\[[\s\S]*\]/);
    if (am) {
        arr = JSON.parse(am[0]);
    } else {
        const obj = JSON.parse(t);
        arr = obj.findings ?? obj.comments ?? obj.issues ?? [];
    }
    if (!Array.isArray(arr)) throw new Error('model output is not a JSON array');
    return arr
        .filter((c) => c && typeof c.body === 'string' && c.body.trim())
        .map((c) => ({
            path: typeof c.path === 'string' ? c.path : null,
            line: Number.isFinite(c.line) ? c.line : null,
            body: c.body,
        }));
}

const cases = Object.values(JSON.parse(fs.readFileSync(CASES_PATH, 'utf-8')))
    .filter((c) => c.baseSha && c.headSha)
    .filter((c) => !CASE_FILTER || c.url.includes(CASE_FILTER));
const selected = LIMIT > 0 ? cases.slice(0, LIMIT) : cases;

const out = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8')) : {};
let done = 0, failed = 0;

for (const c of selected) {
    for (let run = 1; run <= RUNS; run++) {
        const key = RUNS > 1 ? `${c.url}#run${run}` : c.url;
        if (out[key]?.review_comments) { console.error(`cached: ${key}`); continue; }
        console.error(`\n=== raw-llm ${c.repoSlug}#${c.prNumber} (run ${run}/${RUNS})`);
        try {
            let diff = await fetchDiff(c);
            const truncated = diff.length > DIFF_CHAR_CAP;
            if (truncated) diff = diff.slice(0, DIFF_CHAR_CAP) + '\n[diff truncated]';
            const t0 = Date.now();
            const { text, usage } = await callModel(diff);
            const wallMs = Date.now() - t0;
            const review_comments = parseComments(text);
            out[key] = {
                tool: 'raw-llm',
                url: c.url,
                repoSlug: c.repoSlug,
                prNumber: c.prNumber,
                run,
                review_comments,
                meter: {
                    tokensUsed: usage ? { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0, calls: 1 } : null,
                    model: MODEL,
                    wallClockMs: wallMs,
                    diffChars: diff.length,
                    diffTruncated: truncated,
                    commentCount: review_comments.length,
                },
            };
            done++;
            console.error(`  ok: ${review_comments.length} comments, ${(usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0)} tokens, ${Math.round(wallMs / 1000)}s${truncated ? ' (DIFF TRUNCATED)' : ''}`);
        } catch (err) {
            failed++;
            out[key] = { tool: 'raw-llm', url: c.url, run, error: String(err.message).slice(0, 500) };
            console.error(`  FAILED: ${err.message}`);
        }
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
        fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
    }
}

console.error(`\nraw-llm arm: ${done} reviewed, ${failed} failed → ${OUT_PATH}`);
process.exit(failed > 0 ? 1 : 0);
