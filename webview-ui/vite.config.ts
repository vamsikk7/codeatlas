import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read extension version + build number from the parent package.json so the
// webview can surface "CodeAtlas v<version>.<build>" on the home title +
// footer — lets you eyeball at a glance which build is running, especially
// during iterative install + reload cycles.
const extensionPkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

// Mirror esbuild.js: bake the Sentry DSN into the webview bundle so
// `sentryBrowser.ts` can pick it up via the `CODEATLAS_SENTRY_DSN`
// declared-const. DSNs are public-by-design (ingest-only auth); the
// runtime `CODEATLAS_TELEMETRY=0` / `DO_NOT_TRACK=1` flags still
// short-circuit regardless of what's baked in. Override at build time
// with `CODEATLAS_SENTRY_DSN=` (empty) or a different DSN per project.
// No fallback DSN in source -- see esbuild.js for the reasoning. An empty
// DSN makes the webview Sentry init a no-op.
const sentryDsn = process.env.CODEATLAS_SENTRY_DSN ?? '';

export default defineConfig({
    plugins: [react()],
    define: {
        __CODEATLAS_VERSION__: JSON.stringify(extensionPkg.version),
        __CODEATLAS_BUILD__: JSON.stringify(extensionPkg.buildNumber ?? 0),
        CODEATLAS_SENTRY_DSN: JSON.stringify(sentryDsn),
    },
    build: {
        outDir: 'dist',
        rollupOptions: {
            output: {
                entryFileNames: 'assets/index.js',
                chunkFileNames: 'assets/[name].js',
                assetFileNames: 'assets/[name].[ext]',
            },
        },
    },
});
