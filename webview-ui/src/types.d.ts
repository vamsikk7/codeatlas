/// <reference types="vite/client" />

// Injected at build time by vite.config.ts via `define`. Holds the extension
// version + build number from the parent package.json so the home title +
// footer can show "CodeAtlas v<version>.<build>".
declare const __CODEATLAS_VERSION__: string;
declare const __CODEATLAS_BUILD__: number;
