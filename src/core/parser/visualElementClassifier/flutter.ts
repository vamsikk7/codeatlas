/**
 * visualElementClassifier/flutter.ts — Issue #485-VISUAL Flutter widget classifier.
 *
 * Flutter widgets are Dart classes constructed via `Widget()` calls in
 * the `build` method. We scan source for known stdlib widget
 * invocations + Cupertino + Material catalogs.
 *
 * Recognised primitives:
 *   ElevatedButton / OutlinedButton / TextButton / IconButton /
 *     FloatingActionButton / CupertinoButton / GestureDetector /
 *     InkWell                                                — Button
 *   TextField / TextFormField / CupertinoTextField           — Input
 *   Switch / Checkbox / Radio / CupertinoSwitch              — Toggle
 *   DropdownButton / CupertinoPicker                         — Picker
 *   ListView / GridView / Wrap / SliverList                  — List
 *   Text / RichText                                          — Label
 *   Image / Image.asset / Image.network / FadeInImage / Icon — Image
 *   Form                                                     — Form
 *   Container / Row / Column / Stack / SizedBox / Padding /
 *     Center / Align / SafeArea / Scaffold / AppBar          — Layout
 *   Divider / VerticalDivider                                — Divider
 *   CircularProgressIndicator / LinearProgressIndicator      — Indicator
 *   AlertDialog / SimpleDialog / Dialog / BottomSheet        — Modal
 */

import type { VisualElementClassification, VisualElementKind } from './types';

const PRIMITIVE_MAP: Record<string, VisualElementKind> = {
    // Buttons
    ElevatedButton:        'Button',
    OutlinedButton:        'Button',
    TextButton:            'Button',
    IconButton:            'Button',
    FloatingActionButton:  'Button',
    CupertinoButton:       'Button',
    GestureDetector:       'Button',
    InkWell:               'Button',
    MaterialButton:        'Button',
    RaisedButton:          'Button',
    FlatButton:            'Button',

    // Inputs
    TextField:             'Input',
    TextFormField:         'Input',
    CupertinoTextField:    'Input',

    // Toggles
    Switch:                'Toggle',
    Checkbox:              'Toggle',
    Radio:                 'Toggle',
    CupertinoSwitch:       'Toggle',

    // Pickers
    DropdownButton:        'Picker',
    DropdownMenu:          'Picker',
    CupertinoPicker:       'Picker',

    // Lists
    ListView:              'List',
    GridView:              'List',
    Wrap:                  'List',
    SliverList:            'List',
    SliverGrid:            'List',
    ReorderableListView:   'List',

    // Labels
    Text:                  'Label',
    RichText:              'Label',
    SelectableText:        'Label',

    // Images
    Image:                 'Image',
    FadeInImage:           'Image',
    NetworkImage:          'Image',
    AssetImage:            'Image',
    Icon:                  'Image',
    CircleAvatar:          'Image',

    // Forms
    Form:                  'Form',

    // Layouts
    Container:             'Layout',
    Row:                   'Layout',
    Column:                'Layout',
    Stack:                 'Layout',
    SizedBox:              'Layout',
    Padding:               'Layout',
    Center:                'Layout',
    Align:                 'Layout',
    SafeArea:              'Layout',
    Scaffold:              'Layout',
    AppBar:                'Layout',
    Expanded:              'Layout',
    Flexible:              'Layout',
    Card:                  'Layout',

    // Dividers
    Divider:               'Divider',
    VerticalDivider:       'Divider',

    // Indicators
    CircularProgressIndicator: 'Indicator',
    LinearProgressIndicator:   'Indicator',

    // Modals
    AlertDialog:           'Modal',
    SimpleDialog:          'Modal',
    Dialog:                'Modal',
    BottomSheet:           'Modal',
    ModalBottomSheet:      'Modal',
    CupertinoAlertDialog:  'Modal',
};

export function classifyFlutterElement(name: string): VisualElementKind | undefined {
    if (!name) return undefined;
    if (PRIMITIVE_MAP[name]) return PRIMITIVE_MAP[name];
    if (/^[A-Z][\w]*$/.test(name)) return 'Custom';
    return undefined;
}

export function classifyFlutterSource(source: string): Map<VisualElementKind, number> {
    const out = new Map<VisualElementKind, number>();
    if (!source) return out;
    const stripped = source
        .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
        .replace(/\/\*[\s\S]*?\*\//g, m => m.split('').map(c => (c === '\n' ? '\n' : ' ')).join(''))
        .replace(/'(?:\\.|[^'\\])*'/g, m => `'${' '.repeat(Math.max(0, m.length - 2))}'`)
        .replace(/"(?:\\.|[^"\\])*"/g, m => `"${' '.repeat(Math.max(0, m.length - 2))}"`);

    // Widget invocations: `Name(`. Strip declarations.
    const re = /\b([A-Z][\w]*)\s*\(/g;
    let m: RegExpExecArray | null;
    // Non-visual Dart helpers + scaffolding types — these have Flutter
    // constructor invocations but aren't elements the user sees.
    const KNOWN_NON_WIDGETS = new Set([
        'BuildContext', 'Widget', 'Key', 'GlobalKey',
        'EdgeInsets', 'Color', 'Colors', 'TextStyle', 'IconData',
        'MediaQuery', 'Theme', 'MaterialApp', 'WidgetsApp', 'CupertinoApp',
        'InputDecoration', 'BoxDecoration', 'Border', 'BorderRadius',
        'BorderSide', 'BoxShadow', 'BoxConstraints', 'Offset', 'Size',
        'Duration', 'Curve', 'Curves', 'Tween',
        'MainAxisAlignment', 'CrossAxisAlignment', 'MainAxisSize', 'TextAlign',
        'Alignment', 'AlignmentDirectional', 'FontWeight', 'FontStyle',
    ]);
    while ((m = re.exec(stripped)) !== null) {
        const lookback = stripped.slice(Math.max(0, m.index - 30), m.index);
        // Note: we deliberately DON'T include `return`/`new` here because
        // `return Container(...)` and `new Foo()` are exactly the
        // widget-invocation shape we want to count. Same for named
        // arguments like `appBar: AppBar(…)` — Dart uses `:` for both
        // type annotations AND named args, and the named-arg form is
        // overwhelmingly the dominant case in build() bodies.
        if (/\b(?:class|extends|implements|with|var|final|const|late|static|abstract|typedef)\s+$/.test(lookback)) continue;
        const name = m[1];
        if (KNOWN_NON_WIDGETS.has(name)) continue;
        const kind = classifyFlutterElement(name);
        if (!kind) continue;
        out.set(kind, (out.get(kind) ?? 0) + 1);
    }
    return out;
}

export function classifyFlutterWidget(
    source: string,
    widgetName: string,
): VisualElementClassification | undefined {
    // Match `class <name> extends StatelessWidget|StatefulWidget { ... build(...) { return ... } }`
    const re = new RegExp(
        `class\\s+${widgetName}\\s+extends\\s+(?:Stateless|Stateful)Widget[\\s\\S]*?Widget\\s+build\\([^)]*\\)\\s*\\{([\\s\\S]+?)\\n\\s{0,2}\\}`,
    );
    const m = re.exec(source);
    if (!m) return undefined;
    const tally = classifyFlutterSource(m[1]);
    if (tally.size === 0) return undefined;
    return {
        kind: 'Custom',
        originalName: widgetName,
        nestedCounts: Object.fromEntries(tally.entries()) as Partial<Record<VisualElementKind, number>>,
    };
}
