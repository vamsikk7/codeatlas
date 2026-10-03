/**
 * visualElementClassifier/types.ts — Issue #485-VISUAL shared types.
 *
 * Each per-framework classifier exports `classify(elementName)` →
 * `VisualElementKind | undefined`. The kind enum is intentionally
 * UI-agnostic so the L2b "Visual elements" panel can render the same
 * shape regardless of React/Vue/SwiftUI/Compose origin.
 */

export type VisualElementKind =
    | 'Button'
    | 'Input'
    | 'Toggle'
    | 'Picker'
    | 'List'
    | 'Label'
    | 'Image'
    | 'Form'
    | 'Layout'
    | 'Divider'
    | 'Indicator'
    | 'Modal'
    | 'Custom';

/**
 * Optional per-classifier metadata. Callers can ignore — the L2b
 * inventory panel only needs the kind tally — but the per-element
 * breakdown (`<Form> — 2 inputs, 1 button`) needs `nestedCounts`.
 */
export interface VisualElementClassification {
    kind: VisualElementKind;
    /** Element source name as written (e.g. `TouchableOpacity`, `View`). */
    originalName: string;
    /** Best-effort tally of immediate children by kind (form summary). */
    nestedCounts?: Partial<Record<VisualElementKind, number>>;
}
