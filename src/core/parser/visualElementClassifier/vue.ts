/**
 * visualElementClassifier/vue.ts — Issue #485-VISUAL Vue SFC classifier.
 *
 * Same pattern as `react.ts` — element-name → `VisualElementKind`
 * mapping. Two parts:
 *
 *   - Standard HTML primitives (`<button>`, `<input>`, `<ul>`, etc.)
 *     identical to the React mapping since Vue templates use the same
 *     HTML tag names.
 *   - Vue-ecosystem PascalCase / kebab-case components from common UI
 *     libraries (Vuetify, Element Plus, Naive UI, BootstrapVue, Quasar,
 *     PrimeVue) — `<v-btn>`, `<el-input>`, `<n-select>`, `<b-form>`,
 *     `<q-list>`, `<p-button>`, etc.
 *
 * The classifier ONLY scans content inside `<template>…</template>`
 * blocks (Vue SFCs separate template from script + style); if no
 * template tag exists, the whole source is scanned (handles
 * `defineComponent({ template: '…' })` and pre-compiled render
 * functions, best-effort).
 */

import type { VisualElementClassification, VisualElementKind } from './types';

const PRIMITIVE_MAP: Record<string, VisualElementKind> = {
    // ── HTML primitives (mirror of react.ts web mapping) ──────────
    button:     'Button',
    a:          'Button',
    input:      'Input',
    textarea:   'Input',
    select:     'Picker',
    option:     'Picker',
    ul:         'List',
    ol:         'List',
    li:         'List',
    label:      'Label',
    p:          'Label',
    span:       'Label',
    h1: 'Label', h2: 'Label', h3: 'Label', h4: 'Label', h5: 'Label', h6: 'Label',
    img:        'Image',
    picture:    'Image',
    video:      'Image',
    form:       'Form',
    div:        'Layout',
    section:    'Layout',
    main:       'Layout',
    nav:        'Layout',
    header:     'Layout',
    footer:     'Layout',
    article:    'Layout',
    aside:      'Layout',
    hr:         'Divider',
    progress:   'Indicator',
    dialog:     'Modal',

    // ── Vuetify `v-*` components ──────────────────────────────────
    'v-btn':    'Button',
    'v-button': 'Button',
    'v-text-field':   'Input',
    'v-textarea':     'Input',
    'v-switch':       'Toggle',
    'v-checkbox':     'Toggle',
    'v-radio':        'Toggle',
    'v-select':       'Picker',
    'v-autocomplete': 'Picker',
    'v-combobox':     'Picker',
    'v-list':         'List',
    'v-data-table':   'List',
    'v-img':          'Image',
    'v-card-text':    'Label',
    'v-container':    'Layout',
    'v-row':          'Layout',
    'v-col':          'Layout',
    'v-card':         'Layout',
    'v-divider':      'Divider',
    'v-progress-circular': 'Indicator',
    'v-progress-linear':   'Indicator',
    'v-dialog':       'Modal',
    'v-form':         'Form',

    // ── Element Plus `el-*` ───────────────────────────────────────
    'el-button':      'Button',
    'el-input':       'Input',
    'el-switch':      'Toggle',
    'el-checkbox':    'Toggle',
    'el-radio':       'Toggle',
    'el-select':      'Picker',
    'el-table':       'List',
    'el-image':       'Image',
    'el-row':         'Layout',
    'el-col':         'Layout',
    'el-card':        'Layout',
    'el-divider':     'Divider',
    'el-progress':    'Indicator',
    'el-dialog':      'Modal',
    'el-form':        'Form',

    // ── Naive UI `n-*` ────────────────────────────────────────────
    'n-button':       'Button',
    'n-input':        'Input',
    'n-switch':       'Toggle',
    'n-checkbox':     'Toggle',
    'n-radio':        'Toggle',
    'n-select':       'Picker',
    'n-data-table':   'List',
    'n-image':        'Image',
    'n-grid':         'Layout',
    'n-card':         'Layout',
    'n-divider':      'Divider',
    'n-progress':     'Indicator',
    'n-modal':        'Modal',
    'n-form':         'Form',

    // ── Quasar `q-*` ──────────────────────────────────────────────
    'q-btn':          'Button',
    'q-input':        'Input',
    'q-toggle':       'Toggle',
    'q-checkbox':     'Toggle',
    'q-radio':        'Toggle',
    'q-select':       'Picker',
    'q-list':         'List',
    'q-table':        'List',
    'q-img':          'Image',
    'q-page':         'Layout',
    'q-card':         'Layout',
    'q-separator':    'Divider',
    'q-spinner':      'Indicator',
    'q-dialog':       'Modal',
    'q-form':         'Form',
};

export function classifyVueElement(name: string): VisualElementKind | undefined {
    if (!name) return undefined;
    const normalised = name.toLowerCase();
    if (PRIMITIVE_MAP[normalised]) return PRIMITIVE_MAP[normalised];
    if (PRIMITIVE_MAP[name])      return PRIMITIVE_MAP[name];
    // PascalCase / kebab-case → user component.
    if (/^[A-Z][\w$]*$/.test(name) || /^[a-z]+-[a-z][\w-]*$/.test(name)) return 'Custom';
    return undefined;
}

export function classifyVueSource(source: string): Map<VisualElementKind, number> {
    const out = new Map<VisualElementKind, number>();
    if (!source) return out;
    // Prefer the <template>…</template> block when present; otherwise
    // scan the whole source.
    const templateMatch = /<template[^>]*>([\s\S]*?)<\/template>/i.exec(source);
    const body = templateMatch ? templateMatch[1] : source;
    const tagRe = /<\/?([A-Za-z][\w.-]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(body)) !== null) {
        if (body[m.index + 1] === '/') continue;
        const name = m[1].split('.').pop() ?? m[1];
        const kind = classifyVueElement(name);
        if (!kind) continue;
        out.set(kind, (out.get(kind) ?? 0) + 1);
    }
    return out;
}

export function classifyVueComponent(
    source: string,
    componentName: string,
): VisualElementClassification | undefined {
    // Vue SFCs don't have a per-component "return ()" block — the whole
    // <template> IS the body. Caller passes a slice for that.
    const tally = classifyVueSource(source);
    if (tally.size === 0) return undefined;
    return {
        kind: 'Custom',
        originalName: componentName,
        nestedCounts: Object.fromEntries(tally.entries()) as Partial<Record<VisualElementKind, number>>,
    };
}
