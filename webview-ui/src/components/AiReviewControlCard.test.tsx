import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { AiReviewControlCard } from './AiReviewControlCard';

beforeEach(() => {
    (window as any).vscodeApi = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
});
afterEach(() => {
    delete (window as any).vscodeApi;
});

function countType(spy: ReturnType<typeof vi.fn>, type: string): number {
    return spy.mock.calls.filter((c) => c[0]?.type === type).length;
}

describe('AiReviewControlCard — mount priming (request-flood regression)', () => {
    // Regression for the WsBridge request flood: the mount effect that primes
    // findings + in-flight status depended on `postMessage`, whose identity
    // changes every render (the parent passes an inline arrow). Each reply
    // re-rendered the card → the effect re-fired → a tight
    // requestAiFindings/requestAiReviewStatus loop. It must fire ONCE.
    it('sends requestAiFindings + requestAiReviewStatus exactly once on mount', () => {
        const post = vi.fn();
        render(<AiReviewControlCard postMessage={post} needsSetup={false} />);
        expect(countType(post, 'requestAiFindings')).toBe(1);
        expect(countType(post, 'requestAiReviewStatus')).toBe(1);
    });

    it('does NOT re-fire when the parent passes a fresh postMessage identity each render', () => {
        // Simulate the real parent: a NEW inline arrow every render.
        const sink = vi.fn();
        const freshArrow = () => (msg: any) => sink(msg);
        const { rerender } = render(<AiReviewControlCard postMessage={freshArrow()} needsSetup={false} />);
        // Several re-renders, each with a brand-new postMessage function.
        for (let i = 0; i < 5; i++) {
            rerender(<AiReviewControlCard postMessage={freshArrow()} needsSetup={false} />);
        }
        // Still exactly one prime — no per-render loop.
        expect(countType(sink, 'requestAiFindings'), 'primed once across 6 renders').toBe(1);
        expect(countType(sink, 'requestAiReviewStatus')).toBe(1);
    });
});
