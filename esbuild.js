const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');
const isPackage = process.argv.includes('--package');

// Build-time injection of the Mixpanel project token.
//
// There is NO fallback token in source. A build with no
// `CODEATLAS_MIXPANEL_TOKEN` in the environment produces a bundle with an
// empty token, and the runtime short-circuits before any network call --
// so a clone, a fork, or a contributor running `npm run package` sends
// nothing at all. That is a property of this repository, not a setting,
// and PRIVACY.md states it as such.
//
// Official releases inject the token from GitHub Actions secrets. Mixpanel
// project tokens are write-only and safe to embed in a shipped artifact;
// the reason to keep this one out of source is that a public token in a
// public repo lets anyone forge events into the production funnel.
const mixpanelToken = process.env.CODEATLAS_MIXPANEL_TOKEN || '';

// Build-time injection of the Sentry DSN. Same rule as the Mixpanel token
// above: no fallback in source. `sentryNode.ts` treats an empty DSN as
// "no error reporting" and returns before initialising the SDK, so a
// source build reports nothing.
//
// One DSN is shared across extension host, MCP standalone, and the
// webview-ui bundle (see webview-ui/vite.config.ts); each event is tagged
// with `context` so the three can be split in the dashboard.
const sentryDsn = process.env.CODEATLAS_SENTRY_DSN ?? '';

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
    entryPoints: ['./src/extension.ts'],
    bundle: true,
    outfile: './dist/extension.js',
    // Issue #790 #6 — chokidar v5 is ESM-only. Marking it external so
    // esbuild leaves a literal `require('chokidar')` / dynamic
    // `import('chokidar')` in the bundle; the VSIX ships
    // `node_modules/chokidar/` + `node_modules/readdirp/` (see
    // .vscodeignore exceptions) so Node's real ESM loader handles them
    // at runtime. Bundling chokidar via esbuild's ESM→CJS transpile +
    // minify silently broke deep-directory event dispatch in monorepo
    // workspaces (132-sub-repo live-verify on serverless/examples).
    external: ['vscode', 'chokidar', 'readdirp'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !isPackage,  // no sourcemaps in package/release builds
    minify: isPackage,      // minify before obfuscation pass
    define: {
        // Replaced at build time. Source code reads `process.env.CODEATLAS_AMPLITUDE_KEY`
        // through esbuild's define, NOT from Node's process.env at runtime.
        'process.env.CODEATLAS_MIXPANEL_TOKEN': JSON.stringify(mixpanelToken),
        // `sentryNode.ts` reads CODEATLAS_SENTRY_DSN as a bare global
        // identifier (via `declare const`), so the define key is the
        // identifier itself — NOT `process.env.CODEATLAS_SENTRY_DSN`.
        'CODEATLAS_SENTRY_DSN': JSON.stringify(sentryDsn),
    },
};

/**
 * Tier 1 #6: stand-alone MCP server bundle. Allows registering CodeAtlas as a
 * Model Context Protocol provider in Claude / Cursor / Continue / any MCP
 * client via a stable path: `node dist/mcp-server.js <workspaceRoot>`.
 *
 * `vscode` is marked external because the MCP server reads the persisted
 * state.db via SnapshotStore — it never imports the VS Code API. The shim is
 * pulled in transitively through `core/storage`; we shim it to a tiny noop
 * module via the alias below so the standalone binary doesn't fail to load.
 */
