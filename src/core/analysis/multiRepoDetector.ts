/**
 * multiRepoDetector.ts
 *
 * Detects when a workspace is a "bag of independent repos" rather than a
 * single project or a properly-orchestrated monorepo. Triggered when ≥2
 * sibling subdirs each look like their own project (own .git, own root
 * manifest, or a clear project skeleton) AND the workspace root carries
 * NO monorepo-orchestrator signal (no `workspaces` in root package.json,
 * no lerna/pnpm-workspace/nx/turbo/rush config).
 *
 * Why: opened on `~/work/all-services/`, the existing serviceDetector
 * indexes everything as one workspace and the same-origin `/api/...`
 * fallback connects every repo to every other repo's API surface — a
 * 37-repo folder turns into a spaghetti L1. Once multi-repo mode is
 * known, downstream code can:
 *   - skip the broad same-origin fallback (per-repo origins don't share)
 *   - render L1 nodes grouped by their owning repo
 *   - consolidate shared externals (OpenAI/Stripe/etc) into one node
 *     per provider across the whole workspace
 *
 * Pure I/O over the filesystem — no parsing, no AST. Cheap enough to
 * call on every init.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Files at the root of a child directory that mark it as "its own project"
 * — any single one is enough. Mirrors `findMonorepoServices`'s manifest
 * list and extends it with the common build-system files we want to
 * accept as a standalone-project signal.
 */
const TOP_LEVEL_MANIFESTS = [
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'setup.py',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'go.mod',
    'Cargo.toml',
    'composer.json',
    'Gemfile',
    'Package.swift',
    'pubspec.yaml',
    'mix.exs',          // Elixir
    'project.clj',      // Clojure
    '*.csproj',         // .NET — handled via glob below
    '*.fsproj',
    '*.vbproj',
    '*.sln',
] as const;

/**
 * Orchestrator files at the workspace root that mean "this is a monorepo,
 * NOT a bag of independent repos". If any one exists, multi-repo mode is
 * suppressed even when children look standalone.
 */
const MONOREPO_ORCHESTRATORS = [
    'lerna.json',
    'pnpm-workspace.yaml',
    'pnpm-workspace.yml',
    'nx.json',
    'turbo.json',
    'rush.json',
    'workspace.json',          // older Nx
];

const SKELETON_DIRS = ['src', 'app', 'lib', 'pages', 'public'];

/**
 * Framework / app entry-point files. A child carrying any one of these at
 * its root is a self-contained runnable thing — strong evidence it's a
 * real sibling repo, not a passive sub-folder that just happens to have
 * a `package.json` (e.g. an `examples/` template). Tested by file
 * existence; a small subset (Cargo, go, Ruby) is content-scanned. Per
 * ADR-034 pre-Phase-A refinements.
 */
const ENTRY_POINT_FILES = [
    // JS/TS frameworks
    'vite.config.js', 'vite.config.ts', 'vite.config.mjs',
    'next.config.js', 'next.config.ts', 'next.config.mjs',
    'nuxt.config.js', 'nuxt.config.ts', 'nuxt.config.mjs',
    'astro.config.mjs', 'astro.config.js', 'astro.config.ts',
    'remix.config.js',
    'svelte.config.js',
    'webpack.config.js',
    'nest-cli.json',
    'tsup.config.ts', 'tsup.config.js',
    'angular.json',
    // Python
    'manage.py',                  // Django
    'wsgi.py',                    // generic WSGI
    'asgi.py',                    // generic ASGI
    'gunicorn.conf.py',
    // Java/Kotlin (Spring Boot)
    'application.yml', 'application.yaml', 'application.properties',
    // Ruby
    'config.ru',                  // Rack apps
    // Mobile
    'Info.plist',                 // iOS
    // Containers
    'Dockerfile',
    'docker-compose.yml', 'docker-compose.yaml',
] as const;

/**
 * Files where a content scan reveals a runnable entry point. The keys are
 * candidate filenames; values are regexes that must match the file content
 * to count.
 */
