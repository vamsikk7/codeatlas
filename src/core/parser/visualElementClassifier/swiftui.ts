/**
 * visualElementClassifier/swiftui.ts — Issue #485-VISUAL SwiftUI classifier.
 *
 * SwiftUI views are plain Swift expressions like `Button("Click") { … }`
 * or `TextField("Email", text: $email)`. There's no XML — just type
 * names invoked as initializers. We scan source for known SwiftUI view
 * type initializers and tally each by kind.
 *
 * Recognised primitives cover the SwiftUI standard library:
 *   Button / NavigationLink / Link                — Button
 *   TextField / SecureField / TextEditor          — Input
 *   Toggle                                        — Toggle
 *   Picker / Menu                                 — Picker
 *   List / ForEach (when wrapping a List)         — List
 *   Text / Label (a.k.a. View Label)              — Label
 *   Image / AsyncImage                            — Image
 *   Form                                          — Form
 *   VStack / HStack / ZStack / NavigationView / ScrollView / Group — Layout
 *   Divider                                       — Divider
 *   ProgressView                                  — Indicator
 *   Sheet (.sheet modifier) / Alert / ActionSheet — Modal
 *
 * Detection is regex-based on the source — no Swift parser. Matches
 * `<ViewName>(` at word boundaries; ignores `var body: some View {`
 * declarations + struct/class definitions.
 */

import type { VisualElementClassification, VisualElementKind } from './types';

const PRIMITIVE_MAP: Record<string, VisualElementKind> = {
    Button:         'Button',
    NavigationLink: 'Button',
    Link:           'Button',
    TextField:      'Input',
    SecureField:    'Input',
    TextEditor:     'Input',
    Toggle:         'Toggle',
    Picker:         'Picker',
    Menu:           'Picker',
    List:           'List',
    LazyVStack:     'List',
    LazyHStack:     'List',
    Text:           'Label',
    Label:          'Label',
    Image:          'Image',
    AsyncImage:     'Image',
    Form:           'Form',
    VStack:         'Layout',
    HStack:         'Layout',
    ZStack:         'Layout',
    NavigationView: 'Layout',
    NavigationStack:'Layout',
    ScrollView:     'Layout',
    Group:          'Layout',
    Section:        'Layout',
    Spacer:         'Layout',
    Divider:        'Divider',
    ProgressView:   'Indicator',
    Sheet:          'Modal',
    Alert:          'Modal',
    ActionSheet:    'Modal',
};

export function classifySwiftUIElement(name: string): VisualElementKind | undefined {
    if (!name) return undefined;
    if (PRIMITIVE_MAP[name]) return PRIMITIVE_MAP[name];
    // PascalCase Swift type → user view.
    if (/^[A-Z][\w]*$/.test(name)) return 'Custom';
    return undefined;
}

export function classifySwiftUISource(source: string): Map<VisualElementKind, number> {
    const out = new Map<VisualElementKind, number>();
    if (!source) return out;
    // Strip line + block comments + string literals so they don't
    // shadow real type references.
    const stripped = source
        .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
        .replace(/\/\*[\s\S]*?\*\//g, m => m.split('').map(c => (c === '\n' ? '\n' : ' ')).join(''))
        .replace(/"(?:\\.|[^"\\])*"/g, m => `"${' '.repeat(Math.max(0, m.length - 2))}"`);

    // We only want INVOCATIONS like `Button(` / `Text(` — not type
    // declarations like `struct ContentView: View {` or `class Foo`,
    // and not protocol-annotation positions like `: View` / `some View`.
    const re = /\b([A-Z][\w]*)\s*(?:\(|\{)/g;
    let m: RegExpExecArray | null;
    const KNOWN_NON_ELEMENTS = new Set(['Self', 'Type', 'View', 'Any', 'AnyView', 'EmptyView']);
    while ((m = re.exec(stripped)) !== null) {
        const lookback = stripped.slice(Math.max(0, m.index - 24), m.index);
        // Skip declaration keywords + protocol-position lookbacks (`:`, `some`, `any`).
        if (/\b(?:struct|class|enum|protocol|extension|var|let|func|return)\s+$/.test(lookback)) continue;
        if (/[:&|]\s*$/.test(lookback)) continue;            // `: View` / `& View`
        if (/\b(?:some|any)\s+$/.test(lookback)) continue;   // `some View` / `any View`
        const name = m[1];
        // SwiftUI protocol / scaffold types that shouldn't count.
        if (KNOWN_NON_ELEMENTS.has(name)) continue;
        const kind = classifySwiftUIElement(name);
        if (!kind) continue;
        out.set(kind, (out.get(kind) ?? 0) + 1);
    }
    return out;
}

export function classifySwiftUIView(
    source: string,
    viewName: string,
): VisualElementClassification | undefined {
    // Match `struct <viewName>: View { var body: some View { … } }`.
    const re = new RegExp(
        `struct\\s+${viewName}\\s*[:,][^{]*View[^{]*\\{[\\s\\S]*?var\\s+body\\s*:\\s*some\\s+View\\s*\\{([\\s\\S]+?)\\}\\s*\\}`,
    );
    const m = re.exec(source);
    if (!m) return undefined;
    const tally = classifySwiftUISource(m[1]);
    if (tally.size === 0) return undefined;
    return {
        kind: 'Custom',
        originalName: viewName,
        nestedCounts: Object.fromEntries(tally.entries()) as Partial<Record<VisualElementKind, number>>,
    };
}
