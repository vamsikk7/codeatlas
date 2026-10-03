/**
 * PersonaSelector.tsx — Issue #706.
 *
 * Segmented control on the home page next to the theme toggle. Three
 * options: 🧑‍🎓 Junior, 📊 PM, ⚡ Power (default). Click → calls
 * `setPersona`; the global store update triggers a re-render of every
 * subscribed component (HomePage, AiReviewControlCard, DiagramView).
 *
 * Persists to localStorage via `personaStore.setPersona`.
 */

import React from 'react';
import { type Persona, usePersona, setPersona } from '../state/personaStore';

interface PersonaOption {
    id: Persona;
    label: string;
    icon: string;
    title: string;
}

const OPTIONS: PersonaOption[] = [
    {
        id: 'junior',
        label: 'Junior',
        icon: '🎓',
        title: 'Junior — Diagrams + Code Review only; advanced controls + MCP/LLM panels hidden.',
    },
    {
        id: 'pm',
        label: 'PM',
        icon: '📊',
        title: 'PM — High-level dashboards: L1 + counts + costs; code-level diagrams hidden.',
    },
    {
        id: 'power',
        label: 'Power',
        icon: '⚡',
        title: 'Power — Full UI (default). All controls visible.',
    },
];

export function PersonaSelector() {
    const current = usePersona();
    return (
        <div
            role="radiogroup"
            aria-label="Persona"
            data-testid="persona-selector"
            style={{
                display: 'inline-flex',
                border: '1px solid var(--ca-border)',
                borderRadius: 6,
                overflow: 'hidden',
                fontSize: 11,
            }}
        >
            {OPTIONS.map(opt => {
                const active = opt.id === current;
                return (
                    <span
                        key={opt.id}
                        role="radio"
                        aria-checked={active}
                        data-testid={`persona-option-${opt.id}`}
                        onClick={() => setPersona(opt.id)}
                        title={opt.title}
                        style={{
                            padding: '3px 9px',
                            cursor: active ? 'default' : 'pointer',
                            background: active
                                ? 'var(--ca-toggle-on-bg, rgba(91,141,239,0.18))'
                                : 'transparent',
                            color: active ? 'var(--ca-accent)' : 'var(--ca-text-muted)',
                            fontWeight: active ? 600 : 500,
                            userSelect: 'none' as const,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                        }}
                    >
                        <span aria-hidden>{opt.icon}</span>
                        <span>{opt.label}</span>
                    </span>
                );
            })}
        </div>
    );
}

export default PersonaSelector;
