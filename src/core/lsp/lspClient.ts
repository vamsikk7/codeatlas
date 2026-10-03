/**
 * lspClient.ts
 *
 * Abstract interface for language server definition providers.
 * The extension host injects a concrete implementation (VS Code's
 * `executeDefinitionProvider` for TS; language-specific stubs for others).
 */

import type { SupportedLanguage } from '../parser/treeSitterParser';

/**
 * A definition location returned by an LSP-compatible provider.
 */
export interface DefinitionLocation {
    /** Workspace-relative file path of the definition */
    filePath: string;
    /** Zero-based line number */
    line: number;
    /** Zero-based column */
    column: number;
}

/**
 * Signature of a function that resolves a symbol at a given position
 * to its definition location(s).
 *
 * In the VS Code extension host this is backed by
 * `vscode.commands.executeCommand('vscode.executeDefinitionProvider', ...)`.
 */
export type DefinitionProviderFn = (
    filePath: string,
    line: number,
    column: number,
) => Promise<DefinitionLocation[] | null>;

/**
 * Options that control the LSP fallback layer.
 */
export interface LspClientOptions {
    /** Whether the fallback is enabled (maps to `codeatlas.lspFallback`). */
    enabled: boolean;
    /** Per-call timeout in ms (maps to `codeatlas.lspTimeout`). Default 2000. */
    timeout: number;
    /** Idle shutdown delay in ms. Default 30 000. */
    idleShutdownMs: number;
}

export const DEFAULT_LSP_OPTIONS: LspClientOptions = {
    enabled: false,
    timeout: 2000,
    idleShutdownMs: 30_000,
};
