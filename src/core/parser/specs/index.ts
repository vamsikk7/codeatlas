/**
 * specs/index.ts — Language → `LanguageSpec` lookup table.
 *
 * Unlike `frameworks/index.ts` and `mobile/index.ts`, the tree-sitter
 * dispatch is 1-to-1 (one spec per language, picked by `extractSymbols`
 * from a direct map lookup), so we don't need a `Registry` class. The
 * dispatcher reads `LANGUAGE_SPECS[language]` once per file.
 *
 * C++ deliberately shares the C spec — the two languages overlap enough
 * for our purposes (function definitions, struct/enum/union, includes)
 * and we don't currently extract C++-specific constructs like
 * namespaces or templates.
 */

import type { SupportedLanguage } from '../treeSitterParser';
import type { LanguageSpec } from './_shared';

import { JAVASCRIPT_SPEC } from './javascript';
import { TYPESCRIPT_SPEC } from './typescript';
import { PYTHON_SPEC } from './python';
import { JAVA_SPEC } from './java';
import { KOTLIN_SPEC } from './kotlin';
import { GO_SPEC } from './go';
import { RUST_SPEC } from './rust';
import { C_SPEC } from './c';
import { CSHARP_SPEC } from './csharp';
import { PHP_SPEC } from './php';
import { RUBY_SPEC } from './ruby';
import { SWIFT_SPEC } from './swift';
import { DART_SPEC } from './dart';

export { type LanguageSpec, type TSNode, nodeText, findChild, findChildByField } from './_shared';

export const LANGUAGE_SPECS: Partial<Record<SupportedLanguage, LanguageSpec>> = {
    javascript: JAVASCRIPT_SPEC,
    typescript: TYPESCRIPT_SPEC,
    python: PYTHON_SPEC,
    java: JAVA_SPEC,
    kotlin: KOTLIN_SPEC,
    go: GO_SPEC,
    rust: RUST_SPEC,
    c: C_SPEC,
    cpp: C_SPEC, // C++ uses mostly same patterns as C with additions
    csharp: CSHARP_SPEC,
    php: PHP_SPEC,
    ruby: RUBY_SPEC,
    swift: SWIFT_SPEC,
    dart: DART_SPEC,
};
