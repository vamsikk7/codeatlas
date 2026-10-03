/**
 * visualElementClassifier/react.ts — Issue #485-VISUAL React + React Native.
 *
 * Maps JSX element names to a shared `VisualElementKind`. Covers both
 * web (`<button>`, `<input>`, `<ul>`, `<img>`, etc.) and React Native
 * primitives (`<TouchableOpacity>`, `<TextInput>`, `<FlatList>`, etc.)
 * since most repos using RN intermix the two through code-sharing
 * boundaries (Expo Web, react-native-web, etc.).
 *
 * Output:
 *   - `classifyReactElement(name)` returns the `VisualElementKind` for
 *     a recognised primitive, or `'Custom'` for PascalCase user
 *     components, or `undefined` for non-component nodes (text strings,
 *     comments, expressions).
 *   - `classifyReactSource(source)` scans a JSX-bearing source file and
 *     returns a `Map<VisualElementKind, number>` tallying every
 *     recognised element. Use for the L2b "Visual elements" inventory.
 *
 * Notes:
 *   - HTML lowercase primitives (`button`, `input`) are matched
 *     case-sensitively to avoid colliding with PascalCase imports of
 *     the same name (`Button` from a UI lib is `'Button'` not `'Custom'`).
 *   - "Layout" is a catch-all for non-interactive containers — the
 *     panel renders the kind tally, so users can still see N layouts.
 *   - Custom-component nested-content recursion (per spec §4) is a
 *     follow-up. v1 treats every PascalCase element as `'Custom'` and
 *     bucket-counts it; the panel can show "X custom components".
 */

import type { VisualElementClassification, VisualElementKind } from './types';

const PRIMITIVE_MAP: Record<string, VisualElementKind> = {
    // ── HTML / web primitives ──────────────────────────────────────
    button:     'Button',
    a:          'Button', // anchor — interactive, often styled as button
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
    h1:         'Label', h2: 'Label', h3: 'Label', h4: 'Label', h5: 'Label', h6: 'Label',
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

    // ── React Native primitives ────────────────────────────────────
    Button:                 'Button',
    Pressable:              'Button',
    TouchableOpacity:       'Button',
    TouchableHighlight:     'Button',
    TouchableNativeFeedback:'Button',
    TouchableWithoutFeedback:'Button',
    TextInput:              'Input',
    Switch:                 'Toggle',
    Checkbox:               'Toggle',
    RadioButton:            'Toggle',
    Picker:                 'Picker',
    SegmentedControl:       'Picker',
    FlatList:               'List',
    SectionList:            'List',
    VirtualizedList:        'List',
    Text:                   'Label',
    Image:                  'Image',
    ImageBackground:        'Image',
    View:                   'Layout',
    SafeAreaView:           'Layout',
    KeyboardAvoidingView:   'Layout',
    ScrollView:             'Layout',
    ActivityIndicator:      'Indicator',
    Spinner:                'Indicator',
    Modal:                  'Modal',
};

export function classifyReactElement(name: string): VisualElementKind | undefined {
    if (!name) return undefined;
    if (PRIMITIVE_MAP[name]) return PRIMITIVE_MAP[name];
    // PascalCase fallback — user component.
    if (/^[A-Z][\w$]*$/.test(name)) return 'Custom';
    return undefined;
}

/**
 * Scan a JSX-bearing source file for element openers and tally each by
 * kind. Self-closing tags + opening tags both count once; closing tags
 * don't (to avoid double-counting). Comments + strings are skipped.
 */
export function classifyReactSource(source: string): Map<VisualElementKind, number> {
    const out = new Map<VisualElementKind, number>();
    if (!source) return out;
    // Strip JS comments + string literals so they don't shadow JSX
    // tags. Templating + JSX-in-strings are out of scope for v0.
    const stripped = stripJsCommentsAndStrings(source);
    // Match `<Tag` or `<tag` — letter-leading; capture the element name.
    // We intentionally over-match here (closing `</Tag>` also matches)
    // and dedup via a position-based skip below.
    const tagRe = /<\/?([A-Za-z][\w.]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(stripped)) !== null) {
        // Skip closing tags — preceded by `/`.
        if (stripped[m.index + 1] === '/') continue;
        // Dotted-namespace elements (`<Foo.Bar>`) — classify by leaf.
        const name = m[1].split('.').pop() ?? m[1];
        const kind = classifyReactElement(name);
        if (!kind) continue;
        out.set(kind, (out.get(kind) ?? 0) + 1);
    }
    return out;
}

/**
 * Bottom-up classifier used by `screenContentExtractor.ts` (#485 — L2b screen contents — 5 sections + visual inventory) to
 * collapse a custom component summary (`<LoginForm /> — 2 inputs, 1
 * button`). Best-effort: matches a single component's body and tallies
 * the immediate children inside its `return (...)` block.
 */
export function classifyComponentReturn(
    source: string,
    componentName: string,
): VisualElementClassification | undefined {
    const re = new RegExp(`(?:function|const)\\s+${componentName}\\b[^]*?return\\s*\\(([\\s\\S]+?)\\);`);
    const m = re.exec(source);
    if (!m) return undefined;
    const body = m[1];
    const tally = classifyReactSource(body);
    const nestedCounts = Object.fromEntries(tally.entries()) as Partial<Record<VisualElementKind, number>>;
    return {
        kind: 'Custom',
        originalName: componentName,
        nestedCounts,
    };
}

function stripJsCommentsAndStrings(source: string): string {
    // Replace line + block comments with equal-length whitespace.
    let out = source.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
    out = out.replace(/\/\*[\s\S]*?\*\//g, m => m.split('').map(c => (c === '\n' ? '\n' : ' ')).join(''));
    // Replace single+double+template strings (best-effort — no
    // interpolation-aware walk; the JSX inside template literals is
    // out of scope).
    out = out.replace(/'(?:\\.|[^'\\])*'/g, m => `'${' '.repeat(Math.max(0, m.length - 2))}'`);
    out = out.replace(/"(?:\\.|[^"\\])*"/g, m => `"${' '.repeat(Math.max(0, m.length - 2))}"`);
    return out;
}
