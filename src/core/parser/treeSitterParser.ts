/**
 * treeSitterParser.ts
 *
 * Universal multi-language parser using Tree-sitter WASM grammars.
 * Replaces the Babel-only jsParser.ts for non-JS languages and extends
 * CodeAtlas to support 12+ programming languages.
 *
 * Architecture:
 * - Uses `web-tree-sitter` for WASM-based parsing (works in Node.js and browser)
 * - Grammars are loaded lazily per-language on first use
 * - Returns standard Tree-sitter Tree objects for downstream extraction
 */

import Parser from 'web-tree-sitter';

// In vitest, `import Parser` and `require('web-tree-sitter')` resolve to *different* objects,
// and `init()` only mutates whichever one it's called on. The CJS build is the real constructor,
// so prefer it. If require fails (pure ESM env), fall back to the ESM default.
let _reqParser: any = null;
try {
    const _req = require('web-tree-sitter');
    if (_req && typeof _req.init === 'function') _reqParser = _req;
} catch { /* pure ESM env */ }
import * as path from 'path';
import * as fs from 'fs';

// ─── Language Registry ──────────────────────────────────────────────────────

export type SupportedLanguage =
    | 'javascript'
    | 'typescript'
    | 'python'
    | 'java'
    | 'kotlin'
    | 'go'
    | 'rust'
    | 'c'
    | 'cpp'
    | 'csharp'
    | 'php'
    | 'ruby'
    | 'swift'
    | 'dart';

/**
 * Map file extensions to language identifiers.
 */
const EXTENSION_MAP: Record<string, SupportedLanguage> = {
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.py': 'python',
    '.pyw': 'python',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.go': 'go',
    '.rs': 'rust',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hxx': 'cpp',
    '.cs': 'csharp',
    '.php': 'php',
    '.rb': 'ruby',
    '.swift': 'swift',
    '.dart': 'dart',
};

/**
 * Map language names to WASM grammar filenames.
 * These files are expected in the `grammars/` directory relative to the extension root.
 */
const GRAMMAR_FILES: Record<SupportedLanguage, string> = {
    javascript: 'tree-sitter-javascript.wasm',
    typescript: 'tree-sitter-typescript.wasm',
    python: 'tree-sitter-python.wasm',
    java: 'tree-sitter-java.wasm',
    kotlin: 'tree-sitter-kotlin.wasm',
    go: 'tree-sitter-go.wasm',
    rust: 'tree-sitter-rust.wasm',
    c: 'tree-sitter-c.wasm',
    cpp: 'tree-sitter-cpp.wasm',
    csharp: 'tree-sitter-c_sharp.wasm',
    php: 'tree-sitter-php.wasm',
    ruby: 'tree-sitter-ruby.wasm',
    swift: 'tree-sitter-swift.wasm',
    dart: 'tree-sitter-dart.wasm',
};

/**
 * All file extensions we support for scanning.
 */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_MAP);

/**
 * Regex pattern for file watcher globs.
 */
export const SUPPORTED_EXTENSIONS_GLOB =
    '**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts,py,pyw,java,kt,kts,go,rs,c,h,cpp,cc,cxx,hpp,hxx,cs,php,rb,swift,dart}';

/**
 * Regex for matching supported files by extension.
 */
export const SUPPORTED_FILE_REGEX = new RegExp(
    `\\.(${Object.keys(EXTENSION_MAP).map(e => e.slice(1)).join('|')})$`,
    'i'
);

// ─── Parser Manager ─────────────────────────────────────────────────────────

let parserInitialized = false;
let parserInitFailed = false;
const loadedLanguages = new Map<SupportedLanguage, Parser.Language>();
// Resolve grammars directory — works from both dist/ (production) and src/ (test/dev)
let grammarsDir: string = findFirstExisting([
    // #EXP-6 — the bundled daemon/extension live in `<root>/dist`, and grammars in
    // `<root>/grammars`, so from dist/ the correct path is `__dirname/../grammars`.
    // The two `..` variants only ever resolved via the cwd fallback (which breaks
    // when the standalone MCP daemon is launched from a workspace dir), leaving
    // every tree-sitter language with EMPTY symbols → empty L4/L3/L5 for non-JS/TS.
    path.join(__dirname, 'grammars'),                   // npm @codeatlas/mcp — grammars colocated in dist/
    path.join(__dirname, '..', 'grammars'),             // from dist/ (production: dist/../grammars = <root>/grammars)
    path.join(__dirname, '..', '..', 'grammars'),       // legacy nested layout
    path.join(__dirname, '..', '..', '..', 'grammars'), // from src/core/parser/ (test: ../../../grammars)
    path.join(process.cwd(), 'grammars'),               // from project root (fallback)
]) ?? path.join(__dirname, '..', 'grammars');

/**
 * Find the first existing directory from a list of candidates.
 */
function findFirstExisting(candidates: string[]): string | undefined {
    for (const dir of candidates) {
        try { if (fs.existsSync(dir)) return dir; } catch { /* ignore */ }
    }
    return undefined;
}

/**
 * Set the directory where WASM grammar files are stored.
 * Call this from extension.ts activate() to set the correct path relative to the extension.
 */
export function setGrammarsDir(dir: string): void {
    grammarsDir = dir;
}

/**
 * Allow tests to reset the init state so WASM can be re-initialized.
 */
export function resetTreeSitterForTesting(): void {
    parserInitialized = false;
    parserInitFailed = false;
    loadedLanguages.clear();
    // #723 — drop cached parsers so tests that re-init grammars from a
    // fresh wasm runtime aren't holding stale parser instances against the
    // previous language objects.
    for (const p of parsers.values()) {
        try { (p as any).delete?.(); } catch { /* ignore */ }
    }
    parsers.clear();
}

