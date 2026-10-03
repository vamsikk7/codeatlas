/**
 * ChainRunnerModal.tsx — Issue #603 Phase 3 chain runner UI.
 *
 * Modal opened from the API Testing surface. Users pick endpoints from
 * the existing collection tree, order them via up/down controls, run
 * the chain, and see a per-step pass/fail row in the result panel.
 *
 * MVP scope:
 *   - Step list seeded from the user-selected endpoints (passed as a
 *     prop). Each row gets stable defaults (no extract / assert).
 *   - "Run chain" button posts `runChain` to the server.
 *   - Result panel renders per-step status + duration + error / assert
 *     failures. Final env mirror at the bottom for verification.
 *   - Deferred: drag-to-reorder, per-step extract / assert editors,
 *     save chain as named collection.
 */

import React, { useState, useEffect } from 'react';
import type { ApiTestingEndpoint } from './ApiTestingView';
import TextPromptModal from './TextPromptModal';

const SAVED_CHAINS_KEY = 'codeatlas:savedChains'; // #914 — localStorage collection store

export interface ChainStepInput {
    id: string;
    label: string;
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    bearerToken?: string;
    extract?: Record<string, { scope: 'json' | 'headers' | 'status'; path: string }>;
    assert?: { statusBetween?: [number, number]; statusEquals?: number };
}

export interface ChainStepOutcome {
    id: string;
    label?: string;
    method: string;
    url: string;
    resolvedUrl: string;
    response: { durationMs: number; status: number; statusText: string; body: string; error?: string };
    extracted: Record<string, unknown>;
    assertFailures: string[];
    outcome: 'passed' | 'failed' | 'errored';
}

export interface ChainRunResult {
    steps: ChainStepOutcome[];
    finalEnv: Record<string, string>;
    passed: number;
    failed: number;
    errored: number;
    aborted: boolean;
}

interface ChainRunnerModalProps {
    /** Endpoints the user can add as steps. Reuses the L2a tree shape. */
    available: ApiTestingEndpoint[];
    /** Env vars text (key=value lines) inherited from the API Testing view. */
    envText: string;
    /** Send the chain to the server. */
    postMessage: (msg: unknown) => void;
    /** Latest server result, keyed by runId. */
    result: ChainRunResult | null;
    onCancel: () => void;
}

