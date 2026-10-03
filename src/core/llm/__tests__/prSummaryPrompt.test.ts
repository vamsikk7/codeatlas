/**
 * prSummaryPrompt tests.
 *
 * Covers the prompt builder (key clauses survive) + the mapping-rule
 * validator (R1 no orphan criticals, R2 no invented instructions, R3 strict
 * subset, R4 severity-flows-up, R5 recommendation match).
 */

import { describe, it, expect } from 'vitest';
import {
    buildPrSummarySystemPrompt,
    validatePrSummary,
    type PrSummaryDoc,
} from '../prSummaryPrompt';

function validDoc(overrides: Partial<PrSummaryDoc> = {}): PrSummaryDoc {
    return {
        header: { title: 'Auth tightening', recommendation: 'block', severity: 'error' },
        summary: 'Adds CSRF + tightens admin auth. Introduces one merge-blocker.',
        interpretation: {
            reframe: 'This is a privileged-write hardening pass, not a feature.',
            shift: {
                before: 'Admin endpoints accept session-less POST.',
                after: 'All writes require CSRF + verified session.',
                implication: 'Removes the simplest forged-request attack surface.',
            },
            pattern: 'Every finding sits on the auth-on-writes axis.',
        },
        findings: [
            {
                id: 'F1', severity: 'error', category: 'security',
                title: 'POST /admin missing CSRF',
                mechanism: 'Without a CSRF token any third-party origin can issue authenticated POST /admin requests against a logged-in user.',
                body: 'Add CSRF middleware to the admin router.',
                evidence: { snippet: 'router.post(\'/admin\', adminController.delete)' },
            },
            {
                id: 'F2', severity: 'warning', category: 'code-quality',
                title: 'Auth middleware ordering',
                mechanism: 'rateLimit() runs before auth(), so unauthenticated requests still consume the limiter budget.',
                body: 'Swap the middleware order so auth runs first.',
                evidence: { snippet: 'app.use(rateLimit()); app.use(auth());' },
            },
        ],
        instructions: {
            items: [
                {
                    id: 'I1', addresses: ['F1'],
                    action: 'Add csurf() middleware to /admin routes.',
                    acceptance: 'POST /admin responds 403 when X-CSRF-Token is missing.',
                },
                {
                    id: 'I2', addresses: ['F2'],
                    action: 'Move auth() above rateLimit() in app.ts.',
                    acceptance: 'Unauthenticated requests do not decrement the rate limit counter.',
                },
            ],
            mergeBlockers: ['I1'],
        },
        ...overrides,
    };
}

describe('buildPrSummarySystemPrompt', () => {
    it('lists the five fixed blocks in order', () => {
        const p = buildPrSummarySystemPrompt();
        const order = ['"header"', '"summary"', '"interpretation"', '"findings"', '"instructions"'];
        let last = -1;
        for (const k of order) {
            const idx = p.indexOf(k);
            expect(idx, `block ${k} not found`).toBeGreaterThan(-1);
            expect(idx, `${k} out of order`).toBeGreaterThan(last);
            last = idx;
        }
    });

    it('names the MECHANISM field explicitly', () => {
        const p = buildPrSummarySystemPrompt();
        expect(p).toContain('mechanism');
        expect(p).toContain('the *how*');
    });

    it('names the acceptance condition on instructions', () => {
        const p = buildPrSummarySystemPrompt();
        expect(p).toContain('acceptance');
        expect(p).toContain('observable');
    });

    it('enumerates the five mapping rules R1–R5', () => {
        const p = buildPrSummarySystemPrompt();
        for (const rule of ['R1.', 'R2.', 'R3.', 'R4.', 'R5.']) {
            expect(p).toContain(rule);
        }
        expect(p).toContain('No orphan criticals');
        expect(p).toContain('No invented instructions');
        expect(p).toContain('strict subset');
        expect(p).toContain('Severity flows up');
    });

    it('injects user guidelines verbatim when provided', () => {
        const p = buildPrSummarySystemPrompt({ guidelinesText: 'flag any TODOs in auth' });
        expect(p).toContain('[USER GUIDELINES BEGIN]');
        expect(p).toContain('flag any TODOs in auth');
        expect(p).toContain('[USER GUIDELINES END]');
    });
});

