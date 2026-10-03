/**
 * Shared LLM configuration payload for the AI-powered surfaces.
 *
 * Previously exported from `NlQueryBar.tsx`. That component was the Ask AI
 * (natural-language query) feature, removed in the open-source release because
 * the MCP tools cover the same ground with a clearer data-flow story. The type
 * itself is still used by AI Review, so it lives here rather than being
 * deleted along with its former host.
 */
export interface LlmConfigPayload {
    apiKey?: string;
    provider?: string;
    model?: string;
    endpoint?: string;
}
