/**
 * visualElementClassifier/index.ts — Issue #485-VISUAL registry.
 *
 * Per-framework classifiers each export a `classify*` function. The
 * dispatcher (`classifyVisualElements`) picks the right one based on
 * file extension + content sniffing.
 *
 * v1 ships React + React Native via `react.ts`. Vue / Svelte / SwiftUI
 * / Compose / Flutter / Android XML follow as separate single-file PRs.
 */

export type { VisualElementKind, VisualElementClassification } from './types';
export { classifyReactElement, classifyReactSource, classifyComponentReturn } from './react';
export { classifyVueElement, classifyVueSource, classifyVueComponent } from './vue';
export { classifySvelteElement, classifySvelteSource, classifySvelteComponent } from './svelte';
export { classifySwiftUIElement, classifySwiftUISource, classifySwiftUIView } from './swiftui';
export { classifyComposeElement, classifyComposeSource, classifyComposeComposable } from './compose';
export { classifyFlutterElement, classifyFlutterSource, classifyFlutterWidget } from './flutter';
export { canParseAndroidXml, classifyAndroidXmlElement, classifyAndroidXmlSource, classifyAndroidXmlLayout } from './androidXml';

import type { VisualElementKind } from './types';
import { classifyReactSource } from './react';
import { classifyVueSource } from './vue';
import { classifySvelteSource } from './svelte';
import { classifySwiftUISource } from './swiftui';
import { classifyComposeSource } from './compose';
import { classifyFlutterSource } from './flutter';
import { canParseAndroidXml, classifyAndroidXmlSource } from './androidXml';

/**
 * Top-level dispatcher. Inspects file extension + first-200-char content
 * shape to pick the per-framework classifier. Returns an empty tally
 * when no classifier claims the file.
 */
export function classifyVisualElements(
    filePath: string,
    source: string,
): Map<VisualElementKind, number> {
    const lower = filePath.toLowerCase();
    if (/\.(tsx|jsx)$/i.test(lower)) return classifyReactSource(source);
    if (/\.vue$/i.test(lower)) return classifyVueSource(source);
    if (/\.svelte$/i.test(lower)) return classifySvelteSource(source);
    if (/\.swift$/i.test(lower)) return classifySwiftUISource(source);
    if (/\.kt$/i.test(lower)) return classifyComposeSource(source);
    if (/\.dart$/i.test(lower)) return classifyFlutterSource(source);
    if (canParseAndroidXml(filePath)) return classifyAndroidXmlSource(source);
    // Fall back to source-content sniffing for .js/.ts when JSX is present.
    if (/\.(js|ts)$/i.test(lower) && /<[A-Za-z]/.test(source.slice(0, 4000))) {
        return classifyReactSource(source);
    }
    return new Map();
}