/** @type {import('esbuild').BuildOptions} */
const mcpServerConfig = {
    entryPoints: ['./src/mcp/mcp-server.ts'],
    bundle: true,
    outfile: './dist/mcp-server.js',
    // Issue #790 #6 — chokidar v5 ESM external; same as extensionConfig.
    // The MCP npm tarball ships `node_modules/chokidar/` + readdirp.
    external: ['chokidar', 'readdirp'],
    // The standalone MCP binary has no VS Code host to provide the `vscode`
    // module. SyncOrchestrator (now imported transitively from
    // workspaceBootstrap) pulls it for telemetry. Use an esbuild plugin to
    // redirect every `require('vscode')` to the existing test mock — a tiny
    // shim that satisfies the surface without doing anything.
    plugins: [{
        name: 'codeatlas-vscode-shim',
        setup(build) {
            const shimPath = path.join(__dirname, 'src', '__mocks__', 'vscode.ts');
            build.onResolve({ filter: /^vscode$/ }, () => ({ path: shimPath }));
        },
    }],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !isPackage,
    minify: isPackage,
    // No banner: mcp-server.ts already begins with `#!/usr/bin/env node`.
    define: {
        'process.env.CODEATLAS_MIXPANEL_TOKEN': JSON.stringify(mixpanelToken),
        'CODEATLAS_SENTRY_DSN': JSON.stringify(sentryDsn),
        // Inject MCP version + build at build time so telemetry can attribute
        // events to a specific bundle and the webview footer shows which
        // standalone is serving. The MCP standalone (`@codeatlas/mcp`) now
        // carries its OWN major version, DECOUPLED from the extension (VSIX):
        // `MCP_SERVER_VERSION` reads `mcp-package/package.json` (e.g. 5.0.0)
        // while the VSIX tracks the root `package.json` (e.g. 9.0.0). The two
        // manifests are bumped together at release time so the MCP version can
        // no longer drift stale (the historical reason it was coupled). The
        // BUILD number stays shared (root `package.json.buildNumber`) since
        // both surfaces ship from the same CI build. The webview title
        // concatenates them as `MCP v<version>.<build>`.
        'MCP_SERVER_VERSION': JSON.stringify(
            require('./mcp-package/package.json').version,
        ),
        'MCP_SERVER_BUILD': JSON.stringify(
            require('./package.json').buildNumber ?? 0,
        ),
    },
};

