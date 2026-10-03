import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';

export interface ScanResult {
    filePath: string;
    relativePath: string;
    hash: string;
    mtime: number;
}

/**
 * Default ignore globs grouped by language / framework. Directories listed
 * here never get L4 (file) or L5 (flow) diagrams — they're third-party code
 * (downloaded dependencies), build artifacts, caches, or IDE state. Users
 * still see references to these paths in higher-layer diagrams (an `axios`
 * import node in an L4 file graph is fine — the FILE itself shouldn't get
 * its own L4 / L5 panel because no one edits node_modules).
 *
 * Override via the `codeatlas.ignore` VS Code setting (extension) or the
 * `--ignore` CLI flag (standalone). The defaults below cover JS, Python,
 * Java/Kotlin, Go, Rust, PHP, Ruby, .NET, iOS/Swift, Flutter/Dart, and the
 * common modern JS-framework caches (Next, Nuxt, SvelteKit, Expo, Astro,
 * Turborepo, Parcel).
 */
const DEFAULT_IGNORE = [
    // VCS + universal scratch
    '**/.git/**',
    '**/.svn/**',
    '**/.hg/**',
    '**/.codeatlas/**',                  // our own state dir

    // JS / TS dependency + build dirs
    '**/node_modules/**',
    '**/bower_components/**',
    '**/jspm_packages/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',                       // Next.js
    '**/.nuxt/**',                       // Nuxt
    '**/.svelte-kit/**',                 // SvelteKit
    '**/.astro/**',                      // Astro
    '**/.expo/**',                       // Expo
    '**/.expo-shared/**',
    '**/.vercel/**',                     // Vercel CLI artefacts
    '**/.netlify/**',
    '**/.turbo/**',                      // Turborepo
    '**/.parcel-cache/**',
    '**/.cache/**',
    '**/.yarn/cache/**',
    '**/.pnpm-store/**',
    '**/*.min.js',
    '**/*.bundle.js',
    // NOTE: `out/` is intentionally NOT in the list. Next.js static
    // exports use it, but Go projects (e.g. go-fiber) and several
    // mobile projects ship code from `out/`. .NET also uses `bin/Debug`
    // / `bin/Release` — see the .NET section below for those.

    // Python
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/.tox/**',
    '**/.nox/**',
    '**/*.egg-info/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/.ruff_cache/**',
    '**/.ipynb_checkpoints/**',
    // NOTE: `env/` is NOT excluded — too many real source files live
    // under `pkg/env/` (Go), `internal/env/` (Go), etc. Users with a
    // Python `env/` venv can add it via `codeatlas.ignore`.

    // Java / Kotlin / Gradle / Maven
    '**/target/**',                      // Maven (also Rust — covered below)
    '**/.gradle/**',
    '**/gradle/wrapper/**',
    '**/.idea/**',                       // IntelliJ workspace files (also Android Studio)

    // .NET — use configuration-scoped patterns so legitimate `bin/` and
    // `obj/` source dirs (Express `bin/www`, Celery `celery/bin/*.py`,
    // any framework that scripts via `bin/`) aren't dropped.
    '**/bin/Debug/**',
    '**/bin/Release/**',
    '**/bin/x86/**',
    '**/bin/x64/**',
    '**/bin/AnyCPU/**',
    '**/obj/Debug/**',
    '**/obj/Release/**',
    '**/obj/project.assets.json',
    // NOTE: legacy NuGet uses `packages/` at the repo root, but Lerna /
    // yarn-workspace monorepos also use `packages/` as the *source* tree
    // (e.g. ts-apollo, ts-react-native/with-yarn-workspaces). Excluding
    // `**/packages/**` would wipe their code from L4 / L5, so leave it
    // off by default; .NET users who hit collisions can opt-in via
    // `codeatlas.ignore`.

    // Go
    '**/vendor/**',                      // also PHP/Composer, Ruby/Bundler

    // Rust (target/ covered by Java/Maven entry)
    // No additional Rust-specific dirs.

    // Ruby
    '**/.bundle/**',
    '**/tmp/cache/**',
    // NOTE: `log/` is NOT in the list. Rails puts logs under `log/` and
    // some other frameworks ship logging *code* under `log/`. Users with
    // a real `log/` dir to ignore can add it via `codeatlas.ignore`.

    // iOS / Swift
    '**/Pods/**',                        // CocoaPods
    '**/.build/**',                      // Swift Package Manager
    '**/DerivedData/**',
    '**/.swiftpm/**',
    '**/*.xcworkspace/**',
    '**/*.xcodeproj/**',

    // Flutter / Dart
    '**/.dart_tool/**',
    '**/.flutter-plugins',
    '**/.flutter-plugins-dependencies',

    // Android (Gradle build artefacts not already covered)
    '**/.kotlin/**',

    // PHP (vendor covered above)
    '**/composer.phar',

    // IaC + serverless caches
    '**/.terraform/**',
    '**/.serverless/**',
    '**/.aws-sam/**',

    // Editor / tooling caches
    '**/.history/**',                    // VS Code Local History extension
    '**/.fleet/**',
    '**/.husky/_/**',                    // husky auto-generated wrapper scripts

    // Coverage reports (any language)
    '**/coverage/**',
    '**/htmlcov/**',
    '**/.nyc_output/**',
];