describe('validatePrSummary', () => {
    it('passes a well-formed doc', () => {
        const report = validatePrSummary(validDoc());
        expect(report.ok, JSON.stringify(report.violations, null, 2)).toBe(true);
    });

    it('R1: flags an error finding that no instruction addresses', () => {
        const doc = validDoc({
            instructions: { items: [], mergeBlockers: [] },
            header: { title: 't', recommendation: 'request-changes', severity: 'error' },
        });
        const report = validatePrSummary(doc);
        expect(report.ok).toBe(false);
        expect(report.violations.find((v) => v.rule === 'R1' && v.refId === 'F1')).toBeTruthy();
    });

    it('R2: flags an instruction that addresses a non-existent finding', () => {
        const doc = validDoc({
            instructions: {
                items: [{ id: 'I9', addresses: ['F99'], action: 'a', acceptance: 'b' }],
                mergeBlockers: [],
            },
            // Remove F1's address so R1 doesn't muddy the test.
            header: { title: 't', recommendation: 'request-changes', severity: 'error' },
        });
        const report = validatePrSummary(doc);
        expect(report.violations.some((v) => v.rule === 'R2')).toBe(true);
    });

    it('R3: flags mergeBlockers that reference unknown instruction ids', () => {
        const doc = validDoc({
            instructions: {
                items: [{ id: 'I1', addresses: ['F1'], action: 'a', acceptance: 'b' }],
                mergeBlockers: ['I-DOES-NOT-EXIST'],
            },
        });
        const report = validatePrSummary(doc);
        expect(report.violations.some((v) => v.rule === 'R3')).toBe(true);
    });

    it('R4: flags header severity lower than max finding severity', () => {
        const doc = validDoc({
            header: { title: 't', recommendation: 'merge', severity: 'info' },
        });
        const report = validatePrSummary(doc);
        expect(report.violations.some((v) => v.rule === 'R4')).toBe(true);
    });

    it('R5: flags recommendation that does not match severity + mergeBlockers', () => {
        const doc = validDoc({
            header: { title: 't', recommendation: 'merge', severity: 'error' },
            instructions: {
                items: [{ id: 'I1', addresses: ['F1'], action: 'a', acceptance: 'b' }],
                mergeBlockers: ['I1'],
            },
        });
        const report = validatePrSummary(doc);
        const r5 = report.violations.find((v) => v.rule === 'R5');
        expect(r5).toBeTruthy();
        expect(r5!.detail).toContain('expected "block"');
    });

    it('shape: missing mechanism on a finding is flagged with clear message', () => {
        const doc = validDoc();
        // Strip mechanism off F1.
        (doc.findings[0] as any).mechanism = '';
        const report = validatePrSummary(doc);
        expect(report.violations.find((v) => v.rule === 'shape' && /mechanism/.test(v.detail))).toBeTruthy();
    });

    it('shape: missing acceptance on an instruction is flagged', () => {
        const doc = validDoc();
        (doc.instructions.items[0] as any).acceptance = '';
        const report = validatePrSummary(doc);
        expect(report.violations.find((v) => v.rule === 'shape' && /acceptance/.test(v.detail))).toBeTruthy();
    });

    it('all-info doc with no instructions is OK (no orphan-critical risk)', () => {
        const doc: PrSummaryDoc = {
            header: { title: 't', recommendation: 'merge', severity: 'info' },
            summary: 'Cosmetic-only change.',
            interpretation: {
                reframe: 'Nothing structural.',
                shift: { before: 'a', after: 'b', implication: 'c' },
                pattern: 'All info — naming nits.',
            },
            findings: [
                { id: 'F1', severity: 'info', category: 'code-quality', title: 't', mechanism: 'name is unclear', body: 'rename' },
            ],
            instructions: { items: [], mergeBlockers: [] },
        };
        const report = validatePrSummary(doc);
        expect(report.ok, JSON.stringify(report.violations)).toBe(true);
    });
});
