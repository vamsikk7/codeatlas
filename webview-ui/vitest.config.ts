import { defineConfig } from 'vitest/config';
import { readFileSync } from 'fs';
import { join } from 'path';

const extensionPkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

export default defineConfig({
    define: {
        __CODEATLAS_VERSION__: JSON.stringify(extensionPkg.version),
        __CODEATLAS_BUILD__: JSON.stringify(extensionPkg.buildNumber ?? 0),
    },
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.test.{ts,tsx}'],
        setupFiles: ['./src/test-setup.ts'],
    },
});