/** Exposed for tests + so callers can read the baseline ignore list. */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = DEFAULT_IGNORE;

/**
 * Scans a workspace directory for JavaScript files.
 * Respects ignore patterns and computes file hashes for change detection.
 *
 * The constructor's `ignorePatterns` argument is treated as ADDITIONAL
 * exclusions on top of `DEFAULT_IGNORE` (so users adding to
 * `codeatlas.ignore` extend the defaults rather than replacing them).
 * Pass `replaceDefaults: true` to opt out of the defaults entirely (used
 * by a couple of unit tests that need to scan inside `node_modules`).
 */
export class WorkspaceScanner {
    private ignorePatterns: string[];
    private maxFiles: number;

    constructor(
        ignorePatterns?: string[],
        maxFiles: number = 2000,
        replaceDefaults: boolean = false,
    ) {
        if (replaceDefaults && ignorePatterns) {
            this.ignorePatterns = ignorePatterns;
        } else {
            // Merge defaults + user's patterns, deduped. User additions take
            // effect on top of the baseline.
            const user = ignorePatterns ?? [];
            this.ignorePatterns = Array.from(new Set([...DEFAULT_IGNORE, ...user]));
        }
        this.maxFiles = maxFiles;
    }

    /**
     * Scan a directory recursively for .js files
     */
    scan(workspaceRoot: string): ScanResult[] {
        const results: ScanResult[] = [];
        this.walkDir(workspaceRoot, workspaceRoot, results);
        // No truncation — scan all files. Ignore patterns handle exclusion.
        (results as any).__truncated = false;
        (results as any).__totalFound = results.length;
        return results;
    }

    /**
     * ADR-034 Phase B — explicit per-repo scan with workspace-relative paths.
     *
     * Walks `repoRoot`'s subtree only (so per-repo isolation is preserved),
     * but emits paths relative to `relativeBase` (defaults to `repoRoot`).
     * Multi-repo callers pass `workspaceRoot` as the relativeBase so the
     * per-repo `state.db` stores workspace-relative paths
     * (`svc-alpha/src/server.js`) that match webview hash routes 1:1 —
     * no graphId rewriting needed at the read boundary.
     *
     * Single-repo callers pass nothing (or pass `repoRoot === workspaceRoot`)
     * and behavior is byte-identical to `scan()`.
     */
    scanRepo(repoRoot: string, relativeBase?: string): ScanResult[] {
        const base = relativeBase ?? repoRoot;
        const results: ScanResult[] = [];
        this.walkDir(repoRoot, base, results);
        (results as any).__truncated = false;
        (results as any).__totalFound = results.length;
        return results;
    }

    /**
     * Compute SHA-256 hash of file content
     */
    static hashContent(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Hash a file from disk
     */
    static hashFile(filePath: string): string {
        const content = fs.readFileSync(filePath, 'utf-8');
        return WorkspaceScanner.hashContent(content);
    }

    /**
     * Check if a path should be ignored based on configured ignore patterns
     */
    shouldIgnore(relativePath: string): boolean {
        return this.ignorePatterns.some((pattern) =>
            minimatch(relativePath, pattern, { dot: true })
        );
    }

    private walkDir(dir: string, root: string, results: ScanResult[]): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return; // Skip unreadable directories
        }

        for (const entry of entries) {

            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(root, fullPath);

            if (this.shouldIgnore(relativePath)) continue;

            if (entry.isDirectory()) {
                this.walkDir(fullPath, root, results);
            } else if (entry.isFile() && /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|py|pyw|java|kt|kts|go|rs|c|h|cpp|cc|cxx|hpp|hxx|cs|php|rb|swift|dart|prisma)$/i.test(entry.name)) {
                try {
                    const stat = fs.statSync(fullPath);
                    const hash = WorkspaceScanner.hashFile(fullPath);
                    results.push({
                        filePath: fullPath,
                        relativePath,
                        hash,
                        mtime: stat.mtimeMs,
                    });
                } catch {
                    // Skip unreadable files
                }
            }
        }
    }
}
