/**
 * lspFallbackResolver.ts
 *
 * Two-tier receiver-type resolution:
 *   1. **Snapshot scan** — fast, synchronous; checks snapshot file records
 *      for a matching type name across all files.  Works for simple cases
 *      (class defined in another file with a matching name).
 *   2. **LSP definition lookup** — async; uses the injected
 *      `DefinitionProviderFn` to ask the language server for the definition
 *      of a symbol at a specific file position.  Handles generics, re-exports,
 *      interface→impl, and DI.
 *
 * The LSP path is lazily activated:  it is never invoked if tree-sitter
 * resolution succeeded, and only if `codeatlas.lspFallback` is `true`.
 */

import type { DefinitionProviderFn, DefinitionLocation, LspClientOptions } from './lspClient';
import { DEFAULT_LSP_OPTIONS } from './lspClient';
import type { FileRecord } from '../graph/graphTypes';

/**
 * Result returned by the fallback resolver.
 */
export interface ResolvedReceiver {
    /** Workspace-relative path to the file that defines the receiver type. */
    filePath: string;
    /** The type/class name that was resolved. */
    typeName: string;
}

export class LspFallbackResolver {
    private options: LspClientOptions;
    private definitionProvider: DefinitionProviderFn | null = null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private lastCallTime = 0;

    constructor(options?: Partial<LspClientOptions>) {
        this.options = { ...DEFAULT_LSP_OPTIONS, ...options };
    }

    /** Inject a definition provider (typically from the VS Code extension host). */
    setDefinitionProvider(provider: DefinitionProviderFn): void {
        this.definitionProvider = provider;
    }

    /** Update options at runtime (e.g. when user toggles the setting). */
    updateOptions(options: Partial<LspClientOptions>): void {
        this.options = { ...this.options, ...options };
    }

    get enabled(): boolean {
        return this.options.enabled;
    }

    // ─── Tier 1: snapshot scan (sync, no LSP) ──────────────────────────

    /**
     * Tries to resolve `typeName` by scanning snapshot file records for
     * a file that exports / defines a class or function with that name.
     *
     * This handles the common case where:
     *   `import { TodoService } from './services/todoService'`
     * but the import path didn't resolve because it goes through an index
     * re-export or the receiver variable doesn't match any import local name.
     */
    resolveFromSnapshot(
        typeName: string,
        snapshotFiles: Record<string, FileRecord>,
    ): ResolvedReceiver | null {
        // Strip generic parameters for matching: Repository<Todo> → Repository
        const baseName = extractBaseType(typeName);
        const lowerName = baseName.toLowerCase();

        for (const [filePath, record] of Object.entries(snapshotFiles)) {
            // Check functions (includes class names in non-JS via tree-sitter)
            const fns = record.symbols?.functions ?? [];
            for (const fn of fns) {
                // Exact or case-insensitive match of the bare name
                const bare = fn.name.includes('.') ? fn.name.split('.').pop()! : fn.name;
                if (bare === baseName || bare.toLowerCase() === lowerName) {
                    return { filePath, typeName: bare };
                }
                // Also check the class prefix for dotted names (e.g. 'AuthService.validate' → 'AuthService')
                if (fn.name.includes('.')) {
                    const prefix = fn.name.split('.')[0];
                    if (prefix === baseName || prefix.toLowerCase() === lowerName) {
                        return { filePath, typeName: prefix };
                    }
                }
            }

            // Check variables (exported consts, class instances)
            const vars = record.symbols?.variables ?? [];
            for (const v of vars) {
                if (v.name === baseName || v.name.toLowerCase() === lowerName) {
                    return { filePath, typeName: v.name };
                }
            }
        }

        // Tier 1b: Re-export resolution (multi-hop, #237).
        // Walks `index.ts → users/index.ts → users/User.ts` chains up to
        // `MAX_HOPS` levels, tracking visited files in a Set to break cycles.
        const reExportResult = this.resolveViaReExport(baseName, lowerName, snapshotFiles);
        if (reExportResult) return reExportResult;

        // Tier 1c: Interface→impl resolution
        // If typeName is an interface, find a class that implements it
        for (const [filePath, record] of Object.entries(snapshotFiles)) {
            const fns = record.symbols?.functions ?? [];
            for (const fn of fns) {
                if (fn.kind !== 'class') continue;
                if (fn.implementsInterfaces?.includes(baseName)) {
                    return { filePath, typeName: fn.name };
                }
                if (fn.extendsClass === baseName) {
                    return { filePath, typeName: fn.name };
                }
            }
        }

        // Tier 1d: Generic type parameter resolution
        // For Repository<Todo>, also try resolving "Todo" as a standalone type
        if (baseName !== typeName) {
            const typeParams = extractTypeParams(typeName);
            for (const param of typeParams) {
                const paramBase = extractBaseType(param);
                const result = this.resolveFromSnapshot(paramBase, snapshotFiles);
                if (result) return result;
            }
        }

        return null;
    }

