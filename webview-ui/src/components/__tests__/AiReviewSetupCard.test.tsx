/**
 * AiReviewSetupCard tests — #918 part (b).
 *
 * The unified first-run setup card collapses provider/key + consent into one
 * surface. Cost estimate stays per-run (not gated here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
    AiReviewSetupCard,
    hasAiReviewConsent,
    AI_REVIEW_CONSENT_KEY,
} from '../AiReviewSetupCard';

describe('#918 — AiReviewSetupCard', () => {
    beforeEach(() => { localStorage.clear(); });
    afterEach(() => cleanup());

    it('renders one card combining provider, key, consent and a cost note', () => {
        render(<AiReviewSetupCard onSetLlmConfig={vi.fn()} onComplete={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.getByTestId('ai-review-setup-card')).toBeDefined();
        expect(screen.getByTestId('ai-setup-provider')).toBeDefined();
        expect(screen.getByTestId('ai-setup-api-key')).toBeDefined(); // cloud default
        expect(screen.getByTestId('ai-setup-consent')).toBeDefined();
        expect(screen.getByText(/cost estimate before each paid run/i)).toBeDefined();
    });

    it('keeps Save disabled until consent + credentials are provided', () => {
        render(<AiReviewSetupCard onSetLlmConfig={vi.fn()} onComplete={vi.fn()} onCancel={vi.fn()} />);
        const submit = screen.getByTestId('ai-setup-submit') as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        // Key alone — still blocked on consent.
        fireEvent.change(screen.getByTestId('ai-setup-api-key'), { target: { value: 'sk-test' } });
        expect(submit.disabled).toBe(true);
        // + consent → enabled.
        fireEvent.click(screen.getByTestId('ai-setup-consent'));
        expect(submit.disabled).toBe(false);
    });

    it('Save posts the LLM config, records consent, and calls onComplete', () => {
        const onSetLlmConfig = vi.fn();
        const onComplete = vi.fn();
        render(<AiReviewSetupCard onSetLlmConfig={onSetLlmConfig} onComplete={onComplete} onCancel={vi.fn()} />);
        fireEvent.change(screen.getByTestId('ai-setup-api-key'), { target: { value: 'sk-test' } });
        fireEvent.change(screen.getByTestId('ai-setup-model'), { target: { value: 'gpt-4o-mini' } });
        fireEvent.click(screen.getByTestId('ai-setup-consent'));
        fireEvent.click(screen.getByTestId('ai-setup-submit'));
        expect(onSetLlmConfig).toHaveBeenCalledWith({ provider: 'openrouter', apiKey: 'sk-test', model: 'gpt-4o-mini' });
        expect(hasAiReviewConsent()).toBe(true);
        expect(localStorage.getItem(AI_REVIEW_CONSENT_KEY)).toBe('1');
        expect(onComplete).toHaveBeenCalled();
    });

    it('a local provider (ollama) needs no API key — endpoint field + cost-free note', () => {
        render(<AiReviewSetupCard onSetLlmConfig={vi.fn()} onComplete={vi.fn()} onCancel={vi.fn()} />);
        fireEvent.change(screen.getByTestId('ai-setup-provider'), { target: { value: 'ollama' } });
        expect(screen.getByTestId('ai-setup-endpoint')).toBeDefined();
        expect(screen.queryByTestId('ai-setup-api-key')).toBeNull();
        expect(screen.getByText(/no per-token cost/i)).toBeDefined();
        // Consent alone enables Save (endpoint defaulted).
        fireEvent.click(screen.getByTestId('ai-setup-consent'));
        expect((screen.getByTestId('ai-setup-submit') as HTMLButtonElement).disabled).toBe(false);
    });

    it('Cancel does not record consent or post config', () => {
        const onSetLlmConfig = vi.fn();
        const onCancel = vi.fn();
        render(<AiReviewSetupCard onSetLlmConfig={onSetLlmConfig} onComplete={vi.fn()} onCancel={onCancel} />);
        fireEvent.click(screen.getByTestId('ai-setup-cancel'));
        expect(onCancel).toHaveBeenCalled();
        expect(onSetLlmConfig).not.toHaveBeenCalled();
        expect(hasAiReviewConsent()).toBe(false);
    });
});
