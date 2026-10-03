/**
 * visualElementClassifier/compose.ts — Issue #485-VISUAL Jetpack Compose.
 *
 * Compose UI is Kotlin functions annotated `@Composable`. The "elements"
 * are function-call invocations: `Button(onClick = …) { Text("Click") }`.
 * The classifier scans for known Compose composable invocations from
 * `androidx.compose.material*`, `androidx.compose.foundation*`, and
 * the Material 3 catalog.
 *
 * Recognised primitives:
 *   Button / IconButton / OutlinedButton / TextButton / FloatingActionButton — Button
 *   TextField / OutlinedTextField / BasicTextField                         — Input
 *   Switch / Checkbox / RadioButton / TriStateCheckbox                     — Toggle
 *   DropdownMenu / ExposedDropdownMenuBox                                  — Picker
 *   LazyColumn / LazyRow / LazyVerticalGrid / LazyHorizontalGrid           — List
 *   Text                                                                   — Label
 *   Image / AsyncImage / Icon                                              — Image
 *   Column / Row / Box / Scaffold / Surface                                — Layout
 *   Divider / HorizontalDivider / VerticalDivider                          — Divider
 *   CircularProgressIndicator / LinearProgressIndicator                    — Indicator
 *   AlertDialog / ModalBottomSheet / Dialog                                — Modal
 */

import type { VisualElementClassification, VisualElementKind } from './types';

const PRIMITIVE_MAP: Record<string, VisualElementKind> = {
    Button:                  'Button',
    IconButton:              'Button',
    OutlinedButton:          'Button',
    TextButton:              'Button',
    FilledTonalButton:       'Button',
    FloatingActionButton:    'Button',
    ExtendedFloatingActionButton: 'Button',
    SmallFloatingActionButton:    'Button',
    LargeFloatingActionButton:    'Button',

    TextField:               'Input',
    OutlinedTextField:       'Input',
    BasicTextField:          'Input',

    Switch:                  'Toggle',
    Checkbox:                'Toggle',
    RadioButton:             'Toggle',
    TriStateCheckbox:        'Toggle',

    DropdownMenu:            'Picker',
    ExposedDropdownMenuBox:  'Picker',

    LazyColumn:              'List',
    LazyRow:                 'List',
    LazyVerticalGrid:        'List',
    LazyHorizontalGrid:      'List',
    LazyVerticalStaggeredGrid: 'List',

    Text:                    'Label',

    Image:                   'Image',
    AsyncImage:              'Image',
    Icon:                    'Image',

    Column:                  'Layout',
    Row:                     'Layout',
    Box:                     'Layout',
    Scaffold:                'Layout',
    Surface:                 'Layout',
    Card:                    'Layout',
    Spacer:                  'Layout',

    Divider:                 'Divider',
    HorizontalDivider:       'Divider',
    VerticalDivider:         'Divider',

    CircularProgressIndicator: 'Indicator',
    LinearProgressIndicator:   'Indicator',

    AlertDialog:             'Modal',
    Dialog:                  'Modal',
    ModalBottomSheet:        'Modal',
    BottomSheet:             'Modal',
};

export function classifyComposeElement(name: string): VisualElementKind | undefined {
    if (!name) return undefined;
    if (PRIMITIVE_MAP[name]) return PRIMITIVE_MAP[name];
    // PascalCase Kotlin function → user composable.
    if (/^[A-Z][\w]*$/.test(name)) return 'Custom';
    return undefined;
}

export function classifyComposeSource(source: string): Map<VisualElementKind, number> {
    const out = new Map<VisualElementKind, number>();
    if (!source) return out;
    // Strip line + block comments + string literals.
    const stripped = source
        .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
        .replace(/\/\*[\s\S]*?\*\//g, m => m.split('').map(c => (c === '\n' ? '\n' : ' ')).join(''))
        .replace(/"(?:\\.|[^"\\])*"/g, m => `"${' '.repeat(Math.max(0, m.length - 2))}"`);
    // Compose calls look like `Name(` OR `Name {` for trailing-lambda
    // form (`Column { … }`). Same false-positive guard as SwiftUI —
    // skip `class Foo`, `fun Bar`, etc.
    const re = /\b([A-Z][\w]*)\s*(?:\(|\{)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
        const lookback = stripped.slice(Math.max(0, m.index - 24), m.index);
        if (/\b(?:class|fun|val|var|object|interface|return|is|as|in|by|where)\s+$/.test(lookback)) continue;
        const name = m[1];
        if (name === 'Modifier') continue; // Pseudo-builder; not a UI element.
        const kind = classifyComposeElement(name);
        if (!kind) continue;
        out.set(kind, (out.get(kind) ?? 0) + 1);
    }
    return out;
}

export function classifyComposeComposable(
    source: string,
    composableName: string,
): VisualElementClassification | undefined {
    // Match `@Composable fun <name>( … ) { … }` and tally the body.
    const re = new RegExp(
        `@Composable[^\\n]*\\nfun\\s+${composableName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]+?)\\n\\}`,
    );
    const m = re.exec(source);
    if (!m) return undefined;
    const tally = classifyComposeSource(m[1]);
    if (tally.size === 0) return undefined;
    return {
        kind: 'Custom',
        originalName: composableName,
        nestedCounts: Object.fromEntries(tally.entries()) as Partial<Record<VisualElementKind, number>>,
    };
}