    // ─── Tier 2: LSP definition lookup (async) ─────────────────────────

    /**
     * Resolve a receiver's type by asking the language server for a
     * go-to-definition at the given file position.
     *
     * @param receiverName  Variable name being resolved (e.g. `todoService`).
     * @param filePath      Absolute or workspace-relative path of the file.
     * @param line          Zero-based line where `receiverName` appears.
     * @param column        Zero-based column where `receiverName` starts.
     * @param snapshotFiles Snapshot for post-processing the LSP result.
     * @returns Resolved receiver, or `null` if LSP unavailable / timed out.
     */
    async resolveViaLsp(
        receiverName: string,
        filePath: string,
        line: number,
        column: number,
        snapshotFiles: Record<string, FileRecord>,
    ): Promise<ResolvedReceiver | null> {
        if (!this.options.enabled || !this.definitionProvider) return null;

        this.touchIdle();

        try {
            const locations = await this.withTimeout(
                this.definitionProvider(filePath, line, column),
            );

            if (!locations || locations.length === 0) return null;

            // Pick the first definition that exists in the snapshot
            for (const loc of locations) {
                if (snapshotFiles[loc.filePath]) {
                    // Extract the type name from the target file
                    const typeName = this.extractTypeName(loc, snapshotFiles[loc.filePath]);
                    return { filePath: loc.filePath, typeName: typeName ?? receiverName };
                }
            }

            // If no snapshot match, still return the first location
            const first = locations[0];
            return { filePath: first.filePath, typeName: receiverName };
        } catch {
            // LSP timeout or error — graceful degradation
            return null;
        }
    }

    /**
     * Combined resolution: snapshot scan first, then LSP if enabled.
     * This is the main entry point for the sequence graph builder.
     */
    async resolveReceiverType(
        receiverName: string,
        filePath: string,
        line: number,
        column: number,
        snapshotFiles: Record<string, FileRecord>,
    ): Promise<ResolvedReceiver | null> {
        // Tier 1: snapshot scan
        const snapshotResult = this.resolveFromSnapshot(receiverName, snapshotFiles);
        if (snapshotResult) return snapshotResult;

        // Tier 2: LSP
        return this.resolveViaLsp(receiverName, filePath, line, column, snapshotFiles);
    }

