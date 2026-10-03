/**
 * AiReviewSetupCard.tsx — #918 part (b).
 *
 * On the FIRST AI-review run, the user previously had to clear three separate
 * gates in three places: configure an LLM provider + key (LLM settings
 * section), acknowledge the consent prompt, then confirm a cost estimate at
 * launch. This collapses the first two gates — provider/key/model + a single
 * consent acknowledgement — into ONE guided card shown inline when the user
 * clicks Start before setup is complete. The cost estimate stays where it is
 * (it's per-run, not one-time), but the card tells the user it's coming so
 * there are no surprises.
 *
 * Consent is recorded in localStorage (`codeatlas:aiReviewConsent`) so the
 * card never re-prompts once dismissed; the LLM config rides the existing
 * `onSetLlmConfig` postMessage path (no new backend wiring).
 */

import React, { useState } from 'react';
import type { LlmConfigPayload } from './llmConfig';

export const AI_REVIEW_CONSENT_KEY = 'codeatlas:aiReviewConsent';

const PROVIDERS = ['openrouter', 'openai', 'anthropic', 'ollama', 'custom'] as const;

const PROVIDER_LABELS: Record<string, string> = {
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    ollama: 'Ollama (local)',
    custom: 'Custom endpoint',
};

const MODEL_PLACEHOLDERS: Record<string, string> = {
    openrouter: 'openrouter/free',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-20250514',
    ollama: 'llama3',
    custom: 'model-name',
};

const ENDPOINT_DEFAULTS: Record<string, string> = {
    ollama: 'http://localhost:11434/v1/chat/completions',
    custom: 'http://localhost:8080/v1/chat/completions',
};

/** Local providers run on the user's machine — no API key, no per-token cost. */
function isLocalProvider(provider: string): boolean {
    return provider === 'ollama' || provider === 'custom';
}

/** Persist the one-time consent acknowledgement. */
export function recordAiReviewConsent(): void {
    try { localStorage.setItem(AI_REVIEW_CONSENT_KEY, '1'); } catch { /* private mode — non-fatal */ }
}

/** Whether the user has already acknowledged the AI-review consent. */
export function hasAiReviewConsent(): boolean {
    try { return localStorage.getItem(AI_REVIEW_CONSENT_KEY) === '1'; } catch { return false; }
}

interface AiReviewSetupCardProps {
    /** Current provider (from workspace info), used to pre-fill the select. */
    initialProvider?: string;
    /** Current model, used to pre-fill the model field. */
    initialModel?: string;
    /** Apply the chosen LLM config (rides the existing setLlmConfig path). */
    onSetLlmConfig: (config: LlmConfigPayload) => void;
    /** Setup finished — parent proceeds with the originally-intended launch. */
    onComplete: () => void;
    /** User backed out — parent abandons the pending launch. */
    onCancel: () => void;
}

