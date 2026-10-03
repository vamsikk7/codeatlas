/**
 * AiReviewErrorBanner.tsx — Issue 609
 *
 * Renders a specific, actionable banner when the last AI Review attempt
 * failed with a classified error. Replaces the previous generic toast that
 * left users without a remediation path. Comes with a "View raw response"
 * disclosure for the LLM body so users can paste it into a bug report.
 */
import React, { useState } from 'react';

export type AiReviewErrorKind =
    | 'network' | 'auth' | 'rate-limit' | 'model-not-found'
    | 'server-error' | 'schema-invalid' | 'evidence-gate-too-strict'
    | 'unknown';

export interface AiReviewErrorState {
    kind: AiReviewErrorKind;
    message: string;
    rawResponse?: string;
    provider?: string;
    status?: number;
}

interface Props {
    error: AiReviewErrorState | null;
    onDismiss: () => void;
}

interface BannerCopy {
    headline: string;
    hint: string;
}

const COPY: Record<AiReviewErrorKind, BannerCopy> = {
    network: {
        headline: 'Could not reach the LLM endpoint',
        hint: 'Check your network and confirm the endpoint is correct in the AI configuration section. If you are using a local model (Ollama), make sure it is running.',
    },
    auth: {
        headline: 'LLM rejected the API key',
        hint: 'Update the API key in the AI configuration section. If you are using OpenRouter, generate a fresh key at openrouter.ai/keys.',
    },
    'rate-limit': {
        headline: 'LLM is rate-limited',
        hint: 'Wait a minute and try again, or switch to a different model. If this keeps happening, upgrade your API tier or use a self-hosted model.',
    },
    'model-not-found': {
        headline: 'Model not found at the configured endpoint',
        hint: 'Confirm the model id matches what your provider supports. For Ollama, run `ollama pull <model>` first.',
    },
    'server-error': {
        headline: 'LLM provider returned a server error',
        hint: 'Likely transient — try again in a moment. If it persists, check the provider status page.',
    },
    'schema-invalid': {
        headline: 'LLM returned a malformed response',
        hint: 'The model produced JSON that does not match our schema. Try a stronger model, or simplify your review guidelines (a single clear rule often produces cleaner output than five vague ones).',
    },
    'evidence-gate-too-strict': {
        headline: 'Every finding was dropped by the evidence gate',
        hint: 'The model paraphrased instead of quoting source verbatim. Try a stronger model, enable the small-model fallback in settings, or temporarily disable the evidence gate (debug toggle).',
    },
    unknown: {
        headline: 'AI Review failed',
        hint: 'Open the raw response below to see what the LLM actually returned.',
    },
};

export default function AiReviewErrorBanner({ error, onDismiss }: Props) {
    const [rawOpen, setRawOpen] = useState(false);
    if (!error) return null;
    const copy = COPY[error.kind] ?? COPY.unknown;
    const accent = error.kind === 'rate-limit' || error.kind === 'server-error'
        ? 'var(--ca-warning, #d4a72c)'
        : 'var(--ca-danger, #e15c5c)';

    return (
        <div
            data-testid="ai-review-error-banner"
            role="alert"
            style={{
                border: `1px solid ${accent}`,
                background: 'rgba(225, 92, 92, 0.08)',
                borderRadius: 6,
                padding: '10px 12px',
                margin: '8px 0',
                fontSize: 12,
                color: 'var(--ca-text, #ececef)',
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        ⚠️ {copy.headline}
                        <span style={{ marginLeft: 8, opacity: 0.55, fontWeight: 400, fontSize: 11 }} data-testid="ai-review-error-kind">
                            kind: {error.kind}{error.status ? ` · ${error.status}` : ''}{error.provider ? ` · ${error.provider}` : ''}
                        </span>
                    </div>
                    <div style={{ opacity: 0.85, lineHeight: 1.4 }}>{copy.hint}</div>
                    {error.message && (
                        <div style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 11, opacity: 0.7, wordBreak: 'break-word' }}>
                            {error.message}
                        </div>
                    )}
                    {error.rawResponse && (
                        <button
                            type="button"
                            data-testid="ai-review-error-view-raw"
                            onClick={() => setRawOpen((o) => !o)}
                            style={{
                                marginTop: 8, fontSize: 11, padding: '3px 8px', borderRadius: 4,
                                background: 'transparent', color: 'var(--ca-text-dim, #9ca0a8)',
                                border: '1px solid var(--ca-border, #232429)', cursor: 'pointer',
                            }}
                        >
                            {rawOpen ? '▾ Hide raw response' : '▸ View raw response'}
                        </button>
                    )}
                    {rawOpen && error.rawResponse && (
                        <pre
                            data-testid="ai-review-error-raw"
                            style={{
                                marginTop: 8, padding: 8, borderRadius: 4, fontSize: 11,
                                background: 'rgba(0,0,0,0.25)', overflowX: 'auto', maxHeight: 200,
                                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            }}
                        >
                            {error.rawResponse}
                        </pre>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label="Dismiss error"
                    title="Dismiss"
                    style={{
                        background: 'transparent', border: 'none', color: 'var(--ca-text-dim, #9ca0a8)',
                        fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: '0 4px',
                    }}
                >
                    ✕
                </button>
            </div>
        </div>
    );
}