const ENTRY_POINT_CONTENT_FILES: Array<{ file: string; pattern: RegExp }> = [
    // Go: `package main` at the top → executable binary
    { file: 'main.go', pattern: /^\s*package\s+main\b/m },
    // Rust: `[[bin]]` section in root Cargo.toml → executable binary
    { file: 'Cargo.toml', pattern: /^\s*\[\[bin\]\]/m },
    // Rails: Gemfile mentioning `gem "rails"`
    { file: 'Gemfile', pattern: /gem\s+['"]rails['"]/ },
    // Flutter: pubspec.yaml with a `flutter:` block
    { file: 'pubspec.yaml', pattern: /^\s*flutter\s*:/m },
    // npm scripts.start / scripts.dev — captures generic Node apps that
    // don't declare a framework-specific config file but ARE runnable.
    { file: 'package.json', pattern: /"scripts"\s*:\s*\{[^}]*?"(start|dev|serve)"\s*:/s },
];

const ENTRY_POINT_SUBPATHS = [
    'app/src/main/AndroidManifest.xml',   // Android Gradle layout
    'AndroidManifest.xml',                // legacy / Eclipse-style
] as const;

const IGNORE_CHILDREN = new Set([
    '.git', '.hg', '.svn',
    'node_modules', '.codeatlas', '.vscode', '.idea',
    'dist', 'build', 'out', 'target', 'bin', 'obj',
    'coverage', '.cache', '.next', '.nuxt', '.output',
    '__pycache__', '.venv', 'venv', 'env',
    '.gradle', '.mvn',
]);

export interface DetectedRepo {
    /** Directory name as it appears under workspaceRoot. */
    name: string;
    /** Path relative to workspaceRoot — same shape `ServiceRecord.rootPath` uses. */
    rootPath: string;
    /**
     * Which signals the child fired — useful for tests + diagnostics.
     * `entry-point` = the child carries a framework-specific runnable file
     *   (vite.config / next.config / manage.py / Dockerfile / etc.); strong
     *   evidence it's a self-contained app, not a passive sub-folder.
     */
    signals: Array<'git' | 'manifest' | 'skeleton' | 'entry-point' | 'iac'>;
}

export interface MultiRepoDetection {
    /** True when ≥2 standalone-project children exist AND root has no orchestrator. */
    isMultiRepo: boolean;
    /**
     * The standalone-project children found regardless of whether the workspace
     * is in multi-repo mode. Tests + diagnostics use this to explain "why" the
     * detector decided what it did. When `isMultiRepo` is false this list may
     * still be non-empty (e.g. exactly one project sibling, or the orchestrator
     * suppression fired).
     */
    repos: DetectedRepo[];
    /** When set, the workspace root looked like a monorepo orchestrator. */
    orchestratorFile?: string;
    /** True when root has a manifest of its own — a hint we're inside one project. */
    rootHasManifest: boolean;
}

/**
 * Returns the multi-repo detection for `workspaceRoot`. Pure FS read; no
 * caching here — the caller (snapshot init) already runs this once per
 * cascade.
 */
export function detectMultiRepoMode(workspaceRoot: string): MultiRepoDetection {
    const orchestrator = findOrchestrator(workspaceRoot);
    const rootHasManifest = hasAnyManifest(workspaceRoot);

    // Walk depth-1 children and classify each.
    let children: fs.Dirent[] = [];
    try {
        children = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    } catch {
        return { isMultiRepo: false, repos: [], rootHasManifest };
    }

    const repos: DetectedRepo[] = [];
    for (const entry of children) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (IGNORE_CHILDREN.has(entry.name)) continue;
        const childPath = path.join(workspaceRoot, entry.name);
        const signals: DetectedRepo['signals'] = [];

        // .git/ — strongest individual signal that this child is its own
        // repository, even if its build manifest lives deeper.
        if (existsDir(path.join(childPath, '.git'))) signals.push('git');

        // Manifest at the child's root.
        if (hasAnyManifest(childPath)) signals.push('manifest');

        // Skeleton: at least one of src/app/lib/pages/public AND at least
        // one file at the root that looks "project-y" (README, Makefile,
        // Dockerfile, .editorconfig). The two-signal requirement avoids
        // false-positives on arbitrary subfolders that just happen to
        // contain `src/`.
        if (hasSkeleton(childPath)) signals.push('skeleton');

        // Framework entry point — strong evidence this child is a
        // self-contained runnable app (vite/next/django/spring/dockerfile/
        // android-manifest/etc.). Distinguishes a real sibling repo from
        // a passive sub-folder like an `examples/` template.
        if (hasEntryPoint(childPath)) signals.push('entry-point');

        // UX-24 / UX-25 (2026-06-04) — Infrastructure-as-Code template
        // at the child's root. A SAM `template.yaml` or Serverless
        // Framework `serverless.yml` makes that dir a self-contained
        // serverless service — counts the same as a manifest. This is
        // what brings AWS-samples / serverless-framework example repos
        // into multi-repo mode so each session/example gets its own
        // per-repo orchestrator + IaC route scan.
        if (hasIacTemplate(childPath)) signals.push('iac');

        if (signals.length === 0) continue;
        repos.push({
            name: entry.name,
            rootPath: entry.name,
            signals,
        });
    }

    // Multi-repo decision (ADR-034):
    //   - root orchestrator present → NEVER multi-repo (it's a monorepo).
    //   - root has a manifest AND its own framework entry point →
    //     it's likely a single project whose siblings are passive sub-
    //     folders (examples/, packages/). Require strong evidence to
    //     escalate: ≥3 standalone children OR ≥2 with git+entry-point.
    //   - root has a manifest but NO entry point → ambiguous; require
    //     ≥3 standalone children OR ≥2 with `git`.
    //   - root has no manifest and no entry point → classic "many repos
    //     in one folder"; ≥2 standalone children is enough.
    let isMultiRepo = false;
    if (!orchestrator) {
        const rootHasEntryPoint = hasEntryPoint(workspaceRoot);
        const gitChildren = repos.filter(r => r.signals.includes('git')).length;
        const gitAndEntryChildren = repos.filter(
            r => r.signals.includes('git') && r.signals.includes('entry-point'),
        ).length;
        if (rootHasManifest && rootHasEntryPoint) {
            // Root looks like a real project with sibling sub-folders.
            // Only escalate when sibling evidence is overwhelming.
            isMultiRepo = repos.length >= 3 || gitAndEntryChildren >= 2;
        } else if (rootHasManifest) {
            isMultiRepo = repos.length >= 3 || gitChildren >= 2;
        } else {
            isMultiRepo = repos.length >= 2;
        }
    }

    return {
        isMultiRepo,
        repos,
        orchestratorFile: orchestrator ?? undefined,
        rootHasManifest,
    };
}

/**
 * Map a file path to the repo it belongs to, when multi-repo mode is on.
 * Returns the matching repo's rootPath, or `null` for files outside any
 * detected repo (configs at workspace root, etc.).
 */
export function repoRootForFile(
    detection: MultiRepoDetection,
    filePath: string,
): string | null {
    if (!detection.isMultiRepo) return null;
    // Longest-prefix match so nested repo-like dirs win over their parent.
    let best: DetectedRepo | null = null;
    for (const r of detection.repos) {
        const prefix = r.rootPath + '/';
        if (filePath === r.rootPath || filePath.startsWith(prefix)) {
            if (!best || r.rootPath.length > best.rootPath.length) best = r;
        }
    }
    return best?.rootPath ?? null;
}

// ── helpers ──────────────────────────────────────────────────────────────

function findOrchestrator(root: string): string | null {
    for (const f of MONOREPO_ORCHESTRATORS) {
        if (existsFile(path.join(root, f))) return f;
    }
    // Root `package.json` with a `workspaces` field is the JS-monorepo path.
    const pkg = readJsonSafe(path.join(root, 'package.json'));
    if (pkg && (Array.isArray(pkg.workspaces) || (pkg.workspaces && typeof pkg.workspaces === 'object'))) {
        return 'package.json#workspaces';
    }
    return null;
}

function hasAnyManifest(dir: string): boolean {
    for (const m of TOP_LEVEL_MANIFESTS) {
        if (m.includes('*')) {
            // glob form — only handle leading-`*` extension globs we declared.
            const ext = m.slice(1); // ".csproj" etc.
            try {
                const entries = fs.readdirSync(dir);
                if (entries.some(e => e.endsWith(ext))) return true;
            } catch { /* unreadable */ }
            continue;
        }
        if (existsFile(path.join(dir, m))) return true;
    }
    return false;
}

function hasSkeleton(dir: string): boolean {
    const hasAnyDir = SKELETON_DIRS.some(d => existsDir(path.join(dir, d)));
    if (!hasAnyDir) return false;
    // Project-y root file requirement so a random `things/src/` doesn't qualify.
    const rootFiles = ['README.md', 'README', 'README.rst', 'Makefile', 'Dockerfile', '.editorconfig'];
    return rootFiles.some(f => existsFile(path.join(dir, f)));
}

/**
 * True when the directory carries a framework / app entry-point signal —
 * a self-contained runnable app marker. Existence-only files (cheap) are
 * checked first; the small content-scan tier only runs if existence didn't
 * already prove it.
 */
/**
 * UX-24 / UX-25 (2026-06-04): IaC template at the dir's root marks it
 * as a self-contained serverless service. Recognized names:
 *   - `template.yaml` / `template.yml`     — AWS SAM
 *   - `serverless.yml` / `serverless.yaml` — Serverless Framework
 * Pure existence check; no content read.
 *
 * Also returns true when the dir is a "container of SAM apps" — at
 * least one immediate sub-dir carries its own template.yaml. That
 * matches three real-world layouts:
 *   - `sessions-with-aws-sam/custom-domains/` (4 sub-dirs each with template.yaml)
 *   - `sessions-with-aws-sam/starter-templates/` (one sub-dir, `web-app/template.yaml`)
 *   - `sessions-with-aws-sam/sam-or-cdk/` (`sam/template.yaml`)
 * The single-nested case still needs the per-repo IaC walker to find
 * the routes — the multiRepoDetector just promotes the parent dir so
 * a per-repo orchestrator is spawned for it.
 */
function hasIacTemplate(dir: string): boolean {
    if (
        existsFile(path.join(dir, 'template.yaml')) ||
        existsFile(path.join(dir, 'template.yml')) ||
        existsFile(path.join(dir, 'serverless.yml')) ||
        existsFile(path.join(dir, 'serverless.yaml'))
    ) {
        return true;
    }
    // Depth-2 fallback — promote any dir that contains at least one
    // immediate sub-dir with its own canonical IaC template. Catches
    // both the multi-app container case (custom-domains/*/template.yaml)
    // and the single-app container case (starter-templates/web-app/template.yaml).
    let children: fs.Dirent[];
    try {
        children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return false;
    }
    for (const child of children) {
        if (!child.isDirectory()) continue;
        if (child.name.startsWith('.')) continue;
        if (IGNORE_CHILDREN.has(child.name)) continue;
        const childPath = path.join(dir, child.name);
        if (
            existsFile(path.join(childPath, 'template.yaml')) ||
            existsFile(path.join(childPath, 'template.yml')) ||
            existsFile(path.join(childPath, 'serverless.yml')) ||
            existsFile(path.join(childPath, 'serverless.yaml'))
        ) {
            return true;
        }
    }
    return false;
}

function hasEntryPoint(dir: string): boolean {
    // Tier 1: existence-only.
    for (const f of ENTRY_POINT_FILES) {
        if (existsFile(path.join(dir, f))) return true;
    }
    for (const sub of ENTRY_POINT_SUBPATHS) {
        if (existsFile(path.join(dir, sub))) return true;
    }
    // Tier 2: content scan (Go main, Rust [[bin]], Rails Gemfile, Flutter
    // pubspec.yaml, npm scripts.start/.dev). Each file is read at most once
    // since the helper only fires per-child / per-workspace-root.
    for (const { file, pattern } of ENTRY_POINT_CONTENT_FILES) {
        const p = path.join(dir, file);
        if (!existsFile(p)) continue;
        try {
            const txt = fs.readFileSync(p, 'utf-8');
            if (pattern.test(txt)) return true;
        } catch { /* unreadable — skip */ }
    }
    return false;
}

function existsDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function existsFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readJsonSafe(p: string): any {
    try {
        const txt = fs.readFileSync(p, 'utf-8');
        return JSON.parse(txt);
    } catch { return null; }
}