    /** Shut down and clear timers. */
    dispose(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    // ─── Internals ─────────────────────────────────────────────────────

    /**
     * Recursive re-export walker (#237). Follows `index.ts → sub/index.ts →
     * sub/X.ts` chains up to MAX_HOPS deep, breaking cycles via a `visited`
     * set keyed by absolute file path. Returns the first concrete file that
     * actually defines `baseName` as a function/class/variable.
     */
    private resolveViaReExport(
        baseName: string,
        lowerName: string,
        snapshotFiles: Record<string, FileRecord>,
        visited: Set<string> = new Set(),
        depth: number = 0,
    ): ResolvedReceiver | null {
        const MAX_HOPS = 5;
        if (depth >= MAX_HOPS) return null;

        for (const [filePath, record] of Object.entries(snapshotFiles)) {
            if (visited.has(filePath)) continue;
            // Only consider barrel/index files as bridges; non-index files
            // are handled by the leaf scan in resolveFromSnapshot's tier 1a.
            if (!filePath.match(/\/index\.[jt]sx?$/) && !filePath.match(/^index\.[jt]sx?$/)) continue;
            const imports = record.symbols?.imports ?? [];
            for (const imp of imports) {
                const hasSpecifier = imp.specifiers?.some(
                    s => s.local === baseName || s.imported === baseName,
                );
                if (!hasSpecifier && imp.source !== baseName) continue;
                if (!imp.source.startsWith('.')) continue;
                const indexDir = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '';
                const exts = ['', '.ts', '.tsx', '.js', '.jsx'];
                for (const ext of exts) {
                    const candidate = (indexDir ? indexDir + '/' : '') +
                        imp.source.replace(/^\.\//, '') + ext;
                    if (!snapshotFiles[candidate]) continue;
                    // Tier 1: leaf check — does the candidate file directly
                    // define the name?
                    const targetFns = snapshotFiles[candidate].symbols?.functions ?? [];
                    for (const fn of targetFns) {
                        const bare = fn.name.includes('.') ? fn.name.split('.').pop()! : fn.name;
                        if (bare === baseName || bare.toLowerCase() === lowerName) {
                            return { filePath: candidate, typeName: bare };
                        }
                    }
                    // Tier 2: candidate is itself an index file → recurse.
                    if (candidate.match(/\/index\.[jt]sx?$/) || candidate.match(/^index\.[jt]sx?$/)) {
                        visited.add(filePath);
                        const next = this.resolveViaReExport(baseName, lowerName, snapshotFiles, visited, depth + 1);
                        if (next) return next;
                    }
                }
            }
        }
        return null;
    }

    private touchIdle(): void {
        this.lastCallTime = Date.now();
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            // After idle period, null out provider reference so callers know
            // they need to re-inject if they want to use LSP again.
            // (In practice the extension host re-injects on next activate.)
            this.idleTimer = null;
        }, this.options.idleShutdownMs);
    }

    private withTimeout<T>(promise: Promise<T>): Promise<T | null> {
        return Promise.race([
            promise,
            new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), this.options.timeout),
            ),
        ]);
    }

    private extractTypeName(
        location: DefinitionLocation,
        record: FileRecord,
    ): string | null {
        // Look for a function/class at the definition line
        const fns = record.symbols?.functions ?? [];
        for (const fn of fns) {
            // If the definition's line matches a known entity span, use its name
            const bare = fn.name.includes('.') ? fn.name.split('.').pop()! : fn.name;
            if (bare) return bare;
        }
        return null;
    }
}

// ─── Utility: offset → line:col conversion ───────────────────────────────

/**
 * Convert a character offset in a source string to a zero-based { line, col }.
 * Used to translate tree-sitter spans to line:col positions for LSP calls.
 */
export function offsetToLineCol(content: string, offset: number): { line: number; col: number } {
    if (!content || offset <= 0) return { line: 0, col: 0 };
    const clamped = Math.min(offset, content.length);
    let line = 0;
    let lastNewline = -1;
    for (let i = 0; i < clamped; i++) {
        if (content[i] === '\n') {
            line++;
            lastNewline = i;
        }
    }
    return { line, col: clamped - lastNewline - 1 };
}

/**
 * Extract the base type name from a generic type string.
 * e.g. "Repository<Todo>" → "Repository", "Map<String, List<Int>>" → "Map"
 */
export function extractBaseType(typeName: string): string {
    const idx = typeName.indexOf('<');
    return idx >= 0 ? typeName.slice(0, idx) : typeName;
}

/**
 * Extract type parameters from a generic type string.
 * e.g. "Repository<Todo>" → ["Todo"], "Map<String, Int>" → ["String", "Int"]
 * Only extracts top-level parameters (no nesting).
 */
export function extractTypeParams(typeName: string): string[] {
    const start = typeName.indexOf('<');
    const end = typeName.lastIndexOf('>');
    if (start < 0 || end < 0 || end <= start) return [];
    const inner = typeName.slice(start + 1, end);
    // Split on commas not inside nested angle brackets
    const params: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of inner) {
        if (ch === '<') depth++;
        else if (ch === '>') depth--;
        else if (ch === ',' && depth === 0) {
            const trimmed = current.trim();
            if (trimmed) params.push(trimmed);
            current = '';
            continue;
        }
        current += ch;
    }
    const trimmed = current.trim();
    if (trimmed) params.push(trimmed);
    return params;
}

// Singleton instance for the extension
let instance: LspFallbackResolver | null = null;

export function getLspFallbackResolver(): LspFallbackResolver {
    if (!instance) {
        instance = new LspFallbackResolver();
    }
    return instance;
}

export function disposeLspFallbackResolver(): void {
    instance?.dispose();
    instance = null;
}
