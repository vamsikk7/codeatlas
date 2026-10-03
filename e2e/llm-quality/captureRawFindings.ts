#!/usr/bin/env node
/**
 * captureRawFindings.ts — Issue 605
 *
 * Drives a live LLM against the bench corpus and writes its raw findings
 * (pre-gate) to a JSON file, ready to be lifted into the canonical
 * `findings-small-coder-model.ts` / `findings-capable-model.ts` fixtures.
 *
 * Use cases:
 *   • Refreshing fixtures after a major prompt rewrite.
 *   • Sanity-checking a newly added model class (e.g. local llama3:8b).
 *   • Capturing real-world keep-rate numbers — `keepRateBench.spec.ts`
 *     asserts synthetic floors; THIS script answers "what does the real
 *     model emit and what fraction survives the gate?"
 *
 * NOT run in CI. Requires:
 *   • A running LLM endpoint (Ollama, OpenAI, OpenRouter, Anthropic).
 *   • The model id + endpoint passed via env.
 *
 * Usage:
 *   OLLAMA=1 MODEL=deepseek-coder:6.7b \
 *     node --import tsx/esm e2e/llm-quality/captureRawFindings.ts \
 *     --out /tmp/captured-deepseek.json
 *
 *   OPENROUTER_KEY=sk-... MODEL=openai/gpt-4o-mini \
 *     node --import tsx/esm e2e/llm-quality/captureRawFindings.ts \
 *     --out /tmp/captured-gpt4o.json
 *
 * The captured JSON is human-readable. Inspect, hand-pick the realistic
 * findings (drop obvious junk), then port the relevant ones into the
 * bench fixture files.
 */
import * as fs from 'fs';
import * as path from 'path';
import { sendOpenRouterRequest } from '../../src/core/llm/openRouterClient';
import { evidenceMatches, isSmallCoderModel } from '../../src/core/llm/perEntryReviewer';
import { BENCH_SOURCE } from './fixtures/source-corpus';

interface RawCapture {
    title?: string;
    severity?: string;
    body?: string;
    evidence?: { snippet?: string };
}

function getArg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
    return fallback;
}

async function main(): Promise<number> {
    const outPath = getArg('out');
    if (!outPath) {
        console.error('usage: captureRawFindings.ts --out <file.json>');
        return 2;
    }

    const model = process.env.MODEL ?? 'deepseek-coder:6.7b';
    const useOllama = process.env.OLLAMA === '1';
    const provider = useOllama ? 'ollama' : (process.env.PROVIDER ?? 'openrouter');
    const apiKey = process.env.OPENROUTER_KEY ?? process.env.OPENAI_KEY ?? '';

    const system = `You are a senior code reviewer. Review the source below against this guideline:
- All POST/PUT/PATCH routes that touch the users table must validate input before any DB call.
- bcrypt salt rounds must be ≥ 12 in production.

For every issue you find, emit a JSON object: { "severity": "warning|error|info", "title": "...", "body": "...", "evidence": { "snippet": "<verbatim line(s) from source>" } }.

Wrap the array in { "findings": [...] }. Quote source VERBATIM in evidence.snippet.`;

    const user = `Source file (excerpt from a real Express + Prisma auth handler):\n\n\`\`\`ts\n${BENCH_SOURCE}\n\`\`\``;

    console.log(`Capturing raw findings from ${provider}:${model}…`);
    const start = Date.now();
    const resp = await sendOpenRouterRequest(
        {
            apiKey,
            model,
            timeoutMs: 5 * 60 * 1000,
            provider,
            responseFormat: 'json_object',
        },
        [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
    );
    const durationMs = Date.now() - start;

    let parsed: { findings?: RawCapture[] } = {};
    try {
        parsed = JSON.parse(resp.text);
    } catch (err) {
        console.error('LLM returned non-JSON:', resp.text.slice(0, 500));
        return 1;
    }
    const raw = parsed.findings ?? [];

    // Score each finding against both tolerances.
    const tol = isSmallCoderModel(model) ? 'relaxed' : 'strict';
    const scored = raw.map((f) => {
        const snip = f.evidence?.snippet ?? '';
        return {
            ...f,
            gate: {
                strict: snip ? evidenceMatches(snip, BENCH_SOURCE, 'strict') : false,
                relaxed: snip ? evidenceMatches(snip, BENCH_SOURCE, 'relaxed') : false,
                autoPick: tol,
            },
        };
    });

    const summary = {
        model,
        provider,
        autoTolerance: tol,
        durationMs,
        rawCount: raw.length,
        strictKept: scored.filter((s) => s.gate.strict).length,
        relaxedKept: scored.filter((s) => s.gate.relaxed).length,
        strictKeepRate: raw.length === 0 ? 0 : scored.filter((s) => s.gate.strict).length / raw.length,
        relaxedKeepRate: raw.length === 0 ? 0 : scored.filter((s) => s.gate.relaxed).length / raw.length,
    };

    const out = { capturedAt: new Date().toISOString(), summary, findings: scored };
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(out, null, 2));

    console.log(`\nCaptured ${raw.length} raw findings → ${outPath}`);
    console.log(`  strict keep-rate:  ${(summary.strictKeepRate * 100).toFixed(1)}%  (${summary.strictKept}/${raw.length})`);
    console.log(`  relaxed keep-rate: ${(summary.relaxedKeepRate * 100).toFixed(1)}%  (${summary.relaxedKept}/${raw.length})`);
    console.log(`  auto-picked tolerance for this model: ${tol}`);
    return 0;
}

main().then((c) => process.exit(c)).catch((err) => {
    console.error(err);
    process.exit(1);
});
