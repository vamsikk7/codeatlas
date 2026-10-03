/**
 * visualElementClassifier/androidXml.ts — Issue #485-VISUAL Android XML layout classifier.
 *
 * Android XML layouts (`res/layout/*.xml`) declare widgets as XML
 * elements with `android:` attributes. The classifier maps tag names to
 * `VisualElementKind`:
 *
 *   Button / ImageButton / CompoundButton                — Button
 *   EditText / TextInputEditText / SearchView            — Input
 *   Switch / SwitchCompat / CheckBox / RadioButton       — Toggle
 *   Spinner / NumberPicker / TimePicker / DatePicker     — Picker
 *   RecyclerView / ListView / GridView / ExpandableListView — List
 *   TextView / Chip                                      — Label
 *   ImageView / ShapeableImageView                       — Image
 *   LinearLayout / RelativeLayout / FrameLayout /
 *     ConstraintLayout / CoordinatorLayout / MotionLayout / ScrollView / NestedScrollView — Layout
 *   View / Space                                         — Divider (when used as visual separator)
 *   ProgressBar                                          — Indicator
 *   (No Modal — Dialogs are programmatic in Android, not in XML)
 *
 * Tag names use both bare (`Button`) and fully-qualified
 * (`androidx.compose.foundation.BasicTextField`) forms. We classify by
 * the leaf tag name (`split('.').pop()`).
 */

import type { VisualElementClassification, VisualElementKind } from './types';

const PRIMITIVE_MAP: Record<string, VisualElementKind> = {
    Button:                 'Button',
    ImageButton:            'Button',
    MaterialButton:         'Button',
    CompoundButton:         'Button',
    FloatingActionButton:   'Button',
    Chip:                   'Label',

    EditText:               'Input',
    TextInputEditText:      'Input',
    TextInputLayout:        'Input',
    SearchView:             'Input',
    AutoCompleteTextView:   'Input',

    Switch:                 'Toggle',
    SwitchCompat:           'Toggle',
    SwitchMaterial:         'Toggle',
    CheckBox:               'Toggle',
    RadioButton:            'Toggle',
    ToggleButton:           'Toggle',

    Spinner:                'Picker',
    NumberPicker:           'Picker',
    TimePicker:             'Picker',
    DatePicker:             'Picker',

    RecyclerView:           'List',
    ListView:               'List',
    GridView:               'List',
    ExpandableListView:     'List',

    TextView:               'Label',

    ImageView:              'Image',
    ShapeableImageView:     'Image',

    LinearLayout:           'Layout',
    RelativeLayout:         'Layout',
    FrameLayout:            'Layout',
    ConstraintLayout:       'Layout',
    CoordinatorLayout:      'Layout',
    MotionLayout:           'Layout',
    ScrollView:             'Layout',
    NestedScrollView:       'Layout',
    HorizontalScrollView:   'Layout',
    TableLayout:            'Layout',

    ProgressBar:            'Indicator',
};

export function canParseAndroidXml(filePath: string): boolean {
    return /\.xml$/i.test(filePath) && /\b(?:res|layout)\b/.test(filePath);
}

export function classifyAndroidXmlElement(tagName: string): VisualElementKind | undefined {
    if (!tagName) return undefined;
    // Strip any package qualifier (`androidx.foo.Button` → `Button`).
    const leaf = tagName.split('.').pop() ?? tagName;
    if (PRIMITIVE_MAP[leaf]) return PRIMITIVE_MAP[leaf];
    // PascalCase user view → Custom.
    if (/^[A-Z][\w]*$/.test(leaf)) return 'Custom';
    return undefined;
}

export function classifyAndroidXmlSource(source: string): Map<VisualElementKind, number> {
    const out = new Map<VisualElementKind, number>();
    if (!source) return out;
    // Strip XML comments.
    const stripped = source.replace(/<!--[\s\S]*?-->/g, m => m.split('').map(c => (c === '\n' ? '\n' : ' ')).join(''));
    // Match opening tags: `<TagName` or `<package.TagName`. Closing
    // tags (`</…>`) are not counted (`<` is followed by `/`).
    const tagRe = /<\/?([A-Za-z][\w.]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(stripped)) !== null) {
        if (stripped[m.index + 1] === '/') continue;
        const kind = classifyAndroidXmlElement(m[1]);
        if (!kind) continue;
        out.set(kind, (out.get(kind) ?? 0) + 1);
    }
    return out;
}

export function classifyAndroidXmlLayout(
    source: string,
    layoutName: string,
): VisualElementClassification | undefined {
    const tally = classifyAndroidXmlSource(source);
    if (tally.size === 0) return undefined;
    return {
        kind: 'Custom',
        originalName: layoutName,
        nestedCounts: Object.fromEntries(tally.entries()) as Partial<Record<VisualElementKind, number>>,
    };
}
