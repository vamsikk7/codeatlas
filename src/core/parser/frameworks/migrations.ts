/**
 * frameworks/migrations.ts — DB migration patterns (TypeORM + Knex)
 * (Issue #703, Phase 2 — fifth per-framework extraction.)
 *
 * Two patterns produce `DB_MIGRATION` records:
 *
 *   - **TypeORM** — `class FooMigration1234 implements MigrationInterface`
 *     anywhere in the file. The class name is taken as the migration id.
 *   - **Knex / generic** — `exports.up = function(knex)` or
 *     `export const up = …` / `export async function up()` inside a file
 *     whose path contains `migrations/`. The file name (minus extension)
 *     becomes the migration id.
 *
 * The Knex pattern is path-gated rather than import-gated because
 * `exports.up` is too generic — the `migrations/` path requirement is
 * the disambiguator. Both Knex and the various flavours of
 * "raw" / "node-pg-migrate" / "umzug" migrations use this convention.
 *
 * TypeORM's `MigrationInterface` is unambiguous — no other Node library
 * uses that interface name.
 */

import type { FrameworkPlugin } from './types';

export const migrationsPlugin: FrameworkPlugin = {
    id: 'migrations',
    name: 'DB Migrations (TypeORM / Knex)',
    languages: ['javascript', 'typescript'],
    patterns: [
        // TypeORM: `class FooMigration1234 implements MigrationInterface`
        {
            callPattern: /class\s+(\w+)\s+implements\s+MigrationInterface\b/g,
            extract: (m) => ({ method: 'DB_MIGRATION', route: `migration:${m[1]}`, handlerName: m[1] }),
            skipInsideTemplate: true,
        },
        // Knex / generic: `exports.up = function(knex)` or `export const up`
        // gated by `migrations/` in the file path.
        {
            callPattern: /(?:exports\.up\s*=|export\s+(?:const|async\s+function|function)\s+up\b)/g,
            extract: (m, ctx) => {
                if (!/(?:^|\/)migrations\//.test(ctx.filePath)) return null;
                const fileName = ctx.filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || ctx.filePath;
                return { method: 'DB_MIGRATION', route: `migration:${fileName}`, handlerName: 'up' };
            },
            skipInsideTemplate: true,
        },
    ],
};