export function AiReviewSetupCard({
    initialProvider,
    initialModel,
    onSetLlmConfig,
    onComplete,
    onCancel,
}: AiReviewSetupCardProps): React.ReactElement {
    const [provider, setProvider] = useState(initialProvider || 'openrouter');
    const [model, setModel] = useState(initialModel || '');
    const [apiKey, setApiKey] = useState('');
    const [endpoint, setEndpoint] = useState(ENDPOINT_DEFAULTS[initialProvider ?? ''] ?? '');
    const [consent, setConsent] = useState(false);

    const local = isLocalProvider(provider);

    // Minimal config to proceed: a local provider needs only an endpoint
    // (defaulted); a cloud provider needs an API key. Consent is always
    // required. The cost estimate is NOT gated here — it fires per-run after.
    const configReady = local
        ? (endpoint.trim().length > 0 || (ENDPOINT_DEFAULTS[provider] ?? '').length > 0)
        : apiKey.trim().length > 0;
    const canSubmit = consent && configReady;

    const handleProviderChange = (next: string) => {
        setProvider(next);
        setEndpoint(ENDPOINT_DEFAULTS[next] ?? '');
    };

    const handleSubmit = () => {
        if (!canSubmit) return;
        const payload: LlmConfigPayload = { provider };
        if (apiKey.trim()) payload.apiKey = apiKey.trim();
        if (model.trim()) payload.model = model.trim();
        if (local) payload.endpoint = endpoint.trim() || ENDPOINT_DEFAULTS[provider] || '';
        onSetLlmConfig(payload);
        recordAiReviewConsent();
        onComplete();
    };

    return (
        <div
            className="ca-ai-setup-card"
            data-testid="ai-review-setup-card"
            role="dialog"
            aria-label="Set up AI Review"
            style={{
                marginTop: 12,
                padding: '14px 16px',
                border: '1px solid var(--ca-accent, #6366f1)',
                borderRadius: 8,
                background: 'var(--ca-surface, #131316)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
            }}
        >
            <div style={{ fontWeight: 600, fontSize: 14 }}>Set up AI Review</div>
            <div style={{ fontSize: 12, color: 'var(--ca-text-muted, #9ca0a8)' }}>
                One-time setup. Pick a model provider, then acknowledge what gets sent.
            </div>

            {/* 1. Provider + credentials */}
            <label style={{ fontSize: 11, color: 'var(--ca-text-muted, #9ca0a8)' }}>
                Provider
                <select
                    data-testid="ai-setup-provider"
                    aria-label="LLM provider"
                    value={provider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', boxSizing: 'border-box' }}
                >
                    {PROVIDERS.map((p) => (
                        <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                    ))}
                </select>
            </label>

            {local ? (
                <label style={{ fontSize: 11, color: 'var(--ca-text-muted, #9ca0a8)' }}>
                    Endpoint
                    <input
                        data-testid="ai-setup-endpoint"
                        aria-label="LLM endpoint"
                        value={endpoint}
                        onChange={(e) => setEndpoint(e.target.value)}
                        placeholder={ENDPOINT_DEFAULTS[provider] ?? 'http://localhost:8080/v1/chat/completions'}
                        style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', boxSizing: 'border-box' }}
                    />
                </label>
            ) : (
                <label style={{ fontSize: 11, color: 'var(--ca-text-muted, #9ca0a8)' }}>
                    API key
                    <input
                        data-testid="ai-setup-api-key"
                        aria-label="API key"
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="API key…"
                        style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', boxSizing: 'border-box' }}
                    />
                </label>
            )}

            <label style={{ fontSize: 11, color: 'var(--ca-text-muted, #9ca0a8)' }}>
                Model {local ? '' : '(optional)'}
                <input
                    data-testid="ai-setup-model"
                    aria-label="Model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={MODEL_PLACEHOLDERS[provider] ?? 'model-name'}
                    style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', boxSizing: 'border-box' }}
                />
            </label>

            {/* 2. Consent */}
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--ca-text, #ececef)' }}>
                <input
                    data-testid="ai-setup-consent"
                    aria-label="Consent to send code snippets"
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    style={{ marginTop: 2 }}
                />
                <span>
                    I understand snippets of changed code from reviewed entry points are sent to{' '}
                    <strong>{PROVIDER_LABELS[provider] ?? provider}</strong> for analysis. Secrets are
                    redacted before sending.
                </span>
            </label>

            {/* 3. Cost note (the estimate itself fires per-run, after this card) */}
            <div style={{ fontSize: 11, color: 'var(--ca-text-muted, #9ca0a8)' }}>
                {local
                    ? '💡 Local model — no per-token cost. The review runs on your machine.'
                    : '💡 You\'ll see a cost estimate before each paid run — nothing is charged without your confirmation.'}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                <button
                    type="button"
                    data-testid="ai-setup-cancel"
                    onClick={onCancel}
                    style={{ padding: '6px 12px', background: 'transparent', border: '1px solid var(--ca-border, #232429)', borderRadius: 6, color: 'var(--ca-text, #ececef)', cursor: 'pointer' }}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    data-testid="ai-setup-submit"
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    style={{ padding: '6px 12px', background: canSubmit ? 'var(--ca-accent, #6366f1)' : 'var(--ca-border, #232429)', border: 'none', borderRadius: 6, color: '#fff', cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.6 }}
                >
                    Save & start review
                </button>
            </div>
        </div>
    );
}

export default AiReviewSetupCard;
