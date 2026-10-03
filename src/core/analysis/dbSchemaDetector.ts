/**
 * dbSchemaDetector.ts
 *
 * Walks a service's source files and extracts declared database
 * tables / collections from common ORM declarations. Used by L1 in
 * multi-repo mode to consolidate sibling repos that talk to the same
 * schema into a single `db:<engine>:<table>` node ("Postgres · users"),
 * instead of N independent "database" nodes per repo.
 *
 * MVP scope — match by `(engine, tableName)`:
 *   - Prisma schema files (`*.prisma` — `model X { ... }`, with engine
 *     read from `datasource db { provider = ... }`).
 *   - TypeORM entity classes (`@Entity('users')` / `@Entity({ name: 'users' })`
 *     / `@Entity()` → class name).
 *   - Sequelize (`sequelize.define('users', …)` and `tableName: 'users'`).
 *   - Mongoose (`mongoose.model('User', …)` → engine=mongodb).
 *   - SQLAlchemy (`__tablename__ = 'users'`).
 *   - Django models (`class User(models.Model): class Meta: db_table = 'x'`,
 *     fallback: app_label_classname when class meta missing).
 *   - Rails migrations (`create_table :users do |t|`).
 *   - GORM (`type User struct` + `func (User) TableName() string { return "users" }`).
 *
 * Returns an array of `{ engine, tableName, anchor }` per service; the
 * L1 builder de-dupes across services keyed by `(engine, tableName)`.
 *
 * Regex-based to keep things cheap — same general technique used by
 * the existing apiDetector / sdkDetector. False positives are
 * preferable to misses inside a "Shared lane" — at worst we surface
 * one extra shared node, which the user can ignore.
 */

import type { FileRecord, Anchor } from '../graph/graphTypes';
import type { ContentProvider } from './serviceDetector';

export type DbEngine =
    | 'postgresql'
    | 'mysql'
    | 'sqlite'
    | 'mongodb'
    | 'mssql'
    | 'oracle'
    | 'unknown';

export interface DbSchemaEntry {
    /** Best-guess database engine. `'unknown'` when ORM doesn't reveal it. */
    engine: DbEngine;
    /** Table / collection name as declared in source. Lowercased for stable matching. */
    tableName: string;
    /** Where the declaration was found — fed into L1 anchor for nav. */
    anchor: Anchor;
    /** Original (non-lowercased) display label. */
    displayName: string;
    /** ORM family — diagnostic / future filtering. */
    source: 'prisma' | 'typeorm' | 'sequelize' | 'mongoose' | 'sqlalchemy' | 'django' | 'rails' | 'gorm';
}

/**
 * Detect declared schemas inside a single service's files.
 *
 * @param files      A map of `relPath → FileRecord` scoped to one service.
 * @param getContent Optional lazy fetcher when `FileRecord.content` is
 *                   dropped post-save (lazy-content pattern, #354).
 */
export function detectDbSchemas(
    files: Record<string, FileRecord>,
    getContent?: ContentProvider,
): DbSchemaEntry[] {
    const out: DbSchemaEntry[] = [];
    // Scan once; ORM-specific scanners only do work when their gating
    // import / file-extension condition matches.
    const prismaEngine = resolvePrismaEngine(files, getContent);

    for (const [filePath, rec] of Object.entries(files)) {
        const content = readContent(rec, filePath, getContent);
        if (!content) continue;

        // Cheap pre-filter: skip files that obviously can't hold an ORM
        // declaration. Each scanner re-checks its own signal.
        if (filePath.endsWith('.prisma')) {
            scanPrisma(content, filePath, prismaEngine, out);
            continue;
        }
        if (filePath.endsWith('.py')) {
            scanSqlalchemy(content, filePath, out);
            scanDjango(content, filePath, out);
            continue;
        }
        if (filePath.endsWith('.rb')) {
            scanRailsMigration(content, filePath, out);
            continue;
        }
        if (filePath.endsWith('.go')) {
            scanGorm(content, filePath, out);
            continue;
        }
        if (/\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(filePath)) {
            scanTypeOrm(content, filePath, out);
            scanSequelize(content, filePath, out);
            scanMongoose(content, filePath, out);
            continue;
        }
    }

    return dedupeEntries(out);
}

// ── Engine helpers ───────────────────────────────────────────────────────

const PROVIDER_TO_ENGINE: Record<string, DbEngine> = {
    'postgresql': 'postgresql',
    'postgres': 'postgresql',
    'pg': 'postgresql',
    'mysql': 'mysql',
    'mariadb': 'mysql',
    'sqlite': 'sqlite',
    'sqlserver': 'mssql',
    'mssql': 'mssql',
    'oracle': 'oracle',
    'mongodb': 'mongodb',
};

