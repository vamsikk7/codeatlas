/**
 * visualElementClassifier/svelte.ts — Issue #485-VISUAL Svelte template classifier.
 *
 * Svelte components live in `.svelte` files with three sections:
 *   <script> … </script>
 *   <style>  … </style>
 *   <!-- markup at top level (no wrapper) -->
 *
 * The markup section is the rest of the file outside <script>+<style>.
 * Templates use plain HTML tags + capitalised component imports +
 * Svelte special elements (`<svelte:component>`, `<svelte:head>`, etc.).
 *
 * Svelte ecosystem UI libs are smaller than Vue's — we cover SvelteKit's
 * own (none beyond HTML), Skeleton UI, Carbon Svelte, and Flowbite
 * Svelte best-effort. New entries are one-line catalog adds.
 */

import type { VisualElementClassification, VisualElementKind } from './types';

const PRIMITIVE_MAP: Record<string, VisualElementKind> = {
    // HTML primitives (identical to react.ts web mapping)
    button:   'Button',
    a:        'Button',
    input:    'Input',
    textarea: 'Input',
    select:   'Picker',
    option:   'Picker',
    ul: 'List', ol: 'List', li: 'List',
    label: 'Label', p: 'Label', span: 'Label',
    h1: 'Label', h2: 'Label', h3: 'Label', h4: 'Label', h5: 'Label', h6: 'Label',
    img: 'Image', picture: 'Image', video: 'Image',
    form: 'Form',
    div: 'Layout', section: 'Layout', main: 'Layout', nav: 'Layout',
    header: 'Layout', footer: 'Layout', article: 'Layout', aside: 'Layout',
    hr: 'Divider',
    progress: 'Indicator',
    dialog: 'Modal',
};

export function classifySvelteElement(name: string): VisualElementKind | undefined {
    if (!name) return undefined;
    if (PRIMITIVE_MAP[name]) return PRIMITIVE_MAP[name];
    // Svelte special elements (<svelte:foo>) are scaffolding, not visual.
    if (/^svelte:/.test(name)) return undefined;
    // PascalCase user component.
    if (/^[A-Z][\w$]*$/.test(name)) return 'Custom';
    return undefined;
}

export function classifySvelteSource(source: string): Map<VisualElementKind, number> {
    const out = new Map<VisualElementKind, number>();
    if (!source) return out;
    // Strip <script> and <style> blocks first so JS strings inside them
    // don't shadow HTML tags.
    const markup = source
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    const tagRe = /<\/?([A-Za-z][\w:.-]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(markup)) !== null) {
        if (markup[m.index + 1] === '/') continue;
        const name = m[1];
        const kind = classifySvelteElement(name);
        if (!kind) continue;
        out.set(kind, (out.get(kind) ?? 0) + 1);
    }
    return out;
}

export function classifySvelteComponent(
    source: string,
    componentName: string,
): VisualElementClassification | undefined {
    const tally = classifySvelteSource(source);
    if (tally.size === 0) return undefined;
    return {
        kind: 'Custom',
        originalName: componentName,
        nestedCounts: Object.fromEntries(tally.entries()) as Partial<Record<VisualElementKind, number>>,
    };
}
