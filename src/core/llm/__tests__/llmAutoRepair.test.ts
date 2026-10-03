/**
 * llmAutoRepair.test.ts — Issue #704 auto-repair leg.
 *
 * The Zod *schema-inference* leg of #704 ships at
 * `src/core/parser/schemaInference/zod.ts`. This module covers the
 * OTHER half — taking an LLM call that emits structured JSON and, when
 * the JSON fails to match a Zod schema, sending a targeted re-prompt to
 * fix the offending field rather than dropping the entire response.
 *
 * Distinct from the relaxed-schema repair in `findingSchema.ts` — that
 * pass is purely LOCAL (coercion + tolerant schema). Auto-repair calls
 * back to the LLM with a corrective prompt that quotes the validation
 * error. Use this when the strict shape really matters and a single
 * repair round-trip is cheap compared to dropping the response.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { llmWithAutoRepair } from '../llmAutoRepair';

const schema = z.object({
    title: z.string().min(1),
    bullets: z.array(z.string()).min(1),
    severity: z.enum(['low', 'medium', 'high']),
});

describe('llmWithAutoRepair', () => {
    it('returns data verbatim when the first call already matches', async () => {
        const llm = vi.fn().mockResolvedValueOnce(
            JSON.stringify({ title: 't', bullets: ['a'], severity: 'low' }),
        );
        const result = await llmWithAutoRepair({
            llmCall: llm,
            schema,
            initialPrompt: 'p',
        });
        if ('error' in result) throw new Error('expected success, got: ' + result.error);
        expect(result.data.title).toBe('t');
        expect(result.repaired).toBe(0);
        expect(llm).toHaveBeenCalledTimes(1);
    });

    it('re-prompts when first response has a Zod-invalid field, succeeds on second try', async () => {
        // First response: severity wrong (must be one of low|medium|high).
        // Second response: corrected.
        const llm = vi.fn()
            .mockResolvedValueOnce(JSON.stringify({ title: 't', bullets: ['a'], severity: 'critical' }))
            .mockResolvedValueOnce(JSON.stringify({ title: 't', bullets: ['a'], severity: 'high' }));
        const result = await llmWithAutoRepair({
            llmCall: llm,
            schema,
            initialPrompt: 'Pretend to write a summary.',
        });
        if ('error' in result) throw new Error('expected success, got: ' + result.error);
        expect(result.data.severity).toBe('high');
        expect(result.repaired).toBe(1);
        expect(llm).toHaveBeenCalledTimes(2);
        // The second call must include both the original prompt context AND the
        // validation-error quote so the LLM can self-correct.
        const repairPrompt = llm.mock.calls[1][0] as string;
        expect(repairPrompt).toMatch(/severity|critical|invalid/i);
        expect(repairPrompt).toMatch(/low|medium|high/); // the allowed values
    });

    it('re-prompts when the response is not valid JSON at all', async () => {
        const llm = vi.fn()
            .mockResolvedValueOnce('Here is the summary: { title: t, bullets: [a] }')   // malformed
            .mockResolvedValueOnce(JSON.stringify({ title: 'Recovered', bullets: ['ok'], severity: 'low' }));
        const result = await llmWithAutoRepair({
            llmCall: llm,
            schema,
            initialPrompt: 'p',
        });
        if ('error' in result) throw new Error('expected success, got: ' + result.error);
        expect(result.data.title).toBe('Recovered');
        expect(result.repaired).toBe(1);
        const repairPrompt = llm.mock.calls[1][0] as string;
        expect(repairPrompt).toMatch(/JSON/i);
    });

    it('respects maxRepairs and returns an error when the LLM keeps failing', async () => {
        const llm = vi.fn().mockResolvedValue('not json');
        const result = await llmWithAutoRepair({
            llmCall: llm,
            schema,
            initialPrompt: 'p',
            maxRepairs: 2,
        });
        if (!('error' in result)) throw new Error('expected error, got success');
        // maxRepairs: 2 means we send the corrective prompt up to 2 times,
        // so the total number of LLM calls is 3 (1 initial + 2 repair tries).
        expect(llm).toHaveBeenCalledTimes(3);
        expect(result.error).toMatch(/repair|schema|invalid/i);
    });

    it('defaults to maxRepairs=1 — one corrective re-prompt then giveup', async () => {
        const llm = vi.fn().mockResolvedValue('not json');
        const result = await llmWithAutoRepair({
            llmCall: llm,
            schema,
            initialPrompt: 'p',
        });
        if (!('error' in result)) throw new Error('expected error, got success');
        // 1 initial + 1 repair = 2 calls total.
        expect(llm).toHaveBeenCalledTimes(2);
    });

    it('surfaces the Zod-issue paths in the repair prompt so the LLM knows what to fix', async () => {
        const llm = vi.fn()
            // Two failures so we can inspect the second prompt.
            .mockResolvedValueOnce(JSON.stringify({ title: '', bullets: [], severity: 'low' }))
            .mockResolvedValueOnce(JSON.stringify({ title: 'ok', bullets: ['x'], severity: 'low' }));
        const result = await llmWithAutoRepair({
            llmCall: llm,
            schema,
            initialPrompt: 'Summarise.',
        });
        if ('error' in result) throw new Error('expected success, got: ' + result.error);
        const repairPrompt = llm.mock.calls[1][0] as string;
        // Should mention BOTH problematic fields so the LLM addresses them in one shot.
        expect(repairPrompt).toMatch(/title/);
        expect(repairPrompt).toMatch(/bullets/);
    });
});