function resolvePrismaEngine(
    files: Record<string, FileRecord>,
    getContent?: ContentProvider,
): DbEngine {
    for (const [fp, rec] of Object.entries(files)) {
        if (!fp.endsWith('.prisma')) continue;
        const content = readContent(rec, fp, getContent);
        const m = content?.match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/s);
        if (m) {
            const provider = m[1].toLowerCase();
            return PROVIDER_TO_ENGINE[provider] ?? 'unknown';
        }
    }
    return 'unknown';
}

// ── ORM scanners ─────────────────────────────────────────────────────────

const PRISMA_MODEL = /\bmodel\s+(\w+)\s*\{/g;
function scanPrisma(content: string, fp: string, engine: DbEngine, out: DbSchemaEntry[]): void {
    for (const m of content.matchAll(PRISMA_MODEL)) {
        const name = m[1];
        out.push({
            engine,
            tableName: name.toLowerCase(),
            displayName: name,
            source: 'prisma',
            anchor: { filePath: fp },
        });
    }
}

const TYPEORM_ENTITY_STRING = /@Entity\s*\(\s*['"`]([\w-]+)['"`]\s*\)/g;
const TYPEORM_ENTITY_OPTS = /@Entity\s*\(\s*\{\s*[^}]*name\s*:\s*['"`]([\w-]+)['"`]/g;
const TYPEORM_ENTITY_BARE = /@Entity\s*\(\s*\)\s*\nexport\s+class\s+(\w+)/g;
const TYPEORM_ENTITY_BARE_INLINE = /@Entity\s*\(\s*\)\s*export\s+class\s+(\w+)/g;
function scanTypeOrm(content: string, fp: string, out: DbSchemaEntry[]): void {
    if (!/@Entity/.test(content)) return;
    // TypeORM doesn't expose engine in the entity file (configured at
    // DataSource level) — emit `'unknown'`. Multi-repo consolidation
    // still matches by name regardless of engine guess.
    for (const m of content.matchAll(TYPEORM_ENTITY_STRING)) {
        out.push(typeormEntry(fp, content, m, 1));
    }
    for (const m of content.matchAll(TYPEORM_ENTITY_OPTS)) {
        out.push(typeormEntry(fp, content, m, 1));
    }
    for (const m of content.matchAll(TYPEORM_ENTITY_BARE)) {
        out.push(typeormEntry(fp, content, m, 1));
    }
    for (const m of content.matchAll(TYPEORM_ENTITY_BARE_INLINE)) {
        out.push(typeormEntry(fp, content, m, 1));
    }
}
function typeormEntry(fp: string, content: string, m: RegExpMatchArray, group: number): DbSchemaEntry {
    const display = m[group];
    return {
        engine: 'unknown',
        tableName: display.toLowerCase(),
        displayName: display,
        source: 'typeorm',
        anchor: { filePath: fp },
    };
}

const SEQUELIZE_DEFINE = /sequelize\.define\s*\(\s*['"`]([\w-]+)['"`]/g;
const SEQUELIZE_TABLENAME = /tableName\s*:\s*['"`]([\w-]+)['"`]/g;
function scanSequelize(content: string, fp: string, out: DbSchemaEntry[]): void {
    if (!/sequelize/i.test(content)) return;
    for (const m of content.matchAll(SEQUELIZE_DEFINE)) {
        out.push({
            engine: 'unknown',
            tableName: m[1].toLowerCase(),
            displayName: m[1],
            source: 'sequelize',
            anchor: { filePath: fp },
        });
    }
    // `tableName:` inside a class definition extending Model — only count
    // when paired with a `Model` reference nearby to reduce false positives.
    if (/\bextends\s+Model\b|sequelize\.define/.test(content)) {
        for (const m of content.matchAll(SEQUELIZE_TABLENAME)) {
            out.push({
                engine: 'unknown',
                tableName: m[1].toLowerCase(),
                displayName: m[1],
                source: 'sequelize',
                anchor: { filePath: fp },
            });
        }
    }
}

const MONGOOSE_MODEL = /mongoose\.model\s*\(\s*['"`]([\w-]+)['"`]/g;
const MONGOOSE_MODEL_BARE = /\bmodel\s*\(\s*['"`]([\w-]+)['"`]\s*,\s*\w+Schema/g;
function scanMongoose(content: string, fp: string, out: DbSchemaEntry[]): void {
    if (!/mongoose/i.test(content)) return;
    for (const m of content.matchAll(MONGOOSE_MODEL)) {
        out.push(mongooseEntry(fp, content, m));
    }
    for (const m of content.matchAll(MONGOOSE_MODEL_BARE)) {
        out.push(mongooseEntry(fp, content, m));
    }
}
function mongooseEntry(fp: string, content: string, m: RegExpMatchArray): DbSchemaEntry {
    const display = m[1];
    return {
        engine: 'mongodb',
        tableName: display.toLowerCase(),
        displayName: display,
        source: 'mongoose',
        anchor: { filePath: fp },
    };
}

const SQLA_TABLENAME = /__tablename__\s*=\s*['"]([\w-]+)['"]/g;
function scanSqlalchemy(content: string, fp: string, out: DbSchemaEntry[]): void {
    if (!/__tablename__/.test(content)) return;
    for (const m of content.matchAll(SQLA_TABLENAME)) {
        out.push({
            engine: 'unknown',
            tableName: m[1].toLowerCase(),
            displayName: m[1],
            source: 'sqlalchemy',
            anchor: { filePath: fp },
        });
    }
}

const DJANGO_DB_TABLE = /db_table\s*=\s*['"]([\w-]+)['"]/g;
const DJANGO_CLASS = /class\s+(\w+)\s*\(\s*models\.Model\s*\)\s*:/g;
function scanDjango(content: string, fp: string, out: DbSchemaEntry[]): void {
    if (!/models\.Model/.test(content)) return;
    // Explicit db_table wins.
    let saw = false;
    for (const m of content.matchAll(DJANGO_DB_TABLE)) {
        out.push({
            engine: 'unknown',
            tableName: m[1].toLowerCase(),
            displayName: m[1],
            source: 'django',
            anchor: { filePath: fp },
        });
        saw = true;
    }
    if (saw) return;
    // Fallback: class name → snake_case. Imperfect but matches typical
    // Django default of `<app_label>_<modelname_lowercased>`. We drop
    // the app_label prefix since we don't know it without parsing
    // settings, and the consolidation pass keys on `tableName` so
    // false-positives across repos only fire when class names collide
    // exactly.
    for (const m of content.matchAll(DJANGO_CLASS)) {
        const cls = m[1];
        out.push({
            engine: 'unknown',
            tableName: cls.toLowerCase(),
            displayName: cls,
            source: 'django',
            anchor: { filePath: fp },
        });
    }
}

const RAILS_CREATE_TABLE = /create_table\s+:(\w+)/g;
function scanRailsMigration(content: string, fp: string, out: DbSchemaEntry[]): void {
    if (!/create_table/.test(content)) return;
    if (!fp.includes('db/migrate/') && !fp.endsWith('schema.rb')) return;
    for (const m of content.matchAll(RAILS_CREATE_TABLE)) {
        out.push({
            engine: 'unknown',
            tableName: m[1].toLowerCase(),
            displayName: m[1],
            source: 'rails',
            anchor: { filePath: fp },
        });
    }
}

const GORM_TABLE_NAME = /func\s*\(\s*\w*\s*\*?\s*(\w+)\s*\)\s*TableName\s*\(\s*\)\s*string\s*\{\s*return\s+["`]([\w-]+)["`]/g;
const GORM_STRUCT_TAG = /type\s+(\w+)\s+struct\s*\{[^}]*?\bgorm:"[^"]*"/sg;
function scanGorm(content: string, fp: string, out: DbSchemaEntry[]): void {
    if (!/gorm/.test(content)) return;
    let foundAny = false;
    for (const m of content.matchAll(GORM_TABLE_NAME)) {
        out.push({
            engine: 'unknown',
            tableName: m[2].toLowerCase(),
            displayName: m[2],
            source: 'gorm',
            anchor: { filePath: fp },
        });
        foundAny = true;
    }
    if (foundAny) return;
    for (const m of content.matchAll(GORM_STRUCT_TAG)) {
        const cls = m[1];
        out.push({
            engine: 'unknown',
            tableName: cls.toLowerCase(),
            displayName: cls,
            source: 'gorm',
            anchor: { filePath: fp },
        });
    }
}

// ── Utilities ────────────────────────────────────────────────────────────

function readContent(rec: any, fp: string, getContent?: ContentProvider): string {
    const inMemory = rec?.content;
    if (typeof inMemory === 'string' && inMemory.length > 0) return inMemory;
    return getContent?.(fp) ?? '';
}

function dedupeEntries(entries: DbSchemaEntry[]): DbSchemaEntry[] {
    // Same (engine, tableName, source) within one service collapses to one
    // entry — the L1 builder cares about presence + an anchor, not every
    // occurrence. Multi-repo consolidation happens across services.
    const seen = new Map<string, DbSchemaEntry>();
    for (const e of entries) {
        const key = `${e.engine}|${e.tableName}|${e.source}`;
        if (!seen.has(key)) seen.set(key, e);
    }
    return Array.from(seen.values());
}
