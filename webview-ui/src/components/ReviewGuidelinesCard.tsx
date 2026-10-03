/**
 * ReviewGuidelinesCard.tsx (#505)
 *
 * Home-screen card that lets the user view and edit the review-guideline
 * text that gets injected into every AI review prompt.
 *
 * Read mode: pre-wrapped text + Edit button.
 * Edit mode: textarea (max 8 KB), Save / Cancel, char counter.
 * Empty state: prompt + Edit button.
 */

import React, { useEffect, useRef, useState } from 'react';

const MAX_BYTES = 8000;

interface GuidelinesPayload {
    text: string;
    hash: string;
    updatedAt: number;
}

interface ReviewGuidelinesCardProps {
    /** Request the current guidelines from the server on mount + when reset. */
    onRequest: () => void;
    /** Submit a new value. */
    onSave: (text: string) => void;
    /** Latest guidelines fetched from the server. Updates trigger a re-read. */
    guidelines: GuidelinesPayload | null;
    /** Whether the #513 evidence gate is currently enforced (default true). */
    evidenceGateEnabled?: boolean;
    /** Toggle the evidence gate; used for debug comparisons of gated vs raw. */
    onToggleEvidenceGate?: (enabled: boolean) => void;
    /**
     * Disable mutating controls while an AI Review is in flight. The
     * orchestrator reads guidelines.hash at review start; changing them
     * mid-run would silently desync the hash stamped on findings. Match
     * the lockout pattern AiReviewControlCard uses for the Start buttons.
     */
    disabled?: boolean;
    /**
     * #813 (2026-06-10) — when present, the guidelines are scoped to a
     * specific sub-repo. The label is shown as a chip in the header so
     * the user can see what scope they're editing without checking the
     * sibling Code Review card. Changing this prop re-fetches.
     */
    scopeRepoLabel?: string;
}

function formatUpdatedAt(ts: number): string {
    if (!ts) return '';
    const d = new Date(ts);
    const now = Date.now();
    const ageS = Math.floor((now - ts) / 1000);
    if (ageS < 60) return `${ageS}s ago`;
    if (ageS < 3600) return `${Math.floor(ageS / 60)}m ago`;
    if (ageS < 86400) return `${Math.floor(ageS / 3600)}h ago`;
    return d.toISOString().slice(0, 10);
}

