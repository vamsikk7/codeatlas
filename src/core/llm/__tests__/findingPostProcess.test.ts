import { describe, it, expect } from 'vitest';
import { applyApplicabilityGate, calibrateSeverity, postProcessFinding } from '../findingPostProcess';

function mkFinding(over: any = {}) {
    return {
        severity: 'info' as const,
        category: 'guideline' as const,
        title: '',
        body: '',
        bindings: [],
        entryPointId: 'GET:/api/articles',
        ...over,
    };
}

describe('applyApplicabilityGate (#514)', () => {
    it('passes non-guideline categories through', () => {
        const r = applyApplicabilityGate(mkFinding({ category: 'security', title: 'auth on writes', method: 'GET' }));
        expect(r.keep).toBe(true);
        expect(r.unverified).toBeUndefined();
    });

    it('drops auth-on-writes finding when route is GET', () => {
        const r = applyApplicabilityGate(mkFinding({
            title: 'HTTP route requires auth on writes',
            body: 'must enforce auth on writes',
            method: 'GET',
        }));
        expect(r.keep).toBe(false);
        expect(r.droppedReason).toContain('GET');
    });

    it('keeps auth-on-writes finding when route is POST', () => {
        const r = applyApplicabilityGate(mkFinding({
            title: 'HTTP route requires auth on writes',
            body: 'must enforce auth on writes',
            method: 'POST',
        }));
        expect(r.keep).toBe(true);
    });

    it('drops webhook-signature finding on a non-webhook route', () => {
        const r = applyApplicabilityGate(mkFinding({
            title: 'Webhook signature verification missing',
            body: 'verify signatures before processing',
            method: 'GET', route: '/api/user',
        }));
        expect(r.keep).toBe(false);
        expect(r.droppedReason).toContain('webhook');
    });

    it('keeps webhook-signature finding on a webhook-named route', () => {
        const r = applyApplicabilityGate(mkFinding({
            title: 'Webhook signature verification missing',
            body: 'verify signatures before processing',
            method: 'POST', route: '/api/webhooks/stripe',
        }));
        expect(r.keep).toBe(true);
    });

    it('flags guideline-category finding as unverified when applicability is opinion-only', () => {
        const r = applyApplicabilityGate(mkFinding({
            title: 'Some opinion-only guideline',
            body: 'this is subjective',
            method: 'GET', route: '/api/x',
        }));
        expect(r.keep).toBe(true);
        expect(r.unverified).toBe(true);
    });
});

describe('calibrateSeverity (#516)', () => {
    it('bumps info → error when snippet contains a hardcoded credential string', () => {
        const r = calibrateSeverity({
            severity: 'info', category: 'security',
            snippet: 'process.env.JWT_SECRET || "superSecret"',
        });
        expect(r.severity).toBe('error');
        expect(r.calibrationReason).toMatch(/credential|fallback|secret/i);
    });

    it('bumps info → error on env-var-fallback pattern even without known credential string', () => {
        const r = calibrateSeverity({
            severity: 'info', category: 'security',
            snippet: 'const key = process.env.API_KEY || "mySecretKey";',
        });
        expect(r.severity).toBe('error');
        expect(r.calibrationReason).toContain('fallback');
    });

    it('bumps to error on eval() usage', () => {
        const r = calibrateSeverity({
            severity: 'info', category: 'security',
            snippet: 'const out = eval(userInput);',
        });
        expect(r.severity).toBe('error');
    });

    it('bumps to error on dangerouslySetInnerHTML', () => {
        const r = calibrateSeverity({
            severity: 'warning', category: 'security',
            snippet: '<div dangerouslySetInnerHTML={{ __html: userHtml }} />',
        });
        expect(r.severity).toBe('error');
    });

    it('bumps to warning on async-inside-map', () => {
        const r = calibrateSeverity({
            severity: 'info', category: 'performance',
            snippet: 'articles.map(async (a) => { ... })',
        });
        expect(r.severity).toBe('warning');
    });

    it('does not bump when no pattern matches', () => {
        const r = calibrateSeverity({
            severity: 'info', category: 'code-quality',
            snippet: 'function foo() { return 1; }',
        });
        expect(r.severity).toBe('info');
    });

    it('does not downgrade existing higher severities', () => {
        const r = calibrateSeverity({
            severity: 'error', category: 'security',
            snippet: 'function foo() { return 1; }',  // no pattern
        });
        expect(r.severity).toBe('error');
    });
});

describe('postProcessFinding (combined)', () => {
    it('runs calibration then applicability gate', () => {
        // Calibrated to error, but still tripped by applicability rule.
        const r = postProcessFinding({
            severity: 'info', category: 'guideline',
            title: 'auth on writes', body: 'must enforce auth on writes',
            bindings: [],
            entryPointId: 'GET:/api/articles',
            method: 'GET',
            snippet: 'eval(userInput);',
        });
        expect(r.keep).toBe(false);
    });

    it('appends calibration reason into body when kept', () => {
        const r = postProcessFinding({
            severity: 'info', category: 'security',
            title: 'Hardcoded fallback',
            body: 'fallback to superSecret',
            bindings: [],
            entryPointId: 'POST:/api/users',
            method: 'POST',
            snippet: 'process.env.JWT_SECRET || "superSecret"',
        });
        expect(r.keep).toBe(true);
        expect(r.finding.severity).toBe('error');
        expect(r.finding.body).toContain('calibrated to error');
    });
});