export default function ChainRunnerModal({
    available,
    envText,
    postMessage,
    result,
    onCancel,
}: ChainRunnerModalProps) {
    const [steps, setSteps] = useState<ChainStepInput[]>([]);
    const [running, setRunning] = useState(false);
    const [stopOnFirstFailure, setStopOnFirstFailure] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    // #914 — which step's extract/assert editor is open, + saved-chain library.
    const [editingStep, setEditingStep] = useState<number | null>(null);
    const [savedChains, setSavedChains] = useState<Array<{ name: string; steps: ChainStepInput[] }>>(() => {
        try { return JSON.parse(localStorage.getItem(SAVED_CHAINS_KEY) || '[]'); } catch { return []; }
    });

    useEffect(() => {
        if (result) setRunning(false);
    }, [result]);

    // #914 — per-step patch (extract/assert) + save/load to the localStorage
    // collection store. Chains built in the UI can now carry extract recipes +
    // assertions (the data model + runChain already support them — only the
    // editor was missing) and be saved/reloaded by name across reloads.
    const updateStep = (idx: number, patch: Partial<ChainStepInput>) => {
        setSteps(prev => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
    };
    const persistChains = (next: Array<{ name: string; steps: ChainStepInput[] }>) => {
        setSavedChains(next);
        try { localStorage.setItem(SAVED_CHAINS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    };
    // BUG-EXPLORE-11: was `prompt('Save chain as:')` — native prompt freezes the
    // browser-served webview / no-ops in a VS Code webview. Use the in-webview modal.
    const [savingChain, setSavingChain] = useState(false);
    const saveChain = () => { if (steps.length > 0) setSavingChain(true); };
    const doSaveChain = (name: string) => {
        const next = [...savedChains.filter(c => c.name !== name), { name, steps }];
        persistChains(next);
        setSavingChain(false);
    };
    const loadChain = (name: string) => {
        const found = savedChains.find(c => c.name === name);
        if (found) { setSteps(found.steps); setEditingStep(null); }
    };

    const addStep = (ep: ApiTestingEndpoint) => {
        const env = parseEnvLinesLocal(envText);
        const url = resolveTemplateUrl(ep.route, env);
        setSteps(prev => [...prev, {
            id: `step:${ep.id}:${prev.length}`,
            label: `${ep.method} ${ep.route}`,
            method: ep.method,
            url,
        }]);
        setPickerOpen(false);
    };

    const moveStep = (idx: number, dir: -1 | 1) => {
        setSteps(prev => {
            const next = prev.slice();
            const targetIdx = idx + dir;
            if (targetIdx < 0 || targetIdx >= next.length) return prev;
            const tmp = next[idx];
            next[idx] = next[targetIdx];
            next[targetIdx] = tmp;
            return next;
        });
    };

    const removeStep = (idx: number) => {
        setSteps(prev => prev.filter((_, i) => i !== idx));
    };

    const handleRun = () => {
        if (steps.length === 0) return;
        const env = parseEnvLinesLocal(envText);
        setRunning(true);
        postMessage({
            type: 'runChain',
            runId: `run:${Date.now()}`,
            steps,
            initialEnv: env,
            stopOnFirstFailure,
        });
    };

    return (
        <div className="ca-modal-overlay ca-chain-overlay" role="dialog" aria-modal="true" aria-label="Chain runner">
            {savingChain && (
                <TextPromptModal
                    title="Save chain as"
                    placeholder="Chain name…"
                    submitLabel="Save"
                    onSubmit={doSaveChain}
                    onCancel={() => setSavingChain(false)}
                />
            )}
            <div className="ca-modal ca-chain-modal">
                <header className="ca-chain-header">
                    <span className="ca-chain-title">▶ Chain Runner</span>
                    <button type="button" className="ca-pf-close" onClick={onCancel} aria-label="Close">✕</button>
                </header>

                <div className="ca-chain-body">
                    <section className="ca-chain-steps">
                        <div className="ca-chain-steps-header">
                            <strong>Steps ({steps.length})</strong>
                            <button
                                type="button"
                                className="ca-chain-add-btn"
                                onClick={() => setPickerOpen(v => !v)}
                            >
                                + Add step
                            </button>
                        </div>
                        {pickerOpen && (
                            <div className="ca-chain-picker" role="listbox" aria-label="Available endpoints">
                                {available.slice(0, 50).map(ep => (
                                    <button
                                        key={ep.id}
                                        type="button"
                                        className="ca-chain-picker-row"
                                        onClick={() => addStep(ep)}
                                        role="option"
                                        aria-selected={false}
                                    >
                                        <span className="ca-api-testing-method">{ep.method}</span>
                                        <span>{ep.route}</span>
                                    </button>
                                ))}
                                {available.length === 0 && <div className="ca-chain-empty">No endpoints available.</div>}
                            </div>
                        )}
                        <ol className="ca-chain-list">
                            {steps.map((s, i) => (
                                <li key={s.id} className="ca-chain-step">
                                    <div className="ca-chain-step-main">
                                        <span className="ca-chain-step-index">{i + 1}</span>
                                        <span className="ca-api-testing-method">{s.method}</span>
                                        <code className="ca-chain-step-url">{s.url}</code>
                                    </div>
                                    <div className="ca-chain-step-actions">
                                        <button type="button" onClick={() => setEditingStep(editingStep === i ? null : i)} aria-label="Edit extract/assert" data-testid={`chain-step-edit-${i}`} aria-expanded={editingStep === i}>⚙</button>
                                        <button type="button" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Move up">▲</button>
                                        <button type="button" onClick={() => moveStep(i, +1)} disabled={i === steps.length - 1} aria-label="Move down">▼</button>
                                        <button type="button" onClick={() => removeStep(i)} aria-label="Remove">✕</button>
                                    </div>
                                    {editingStep === i && (
                                        <StepEditor step={s} onChange={(patch) => updateStep(i, patch)} />
                                    )}
                                </li>
                            ))}
                            {steps.length === 0 && <li className="ca-chain-empty">No steps yet — click <strong>+ Add step</strong> to pick endpoints.</li>}
                        </ol>
                    </section>

                    <section className="ca-chain-controls">
                        <label className="ca-chain-checkbox">
                            <input
                                type="checkbox"
                                checked={stopOnFirstFailure}
                                onChange={(e) => setStopOnFirstFailure(e.target.checked)}
                            />
                            Stop on first failure
                        </label>
                        <button
                            type="button"
                            className="ca-chain-run-btn"
                            disabled={steps.length === 0 || running}
                            onClick={handleRun}
                        >
                            {running ? 'Running…' : `▶ Run chain (${steps.length})`}
                        </button>
                        {/* #914 — save / load named chains (localStorage collection store). */}
                        <button
                            type="button"
                            className="ca-chain-save-btn"
                            data-testid="chain-save"
                            disabled={steps.length === 0}
                            onClick={saveChain}
                        >
                            💾 Save chain
                        </button>
                        {savedChains.length > 0 && (
                            <select
                                className="ca-chain-load"
                                data-testid="chain-load"
                                aria-label="Load saved chain"
                                value=""
                                onChange={(e) => { if (e.target.value) loadChain(e.target.value); }}
                            >
                                <option value="">Load saved…</option>
                                {savedChains.map(c => <option key={c.name} value={c.name}>{c.name} ({c.steps.length})</option>)}
                            </select>
                        )}
                    </section>

                    {result && <ChainResultPanel result={result} />}
                </div>
            </div>
        </div>
    );
}

/**
 * #914 — per-step extract + assert editor. Extract pulls ONE value from the
 * response into an env var (var name + scope + JSONPath-lite); assert checks the
 * status code. The data model + the runChain backend already consume these —
 * this is the missing UI.
 */
function StepEditor({ step, onChange }: { step: ChainStepInput; onChange: (patch: Partial<ChainStepInput>) => void }) {
    // The extract model is `Record<varName, {scope, path}>`. The UI edits a single
    // entry (the common case); the first key is the editable one.
    const entries = Object.entries(step.extract ?? {});
    const [varName, scopePath] = entries[0] ?? ['', { scope: 'json' as const, path: '' }];
    const setExtract = (name: string, scope: 'json' | 'headers' | 'status', path: string) => {
        if (!name.trim()) { onChange({ extract: undefined }); return; }
        onChange({ extract: { [name.trim()]: { scope, path } } });
    };
    const setStatusEquals = (v: string) => {
        const n = Number(v);
        onChange({ assert: v === '' ? undefined : { ...(step.assert ?? {}), statusEquals: Number.isFinite(n) ? n : undefined } });
    };
    return (
        <div className="ca-chain-step-editor" data-testid="chain-step-editor" style={{ padding: '8px 0 4px 28px', display: 'grid', gap: 6, fontSize: 12 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--ca-text-dim,#9ca0a8)', minWidth: 52 }}>Extract</span>
                <input
                    aria-label="Extract variable name" placeholder="varName" defaultValue={varName}
                    onBlur={(e) => setExtract(e.target.value, (scopePath as any).scope, (scopePath as any).path)}
                    style={{ width: 110 }}
                />
                <select aria-label="Extract scope" defaultValue={(scopePath as any).scope}
                    onChange={(e) => setExtract(varName, e.target.value as any, (scopePath as any).path)}>
                    <option value="json">json</option>
                    <option value="headers">headers</option>
                    <option value="status">status</option>
                </select>
                <input
                    aria-label="Extract path" placeholder="$.token" defaultValue={(scopePath as any).path}
                    onBlur={(e) => setExtract(varName, (scopePath as any).scope, e.target.value)}
                    style={{ flex: 1, minWidth: 120 }}
                />
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ color: 'var(--ca-text-dim,#9ca0a8)', minWidth: 52 }}>Assert</span>
                <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    status =
                    <input
                        aria-label="Assert status equals" type="number" placeholder="200"
                        defaultValue={step.assert?.statusEquals ?? ''}
                        onBlur={(e) => setStatusEquals(e.target.value)}
                        style={{ width: 70 }}
                    />
                </label>
            </div>
        </div>
    );
}

function ChainResultPanel({ result }: { result: ChainRunResult }) {
    return (
        <section className="ca-chain-result">
            <header className="ca-chain-result-header">
                <strong>{result.passed} pass</strong>
                <span className={result.failed > 0 ? 'fail' : ''}>{result.failed} fail</span>
                <span className={result.errored > 0 ? 'fail' : ''}>{result.errored} error</span>
                {result.aborted && <span className="ca-pf-result-warning">aborted</span>}
            </header>
            <ol className="ca-chain-result-list">
                {result.steps.map((s, i) => (
                    <li key={s.id} className={`ca-chain-result-row outcome-${s.outcome}`}>
                        <span className="ca-chain-step-index">{i + 1}</span>
                        <span className="ca-api-testing-method">{s.method}</span>
                        <code className="ca-chain-step-url">{s.resolvedUrl}</code>
                        <span className={`ca-chain-status outcome-${s.outcome}`}>
                            {s.response.status > 0 ? `${s.response.status}` : 'X'}
                        </span>
                        <span className="ca-api-testing-meta-chip">{s.response.durationMs} ms</span>
                        {s.response.error && <span className="ca-chain-error">{s.response.error}</span>}
                        {s.assertFailures.length > 0 && (
                            <ul className="ca-chain-asserts">
                                {s.assertFailures.map((f, j) => <li key={j}>{f}</li>)}
                            </ul>
                        )}
                    </li>
                ))}
            </ol>
            {Object.keys(result.finalEnv).length > 0 && (
                <details className="ca-api-testing-details">
                    <summary>Final env ({Object.keys(result.finalEnv).length} vars)</summary>
                    <pre className="ca-api-testing-response-pre">
                        {Object.entries(result.finalEnv).map(([k, v]) => `${k}=${v}`).join('\n')}
                    </pre>
                </details>
            )}
        </section>
    );
}

// ── helpers (mirror those in ApiTestingView) ────────────────────────

function parseEnvLinesLocal(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!text) return out;
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const key = t.slice(0, eq).trim();
        if (!/^[A-Za-z_$][\w$.-]*$/.test(key)) continue;
        out[key] = t.slice(eq + 1).trim();
    }
    return out;
}

function resolveTemplateUrl(route: string, env: Record<string, string>): string {
    let url = route;
    if (env.base && !/^https?:\/\//i.test(url)) {
        const sep = url.startsWith('/') ? '' : '/';
        url = `${env.base}${sep}${url}`;
    }
    for (let i = 0; i < 5; i++) {
        const next = url.replace(/\{\{\s*([A-Za-z_$][\w$.-]*)\s*\}\}/g, (full, name) => env[name] ?? full);
        if (next === url) break;
        url = next;
    }
    return url;
}
