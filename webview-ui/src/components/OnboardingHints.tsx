/**
 * OnboardingHints.tsx — #919
 *
 * Two small pieces that explain the product's mental model without adding a
 * heavy tutorial:
 *   - `LayerLegend` — a persistent one-line "what am I looking at?" for each
 *     diagram layer (L1–L5, Map, Domains, Health). Keyed by view mode.
 *   - `ModelExplainer` — a one-time, dismissable first-run card stating the
 *     north-star model: layers = the canvas, overlays = the lens, anchors = the
 *     join key. Dismissal is remembered in localStorage.
 */
import { useState } from 'react';

/** One-liner per view mode. Empty string ⇒ no legend for that mode. */
export const LAYER_LEGEND: Record<string, string> = {
    microservice: 'L1 · System Design — services, databases, and the calls between them.',
    feature: 'L2a · Feature Areas — endpoints grouped by feature (screens for frontends).',
    domain: 'Domains — a cluster map of your code grouped by the action it performs.',
    'api-list': 'L2b · API List — every endpoint exposed in this area.',
    sequence: 'L3 · Sequence — the call chain that runs for one endpoint.',
    file: 'L4 · File Dependencies — imports, functions, and how they link inside a file.',
    flow: 'L5 · Function Flow — the control flow (branches, loops) inside one function.',
    map: 'Knowledge Map — domains and how they connect across the system.',
    health: 'Health — dead code, god files, tight coupling, and cycles.',
    'screen-content': 'Screen Content — the UI elements each screen renders.',
};

export function LayerLegend({ mode }: { mode: string }) {
    const text = LAYER_LEGEND[mode];
    if (!text) return null;
    return (
        <div
            className="ca-layer-legend"
            data-testid="layer-legend"
            style={{
                fontSize: 11, lineHeight: 1.4, padding: '4px 12px',
                color: 'var(--ca-text-dim, #9ca0a8)',
                borderBottom: '1px solid var(--ca-border, rgba(255,255,255,0.06))',
            }}
        >
            {text}
        </div>
    );
}

const EXPLAINER_KEY = 'codeatlas:modelExplainerSeen';

/** First-run model explainer. Renders once until dismissed (localStorage). */
export function ModelExplainer() {
    const [seen, setSeen] = useState<boolean>(() => {
        try { return localStorage.getItem(EXPLAINER_KEY) === '1'; } catch { return false; }
    });
    if (seen) return null;
    const dismiss = () => {
        try { localStorage.setItem(EXPLAINER_KEY, '1'); } catch { /* ignore */ }
        setSeen(true);
    };
    return (
        <div
            className="ca-model-explainer"
            data-testid="model-explainer"
            role="dialog"
            aria-label="How CodeAtlas works"
            style={{
                margin: '0 0 14px', padding: '12px 14px', borderRadius: 8, fontSize: 12, lineHeight: 1.5,
                background: 'var(--ca-info-bg, rgba(96,165,250,0.08))',
                border: '1px solid var(--ca-info-border, rgba(96,165,250,0.25))',
                color: 'var(--ca-text, #d4d4d8)',
            }}
        >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>How to read CodeAtlas</div>
            <div style={{ marginBottom: 4 }}>
                <strong>Layers are the canvas</strong> — six linked views from the whole system (L1) down to one function (L5).
            </div>
            <div style={{ marginBottom: 4 }}>
                <strong>Overlays are the lens</strong> — diff, coverage, AI findings and more paint onto the same canvas.
            </div>
            <div style={{ marginBottom: 8 }}>
                <strong>Anchors are the join key</strong> — every overlay lines up to the exact code each node points at.
            </div>
            <button
                type="button"
                onClick={dismiss}
                data-testid="model-explainer-dismiss"
                style={{
                    fontSize: 11, padding: '4px 12px', borderRadius: 4, cursor: 'pointer',
                    background: 'var(--ca-accent, #60a5fa)', color: '#0b0b0d', border: 'none', fontWeight: 600,
                }}
            >
                Got it
            </button>
        </div>
    );
}