/**
 * Initialize the Tree-sitter WASM runtime.
 * Must be called once before any parsing.
 * Searches multiple paths for tree-sitter.wasm to work in both bundled and source modes.
 */
export async function initTreeSitter(): Promise<void> {
    if (parserInitialized) return;
    if (parserInitFailed) throw new Error('Tree-sitter WASM unavailable');

    // Search multiple candidate locations for tree-sitter.wasm
    const candidates = [
        path.join(__dirname, 'tree-sitter.wasm'),                          // dist/ (production)
        path.join(__dirname, '..', '..', 'dist', 'tree-sitter.wasm'),     // from src/core/parser/ → dist/
        path.join(__dirname, '..', '..', '..', 'dist', 'tree-sitter.wasm'), // deeper src nesting
        path.join(process.cwd(), 'dist', 'tree-sitter.wasm'),             // from project root
    ];
    const wasmPath = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });

    if (!wasmPath) {
        parserInitFailed = true;
        throw new Error(`Tree-sitter WASM not found in any of: ${candidates.join(', ')}`);
    }

    try {
        // Init on the require'd Parser if available (CJS) — that's the one that actually
        // gets `Language` populated. Then mirror Language back onto the ESM-imported Parser
        // so the rest of this module sees it.
        if (_reqParser) {
            await _reqParser.init({ locateFile: () => wasmPath });
            if (_reqParser.Language && !(Parser as any).Language) {
                (Parser as any).Language = _reqParser.Language;
            }
        } else {
            await Parser.init({ locateFile: () => wasmPath });
        }
    } catch (e) {
        parserInitFailed = true;
        throw e;
    }

    parserInitialized = true;
}

/**
 * Load a language grammar, caching it for reuse.
 */
export async function loadLanguage(lang: SupportedLanguage): Promise<Parser.Language> {
    const cached = loadedLanguages.get(lang);
    if (cached) return cached;

    await initTreeSitter();

    const grammarFile = GRAMMAR_FILES[lang];
    const grammarPath = path.join(grammarsDir, grammarFile);

    if (!fs.existsSync(grammarPath)) {
        throw new Error(`Grammar file not found: ${grammarPath}. Run 'npm run download-grammars' to fetch WASM files.`);
    }

    const LanguageCls: any = (_reqParser?.Language) ?? (Parser as any).Language;
    if (!LanguageCls?.load) {
        throw new Error('web-tree-sitter Language class unavailable after init');
    }
    const language = await LanguageCls.load(grammarPath);
    loadedLanguages.set(lang, language);
    return language;
}

/**
 * Detect language from a file path.
 */
export function detectLanguage(filePath: string): SupportedLanguage | undefined {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_MAP[ext];
}

/**
 * Check if a file path is for a supported language.
 */
export function isSupportedFile(filePath: string): boolean {
    return detectLanguage(filePath) !== undefined;
}

/**
 * Cached parser instances, keyed by language.
 *
 * Issue #723 — allocating a fresh `new Parser()` per `parseSource` call
 * leaks tree-sitter wasm memory: each parser owns wasm-side state that
 * is never explicitly freed, and after ~30-40 large-file parses in a
 * single Node process the wasm heap exhausts and subsequent `parser.parse()`
 * calls throw `ERR_INTERNAL_ASSERTION` (visible only as silently caught
 * `[Rebuild] Failed` log lines downstream — the rebuild then returns an
 * empty graphIds list and the working file graph stays identical to
 * baseline, masquerading as a "cascade-skip" bug). Caching one parser
 * per language bounds the wasm parser allocations to ~12 (one per
 * supported language) instead of one-per-parse.
 *
 * Trees returned by `parser.parse()` still leak per-parse — that's a
 * deeper refactor (consumers store live tree-sitter nodes on
 * `entity.node` for downstream flow-graph building, so we can't blindly
 * `tree.delete()` after extraction). But the parser leak is the actual
 * blocker the live-suite cascade probe hits; tree leaks are tolerable
 * for the per-file rebuild path because each tree is short-lived
 * relative to the parser allocations.
 */
const parsers: Map<SupportedLanguage, Parser> = new Map();

/**
 * Parse source code for a given language, returning a Tree-sitter syntax tree.
 */
export async function parseSource(
    code: string,
    language: SupportedLanguage
): Promise<Parser.Tree> {
    await initTreeSitter();

    const lang = await loadLanguage(language);
    let parser = parsers.get(language);
    if (!parser) {
        const Ctor: any = _reqParser ?? Parser;
        parser = new Ctor();
        parser!.setLanguage(lang);
        parsers.set(language, parser!);
    }
    const tree = parser!.parse(code);
    return tree;
}

/**
 * Parse a file by path — detects language from extension and parses.
 */
export async function parseFile(
    code: string,
    filePath: string
): Promise<{ tree: Parser.Tree; language: SupportedLanguage }> {
    const language = detectLanguage(filePath);
    if (!language) {
        throw new Error(`Unsupported file type: ${filePath}`);
    }

    const tree = await parseSource(code, language);
    return { tree, language };
}

/**
 * Get all supported languages.
 */
export function getSupportedLanguages(): SupportedLanguage[] {
    return Object.keys(GRAMMAR_FILES) as SupportedLanguage[];
}

/**
 * Reset parser state (for testing).
 */
export function resetTreeSitter(): void {
    loadedLanguages.clear();
    parserInitialized = false;
    parserInitFailed = false;
}
