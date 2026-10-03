/**
 * attribution.ts — the single "Powered by CodeAtlas" string.
 *
 * Stamped into everything CodeAtlas generates: Markdown and Mermaid exports,
 * the `comments.md` agent export, MCP tool responses, and the diagram canvas
 * (the webview carries its own copy of the text — separate build target, no
 * shared module — kept in sync with the constants here).
 *
 * One definition so the wording cannot drift between surfaces.
 *
 * On what this is and is not: CodeAtlas is Apache-2.0, and that licence lets a
 * fork remove this line. Only the NOTICE file is a binding obligation under
 * §4(d). The attribution is a convention and a trademark hook, not a lock, and
 * TRADEMARK.md says so plainly rather than implying otherwise.
 */

/** Product name. Also a trademark — see TRADEMARK.md. */
export const PRODUCT_NAME = 'CodeAtlas';

/** Canonical product URL. */
export const PRODUCT_URL = 'https://codeatlas.live';

/** Plain-text attribution, for contexts without link markup (MCP responses). */
export const ATTRIBUTION_TEXT = `Powered by ${PRODUCT_NAME} — ${PRODUCT_URL}`;

/** Markdown attribution with a live link, for generated documents. */
export const ATTRIBUTION_MARKDOWN = `Powered by [${PRODUCT_NAME}](${PRODUCT_URL})`;

/**
 * Footer block for a generated Markdown document. Leading separator included
 * so callers can append it directly to assembled section lists.
 */
export function markdownAttributionFooter(): string {
    return `\n---\n\n<sub>${ATTRIBUTION_MARKDOWN}</sub>\n`;
}