export function ReviewGuidelinesCard({ onRequest, onSave, guidelines, evidenceGateEnabled, onToggleEvidenceGate, disabled, scopeRepoLabel }: ReviewGuidelinesCardProps): React.ReactElement {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    // #813 — re-fetch whenever the scope changes so the body reflects the
    // per-repo guidelines for the currently picked sub-repo (or workspace-
    // wide when no repo is picked).
    useEffect(() => { onRequest(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [scopeRepoLabel]);

    // While an AI Review is running, close any open edit session so the
    // user can't save guidelines whose hash would race the in-flight
    // review's stamp. Reverts to read mode; the draft is discarded.
    useEffect(() => {
        if (disabled && editing) setEditing(false);
    }, [disabled, editing]);

    useEffect(() => {
        if (!editing) setDraft(guidelines?.text ?? '');
    }, [guidelines, editing]);

    useEffect(() => {
        if (editing) textareaRef.current?.focus();
    }, [editing]);

    const cur = guidelines?.text ?? '';
    const byteLen = new TextEncoder().encode(draft).length;

    function cancel() {
        setDraft(cur);
        setEditing(false);
    }

    function save() {
        // Browser-side clamp — server also enforces but UX should match.
        const clamped = draft.length > MAX_BYTES ? draft.slice(0, MAX_BYTES) : draft;
        onSave(clamped);
        setEditing(false);
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    }

    return (
        <section
            className="ca-guidelines-card"
            style={{
                background: 'var(--ca-surface, #131316)',
                border: '1px solid var(--ca-border, #232429)',
                borderRadius: '8px',
                padding: '18px',
                marginTop: '16px',
            }}
        >
            <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                    <span aria-hidden>📋</span>
                    <span>Review guidelines</span>
                    <span style={{
                        fontSize: '10px', fontWeight: 700, padding: '2px 6px',
                        background: 'rgba(108,114,203,0.16)', color: 'var(--ca-accent, #6c72cb)',
                        borderRadius: '4px',
                    }}>
                        AI REVIEW
                    </span>
                    {scopeRepoLabel && (
                        <span
                            data-testid="review-guidelines-scope-chip"
                            style={{
                                fontSize: '10px', fontWeight: 600, padding: '2px 6px',
                                background: 'rgba(96, 165, 250, 0.18)', color: 'var(--ca-text)',
                                border: '1px solid rgba(96, 165, 250, 0.4)',
                                borderRadius: '4px',
                            }}
                            title="These guidelines apply only to the picked sub-repo."
                        >
                            🎯 {scopeRepoLabel}
                        </span>
                    )}
                </div>
                {!editing && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {/* #513 — debug toggle: lets the user compare original vs gated findings. */}
                        {onToggleEvidenceGate && (
                            <label
                                title="DEBUG: when off, the evidence gate (#513) is bypassed and every finding the model emits is kept — even unverifiable ones. Use to compare original vs gated output."
                                style={{
                                    display: 'inline-flex', alignItems: 'center', gap: 6,
                                    fontSize: 11, color: 'var(--ca-text-dim, #9ca0a8)',
                                    padding: '4px 10px', borderRadius: '6px',
                                    background: 'transparent',
                                    border: '1px dashed var(--ca-border, #232429)',
                                    cursor: 'pointer', userSelect: 'none',
                                }}
                            >
                                <span style={{
                                    fontSize: 9, fontWeight: 700, padding: '1px 5px',
                                    background: 'rgba(250,204,21,0.16)', color: '#facc15',
                                    borderRadius: 3,
                                }}>DEBUG</span>
                                <span>Evidence gate</span>
                                <input
                                    type="checkbox"
                                    checked={evidenceGateEnabled !== false}
                                    onChange={(e) => onToggleEvidenceGate(e.target.checked)}
                                    disabled={disabled}
                                    style={{ width: 14, height: 14, cursor: disabled ? 'not-allowed' : 'pointer', accentColor: 'var(--ca-accent, #6c72cb)' }}
                                />
                                <span style={{
                                    fontSize: 10, fontWeight: 600,
                                    color: evidenceGateEnabled !== false ? 'var(--ca-success, #10b981)' : 'var(--ca-warning, #f59e0b)',
                                }}>{evidenceGateEnabled !== false ? 'ON' : 'OFF'}</span>
                            </label>
                        )}
                        <button
                            type="button"
                            onClick={() => setEditing(true)}
                            className="ca-btn"
                            disabled={disabled}
                            title={disabled ? 'Cancel the active review before editing guidelines — the orchestrator stamps every finding with the current guidelines hash.' : undefined}
                            style={{
                                background: disabled ? 'var(--ca-border, #2c2d33)' : 'var(--ca-accent, #6c72cb)',
                                color: disabled ? 'var(--ca-text-dim, #9ca0a8)' : 'white',
                                padding: '6px 12px', fontSize: '12px', fontWeight: 500,
                                borderRadius: '6px', border: 'none',
                                cursor: disabled ? 'not-allowed' : 'pointer',
                                opacity: disabled ? 0.7 : 1,
                            }}
                        >
                            {cur ? 'Edit' : 'Add guidelines'}
                        </button>
                    </div>
                )}
            </header>

            {editing ? (
                <>
                    <textarea
                        ref={textareaRef}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={onKeyDown}
                        maxLength={MAX_BYTES}
                        placeholder="• Flag any HTTP route that doesn't enforce auth
• Prefer Result<T,E> over thrown exceptions
• Reject N+1 patterns — call out missing populate / batch lookups"
                        spellCheck={false}
                        style={{
                            width: '100%', boxSizing: 'border-box',
                            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                            fontSize: '12px', lineHeight: 1.55,
                            color: 'var(--ca-text, #ececef)',
                            background: 'var(--ca-bg, #0a0a0b)',
                            border: '1px solid var(--ca-border, #232429)',
                            borderRadius: '6px',
                            padding: '12px',
                            minHeight: '160px', maxHeight: '320px',
                            resize: 'vertical',
                            outline: 'none',
                        }}
                    />
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        marginTop: '10px', fontSize: '11px', color: 'var(--ca-text-dim, #9ca0a8)',
                    }}>
                        <span>{byteLen} / {MAX_BYTES} bytes · ⌘+Enter to save · Esc to cancel</span>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                                type="button"
                                onClick={cancel}
                                style={{
                                    background: 'transparent', color: 'var(--ca-text-dim, #9ca0a8)',
                                    border: '1px solid var(--ca-border, #232429)',
                                    padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px',
                                }}
                            >Cancel</button>
                            <button
                                type="button"
                                onClick={save}
                                style={{
                                    background: 'var(--ca-accent, #6c72cb)', color: 'white',
                                    border: 'none', padding: '6px 12px', borderRadius: '6px',
                                    cursor: 'pointer', fontSize: '12px', fontWeight: 500,
                                }}
                            >Save</button>
                        </div>
                    </div>
                </>
            ) : cur ? (
                <>
                    <pre style={{
                        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                        fontSize: '12px', lineHeight: 1.6,
                        color: 'var(--ca-text, #ececef)',
                        background: 'var(--ca-bg, #0a0a0b)',
                        border: '1px solid var(--ca-border, #232429)',
                        borderRadius: '6px',
                        padding: '12px',
                        whiteSpace: 'pre-wrap', wordWrap: 'break-word',
                        minHeight: '60px', maxHeight: '240px', overflowY: 'auto',
                        margin: 0,
                    }}>{cur}</pre>
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        marginTop: '10px', fontSize: '11px', color: 'var(--ca-text-dim, #9ca0a8)',
                    }}>
                        <span>{new TextEncoder().encode(cur).length} / {MAX_BYTES} bytes · last updated {formatUpdatedAt(guidelines?.updatedAt ?? 0)}</span>
                        <span style={{ color: 'var(--ca-success, #10b981)' }}>● Active — used in every review</span>
                    </div>
                </>
            ) : (
                <div style={{
                    fontSize: '12px', color: 'var(--ca-text-dim, #9ca0a8)',
                    background: 'var(--ca-bg, #0a0a0b)',
                    border: '1px dashed var(--ca-border, #232429)',
                    borderRadius: '6px',
                    padding: '14px',
                }}>
                    No guidelines yet. Add bullet points the AI should enforce on every review — e.g. "Flag missing auth on POST routes". Saved guidelines are injected into every per-entry-point review.
                </div>
            )}
        </section>
    );
}