function copyWasm() {
    if (!fs.existsSync(path.join(__dirname, 'dist'))) {
        fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
    }
    const tsSrc = path.join(__dirname, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
    fs.copyFileSync(tsSrc, path.join(__dirname, 'dist', 'tree-sitter.wasm'));
    console.log('[esbuild] Copied tree-sitter.wasm to dist/');
    const sqlSrc = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    fs.copyFileSync(sqlSrc, path.join(__dirname, 'dist', 'sql-wasm.wasm'));
    console.log('[esbuild] Copied sql-wasm.wasm to dist/');
}

/**
 * ADR-034 Phase D Tier-2 (#789-D2) — per-repo init worker bundle.
 *
 * Worker entry runs inside `new Worker(...)` from `worker_threads` so each
 * worker has its own V8 isolate / Babel / tree-sitter / sql.js — real CPU
 * parallelism for multi-repo workspace init. The bundle is consumed by
 * `workerPool.ts` via an absolute `dist/repo-worker.js` path.
 *
 * Important: workers share `dist/` with the main extension bundle so the
 * sql.js + tree-sitter WASM resolvers (`__dirname` based) line up the same
 * way they do for the host. We DO NOT inject mixpanel here — workers are
 * compute-only, no telemetry surface.
 *
 * `vscode` is externalized; the worker should never reach for the host
 * surface. Anything that does is a bug — fail fast at import time.
 */
/** @type {import('esbuild').BuildOptions} */
const repoWorkerConfig = {
    entryPoints: ['./src/core/sync/repoWorker.ts'],
    bundle: true,
    outfile: './dist/repo-worker.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !isPackage,
    minify: isPackage,
    plugins: [{
        // Same shim as the MCP server bundle — workers never touch the VS
        // Code host, but core/storage transitively imports it. Redirect to
        // the test mock so the bundle resolves cleanly.
        name: 'codeatlas-vscode-shim-worker',
        setup(build) {
            const shimPath = path.join(__dirname, 'src', '__mocks__', 'vscode.ts');
            build.onResolve({ filter: /^vscode$/ }, () => ({ path: shimPath }));
        },
    }],
};

/**
 * #850 / ADR-044 — PR review commenter CLI (`codeatlas-mcp review-pr`).
 *
 * Separate bundle, NOT part of mcp-server.js: adding reviewPrCli to the
 * server bundle's graph (even behind a dynamic import) reordered zod's
 * module init and broke the MCP SDK's schema construction at load time
 * ("Class2 is not a constructor" on every invocation). This bundle has no
 * MCP SDK inside; mcp-server.ts loads it via runtime `require(__dirname +
 * '/review-pr-cli.js')` only when the subcommand fires.
 */
/** @type {import('esbuild').BuildOptions} */
const reviewPrCliConfig = {
    entryPoints: ['./src/standalone/reviewPrCli.ts'],
    bundle: true,
    outfile: './dist/review-pr-cli.js',
    external: ['chokidar', 'readdirp'],
    plugins: [{
        // Same shim as the MCP server bundle — core/storage transitively
        // imports `vscode`; redirect to the test mock.
        name: 'codeatlas-vscode-shim-review-pr',
        setup(build) {
            const shimPath = path.join(__dirname, 'src', '__mocks__', 'vscode.ts');
            build.onResolve({ filter: /^vscode$/ }, () => ({ path: shimPath }));
        },
    }],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !isPackage,
    minify: isPackage,
    define: {
        'process.env.CODEATLAS_MIXPANEL_TOKEN': JSON.stringify(mixpanelToken),
        'CODEATLAS_SENTRY_DSN': JSON.stringify(sentryDsn),
    },
};

/**
 * #954 / ADR-044 — `run_review` MCP tool engine. Same isolation rationale as
 * reviewPrCli above: the review engine (perEntryReviewer/projectLevelReviewer)
 * uses zod, which must NOT enter the mcp-server bundle. Built separately and
 * loaded via `require(__dirname + '/run-review.js')` from the tool handler.
 */
/** @type {import('esbuild').BuildOptions} */
const runReviewConfig = {
    entryPoints: ['./src/standalone/runReviewOnSnapshot.ts'],
    bundle: true,
    outfile: './dist/run-review.js',
    external: ['chokidar', 'readdirp'],
    plugins: [{
        name: 'codeatlas-vscode-shim-run-review',
        setup(build) {
            const shimPath = path.join(__dirname, 'src', '__mocks__', 'vscode.ts');
            build.onResolve({ filter: /^vscode$/ }, () => ({ path: shimPath }));
        },
    }],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !isPackage,
    minify: isPackage,
    define: {
        'process.env.CODEATLAS_MIXPANEL_TOKEN': JSON.stringify(mixpanelToken),
        'CODEATLAS_SENTRY_DSN': JSON.stringify(sentryDsn),
    },
};

/**
 * Separate, dependency-free bundle for the post-install banner. Kept out
 * of the main `mcp-server.js` so a partial install (e.g. wasm copy
 * failed) doesn't block the banner from printing — postinstall must be
 * minimal-dependency.
 */
/** @type {import('esbuild').BuildOptions} */
const postinstallHintConfig = {
    entryPoints: ['./src/mcp/setup/postinstallHint.ts'],
    bundle: true,
    outfile: './dist/postinstall-hint.js',
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !isPackage,
    minify: isPackage,
};

async function main() {
    if (isWatch) {
        const ctx = await esbuild.context(extensionConfig);
        await ctx.watch();
        copyWasm();
        console.log('[esbuild] Watching for changes...');
    } else {
        await esbuild.build(extensionConfig);
        await esbuild.build(mcpServerConfig);
        await esbuild.build(repoWorkerConfig);
        await esbuild.build(reviewPrCliConfig);
        await esbuild.build(runReviewConfig);
        await esbuild.build(postinstallHintConfig);
        copyWasm();
        // Make the standalone MCP server executable.
        try {
            fs.chmodSync(path.join(__dirname, 'dist', 'mcp-server.js'), 0o755);
        } catch { /* fallback: shebang still works on most setups */ }
        console.log('[esbuild] Extension + MCP server + repo-worker + postinstall-hint build complete.');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
