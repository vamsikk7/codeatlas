/**
 * serviceDetector.ts
 *
 * Detects microservice boundaries within a workspace using heuristic rules.
 * Also detects inter-service HTTP calls to build the microservice interaction graph.
 *
 * Detection priority:
 * 1. Multiple package.json at depth 1–2 (monorepo)
 * 2. Top-level source directories (even without manifest files)
 * 3. docker-compose.yml buildable service definitions
 * 4. Fallback: single service = entire workspace
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { Snapshot, ServiceRecord, ApiRecord, DiffStatus, InfrastructureService, RepoCategory, FileRecord } from '../graph/graphTypes';
import { detectSdks } from '../parser/sdkDetector';
import { parseCdkResources, cdkResourcesToInfraServices } from '../parser/cdkResourceExtractor';
import { parseSamResources, samResourcesToInfraServices, isSamLikely } from '../parser/samResourceExtractor';
import { parseSlsResources, isSlsLikely } from '../parser/slsResourceExtractor';
import { detectLanguage } from '../parser/treeSitterParser';
import { detectMultiRepoMode, type MultiRepoDetection, type DetectedRepo } from './multiRepoDetector';
import { detectDbSchemas, type DbSchemaEntry } from './dbSchemaDetector';

// BUG-EXPLORE-12: the entry-point methods that are genuinely HTTP ROUTES — the
// only ones the L1 "N HTTP routes exposed" service label should count. Non-HTTP
// entry points (JOB / MQ_CONSUMER / CLI_COMMAND / DB_MIGRATION / MODEL_HOOK /
// SCREEN / SUBSCRIPTION / WS / SSE / …) are surfaced elsewhere (Worker node,
// Background-Jobs section) and must NOT inflate the HTTP-route count.
export const HTTP_ROUTE_METHODS = new Set<string>([
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY',
    'ROUTE', 'CONTROLLER', 'RESOURCE', 'SERVER_ACTION', 'INCLUDE', 'MOUNT', 'PATH',
]);

/**
 * Pick the owning repo for a service's `rootPath` from the multi-repo
 * detection results. Longest-prefix match so nested repos win — but in
 * practice service `rootPath` already equals one of the repo `rootPath`s
 * (when monorepo detection runs INSIDE a multi-repo) or is empty (single
 * workspace-wide service, which doesn't happen in multi-repo mode since
 * each repo registers its own monorepo services).
 */
function topRepoFor(rootPath: string, repos: DetectedRepo[]): string | undefined {
    if (!rootPath) return undefined;
    let best: DetectedRepo | undefined;
    for (const r of repos) {
        const prefix = r.rootPath + '/';
        if (rootPath === r.rootPath || rootPath.startsWith(prefix)) {
            if (!best || r.rootPath.length > best.rootPath.length) best = r;
        }
    }
    return best?.name;
}

/** Display label for a DB engine, used by the shared-schema L1 node names. */
function prettyEngine(engine: string): string {
    switch (engine) {
        case 'postgresql': return 'Postgres';
        case 'mysql': return 'MySQL';
        case 'sqlite': return 'SQLite';
        case 'mongodb': return 'MongoDB';
        case 'mssql': return 'MSSQL';
        case 'oracle': return 'Oracle';
        default: return 'DB';
    }
}

/**
 * Lazy file-content fetcher. Returns the source text for a path or
 * undefined if unknown. Callers pass this when in-memory FileRecords
 * have had their `.content` dropped (post-save lazy storage, #354) so
 * pattern-matching falls back to the on-disk DB row.
 */
export type ContentProvider = (filePath: string) => string | undefined;

function readContent(record: any, filePath: string, getContent?: ContentProvider): string {
    const inMemory = record?.content;
    if (typeof inMemory === 'string' && inMemory.length > 0) return inMemory;
    return getContent?.(filePath) ?? '';
}

const SERVICE_DIR_PATTERNS = ['services', 'apps', 'packages', 'microservices', 'modules'];
// #426 — source-language extensions that feed the cluster pipeline. Used by
// the cluster-service orphan guard to decide whether an uncovered file is
// "real code" that needs a fallback service, vs a manifest / config / doc
// that shouldn't trigger a phantom workspace service.
const ORPHAN_GUARD_SOURCE_EXT =
    /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|py|java|kt|kts|go|rb|rs|cs|swift|dart|php|scala|groovy|hpp|cpp|h|m|mm|sql)$/;
// BUG-EXP-3 — root-level tooling / scaffolding dirs that hold scripts but no
// application code (copier/cookiecutter hooks, release scripts, CI helpers).
// Their source files must NOT trigger a phantom workspace `main` service in
// the orphan guard below (py-fastapi had `scripts/*.py`, `hooks/post_gen_project.py`,
// `.copier/*.py` → a routeless `main` service). Anchored to the workspace root
// since the guard only ever sees files outside every detected service rootPath.
const ORPHAN_GUARD_IGNORE_PATH =
    /^(?:\.copier|\.github|\.gitlab|\.husky|\.devcontainer|\.vscode|\.circleci|hooks|scripts|tools|bin|ci|deploy|deployment)\//i;

/**
 * BUG-EXP-4 — does an env-var name refer to the app's OWN backend/API base
 * (`VITE_API_URL`, `REACT_APP_API_URL`, `NEXT_PUBLIC_API_URL`, `API_BASE_URL`,
 * `BACKEND_URL`, …) rather than a third-party API (`STRIPE_API_URL`)? Such vars
 * point at the sibling backend service in a full-stack monorepo, so they resolve
 * to that service instead of a phantom `«external»` node. FE-framework public-env
 * prefixes are stripped first so `VITE_API_URL` → `API_URL`; brand-prefixed vars
 * like `STRIPE_API_URL` keep their brand and don't match.
 */
export function isInternalApiBaseEnv(varName: string): boolean {
    const stripped = varName.toUpperCase()
        .replace(/^(?:VITE|REACT_APP|NEXT_PUBLIC|VUE_APP|NG|EXPO_PUBLIC|PUBLIC|GATSBY|NUXT_PUBLIC|SVELTE)_/, '');
    return /^(?:API|BACKEND|SERVER|GATEWAY|API_BASE|BASE_API)(?:_BASE)?(?:_URL|_URI)?$/.test(stripped);
}
const HTTP_CLIENT_PATTERNS = [
    /axios\.(get|post|put|patch|delete)\s*\(\s*[`'"](https?:\/\/[^'"` ]+)/g,
    /fetch\s*\(\s*[`'"](https?:\/\/[^'"` ]+)/g,
    /new\s+URL\s*\(\s*[`'"](https?:\/\/[^'"` ]+)/g,
];
// BUG-EXP-4 — also match Vite's `import.meta.env.VITE_*` convention (used by the
// actual FE source, e.g. `OpenAPI.BASE = import.meta.env.VITE_API_URL`), not only
// Node's `process.env.*`.
const ENV_SERVICE_URL_PATTERN = /(?:process\.env|import\.meta\.env)\.([A-Z_]*SERVICE[A-Z_]*URL[A-Z_]*|[A-Z_]*URL[A-Z_]*)/g;

// Relative same-origin API call patterns (fetch('/api/...') or fetch(BASE_URL + ...))
const RELATIVE_API_PATTERNS: RegExp[] = [
    /fetch\s*\(\s*[`'"]\/api/g,
    // fetch(ANYVAR + ...) — catches API_BASE, baseUrl, apiRoot, etc.
    /fetch\s*\(\s*[A-Za-z_$][A-Za-z0-9_$]+\s*\+/g,
    /axios\.\w+\s*\(\s*[`'"]\/api/g,
    // axios.get(ANYVAR + ...)
    /axios\.\w+\s*\(\s*[A-Za-z_$][A-Za-z0-9_$]+\s*\+/g,
    /XMLHttpRequest[\s\S]{0,200}open\s*\(\s*[`'"]\w+[`'"]\s*,\s*[`'"]\/api/g,
    // localhost or 127.0.0.1 calls (same-machine interservice)
    /(?:fetch|axios\.\w+)\s*\(\s*[`'"](https?:\/\/(?:localhost|127\.0\.0\.1))/g,
    // Python: requests / httpx — relative path calls
    /requests\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"]\/api/g,
    /httpx\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"]\/api/g,
    // Python: requests.get(BASE_URL + ...) / requests.get(f"http://...")
    /requests\s*\.\s*\w+\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*[+f]/g,
    /httpx\s*\.\s*\w+\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*[+f]/g,
    // Python aiohttp
    /aiohttp\.ClientSession[\s\S]{0,100}(?:get|post|put|patch|delete)\s*\(\s*['"]\/api/g,
    // PHP: Http facade
    /Http\s*::\s*(?:get|post|put|patch|delete)\s*\(\s*['"]/g,
    // Go
    /http\.(?:Get|Post|Head)\s*\(\s*"/g,
    // C#
    /HttpClient\s*\.\s*(?:GetAsync|PostAsync|PutAsync|DeleteAsync)\s*\(/g,
    // Ruby
    /Faraday\.(?:get|post|put|delete)\s*\(/g,
    /Net::HTTP\.(?:get|post)\s*\(/g,
    // v2 phase 2 #483 — FE-client patterns that hit a relative `/api/*`
    // route. These contribute the same `relative-api:same-origin`
    // marker as the older patterns. The actual route paths are
    // captured separately by `RELATIVE_API_PATH_PATTERNS` below for
    // precise FE→backend edge labelling.
    /\buseSWR(?:Infinite|Immutable)?\s*\(\s*[`'"]\/api/g,
    /\buse(?:Query|Mutation|InfiniteQuery|SuspenseQuery)\s*\(\s*[`'"]\/api/g,
    // Dart Dio
    /dio\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"]\/api/g,
    // Retrofit (Java/Kotlin) — interface method annotations on FE/mobile clients
    /@(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*['"]\/api/g,
    // Apollo Client — useQuery(GQL_QUERY) / useMutation(GQL_MUTATION).
    // Apollo doesn't carry a URL in the call site, but the import +
    // call shape is a strong signal that the FE talks to a backend.
    /\buseQuery\s*\(\s*[A-Z_$][\w$]*\s*[),]/g,
    /\buseMutation\s*\(\s*[A-Z_$][\w$]*\s*[),]/g,
];

/**
 * Match a literal FE-client path against a backend route template.
 * Supports `:param` (Express/Koa), `{param}` (Spring/FastAPI),
 * `<param>` (Django/Flask). Trailing slashes ignored. (v2 phase 2 #483.)
 */
function routeMatches(callPath: string, routeTemplate: string): boolean {
    const norm = (s: string) => s.replace(/\/+$/, '') || '/';
    const call = norm(callPath);
    const tmpl = norm(routeTemplate);
    if (call === tmpl) return true;
    const re = new RegExp('^' + tmpl
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/:[a-zA-Z_][\w]*/g, '[^/]+')
        .replace(/\\\{[a-zA-Z_][\w]*\\\}/g, '[^/]+')
        .replace(/<[a-zA-Z_][\w]*>/g, '[^/]+') + '$');
    return re.test(call);
}

/**
 * v2 phase 2 #483 — capture the actual relative path from FE-client
 * calls so the post-process step can match it against backend
 * `apiIndex` routes and produce a precise `service:web → service:api`
 * edge with the matching route as label.
 *
 * Each regex MUST emit the path in match group 1. The path MUST start
 * with `/` (absolute paths only — variable expressions and
 * template-literal interpolation are out of scope; the spec defers
 * those to runtime route discovery).
 */
const RELATIVE_API_PATH_PATTERNS: RegExp[] = [
    // JS/TS — fetch('/api/...')
    /\bfetch\s*\(\s*[`'"](\/[^\s`'"$]+)/g,
    // JS/TS — axios.<verb>('/path')
    /\baxios\s*\.\s*(?:get|post|put|patch|delete|head|options|request)\s*\(\s*[`'"](\/[^\s`'"$]+)/g,
    // jQuery — $.ajax({url:'/path'}) / $.get('/path') / $.post('/path')
    /\$\s*\.\s*(?:ajax|get|post)\s*\(\s*\{?[\s\S]{0,40}?(?:url\s*:\s*)?[`'"](\/[^\s`'"$]+)/g,
    // React Query SWR family — useSWR('/path', fetcher)
    /\buseSWR(?:Infinite|Immutable)?\s*\(\s*[`'"](\/[^\s`'"$]+)/g,
    // Older react-query API — useQuery('/path', fetcher)
    /\buse(?:Query|Mutation|InfiniteQuery|SuspenseQuery)\s*\(\s*[`'"](\/[^\s`'"$]+)/g,
    // XMLHttpRequest .open(method, '/path')
    /XMLHttpRequest[\s\S]{0,200}\.open\s*\(\s*[`'"]\w+[`'"]\s*,\s*[`'"](\/[^\s`'"$]+)/g,
    // Python — requests/httpx with literal path
    /(?:requests|httpx)\s*\.\s*(?:get|post|put|patch|delete|head|options)\s*\(\s*['"](\/[^\s'"$]+)/g,
    // Dart Dio
    /\bdio\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"](\/[^\s'"$]+)/g,
    // Dart `package:http` — http.<verb>(Uri.parse('/path'))
    /\bhttp\s*\.\s*(?:get|post|put|patch|delete|head)\s*\(\s*Uri\s*\.\s*parse\s*\(\s*['"](\/[^\s'"$]+)/g,
    // Retrofit (Java/Kotlin) — interface method declarations
    /@(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*['"](\/[^'"]+)/g,
    // C# HttpClient (#483 gap-fill 2026-05-30) — `_httpClient.GetAsync("/path")`,
    // `PostAsJsonAsync("/path", payload)`. Verb is encoded in the method
    // name; we only need the literal path here.
    /\b\w+\s*\.\s*(?:Get|Post|Put|Delete|Patch|Head)(?:AsJson|String|ByteArray)?Async\s*\(\s*['"](\/[^'"]+)/g,
    // Swift URLSession (#483 gap-fill 2026-05-30) — `URL(string: "/path")`
    // following a known network-entry keyword (dataTask / URLSession /
    // Alamofire / httpMethod) on the preceding 200 chars. The lookbehind
    // is fragile in JS regex so we emit any URL literal matching this
    // shape; FE/mobile gating filters non-network references downstream.
    /\bURL\s*\(\s*string\s*:\s*"(\/[^"]+)"\s*\)/g,
];

// Issue 218: canonicalize infra names so `psql` / `postgres` / `postgresql`
// all map to a single `PostgreSQL` infrastructure node. Without this, Docker
// Compose service names and JS/Java connection patterns produced sibling
// infra nodes for the same database.
const INFRA_NAME_ALIASES: Record<string, string> = {
    psql: 'PostgreSQL',
    postgres: 'PostgreSQL',
    postgresql: 'PostgreSQL',
    mongo: 'MongoDB',
    mongodb: 'MongoDB',
    mysql: 'MySQL',
    mariadb: 'MySQL',
    redis: 'Redis',
    rabbit: 'RabbitMQ',
    rabbitmq: 'RabbitMQ',
    kafka: 'Kafka',
    nats: 'NATS',
    sqlite: 'SQLite',
    sqlite3: 'SQLite',
};

function canonicalizeInfraName(raw: string): string {
    const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    return INFRA_NAME_ALIASES[key] ?? raw;
}

// Database / infrastructure connection patterns
const DB_CONNECTION_PATTERNS: Array<{ pattern: RegExp; name: string; kind: InfrastructureService['kind'] }> = [
    { pattern: /mongoose\.connect\b/g, name: 'MongoDB', kind: 'database' },
    { pattern: /new\s+MongoClient\s*\(/g, name: 'MongoDB', kind: 'database' },
    { pattern: /new\s+(?:pg\.)?Pool\s*\(|pg\.connect\s*\(|require\(['"]pg['"]\)/g, name: 'PostgreSQL', kind: 'database' },
    { pattern: /mysql(?:2)?\.createConnection\b|mysql(?:2)?\.createPool\b/g, name: 'MySQL', kind: 'database' },
    { pattern: /redis\.createClient\b|new\s+Redis\s*\(/g, name: 'Redis', kind: 'cache' },
    { pattern: /amqp\.connect\b|amqplib\.connect\b/g, name: 'RabbitMQ', kind: 'queue' },
    { pattern: /new\s+Kafka\s*\(/g, name: 'Kafka', kind: 'queue' },
    { pattern: /new\s+Sequelize\s*\(/g, name: 'SQL (Sequelize)', kind: 'database' },
    { pattern: /createClient\s*\(\s*\{[^}]*url[^}]*\}/g, name: 'Redis', kind: 'cache' },
    // Prisma ORM
    { pattern: /new\s+PrismaClient\s*\(/g, name: 'SQL (Prisma)', kind: 'database' },
    { pattern: /from\s+['"]@prisma\/client['"]/g, name: 'SQL (Prisma)', kind: 'database' },
    { pattern: /import\s+.*PrismaClient.*from\s+['"]@prisma\/client['"]/g, name: 'SQL (Prisma)', kind: 'database' },
    // Drizzle ORM
    { pattern: /from\s+['"]drizzle-orm['"]/g, name: 'SQL (Drizzle)', kind: 'database' },
    // Java / Spring patterns
    { pattern: /import\s+org\.springframework\.data\.jpa\b/g, name: 'SQL (JPA)', kind: 'database' },
    { pattern: /import\s+(?:javax|jakarta)\.persistence\./g, name: 'SQL (JPA)', kind: 'database' },
    { pattern: /import\s+org\.springframework\.data\.mongodb\b/g, name: 'MongoDB', kind: 'database' },
    { pattern: /import\s+org\.springframework\.data\.redis\b/g, name: 'Redis', kind: 'cache' },
    { pattern: /import\s+org\.springframework\.kafka\b/g, name: 'Kafka', kind: 'queue' },
    // Python / Django patterns
    { pattern: /from\s+django\.db\s+import\s+models\b/g, name: 'SQL (Django ORM)', kind: 'database' },
    { pattern: /django\.db\.backends\.postgresql/g, name: 'PostgreSQL', kind: 'database' },
    { pattern: /django\.db\.backends\.mysql/g, name: 'MySQL', kind: 'database' },
    { pattern: /django\.db\.backends\.sqlite3/g, name: 'SQLite', kind: 'database' },
    { pattern: /from\s+sqlalchemy|import\s+sqlalchemy/g, name: 'SQL (SQLAlchemy)', kind: 'database' },
    { pattern: /import\s+pymongo\b|from\s+pymongo\b/g, name: 'MongoDB', kind: 'database' },
    { pattern: /from\s+motor\b|import\s+motor\b/g, name: 'MongoDB', kind: 'database' },
    { pattern: /from\s+celery\s+import\s+Celery|import\s+celery\b/g, name: 'Celery', kind: 'queue' },
    { pattern: /from\s+django_redis\b|django\.core\.cache.*redis/g, name: 'Redis', kind: 'cache' },
    { pattern: /import\s+redis\b|from\s+redis\b/g, name: 'Redis', kind: 'cache' },
    { pattern: /CHANNEL_LAYERS\s*=/g, name: 'Django Channels', kind: 'queue' },
    { pattern: /import\s+aioredis\b|from\s+aioredis\b/g, name: 'Redis', kind: 'cache' },
    { pattern: /DATABASES\s*=\s*\{[^}]*'ENGINE'\s*:\s*'django\.db\.backends\.postgresql/g, name: 'PostgreSQL', kind: 'database' },
    { pattern: /DATABASES\s*=\s*\{[^}]*'ENGINE'\s*:\s*'django\.db\.backends\.mysql/g, name: 'MySQL', kind: 'database' },
    // PHP / Laravel
    { pattern: /use\s+Illuminate\\Database\b/g, name: 'SQL (Eloquent)', kind: 'database' },
    { pattern: /class\s+\w+\s+extends\s+Model\b/g, name: 'SQL (Eloquent)', kind: 'database' },
    { pattern: /DB\s*::\s*(?:select|insert|update|delete|table|raw|statement)\s*\(/g, name: 'SQL (Laravel)', kind: 'database' },
    { pattern: /Redis\s*::\s*(?:get|set|del|command)\s*\(/g, name: 'Redis', kind: 'cache' },
    { pattern: /Cache\s*::\s*(?:get|put|forget|remember|store)\s*\(/g, name: 'Redis', kind: 'cache' },
    { pattern: /Queue\s*::\s*(?:push|later|bulk)\s*\(|dispatch\s*\(\s*new\s+\w+/g, name: 'Laravel Queue', kind: 'queue' },
    { pattern: /use\s+Doctrine\\ORM\b|use\s+Doctrine\\DBAL\b/g, name: 'SQL (Doctrine)', kind: 'database' },
    // Go
    { pattern: /database\/sql/g, name: 'SQL (Go)', kind: 'database' },
    { pattern: /github\.com\/go-redis\/redis|github\.com\/redis\/go-redis/g, name: 'Redis', kind: 'cache' },
    { pattern: /github\.com\/Shopify\/sarama|github\.com\/segmentio\/kafka-go/g, name: 'Kafka', kind: 'queue' },
    { pattern: /go\.mongodb\.org\/mongo-driver/g, name: 'MongoDB', kind: 'database' },
    { pattern: /github\.com\/lib\/pq|github\.com\/jackc\/pgx/g, name: 'PostgreSQL', kind: 'database' },
    { pattern: /github\.com\/go-sql-driver\/mysql/g, name: 'MySQL', kind: 'database' },
    { pattern: /github\.com\/streadway\/amqp|github\.com\/rabbitmq\/amqp091-go/g, name: 'RabbitMQ', kind: 'queue' },
    // C# / .NET
    { pattern: /using\s+Microsoft\.EntityFrameworkCore\b/g, name: 'SQL (EF Core)', kind: 'database' },
    { pattern: /using\s+Dapper\b/g, name: 'SQL (Dapper)', kind: 'database' },
    { pattern: /using\s+StackExchange\.Redis\b/g, name: 'Redis', kind: 'cache' },
    { pattern: /using\s+Npgsql\b/g, name: 'PostgreSQL', kind: 'database' },
    { pattern: /using\s+MassTransit\b/g, name: 'MassTransit', kind: 'queue' },
    { pattern: /using\s+RabbitMQ\.Client\b/g, name: 'RabbitMQ', kind: 'queue' },
    // Ruby
    { pattern: /ActiveRecord::Base/g, name: 'SQL (ActiveRecord)', kind: 'database' },
    { pattern: /require\s+['"]sidekiq['"]/g, name: 'Sidekiq', kind: 'queue' },
    { pattern: /require\s+['"]redis['"]/g, name: 'Redis', kind: 'cache' },
    { pattern: /require\s+['"]bunny['"]/g, name: 'RabbitMQ', kind: 'queue' },
    { pattern: /require\s+['"]pg['"]/g, name: 'PostgreSQL', kind: 'database' },
    // Android (Room, SQLite). `@Entity` is also a JPA / TypeORM annotation,
    // so we restrict to Room-specific decorators (`@Database` / `@Dao` —
    // neither is used by JPA) OR an explicit `androidx.room` import. Issue
    // #432: Petclinic's `jakarta.persistence.@Entity` classes were being
    // mis-classified as Room infra.
    { pattern: /@Database\s*\(|@Dao\b|androidx\.room\b/g, name: 'Room', kind: 'database' },
    { pattern: /android\.database\.sqlite/g, name: 'SQLite (Android)', kind: 'database' },
    // iOS (CoreData, Realm)
    { pattern: /NSManagedObject|NSPersistentContainer/g, name: 'CoreData', kind: 'database' },
    { pattern: /import\s+RealmSwift|import\s+Realm\b/g, name: 'Realm', kind: 'database' },
    // Cross-platform
    { pattern: /import\s+Firebase\b|FirebaseFirestore|FirebaseAuth/g, name: 'Firebase', kind: 'database' },

    // ─── AWS SDK — Issue #790 #8 follow-up ─────────────────────────────
    // Surfaces AWS-managed infra (DynamoDB / S3 / SQS / SNS / Kinesis)
    // in the L1 system-design view for serverless-style monorepos.
    // Covers both SDK v2 (`new AWS.<Svc>(…)`, used by many of the
    // serverless/examples fixtures) and v3 modular clients
    // (`@aws-sdk/client-<svc>`), plus boto3 (`boto3.client('<svc>')`)
    // and the Go / Java SDK paths.

    // DynamoDB
    { pattern: /new\s+AWS\.DynamoDB(?:\.DocumentClient)?\s*\(/g, name: 'DynamoDB', kind: 'database' },
    { pattern: /from\s+['"]@aws-sdk\/client-dynamodb['"]/g, name: 'DynamoDB', kind: 'database' },
    { pattern: /from\s+['"]@aws-sdk\/lib-dynamodb['"]/g, name: 'DynamoDB', kind: 'database' },
    { pattern: /require\(['"]@aws-sdk\/client-dynamodb['"]\)/g, name: 'DynamoDB', kind: 'database' },
    { pattern: /boto3\.(?:client|resource)\s*\(\s*['"]dynamodb['"]/g, name: 'DynamoDB', kind: 'database' },
    { pattern: /import\s+boto3[\s\S]{0,80}dynamodb/g, name: 'DynamoDB', kind: 'database' },
    { pattern: /github\.com\/aws\/aws-sdk-go(?:-v2)?\/service\/dynamodb/g, name: 'DynamoDB', kind: 'database' },
    { pattern: /(?:com\.amazonaws\.services\.dynamodbv2|software\.amazon\.awssdk\.services\.dynamodb)/g, name: 'DynamoDB', kind: 'database' },
    { pattern: /require\s+['"]aws-sdk-dynamodb['"]|Aws::DynamoDB::Client/g, name: 'DynamoDB', kind: 'database' },
    // #811 (2026-06-10) — .NET AWS SDK. Catches `using Amazon.DynamoDBv2;`
    // and the `AmazonDynamoDBClient` type. The .NET serverless fixtures
    // wouldn't surface DynamoDB on L1 without these patterns.
    { pattern: /using\s+Amazon\.DynamoDBv2(?:\.|;)/g, name: 'DynamoDB', kind: 'database' },
    { pattern: /AmazonDynamoDBClient\b/g, name: 'DynamoDB', kind: 'database' },

    // S3
    { pattern: /new\s+AWS\.S3\s*\(/g, name: 'S3', kind: 'database' },
    { pattern: /from\s+['"]@aws-sdk\/client-s3['"]/g, name: 'S3', kind: 'database' },
    { pattern: /require\(['"]@aws-sdk\/client-s3['"]\)/g, name: 'S3', kind: 'database' },
    { pattern: /boto3\.(?:client|resource)\s*\(\s*['"]s3['"]/g, name: 'S3', kind: 'database' },
    { pattern: /github\.com\/aws\/aws-sdk-go(?:-v2)?\/service\/s3/g, name: 'S3', kind: 'database' },
    { pattern: /(?:com\.amazonaws\.services\.s3|software\.amazon\.awssdk\.services\.s3)/g, name: 'S3', kind: 'database' },
    { pattern: /require\s+['"]aws-sdk-s3['"]|Aws::S3::Client/g, name: 'S3', kind: 'database' },
    // #811 — .NET AWS SDK for S3.
    { pattern: /using\s+Amazon\.S3(?:\.|;)/g, name: 'S3', kind: 'database' },
    { pattern: /AmazonS3Client\b/g, name: 'S3', kind: 'database' },

    // SQS
    { pattern: /new\s+AWS\.SQS\s*\(/g, name: 'SQS', kind: 'queue' },
    { pattern: /from\s+['"]@aws-sdk\/client-sqs['"]/g, name: 'SQS', kind: 'queue' },
    { pattern: /require\(['"]@aws-sdk\/client-sqs['"]\)/g, name: 'SQS', kind: 'queue' },
    { pattern: /boto3\.(?:client|resource)\s*\(\s*['"]sqs['"]/g, name: 'SQS', kind: 'queue' },
    { pattern: /github\.com\/aws\/aws-sdk-go(?:-v2)?\/service\/sqs/g, name: 'SQS', kind: 'queue' },
    { pattern: /(?:com\.amazonaws\.services\.sqs|software\.amazon\.awssdk\.services\.sqs)/g, name: 'SQS', kind: 'queue' },
    { pattern: /require\s+['"]aws-sdk-sqs['"]|Aws::SQS::Client/g, name: 'SQS', kind: 'queue' },
    { pattern: /using\s+Amazon\.SQS(?:\.|;)|AmazonSQSClient\b/g, name: 'SQS', kind: 'queue' },

    // SNS
    { pattern: /new\s+AWS\.SNS\s*\(/g, name: 'SNS', kind: 'queue' },
    { pattern: /from\s+['"]@aws-sdk\/client-sns['"]/g, name: 'SNS', kind: 'queue' },
    { pattern: /require\(['"]@aws-sdk\/client-sns['"]\)/g, name: 'SNS', kind: 'queue' },
    { pattern: /boto3\.(?:client|resource)\s*\(\s*['"]sns['"]/g, name: 'SNS', kind: 'queue' },
    { pattern: /github\.com\/aws\/aws-sdk-go(?:-v2)?\/service\/sns/g, name: 'SNS', kind: 'queue' },
    { pattern: /(?:com\.amazonaws\.services\.sns|software\.amazon\.awssdk\.services\.sns)/g, name: 'SNS', kind: 'queue' },
    { pattern: /using\s+Amazon\.SimpleNotificationService(?:\.|;)|AmazonSimpleNotificationServiceClient\b/g, name: 'SNS', kind: 'queue' },

    // Kinesis
    { pattern: /new\s+AWS\.Kinesis\s*\(/g, name: 'Kinesis', kind: 'queue' },
    { pattern: /from\s+['"]@aws-sdk\/client-kinesis['"]/g, name: 'Kinesis', kind: 'queue' },
    { pattern: /require\(['"]@aws-sdk\/client-kinesis['"]\)/g, name: 'Kinesis', kind: 'queue' },
    { pattern: /boto3\.(?:client|resource)\s*\(\s*['"]kinesis['"]/g, name: 'Kinesis', kind: 'queue' },
    { pattern: /github\.com\/aws\/aws-sdk-go(?:-v2)?\/service\/kinesis/g, name: 'Kinesis', kind: 'queue' },
];

// Docker service names to infra kind
const DOCKER_KIND_MAP: Record<string, InfrastructureService['kind']> = {
    mongo: 'database', mongodb: 'database',
    postgres: 'database', postgresql: 'database', mysql: 'database', mariadb: 'database',
    redis: 'cache', memcached: 'cache',
    rabbitmq: 'queue', kafka: 'queue', nats: 'queue',
    elasticsearch: 'database', opensearch: 'database',
    cassandra: 'database', dynamodb: 'database',
};

function inferInfraKind(name: string): InfrastructureService['kind'] {
    const lower = name.toLowerCase();
    for (const [key, kind] of Object.entries(DOCKER_KIND_MAP)) {
        if (lower.includes(key)) return kind;
    }
    return 'external';
}

/**
 * Detect framework from file content.
 */
/** BUG-EXP-5 regression guard — does the service root hold a backend manifest? */
function hasBackendManifest(serviceRoot: { workspaceRoot: string; rootPath: string }): boolean {
    const root = serviceRoot.rootPath
        ? path.join(serviceRoot.workspaceRoot, serviceRoot.rootPath)
        : serviceRoot.workspaceRoot;
    return [
        'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'requirements.txt',
        'pyproject.toml', 'Pipfile', 'Cargo.toml', 'composer.json', 'Gemfile', 'mix.exs',
    ].some((m) => safeExists(path.join(root, m)));
}

const SKIP_WALK_DIRS = new Set(['node_modules', 'build', 'dist', 'out', '.gradle', '.idea', 'target', '.git']);

/**
 * TICKET-MOBILE-2 — true if an `AndroidManifest.xml` exists under `root`. Only
 * Android apps ship one, so it's the definitive android signal. Checks the
 * standard paths first (Android's manifest lives in nested `app/src/main/`),
 * then a depth-/count-bounded dir walk so it stays cheap on large modules.
 * Needed because the manifest isn't a SUPPORTED_EXT (absent from the indexed
 * `files`) and the 50KB source-scan cap can miss `@Composable`.
 */
function hasAndroidManifest(root: string): boolean {
    for (const rel of ['app/src/main/AndroidManifest.xml', 'src/main/AndroidManifest.xml', 'AndroidManifest.xml']) {
        if (safeExists(path.join(root, rel))) return true;
    }
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    let seen = 0;
    while (stack.length > 0 && seen < 500) {
        const { dir, depth } = stack.pop()!;
        if (depth > 5) continue;
        let entries: import('fs').Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            seen++;
            if (e.isFile()) { if (e.name === 'AndroidManifest.xml') return true; }
            else if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_WALK_DIRS.has(e.name)) {
                stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
            }
        }
    }
    return false;
}

function detectTechnology(
    files: Record<string, any>,
    getContent?: ContentProvider,
    serviceRoot?: { workspaceRoot: string; rootPath: string },
): ServiceRecord['technology'] {
    // Serverless Framework: a `serverless.yml`/`serverless.yaml` in the
    // service's files is the canonical marker. Detection has to come
    // BEFORE the JS-runtime imports below — serverless handlers never
    // require('express'), so the import-based detectors will silently
    // fall through to `unknown` and leave the L1 / Map subtitle reading
    // "«unknown» · N apis" for hundreds of valid SLS services (observed
    // in the 132-repo serverless-examples fixture).
    for (const fp of Object.keys(files)) {
        const base = fp.split('/').pop()?.toLowerCase() ?? '';
        if (base === 'serverless.yml' || base === 'serverless.yaml') return 'serverless';
    }
    // FS fallback: `.yml` / `.yaml` files don't always land in the parsed
    // snapshot (the parser allowlist filters them out), so the in-memory
    // check above misses real SLS projects. When the caller passes the
    // service root we synchronously stat the canonical filenames.
    if (serviceRoot) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fs = require('fs');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const path = require('path');
            const base = path.join(serviceRoot.workspaceRoot, serviceRoot.rootPath || '');
            for (const name of ['serverless.yml', 'serverless.yaml']) {
                if (fs.existsSync(path.join(base, name))) return 'serverless';
            }
        } catch { /* swallow — best-effort detection */ }
    }

    const allContent = Object.entries(files)
        .map(([fp, f]) => readContent(f, fp, getContent))
        .join('\n')
        .slice(0, 50000); // first 50KB is enough

    if (/from ['"]@nestjs\/core['"]|@nestjs\/common/.test(allContent)) return 'nestjs';
    if (/require\(['"]fastify['"]\)|from ['"]fastify['"]/.test(allContent)) return 'fastify';
    if (/require\(['"]koa['"]\)|from ['"]koa['"]/.test(allContent)) return 'koa';
    if (/require\(['"]express['"]\)|from ['"]express['"]/.test(allContent)) return 'express';
    // Python — FastAPI checked before Starlette because FastAPI projects
    // commonly import from `starlette.*`; only flag pure Starlette when
    // there's no FastAPI signature. Issue #769.
    if (/from\s+fastapi\s+import|import\s+fastapi/.test(allContent)) return 'fastapi';
    if (/from\s+starlette\.applications\s+import|from\s+starlette\.routing\s+import|import\s+starlette\b/.test(allContent)) return 'starlette';
    if (/from\s+django|import\s+django/.test(allContent)) return 'django';
    if (/from\s+flask\s+import|import\s+flask/.test(allContent)) return 'flask';
    // Java/Kotlin
    if (/import\s+org\.springframework|@SpringBootApplication/.test(allContent)) return 'spring';
    if (/import\s+io\.micronaut/.test(allContent)) return 'micronaut';
    // Go
    if (/"github\.com\/gin-gonic\/gin"/.test(allContent)) return 'gin';
    if (/"github\.com\/labstack\/echo"/.test(allContent)) return 'echo';
    if (/"github\.com\/go-chi\/chi"/.test(allContent)) return 'chi';
    if (/"github\.com\/gofiber\/fiber"/.test(allContent)) return 'fiber';
    // Rust
    if (/use\s+actix_web/.test(allContent)) return 'actix';
    if (/use\s+axum/.test(allContent)) return 'axum';
    if (/use\s+rocket/.test(allContent)) return 'rocket';
    // C#
    if (/using\s+Microsoft\.AspNetCore/.test(allContent)) return 'aspnet';
    // PHP
    if (/use\s+Illuminate/.test(allContent)) return 'laravel';
    if (/use\s+Symfony/.test(allContent)) return 'symfony';
    // Ruby
    if (/Rails\.application/.test(allContent)) return 'rails';
    if (/require\s+['"]sinatra['"]/.test(allContent)) return 'sinatra';
    // Swift
    if (/import\s+Vapor/.test(allContent)) return 'vapor';
    // Kotlin Multiplatform — must check before android (KMP contains android imports too)
    if (/(?:expect\s+(?:fun|class|interface|object)\s|actual\s+(?:fun|class|interface|object)\s)/.test(allContent)) return 'kmp';
    // Mobile / frontend. TICKET-MOBILE-2 — an `AndroidManifest.xml` on disk under
    // the module is UNAMBIGUOUS (only Android apps ship one) and survives every
    // failure mode of the source checks: the 50KB source-scan cap misses
    // `@Composable`, `AndroidManifest.xml` is NOT a SUPPORTED_EXT so it's absent
    // from the indexed `files`, and the android plugin often lives in `app/build.gradle`
    // not the module root. A short bounded disk walk catches it (this is why the
    // compose-samples Jetchat/JetNews/… were left 'unknown').
    if (serviceRoot && hasAndroidManifest(path.join(serviceRoot.workspaceRoot, serviceRoot.rootPath || ''))) return 'android';
    if (/import\s+(?:android\.|androidx\.)|@Composable\b|import\s+org\.jetbrains\.compose/.test(allContent)) return 'android';
    if (/import\s+(?:UIKit|SwiftUI)/.test(allContent)) return 'ios';
    if (/from\s+['"]react-native['"]/.test(allContent)) return 'react-native';
    if (/from\s+['"]next['"]|from\s+['"]next\//.test(allContent)) return 'nextjs';
    // Issue #81 (2026-06-07) — Xamarin / .NET MAUI mobile. Detection gates
    // on the using-import so the technology doesn't false-positive on
    // ASP.NET Core (also C#, also under `Microsoft.*`).
    if (/using\s+(?:Xamarin\.Forms|Microsoft\.Maui)\b/.test(allContent)) return 'maui';

    // BUG-EXP-5 — plain SPA UI frameworks (React/Vue/Svelte/Angular, typically
    // Vite-bundled). Checked AFTER meta-frameworks (Next.js/React-Native) which
    // also import `react`, so those keep their more-specific technology.
    //
    // BUG-EXP-5 follow-up (regression guard) — a service that carries a BACKEND
    // manifest (go.mod, pom.xml, requirements.txt, …) is a backend service even
    // when it bundles a JS/frontend EXAMPLE (e.g. go-echo's `react-router`
    // recipe imports `react`). Don't let SPA detection mislabel it `react`/`vue`.
    const spaAllowed = !(serviceRoot && hasBackendManifest(serviceRoot));
    if (spaAllowed) {
        if (/from\s+['"]@angular\/core['"]/.test(allContent)) return 'angular';
        if (/from\s+['"]svelte['"]|from\s+['"]svelte\//.test(allContent)) return 'svelte';
        if (/from\s+['"]vue['"]/.test(allContent)) return 'vue';
        if (/from\s+['"]react['"]|from\s+['"]react\//.test(allContent)) return 'react';

        // SPA UI framework from package.json deps. The 50KB source-scan cap above
        // can miss `from 'react'` when a service leads with a large generated
        // client (py-fastapi's frontend leads with a big OpenAPI `client/*.gen.ts`).
        // package.json is small + definitive. Skip meta-frameworks so Next.js/Remix
        // isn't mislabeled as plain `react`.
        if (serviceRoot) {
            const root = serviceRoot.rootPath
                ? path.join(serviceRoot.workspaceRoot, serviceRoot.rootPath)
                : serviceRoot.workspaceRoot;
            const pkg = readManifest(path.join(root, 'package.json'));
            if (pkg && !/"(?:next|nuxt|@remix-run\/[\w-]+|@sveltejs\/kit|react-native|expo)"\s*:/.test(pkg)) {
                if (/"@angular\/core"\s*:/.test(pkg)) return 'angular';
                if (/"svelte"\s*:/.test(pkg)) return 'svelte';
                if (/"vue"\s*:/.test(pkg)) return 'vue';
                if (/"react"\s*:/.test(pkg)) return 'react';
            }
        }
    }

    return 'unknown';
}

/**
 * Map a detected `technology` to a `RepoCategory`.
 *
 * v2 phase 2 (#482 + #483) per `docs/v2-frontend-mobile-layer-spec.md` §5.
 *
 * Strategy: prefer the primary `technology` signal (it already does most
 * of the per-stack work) and fall back to filesystem signals for the
 * `unknown` case so a FE-only repo without an obvious framework import
 * (e.g. a static React SPA) still gets classified correctly. The
 * `'monorepo-parent'` category is not produced here because
 * `detectServices()` only emits services for sub-workspaces, never for
 * the monorepo root itself.
 *
 * `'unknown'` is the safe fallback — downstream FE/mobile-only L1
 * enrichment (SDK nodes, screen detection) checks `category` strictly,
 * so an `'unknown'` service keeps today's pure-backend rendering.
 *
 * Pre-v2 snapshots loaded from disk default `category` to `'backend'`
 * at load time (see `snapshotStore.ts`) so existing repos see no
 * behavioural change until a re-init reclassifies them.
 */
function detectCategoryFromTechnology(
    technology: ServiceRecord['technology'],
    serviceFiles: Record<string, unknown>,
    rootPath: string,
    workspaceRoot: string,
): RepoCategory {
    // Backend technologies — exact match to the spec §5 backend signals.
    const BACKEND_TECH: ReadonlySet<ServiceRecord['technology']> = new Set([
        'express', 'fastify', 'koa', 'nestjs',
        'django', 'flask', 'fastapi', 'starlette',
        'spring', 'micronaut',
        'gin', 'echo', 'chi', 'fiber',
        'actix', 'axum', 'rocket',
        'aspnet',
        'laravel', 'symfony',
        'rails', 'sinatra',
        'vapor',
        'serverless',
    ]);

    if (BACKEND_TECH.has(technology)) return 'backend';

    // Next.js is frontend by default; mixed app+api repos render as
    // frontend with a "+N API routes" note (spec §5).
    if (technology === 'nextjs') return 'frontend';
    // BUG-EXP-5 — plain SPA UI frameworks are frontend services.
    if (technology === 'react' || technology === 'vue' || technology === 'svelte' || technology === 'angular') {
        return 'frontend';
    }

    // Mobile / cross-platform.
    if (technology === 'android' || technology === 'ios' || technology === 'react-native' || technology === 'kmp' || technology === 'maui') {
        return 'mobile';
    }

    // technology === 'unknown' — probe filesystem for category-defining
    // manifests. Use rootPath-rooted lookups; tolerate missing files.
    const root = rootPath ? path.join(workspaceRoot, rootPath) : workspaceRoot;

    // Flutter / Dart.
    if (safeExists(path.join(root, 'pubspec.yaml'))) return 'mobile';

    // Android (manifest at any depth under root; the cheap probe is the
    // standard `app/src/main/AndroidManifest.xml` path).
    if (safeExists(path.join(root, 'AndroidManifest.xml')) ||
        safeExists(path.join(root, 'app/src/main/AndroidManifest.xml'))) {
        return 'mobile';
    }

    // iOS / SwiftUI / UIKit via Package.swift or *.xcodeproj/.
    if (safeExists(path.join(root, 'Package.swift')) || hasDirEnding(root, '.xcodeproj')) {
        return 'mobile';
    }

    // Frontend manifests — package.json with `next` / `nuxt` /
    // `@remix-run/*` / `@sveltejs/kit` / `react-router` deps and no
    // server-framework dep (we already routed those above via
    // `technology`). Cheapest read: just `package.json` and grep deps.
    const pkgJson = readManifest(path.join(root, 'package.json'));
    if (pkgJson) {
        if (/"(?:next|nuxt|@remix-run\/[\w-]+|@sveltejs\/kit|react-router|react-router-dom)"\s*:/.test(pkgJson)) {
            return 'frontend';
        }
        if (/"(?:react-native|expo)"\s*:/.test(pkgJson)) return 'mobile';
        // React-without-server-framework heuristic — only when React is
        // present and none of the backend deps are. Backend deps would
        // have been caught by `detectTechnology` already, so reaching
        // here with only `"react"` means a SPA.
        if (/"react"\s*:/.test(pkgJson) && !/"(?:express|fastify|koa|@nestjs\/core|next|nuxt)"\s*:/.test(pkgJson)) {
            return 'frontend';
        }
    }

    // Pubspec or build.gradle hint — `build.gradle` containing
    // `com.android.application` or `androidx.compose.*`.
    const buildGradle = readManifest(path.join(root, 'build.gradle')) ||
                        readManifest(path.join(root, 'app/build.gradle')) ||
                        readManifest(path.join(root, 'build.gradle.kts')) ||
                        readManifest(path.join(root, 'app/build.gradle.kts'));
    if (buildGradle && /com\.android\.application|androidx\.compose\./.test(buildGradle)) {
        return 'mobile';
    }

    return 'unknown';
}

function safeExists(p: string): boolean {
    try { return fs.existsSync(p); } catch { return false; }
}

function hasDirEnding(parent: string, suffix: string): boolean {
    try {
        const entries = fs.readdirSync(parent, { withFileTypes: true });
        return entries.some((e) => e.isDirectory() && e.name.endsWith(suffix));
    } catch { return false; }
}

function readManifest(p: string): string | null {
    try {
        if (!fs.existsSync(p)) return null;
        const stat = fs.statSync(p);
        if (!stat.isFile() || stat.size > 256 * 1024) return null;
        return fs.readFileSync(p, 'utf8');
    } catch { return null; }
}

/**
 * Detect all technologies present in a service (for polyglot display).
 * Returns the primary + any secondary technologies found.
 */
export function detectAllTechnologies(
    files: Record<string, any>,
    getContent?: ContentProvider,
): string[] {
    const allContent = Object.entries(files)
        .map(([fp, f]) => readContent(f, fp, getContent))
        .join('\n')
        .slice(0, 50000);
    const techs: Array<[RegExp, string]> = [
        [/from ['"]@nestjs\/core['"]|@nestjs\/common/, 'nestjs'],
        [/require\(['"]fastify['"]\)|from ['"]fastify['"]/, 'fastify'],
        [/require\(['"]koa['"]\)|from ['"]koa['"]/, 'koa'],
        [/require\(['"]express['"]\)|from ['"]express['"]/, 'express'],
        [/from\s+fastapi\s+import|import\s+fastapi/, 'fastapi'],
        [/from\s+starlette\.applications\s+import|from\s+starlette\.routing\s+import|import\s+starlette\b/, 'starlette'],
        [/from\s+django|import\s+django/, 'django'],
        [/from\s+flask\s+import|import\s+flask/, 'flask'],
        [/import\s+org\.springframework|@SpringBootApplication/, 'spring'],
        [/import\s+io\.micronaut/, 'micronaut'],
        [/"github\.com\/gin-gonic\/gin"/, 'gin'],
        [/"github\.com\/labstack\/echo"/, 'echo'],
        [/use\s+actix_web/, 'actix'],
        [/use\s+axum/, 'axum'],
        [/using\s+Microsoft\.AspNetCore/, 'aspnet'],
        [/use\s+Illuminate/, 'laravel'],
        [/Rails\.application/, 'rails'],
        [/import\s+Vapor/, 'vapor'],
        [/import\s+(?:android\.|androidx\.)/, 'android'],
        [/import\s+(?:UIKit|SwiftUI)/, 'ios'],
        [/from\s+['"]react-native['"]/, 'react-native'],
        [/from\s+['"]next['"]|from\s+['"]next\//, 'nextjs'],
        [/import\s+['"]package:flutter\//, 'flutter'],
    ];
    const found: string[] = [];
    for (const [pattern, name] of techs) {
        if (pattern.test(allContent)) found.push(name);
    }
    return found.length > 0 ? found : ['unknown'];
}

/**
 * Extract HTTP URLs called from a file's content (inter-service calls).
 * Also detects relative same-origin API calls (e.g. fetch('/api/...') in frontend code).
 *
 * Emission shape:
 *   - `https://example.com/...` — absolute URL (matched by HTTP_CLIENT_PATTERNS).
 *   - `env:SOME_URL_VAR`        — env-var-driven service URL.
 *   - `path:/api/foo`           — captured FE-client relative path
 *                                 (v2 phase 2 #483). The post-process
 *                                 step matches these against backend
 *                                 services' apiIndex routes to produce
 *                                 precise FE→backend edges with a
 *                                 route label.
 *   - `relative-api:same-origin`— legacy fallback marker (any
 *                                 relative-API pattern matched). Kept
 *                                 for back-compat with consumers that
 *                                 look for it before #483 lands fully.
 */
function extractConsumedUrls(content: string, category?: RepoCategory): string[] {
    const urls: string[] = [];
    for (const pattern of HTTP_CLIENT_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const url = match[1] || match[2];
            if (url) urls.push(url);
        }
    }
    // Capture env var references to service URLs
    ENV_SERVICE_URL_PATTERN.lastIndex = 0;
    let match;
    while ((match = ENV_SERVICE_URL_PATTERN.exec(content)) !== null) {
        urls.push(`env:${match[1]}`);
    }
    // v2 phase 2 #483 — capture FE-client relative paths so post-process
    // can resolve them to specific backend services / routes. **Gated on
    // category** — only FE/mobile services emit `path:` entries.
    //
    // Why gated: backend services (Go, Java, Python, etc.) have plenty of
    // shapes that look like `path:` candidates (Swagger annotations,
    // generated client stubs, vendor code) and would inflate
    // `consumedUrls` with noise that mis-classifies inter-service
    // relationships at L1. Backend HTTP-client calls already land in
    // `HTTP_CLIENT_PATTERNS` (absolute URL form) or the
    // `'relative-api:same-origin'` marker — the precise path extraction
    // is reserved for the FE-client surface (#483 finish line).
    if (category === 'frontend' || category === 'mobile') {
        const seenPaths = new Set<string>();
        for (const pattern of RELATIVE_API_PATH_PATTERNS) {
            pattern.lastIndex = 0;
            let m;
            while ((m = pattern.exec(content)) !== null) {
                if (seenPaths.size >= 50) break;
                const route = m[1];
                if (route && route.startsWith('/')) {
                    const clean = route.replace(/[?#].*$/, '').replace(/[`'",)\s].*$/, '');
                    if (clean.length > 1 && !seenPaths.has(clean)) {
                        seenPaths.add(clean);
                        urls.push(`path:${clean}`);
                    }
                }
            }
            if (seenPaths.size >= 50) break;
        }
    }
    // Detect same-origin relative API calls (frontend calling backend on same host).
    // Kept as the legacy fallback marker even when path-extraction succeeds —
    // consumers can use either signal.
    for (const pattern of RELATIVE_API_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
            urls.push('relative-api:same-origin');
            break;
        }
    }
    return [...new Set(urls)];
}

/**
 * Check if a docker-compose.yml exists and parse service names with their build context.
 * Returns both buildable services (with source) and infrastructure services (image-only).
 */
function parseDockerCompose(workspaceRoot: string): {
    buildable: Array<{ name: string; buildContext: string | null }>;
    infrastructure: Array<{ name: string; image: string }>;
} | null {
    const candidates = [
        path.join(workspaceRoot, 'docker-compose.yml'),
        path.join(workspaceRoot, 'docker-compose.yaml'),
        path.join(workspaceRoot, 'docker-compose.dev.yml'),
    ];

    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        try {
            // #215: replaced the line-by-line parser with `js-yaml` so anchors
            // (`x-defaults: &defaults`), aliases (`<<: *defaults`), nested
            // build blocks, and YAML 1.2 features parse correctly.
            const content = fs.readFileSync(candidate, 'utf-8');
            const doc = yaml.load(content, { schema: yaml.DEFAULT_SCHEMA }) as any;
            const services = doc?.services;
            if (!services || typeof services !== 'object') continue;

            const buildable: Array<{ name: string; buildContext: string | null }> = [];
            const infrastructure: Array<{ name: string; image: string }> = [];

            for (const [name, def] of Object.entries(services)) {
                if (!def || typeof def !== 'object') continue;
                const sd = def as any;
                // build can be a string ("./api"), an object ({context: "./api"}), or undefined.
                let buildContext: string | null = null;
                if (typeof sd.build === 'string') {
                    buildContext = sd.build === '.' || sd.build === './' ? '.' : String(sd.build).replace(/^\.\//, '');
                } else if (sd.build && typeof sd.build === 'object' && typeof sd.build.context === 'string') {
                    const v = sd.build.context;
                    buildContext = v === '.' || v === './' ? '.' : v.replace(/^\.\//, '');
                }
                if (buildContext !== null) {
                    buildable.push({ name, buildContext });
                } else if (typeof sd.image === 'string') {
                    infrastructure.push({ name, image: sd.image });
                }
            }

            if (buildable.length > 0 || infrastructure.length > 0) {
                return { buildable, infrastructure };
            }
        } catch {
            // Malformed YAML — fall through to the next candidate.
            continue;
        }
    }
    return null;
}

/**
 * Find monorepo service roots (directories containing a manifest file at depth 1-2).
 */
function findMonorepoServices(workspaceRoot: string): Array<{ name: string; rootPath: string }> {
    const services: Array<{ name: string; rootPath: string }> = [];
    const manifestFiles = [
        'package.json', 'requirements.txt', 'pyproject.toml',
        'pom.xml', 'build.gradle', 'build.gradle.kts',
        'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile', 'Package.swift',
        // v2 follow-up #714 — pubspec.yaml is Flutter's manifest;
        // without it `apps/mobile/pubspec.yaml` collapses into the
        // workspace `main` service and L1 loses the Flutter app's
        // own service node. Standalone Flutter repos worked because
        // the pubspec.yaml at workspace root triggered the
        // detectCategoryFromTechnology probe — but monorepos didn't.
        'pubspec.yaml',
    ];
    const hasManifest = (dir: string): boolean =>
        manifestFiles.some(f => fs.existsSync(path.join(dir, f)));
    // KMP source sets: commonMain/androidMain/iosMain under src/
    const KMP_SOURCE_SETS = ['commonMain', 'androidMain', 'iosMain'];
    const isKmpModule = (dir: string): boolean =>
        fs.existsSync(path.join(dir, 'src', 'commonMain')) &&
        hasManifest(dir);
    try {
        for (const serviceDir of SERVICE_DIR_PATTERNS) {
            const dirPath = path.join(workspaceRoot, serviceDir);
            if (!fs.existsSync(dirPath)) continue;
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const childPath = path.join(dirPath, entry.name);
                if (hasManifest(childPath)) {
                    services.push({
                        name: entry.name,
                        rootPath: `${serviceDir}/${entry.name}`,
                    });
                    // For KMP modules, also register per-platform source sets as sub-services
                    if (isKmpModule(childPath)) {
                        for (const sourceSet of KMP_SOURCE_SETS) {
                            if (fs.existsSync(path.join(childPath, 'src', sourceSet))) {
                                services.push({
                                    name: `${entry.name}-${sourceSet}`,
                                    rootPath: `${serviceDir}/${entry.name}/src/${sourceSet}`,
                                });
                            }
                        }
                    }
                }
            }
        }

        if (services.length === 0) {
            const rootEntries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
            // Track root subdirs that BECAME a service so we don't also
            // register their depth-2 children as siblings (Issue #426
            // sanity case). Root subdirs with a manifest but no source
            // (e.g. rust-rocket's `examples/Cargo.toml` is a virtual
            // workspace with no `src/`) do NOT become a service — their
            // children should still be eligible for depth-2 discovery.
            const rootDirsWithManifestService = new Set<string>();
            for (const entry of rootEntries) {
                if (!entry.isDirectory()) continue;
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                const entryPath = path.join(workspaceRoot, entry.name);
                if (hasManifest(entryPath)) {
                    const hasSrc = fs.existsSync(path.join(entryPath, 'src'));
                    const hasIndex = fs.existsSync(path.join(entryPath, 'index.js')) ||
                        fs.existsSync(path.join(entryPath, 'index.ts')) ||
                        fs.existsSync(path.join(entryPath, 'main.py')) ||
                        fs.existsSync(path.join(entryPath, 'main.go')) ||
                        fs.existsSync(path.join(entryPath, 'main.rs'));
                    // Issue #399: also accept Python-convention source dirs
                    // (`app/`, `lib/`) that contain a `main.py` or
                    // `__init__.py` — backend/app/main.py is the canonical
                    // FastAPI/Flask entry point shape.
                    const hasPyApp =
                        (fs.existsSync(path.join(entryPath, 'app', 'main.py')) ||
                            fs.existsSync(path.join(entryPath, 'app', '__init__.py'))) ||
                        (fs.existsSync(path.join(entryPath, 'lib', 'main.py')) ||
                            fs.existsSync(path.join(entryPath, 'lib', '__init__.py')));
                    if (hasSrc || hasIndex || hasPyApp) {
                        services.push({ name: entry.name, rootPath: entry.name });
                        rootDirsWithManifestService.add(entry.name);
                    }
                }
            }
            // Issue #426: monorepos like rust-actix group examples into
            // category dirs (`https-tls/`, `cors/`, `websockets/`) that
            // carry NO manifest but contain per-example sub-crates that
            // each do. The depth-1 loop above missed those. Recurse one
            // level into manifest-less root subdirs and register any
            // depth-2 child that has a manifest. Skip root subdirs that
            // already became a service (their sub-modules belong to that
            // service, not as siblings).
            // Recurse up to depth-3 to handle nested category dirs. The
            // canonical case is rust-rocket's `contrib/db_pools/{codegen,lib}/`
            // — `contrib/` has no manifest, `contrib/db_pools/` has no
            // manifest either, but `contrib/db_pools/codegen/Cargo.toml`
            // and `contrib/db_pools/lib/Cargo.toml` do. Without depth-3
            // recursion these clusters stay orphan (no service serviceId
            // prefixes their files).
            //
            // Strategy: BFS from each manifest-less root subdir; for each
            // child directory, if it carries a manifest → register as
            // service (and stop descending); otherwise keep walking. Cap
            // at depth-3 from workspace root to avoid runaway scans in
            // pathological repos.
            const MAX_DEPTH = 3;
            // Issue #766: directory names that conventionally hold
            // example apps within the framework's own repository
            // (rust-actix has 70+ `examples/*` subcrates, go-fiber has
            // `examples/auth-jwt/` etc.). Treating every example as its
            // own service overwhelms L1 + KMap. When a manifest-less
            // root subdir matches one of these names, we skip the
            // BFS recursion — the example sources will land on the
            // workspace-root service via prefix fallback, and KMap
            // clusters still surface them.
            const EXAMPLE_PARENT_DIRS = new Set([
                'examples', 'example', 'samples',  // generic
                'cookbook', 'recipes',             // go-echo style
                'demos', 'demo',                   // ts-react-native style
                '_examples',                       // go-chi style (underscore-prefixed)
                'sample',
            ]);
            const isExampleParent = (name: string) => EXAMPLE_PARENT_DIRS.has(name.toLowerCase());

            const visit = (dirPath: string, relPath: string, depth: number) => {
                if (depth > MAX_DEPTH) return;
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dirPath, { withFileTypes: true });
                } catch {
                    return;
                }
                for (const child of entries) {
                    if (!child.isDirectory()) continue;
                    if (child.name.startsWith('.') || child.name === 'node_modules') continue;
                    const childPath = path.join(dirPath, child.name);
                    const childRel = `${relPath}/${child.name}`;
                    if (hasManifest(childPath)) {
                        services.push({ name: child.name, rootPath: childRel });
                        // Don't recurse further — sub-crates of this
                        // service belong to its rootPath via prefix match.
                    } else if (depth < MAX_DEPTH) {
                        visit(childPath, childRel, depth + 1);
                    }
                }
            };
            // Issue #766: count children of each example-parent dir so
            // we can distinguish "1-2 example apps that are legitimate
            // top-level services" (e.g. py-django-celery has one
            // `examples/django/` Django app) from "many examples that
            // are the framework's own showcase" (e.g. rust-actix has
            // 73 example subcrates under `examples/`). Only the latter
            // triggers the skip.
            const EXAMPLE_DIR_BURST_THRESHOLD = 4;
            const shouldSkipExampleDir = (entry: fs.Dirent): boolean => {
                if (!isExampleParent(entry.name)) return false;
                const childPath = path.join(workspaceRoot, entry.name);
                let manifestChildren = 0;
                try {
                    for (const c of fs.readdirSync(childPath, { withFileTypes: true })) {
                        if (!c.isDirectory()) continue;
                        if (c.name.startsWith('.') || c.name === 'node_modules') continue;
                        if (hasManifest(path.join(childPath, c.name))) manifestChildren++;
                        if (manifestChildren >= EXAMPLE_DIR_BURST_THRESHOLD) return true;
                    }
                } catch {
                    return false;
                }
                return false;
            };

            for (const entry of rootEntries) {
                if (!entry.isDirectory()) continue;
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                if (rootDirsWithManifestService.has(entry.name)) continue;
                // Issue #766: skip example-parent dirs that hold a burst
                // of subprojects (4+) — those are the framework's own
                // example showcase. Smaller `examples/` (1-3 children)
                // stay eligible since they're often legitimate apps
                // (e.g. py-django-celery's single Django example).
                if (shouldSkipExampleDir(entry)) continue;
                const entryPath = path.join(workspaceRoot, entry.name);
                visit(entryPath, entry.name, 2);
            }
        }
    } catch {
        // ignore filesystem errors
    }
    // #426 follow-up: monorepos with parallel sub-trees often have multiple
    // sub-crates that share a leaf name (rust-rocket has 3 `codegen` and 3
    // `lib` across `core/`, `contrib/db_pools/`, `contrib/sync_db_pools/`).
    // `detectServices` keys the services map by `service:${name}`, so name
    // collisions silently overwrite each other and clusters in the
    // overwritten sub-tree end up orphaned. Disambiguate colliding names by
    // prepending the parent path segment(s).
    const nameToEntries = new Map<string, Array<{ name: string; rootPath: string }>>();
    for (const s of services) {
        if (!nameToEntries.has(s.name)) nameToEntries.set(s.name, []);
        nameToEntries.get(s.name)!.push(s);
    }
    for (const [, group] of nameToEntries) {
        if (group.length < 2) continue;
        for (const entry of group) {
            const segments = entry.rootPath.split('/');
            // Build a disambiguating name from path tail: e.g. `db_pools-codegen`
            // for `contrib/db_pools/codegen`, `core-codegen` for `core/codegen`.
            const tail = segments.slice(-2).join('-');
            entry.name = tail;
        }
    }
    return services;
}

/**
 * Scan top-level directories for source files, regardless of manifest files.
 * Used as a fallback to detect service boundaries in repos without per-service manifests.
 */
function findTopLevelSourceDirs(workspaceRoot: string): Array<{ name: string; rootPath: string }> {
    const IGNORE = new Set([
        'node_modules', '.git', 'dist', 'build', '.codeatlas',
        'coverage', '.cache', '.next', '.nuxt', 'vendor', '__pycache__',
        'target', 'out', 'bin', 'obj', 'tmp', 'temp', 'logs',
        'e2e', 'test', 'tests', 'spec', 'specs', '__tests__', '__test__',
        'cypress', 'playwright', 'fixtures', 'mocks', '__mocks__',
    ]);
    const SOURCE_EXTS = new Set([
        '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
        '.py', '.java', '.kt', '.go', '.rs', '.php', '.rb', '.cs',
        '.html', '.vue', '.svelte',
    ]);
    // Issue #399: accept top-level dirs that DON'T have a source file at
    // depth 1 but DO carry a project manifest. py-fastapi's `backend/`
    // contains pyproject.toml + app/ — the .py files are at depth 2.
    // Without this check, the entire backend service was invisible to
    // detectServices and L1 missed every edit under backend/.
    const MANIFEST_FILES = new Set([
        'package.json', 'requirements.txt', 'pyproject.toml',
        'pom.xml', 'build.gradle', 'build.gradle.kts',
        'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile', 'Package.swift',
        'Pipfile', 'setup.py',
    ]);

    // Issue #767: detect the workspace's primary framework from its
    // root manifest, then exclude that framework's own conventional
    // directories (e.g. Laravel's `bootstrap`, `config`, `routes`,
    // `public`; Rails' `config`, `db`, `public`; Next.js' `app`,
    // `components`, `lib`). Without this, every framework subdir gets
    // promoted to a top-level service and L1 shows 4-5 spurious nodes.
    const frameworkOwnedDirs = detectFrameworkOwnedDirs(workspaceRoot);

    // #820 (2026-06-10): when the workspace root ITSELF carries a project
    // manifest, the repo is one project — source-only child dirs (`src/`,
    // `scripts/`) are its internal layout, not services. Only child dirs
    // that carry their OWN manifest still count (the #399 nested-project
    // shape: `backend/pyproject.toml` + `frontend/package.json`). Without
    // this guard, a fastify boilerplate with root package.json + src/ +
    // scripts/ produced phantom `src` + `scripts` services that inflated
    // the multi-repo home stat and leaked 0-API tiles into the Knowledge
    // Map (dev-walkthrough finding).
    let rootHasManifest = false;
    try {
        const rootChildren = fs.readdirSync(workspaceRoot);
        rootHasManifest = rootChildren.some(f => MANIFEST_FILES.has(f));
    } catch { /* ignore */ }

    const dirs: Array<{ name: string; rootPath: string }> = [];
    try {
        const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
            if (frameworkOwnedDirs.has(entry.name)) continue;  // #767
            const dirPath = path.join(workspaceRoot, entry.name);
            try {
                const children = fs.readdirSync(dirPath);
                const hasSource = children.some(f => SOURCE_EXTS.has(path.extname(f).toLowerCase()));
                const hasManifest = children.some(f => MANIFEST_FILES.has(f));
                // #820 — root manifest present → require the child's own
                // manifest; source files alone don't make it a service.
                const qualifies = rootHasManifest ? hasManifest : (hasSource || hasManifest);
                if (qualifies) {
                    dirs.push({ name: entry.name, rootPath: entry.name });
                }
            } catch { /* skip unreadable dirs */ }
        }
    } catch { /* ignore */ }
    return dirs;
}

/**
 * Issue #767: when the workspace root carries a recognised framework
 * manifest, return the set of subdirectories that framework owns. These
 * dirs get excluded from `findTopLevelSourceDirs` so they don't become
 * separate services. The user-defined dirs (e.g. `apps/`, `services/`)
 * are NOT in any framework's reserved list and remain eligible.
 *
 * Conservative — we only special-case the four frameworks where the
 * 42-repo exploratory walk showed concrete over-split:
 *   - Laravel  (composer.json + artisan)
 *   - Symfony  (composer.json + bin/console)
 *   - Rails    (Gemfile + config/application.rb)
 *   - Next.js  (package.json + next.config.{js,ts,mjs})
 */
function detectFrameworkOwnedDirs(workspaceRoot: string): Set<string> {
    const here = (rel: string) => fs.existsSync(path.join(workspaceRoot, rel));

    // Laravel: composer.json + artisan binary at root.
    if (here('composer.json') && here('artisan')) {
        return new Set([
            'app', 'bootstrap', 'config', 'database', 'public', 'resources',
            'routes', 'storage', 'tests', 'vendor', 'lang',
        ]);
    }

    // Symfony: composer.json + bin/console.
    if (here('composer.json') && here('bin/console')) {
        return new Set([
            'assets', 'bin', 'config', 'public', 'src', 'templates',
            'tests', 'translations', 'var', 'vendor',
        ]);
    }

    // Rails: Gemfile + config/application.rb.
    if (here('Gemfile') && here('config/application.rb')) {
        return new Set([
            'app', 'bin', 'config', 'db', 'lib', 'log', 'public', 'storage',
            'test', 'tmp', 'vendor',
        ]);
    }

    // Next.js: package.json + a next.config.{js,ts,mjs}.
    if (here('package.json') && (here('next.config.js') || here('next.config.ts') || here('next.config.mjs'))) {
        return new Set([
            'app', 'components', 'lib', 'pages', 'public', 'styles', 'hooks',
            'utils', 'context', 'types', 'src', 'middleware',
        ]);
    }

    return new Set();
}

/**
 * Detect all services in the workspace.
 */
// ── #528 Celery process expansion ────────────────────────────────────────

/**
 * For each existing service def, check whether the workspace has runtime
 * evidence of a Celery worker and/or beat scheduler running against it. If
 * so, emit virtual sibling services `<name>-worker` and `<name>-beat`
 * rooted at the same path. They share the same code root because Celery
 * workers + beat scheduler are separate runtime processes of the same
 * codebase, not separate code roots.
 *
 * Evidence sources (any one is enough), located anywhere in the workspace:
 *   - systemd unit files: `celery.service` / `celeryd.service` / `celerybeat.service`
 *   - supervisord configs: `celery.conf` / `celeryd.conf` / `celerybeat.conf`
 *   - Procfile lines invoking `celery ... -A ... worker` or `... beat`
 *   - docker-compose `command:` invoking `celery -A ... worker|beat`
 *
 * Pre-condition: at least one `celery.py` (or `celery_app.py`) file in the
 * service's rootPath containing `Celery(`. Without a Celery app there is
 * nothing to fan out.
 */
function expandCeleryProcesses(
    workspaceRoot: string,
    snapshot: Snapshot,
    serviceDefs: Array<{ name: string; rootPath: string }>,
    getContent?: ContentProvider,
): Array<{ name: string; rootPath: string }> {
    // Sniff Celery app files first — cheap, scoped to the snapshot.
    //
    // Issue #722: `FileRecord.content` is lazy-dropped post-save (see
    // memory `project_lazy_file_content.md`). On every cascade rebuild
    // after the first save, `rec.content` is empty for ALL files, so
    // this loop misses every celery.py and the expansion silently
    // turns off. Result: baseline has django-worker / django-beat
    // (detected when content was still in RAM), working doesn't →
    // `diffInfra` marks every consumer infra (Celery / SQL / SQLite)
    // as `modified` from the `consumedChanged` path. The fix routes
    // through the optional `getContent` fallback so SQLite-backed
    // baseline + cascade-time working both resolve content reliably.
    const celeryAppsByRoot = new Map<string, boolean>();
    for (const [fp, rec] of Object.entries(snapshot.files)) {
        if (!fp.endsWith('celery.py') && !fp.endsWith('celery_app.py')) continue;
        const content = readContent(rec, fp, getContent);
        if (typeof content !== 'string' || !/Celery\s*\(/.test(content)) continue;
        // Map to the closest service root (longest matching prefix).
        let bestRoot: string | null = null;
        for (const def of serviceDefs) {
            if (def.rootPath === '' || fp === def.rootPath || fp.startsWith(def.rootPath + '/')) {
                if (bestRoot === null || def.rootPath.length > bestRoot.length) bestRoot = def.rootPath;
            }
        }
        if (bestRoot !== null) celeryAppsByRoot.set(bestRoot, true);
    }
    if (celeryAppsByRoot.size === 0) return serviceDefs;

    // Walk the workspace looking for runtime evidence. We only descend a few
    // common locations to keep the cost bounded — the systemd/supervisord
    // and Procfile/compose conventions live near the project root.
    const evidence = scanCeleryProcessEvidence(workspaceRoot);
    if (!evidence.hasWorker && !evidence.hasBeat) return serviceDefs;

    const expanded = [...serviceDefs];
    for (const def of serviceDefs) {
        if (!celeryAppsByRoot.has(def.rootPath)) continue;
        if (evidence.hasWorker) expanded.push({ name: `${def.name}-worker`, rootPath: def.rootPath });
        if (evidence.hasBeat) expanded.push({ name: `${def.name}-beat`, rootPath: def.rootPath });
    }
    return expanded;
}

function scanCeleryProcessEvidence(workspaceRoot: string): { hasWorker: boolean; hasBeat: boolean } {
    let hasWorker = false;
    let hasBeat = false;

    // Filename-based: systemd / supervisord. Walk shallow; deep workspaces
    // (>4 levels) skip the recursive sweep — these conventions live near
    // the root.
    const FILENAME_HINTS: Array<{ rx: RegExp; kind: 'worker' | 'beat' }> = [
        { rx: /^celery(d|_worker)?\.service$/i, kind: 'worker' },
        { rx: /^celery(d|_worker)?\.conf$/i, kind: 'worker' },
        { rx: /^celerybeat\.service$/i, kind: 'beat' },
        { rx: /^celerybeat\.conf$/i, kind: 'beat' },
    ];

    function walk(dir: string, depth: number): void {
        if (hasWorker && hasBeat) return;
        if (depth > 4) return;
        let entries: import('node:fs').Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full, depth + 1); continue; }
            if (!e.isFile()) continue;
            for (const { rx, kind } of FILENAME_HINTS) {
                if (rx.test(e.name)) {
                    if (kind === 'worker') hasWorker = true;
                    else hasBeat = true;
                }
            }
            // Procfile + docker-compose content scan.
            if (e.name === 'Procfile') {
                try {
                    const c = fs.readFileSync(full, 'utf-8');
                    for (const line of c.split('\n')) {
                        if (!/^\s*\w+\s*:/.test(line)) continue;
                        if (!/\bcelery\b/i.test(line)) continue;
                        if (/\bworker\b/i.test(line)) hasWorker = true;
                        if (/\bbeat\b/i.test(line)) hasBeat = true;
                    }
                } catch { /* unreadable, skip */ }
            } else if (/^docker-compose.*\.ya?ml$/i.test(e.name)) {
                try {
                    const c = fs.readFileSync(full, 'utf-8');
                    // Conservative regex — picks up `command: celery -A app worker`
                    // and the YAML-list form `- celery -A app beat`.
                    for (const line of c.split('\n')) {
                        if (!/celery\b.*-A\b/i.test(line)) continue;
                        if (/\bworker\b/i.test(line)) hasWorker = true;
                        if (/\bbeat\b/i.test(line)) hasBeat = true;
                    }
                } catch { /* skip */ }
            }
        }
    }
    walk(workspaceRoot, 0);
    return { hasWorker, hasBeat };
}

export function detectServices(
    workspaceRoot: string,
    snapshot: Snapshot,
    getContent?: ContentProvider,
): Record<string, ServiceRecord> {
    const services: Record<string, ServiceRecord> = {};
    const apis = Object.values(snapshot.apiIndex);

    // Multi-repo workspaces ("bag of N independent repos in one folder")
    // are a different shape than monorepos — sibling repos rarely share an
    // origin, so the broad same-origin `/api/*` fallback below produces
    // pure spaghetti. Detect once up-front and let the loop downstream
    // skip that fallback when the flag fires.
    const multiRepo: MultiRepoDetection = detectMultiRepoMode(workspaceRoot);

    const monorepoServices = findMonorepoServices(workspaceRoot);
    const dockerResult = parseDockerCompose(workspaceRoot);

    let serviceDefs: Array<{ name: string; rootPath: string }> = [];

    if (multiRepo.isMultiRepo) {
        // Multi-repo workspace: each detected sibling repo IS the unit. Skip
        // the monorepo / docker / top-level scans entirely — those would
        // descend into each child's internal `examples/`, `packages/`,
        // `services/` folders and register every example as a phantom
        // service. (Observed in the 42-repo `e2e/real-repos` fixture
        // where `ts-nextjs-pages/examples/` alone produced 222 services.)
        // The user's mental model is "one card per repo" and that's what
        // multi-repo mode gives them.
        serviceDefs = multiRepo.repos.map(r => ({ name: r.name, rootPath: r.rootPath }));
    } else if (monorepoServices.length >= 1) {
        // Issue 214: Respect monorepo structure even with 1 service (single-package monorepo)
        serviceDefs = monorepoServices;
    } else {
        // Try top-level source directories (works for backend/ + frontend/ style repos)
        // Only activate when 2+ distinct source dirs exist — single-dir repos fall through to docker/fallback
        const topLevelDirs = findTopLevelSourceDirs(workspaceRoot);
        if (topLevelDirs.length > 1) {
            serviceDefs = topLevelDirs;
        } else if (dockerResult && dockerResult.buildable.length >= 1) {
            // Docker-compose buildable services — fix build:. to use dir name if dir exists
            serviceDefs = dockerResult.buildable.map((s) => {
                let rootPath = s.buildContext === '.' ? '' : (s.buildContext ?? '');
                // If build context is workspace root but a dir with the service name exists, prefer that
                if ((rootPath === '' || rootPath === '.') && fs.existsSync(path.join(workspaceRoot, s.name))) {
                    rootPath = s.name;
                }
                return { name: s.name, rootPath };
            });
        }
    }

    // Fallback: treat entire workspace as a single service
    if (serviceDefs.length === 0) {
        serviceDefs = [{ name: 'main', rootPath: '' }];
    }

    // #528 — expand Django + Celery setups into worker + beat siblings when
    // we find runtime evidence (systemd unit files, supervisord configs,
    // Procfile entries, docker-compose `command:` invocations). The worker /
    // beat services share the same rootPath as their parent Celery app since
    // they're separate runtime processes of the same codebase.
    serviceDefs = expandCeleryProcesses(workspaceRoot, snapshot, serviceDefs, getContent);

    // #426 — cluster-service orphan guard. When the specific serviceDefs we
    // found (monorepo / docker / top-level dirs) don't cover the whole
    // workspace, files outside any rootPath become unattributable — feature
    // clusters built from those files end up with `serviceId: undefined` and
    // disappear from L2a + L1. The historically-worst offenders had repos
    // where detection picked one subdirectory (e.g. ts-remix `remix.init/`,
    // go-echo `website/`) while the actual app code lived elsewhere
    // (`app/`, `cookbook/`).
    //
    // Add a workspace-wide `main` service ONLY when (a) no existing serviceDef
    // already has `rootPath === ''` and (b) at least one SOURCE-CODE file is
    // outside every existing rootPath. Source-file gating matters: monorepos
    // like py-fastapi have root-level configs (pyproject.toml, pre-commit.yml)
    // that aren't clusterable and shouldn't trigger a phantom catch-all. Only
    // languages whose files actually feed into the clustering pipeline count.
    // Sort order in `buildFileToServiceMap` is longest-rootPath-first, so
    // `main` only catches files no more-specific service claims.
    const hasWorkspaceWide = serviceDefs.some((d) => d.rootPath === '');
    if (!hasWorkspaceWide && serviceDefs.length > 0) {
        const uncovered = Object.keys(snapshot.files).some((fp) => {
            // Only source-language files count — configs, manifests, lockfiles,
            // markdown don't appear in clusters and shouldn't trigger a phantom
            // workspace service.
            if (!ORPHAN_GUARD_SOURCE_EXT.test(fp)) return false;
            // BUG-EXP-3 — root-level tooling/scaffolding scripts aren't app code.
            if (ORPHAN_GUARD_IGNORE_PATH.test(fp)) return false;
            return !serviceDefs.some((d) =>
                d.rootPath === '' || fp.startsWith(d.rootPath + '/') || fp === d.rootPath,
            );
        });
        if (uncovered) {
            const usedNames = new Set(serviceDefs.map((d) => d.name));
            let mainName = 'main';
            let i = 2;
            while (usedNames.has(mainName)) {
                mainName = `main_${i++}`;
            }
            serviceDefs.push({ name: mainName, rootPath: '' });
        }
    }

    // Issue #774: when multiple services have nested rootPaths
    // (e.g. workspace-root `main` plus `articles/`, `users/` sub-binaries
    // in go-gin), an API file like `articles/handler.go` matches BOTH
    // `articles/` and the workspace-root `main`. Without explicit
    // attribution, the L1 subtitle counts the same API twice. We assign
    // each API to its LONGEST matching rootPath so every API is owned by
    // exactly one service. This makes the L1 sum agree with the home
    // page total and the KMap APIs count.
    const sortedDefsByDepth = [...serviceDefs].sort(
        (a, b) => b.rootPath.length - a.rootPath.length,
    );
    function pickOwningRootPath(filePath: string): string | null {
        for (const def of sortedDefsByDepth) {
            if (def.rootPath === '') return def.rootPath;
            if (filePath === def.rootPath || filePath.startsWith(def.rootPath + '/')) {
                return def.rootPath;
            }
        }
        return null;
    }

    for (const { name, rootPath } of serviceDefs) {
        const id = `service:${name}`;

        // Filter files belonging to this service
        const serviceFiles: Record<string, any> = {};
        for (const [fp, record] of Object.entries(snapshot.files)) {
            if (rootPath === '' || fp.startsWith(rootPath + '/') || fp === rootPath) {
                serviceFiles[fp] = record;
            }
        }

        // Issue 171: Count only HTTP-style APIs for exposedApiCount (exclude signals, middleware, DI, etc.)
        const NON_HTTP_METHODS = new Set(['SIGNAL', 'EVENT_LISTENER', 'EVENT_EMIT', 'AOP_ASPECT', 'AOP_AROUND',
            'AOP_BEFORE', 'AOP_AFTER', 'AOP_AFTERRETURNING', 'AOP_AFTERTHROWING', 'DI_DEPENDENCY',
            'MIDDLEWARE', 'SERVLET_FILTER', 'HANDLER_INTERCEPTOR', 'DATA_FETCH', 'STATIC_PATHS']);
        const serviceApis = apis.filter(
            (a) => pickOwningRootPath(a.filePath) === rootPath &&
                   !NON_HTTP_METHODS.has(a.method)
        );
        // Phase 2 finding #6 residual (2026-06-07): count outgoing API
        // calls (fetch / axios / useQuery / Dio / URLSession) emitted by
        // the FE/mobile detectors as NETWORK + DATA_FETCH. Filtered to
        // this service's owning files via the same pickOwningRootPath
        // gate the exposed tally uses.
        const CONSUMED_METHODS = new Set(['NETWORK', 'DATA_FETCH']);
        const serviceConsumedApis = apis.filter(
            (a) => pickOwningRootPath(a.filePath) === rootPath &&
                   CONSUMED_METHODS.has(a.method)
        );

        // Detect technology FIRST — required to know which extraction
        // path consumedUrls should take (FE/mobile services get the
        // precise `path:` extraction; backend services don't, to avoid
        // noise from Swagger / generated client stubs / vendor code).
        const technology = detectTechnology(serviceFiles, getContent, { workspaceRoot, rootPath });
        // v2 phase 2 (#482 + #483): classify the service as backend /
        // frontend / mobile / unknown so downstream FE/mobile-only L1
        // enrichment knows whether to run. Backend behaviour is
        // unchanged — every existing backend tech maps to `'backend'`.
        const category = detectCategoryFromTechnology(technology, serviceFiles, rootPath, workspaceRoot);

        // Detect consumed URLs and same-origin API calls
        const allContent = Object.entries(serviceFiles)
            .map(([fp, f]) => readContent(f, fp, getContent))
            .join('\n');
        const consumedUrls = extractConsumedUrls(allContent, category);

        // Collect file paths for this service
        const filePaths = Object.keys(serviceFiles);

        // Phase 2 finding #6 residual (2026-06-07): for FE/mobile
        // services, exposedApiCount is 0 by definition — they don't
        // host HTTP routes. Any `serviceApis` that landed in those
        // buckets get re-routed to consumedApiCount instead so the L1
        // label can switch by category without losing the signal.
        // `serviceApis` already includes NETWORK methods for FE (since
        // NETWORK isn't in NON_HTTP_METHODS), so for FE we use it as
        // the consumed-call total directly rather than adding the
        // separate `serviceConsumedApis` set on top (which would
        // double-count).
        const isFrontendOrMobile = category === 'frontend' || category === 'mobile';
        // BUG-EXPLORE-12: the L1 "N HTTP routes exposed" label must count ONLY
        // true HTTP routes. The blacklist above still lets JOB / MQ_CONSUMER /
        // CLI_COMMAND / DB_MIGRATION / MODEL_HOOK etc. through, so a Celery/Kafka
        // service was mislabeled (py-django-celery `main` said "124 HTTP routes"
        // when 115 were `@shared_task` jobs). Use an HTTP-method WHITELIST for the
        // exposed count; `serviceApis` itself is left untouched so pure-worker
        // services are still detected (their jobs surface on the Worker node).
        const exposedApiCount = isFrontendOrMobile ? 0 : serviceApis.filter((a) => HTTP_ROUTE_METHODS.has(a.method)).length;
        // Consumed-call tally is the same shape for both categories:
        // count of NETWORK + DATA_FETCH apis. For FE/mobile this is the
        // primary L1 label number; for backend it's a secondary metric.
        const consumedApiCount = serviceConsumedApis.length;
        services[id] = {
            id,
            name,
            rootPath,
            technology,
            category,
            exposedApiCount,
            consumedApiCount,
            consumedUrls,
            consumedServices: [],
            diff: 'unchanged',
            repoId: multiRepo.isMultiRepo ? topRepoFor(rootPath, multiRepo.repos) : undefined,
        };
    }

    // Post-process: resolve consumedServices
    const serviceList = Object.values(services);
    for (const service of serviceList) {
        const consumed = new Set<string>();

        for (const url of service.consumedUrls) {
            // Skip the `path:` synthetic prefix in the substring-matching
            // pass — paths get the dedicated route-template matcher below.
            if (url.startsWith('path:')) continue;
            // Match absolute URL to known service by name
            for (const other of serviceList) {
                if (other.id === service.id) continue;
                if (url.toLowerCase().includes(other.name.toLowerCase())) {
                    consumed.add(other.id);
                }
            }
        }

        // v2 phase 2 #483 — captured FE-client paths → resolve each to
        // a specific service whose apiIndex carries a matching route.
        // Only FE/mobile services emit `path:` entries (gating in
        // extractConsumedUrls), so this loop is a no-op for backend
        // services.
        const pathEntries = service.consumedUrls.filter((u) => u.startsWith('path:'));
        for (const entry of pathEntries) {
            const callPath = entry.slice('path:'.length);
            for (const other of serviceList) {
                if (other.id === service.id) continue;
                const otherApis = apis.filter((a) =>
                    other.rootPath === '' ||
                    a.filePath.startsWith(other.rootPath + '/') ||
                    a.filePath === other.rootPath,
                );
                if (otherApis.some((a) => routeMatches(callPath, a.route))) {
                    consumed.add(other.id);
                }
            }
        }

        // Same-origin relative API caller → connect to services that expose APIs.
        // v2 phase 2 #483 — when path-matching already pinned at least one
        // specific backend (FE/mobile services only — backend services
        // never emit `path:` entries so `hadPathMatch` is always false for
        // them), suppress the broad "connect to every API service"
        // fallback. The precise edges from path-matching take priority.
        //
        // Multi-repo workspaces ALWAYS suppress the broad fallback —
        // sibling repos don't share an origin in practice, so a stray
        // `fetch('/api/foo')` in repo A shouldn't draw edges to every
        // other repo's API surface (37 repos × 36 = ~1300 spurious
        // edges otherwise).
        // BUG-EXP-4 — an internal API-base env var (VITE_API_URL, API_BASE_URL,
        // BACKEND_URL, …) points at the sibling backend in a full-stack monorepo.
        // Treat it like `relative-api:same-origin`: resolve to route-exposing
        // sibling services instead of leaving it to become a phantom external node.
        const hasInternalApiEnv = service.consumedUrls.some(
            (u) => u.startsWith('env:') && isInternalApiBaseEnv(u.slice('env:'.length)),
        );
        const hadPathMatch = pathEntries.length > 0 && consumed.size > 0;
        if (
            !hadPathMatch
            && !multiRepo.isMultiRepo
            && (service.consumedUrls.includes('relative-api:same-origin') || hasInternalApiEnv)
        ) {
            for (const other of serviceList) {
                if (other.id !== service.id && other.exposedApiCount > 0) {
                    consumed.add(other.id);
                }
            }
        }

        // #448-A: sort to ensure deterministic order across init and cascade
        // rebuilds. Set iteration is insertion-order, which depends on the
        // order of `serviceList` (Object.values on `services` Record). That
        // order isn't guaranteed identical between init-time service detection
        // and cascade-time re-detection, so without an explicit sort the
        // consumedServices arrays drift, making the L1 microservice graph
        // baseline vs working comparison fail even though the set is the same.
        service.consumedServices = [...consumed].sort();
    }

    return services;
}

/**
 * Detect infrastructure services (databases, caches, queues) used by the workspace.
 * Sources: docker-compose image-only services + database client pattern matching in code.
 */
export function detectInfrastructureServices(
    workspaceRoot: string,
    snapshot: Snapshot,
    services: Record<string, ServiceRecord>,
    getContent?: ContentProvider,
): InfrastructureService[] {
    const infraMap = new Map<string, InfrastructureService>();

    // Multi-repo workspaces lift the FE/mobile gate on SDK detection so a
    // shared `openai` / `stripe` / `twilio` import in ANY repo (even a
    // backend one) gets consolidated into a single shared SDK node. In a
    // single repo / monorepo this gate stays in place to keep the
    // backend `verify:real` expectations byte-stable.
    const multiRepo = detectMultiRepoMode(workspaceRoot);

    // 1. Docker-compose image-only services (mongo, postgres, redis, etc.)
    const dockerResult = parseDockerCompose(workspaceRoot);
    if (dockerResult) {
        for (const ds of dockerResult.infrastructure) {
            const kind = inferInfraKind(ds.name);
            const id = `infra:${ds.name}`;
            if (!infraMap.has(id)) {
                infraMap.set(id, { id, name: ds.name, kind, consumedBy: [] });
            }
        }
    }

    // 2. Database connection patterns in each service's code
    for (const [serviceId, service] of Object.entries(services)) {
        const serviceFiles = Object.entries(snapshot.files)
            .filter(([fp]) => service.rootPath === '' || fp.startsWith(service.rootPath + '/') || fp === service.rootPath);
        const content = serviceFiles.map(([fp, f]) => readContent(f, fp, getContent)).join('\n');

        for (const { pattern, name, kind } of DB_CONNECTION_PATTERNS) {
            pattern.lastIndex = 0;
            if (pattern.test(content)) {
                // Issue 218: canonicalize alias forms so postgres/psql/PostgreSQL
                // collapse into one infra node.
                const canonical = canonicalizeInfraName(name);
                const infraId = `infra:${canonical.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
                if (!infraMap.has(infraId)) {
                    infraMap.set(infraId, { id: infraId, name: canonical, kind, consumedBy: [] });
                }
                const infra = infraMap.get(infraId)!;
                if (!infra.consumedBy.includes(serviceId)) {
                    infra.consumedBy.push(serviceId);
                }
            }
        }
    }

    // 2.5. UX-54a (2026-06-06) — CDK-declared AWS resources lift to L1
    // infra nodes (Kinesis Stream, DynamoDB Table, SQS Queue, S3 Bucket,
    // Cognito UserPool, API Gateway). Walk each service's TS/JS/Python/
    // Java source for `new <Type>(...)` / `<ns>.<Type>(self, ...)` /
    // `<Type>.Builder.create(...)` declarations. Gated by `isCdkLikely`
    // inside `parseCdkResources` so non-CDK files cost a single regex
    // test before being skipped.
    {
        for (const [serviceId, service] of Object.entries(services)) {
            const serviceFiles = Object.entries(snapshot.files)
                .filter(([fp]) => service.rootPath === '' || fp.startsWith(service.rootPath + '/') || fp === service.rootPath);
            const allHits: any[] = [];
            for (const [fp, f] of serviceFiles) {
                const lowerName = fp.toLowerCase();
                if (!/\.(ts|tsx|js|jsx|py|java)$/.test(lowerName)) continue;
                const content = readContent(f, fp, getContent);
                if (!content) continue;
                allHits.push(...parseCdkResources(content));
            }
            if (allHits.length === 0) continue;
            const newInfra = cdkResourcesToInfraServices(allHits, serviceId);
            for (const ni of newInfra) {
                const existing = infraMap.get(ni.id);
                if (existing) {
                    if (!existing.consumedBy.includes(serviceId)) existing.consumedBy.push(serviceId);
                } else {
                    infraMap.set(ni.id, ni);
                }
            }
        }
    }

    // 2.6. UX-54b/c (2026-06-06) — SAM (template.yaml) + Serverless
    // Framework (serverless.yml) resource declarations lift to L1 infra
    // nodes using the same mapping the CDK extractor uses. SLS templates
    // embed CFN under `resources.Resources`; the SLS extractor adapts to
    // the SAM extractor so a single AWS topology renders identically
    // regardless of which IaC flavor declared it.
    {
        for (const [serviceId, service] of Object.entries(services)) {
            const serviceFiles = Object.entries(snapshot.files)
                .filter(([fp]) => service.rootPath === '' || fp.startsWith(service.rootPath + '/') || fp === service.rootPath);
            const allHits: any[] = [];
            for (const [fp, f] of serviceFiles) {
                const lowerName = fp.toLowerCase();
                if (!lowerName.endsWith('.yaml') && !lowerName.endsWith('.yml')) continue;
                const content = readContent(f, fp, getContent);
                if (!content) continue;
                if (isSamLikely(fp, content)) {
                    allHits.push(...parseSamResources(content));
                } else if (isSlsLikely(fp, content)) {
                    allHits.push(...parseSlsResources(content));
                }
            }
            if (allHits.length === 0) continue;
            // Reuse the SAM dedup helper — SLS canonicalised resources
            // share the same `AWS::*::*` Type fields, so they bucket
            // identically.
            const newInfra = samResourcesToInfraServices(allHits, serviceId);
            for (const ni of newInfra) {
                const existing = infraMap.get(ni.id);
                if (existing) {
                    if (!existing.consumedBy.includes(serviceId)) existing.consumedBy.push(serviceId);
                } else {
                    infraMap.set(ni.id, ni);
                }
            }
        }
    }

    // 3. Third-party SDKs for FE/mobile services only (v2 phase 2 — #482).
    //    Backend services are excluded by category check so the existing
    //    backend `verify:real` invariants stay byte-identical. SDK nodes
    //    are kept SEPARATE from docker/DB infra in this pass (different
    //    kind, distinct ID prefix `sdk:`) so the merge logic at step 4
    //    doesn't accidentally collapse `sdk:firebase` into a same-named
    //    infra entry.
    for (const [serviceId, service] of Object.entries(services)) {
        // SDK detection runs for FE/mobile services in all workspaces, and
        // ALSO for backend services in multi-repo workspaces (so a shared
        // `openai` / `stripe` consumed by multiple sibling backend repos
        // surfaces as ONE consolidated node).
        const isFeMobile = service.category === 'frontend' || service.category === 'mobile';
        if (!isFeMobile && !multiRepo.isMultiRepo) continue;
        const serviceFileEntries = Object.entries(snapshot.files)
            .filter(([fp]) => service.rootPath === '' || fp.startsWith(service.rootPath + '/') || fp === service.rootPath);
        const serviceFileMap: Record<string, FileRecord> = {};
        const langMap: Record<string, ReturnType<typeof detectLanguage>> = {};
        for (const [fp, rec] of serviceFileEntries) {
            serviceFileMap[fp] = rec as FileRecord;
            const lang = detectLanguage(fp);
            if (lang) langMap[fp] = lang;
        }
        const sdks = detectSdks(
            serviceFileMap,
            langMap as Record<string, NonNullable<ReturnType<typeof detectLanguage>>>,
            getContent,
        );
        for (const sdk of sdks) {
            const id = `sdk:${sdk.sdkId}`;
            let entry = infraMap.get(id);
            if (!entry) {
                entry = {
                    id,
                    name: sdk.name,
                    kind: 'sdk',
                    consumedBy: [],
                    sdkId: sdk.sdkId,
                    sdkCategory: sdk.category,
                };
                infraMap.set(id, entry);
            }
            if (!entry.consumedBy.includes(serviceId)) {
                entry.consumedBy.push(serviceId);
            }
        }
    }

    // 3b. Shared DB schemas — only in multi-repo workspaces. Walks each
    //     service's files, extracts declared tables/collections via ORM
    //     scanners (Prisma / TypeORM / Sequelize / Mongoose / SQLAlchemy
    //     / Django / Rails / GORM), and emits ONE shared `database` node
    //     per `(engine, tableName)` that ≥2 sibling repos declare. Tables
    //     only seen in a single repo aren't surfaced — they're private,
    //     not "shared".
    if (multiRepo.isMultiRepo) {
        // Per-service schema declarations.
        const perService = new Map<string, DbSchemaEntry[]>();
        for (const [serviceId, service] of Object.entries(services)) {
            const serviceFileMap: Record<string, FileRecord> = {};
            for (const [fp, rec] of Object.entries(snapshot.files)) {
                if (service.rootPath === '' || fp.startsWith(service.rootPath + '/') || fp === service.rootPath) {
                    serviceFileMap[fp] = rec as FileRecord;
                }
            }
            const schemas = detectDbSchemas(serviceFileMap, getContent);
            if (schemas.length > 0) perService.set(serviceId, schemas);
        }
        // Aggregate by (engine, tableName) → owning services.
        type Bucket = { engine: string; tableName: string; displayName: string; consumedBy: string[] };
        const buckets = new Map<string, Bucket>();
        for (const [serviceId, schemas] of perService.entries()) {
            for (const s of schemas) {
                const key = `${s.engine}|${s.tableName}`;
                let b = buckets.get(key);
                if (!b) {
                    b = { engine: s.engine, tableName: s.tableName, displayName: s.displayName, consumedBy: [] };
                    buckets.set(key, b);
                }
                if (!b.consumedBy.includes(serviceId)) b.consumedBy.push(serviceId);
            }
        }
        for (const b of buckets.values()) {
            if (b.consumedBy.length < 2) continue;          // not shared
            const engineLabel = b.engine === 'unknown' ? 'DB' : prettyEngine(b.engine);
            const id = `db:${b.engine}:${b.tableName}`;
            if (infraMap.has(id)) continue;
            infraMap.set(id, {
                id,
                name: `${engineLabel} · ${b.displayName}`,
                kind: 'database',
                consumedBy: [...b.consumedBy].sort(),
            });
        }
    }

    // 4. Cross-reference: docker infra names vs code-detected infra (merge duplicates)
    //    e.g., docker "mongo" + code "MongoDB" → both point to same infra
    //    e.g., docker "postgres" + code "SQL (JPA)" → same underlying DB

    /** True if a and b names refer to the same underlying infrastructure. */
    function infraNamesMatch(a: string, b: string): boolean {
        const clean = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
        const ac = clean(a);
        const bc = clean(b);
        if (ac.includes(bc) || bc.includes(ac)) return true;
        // JPA/JDBC/Hibernate/Django ORM/SQLAlchemy are ORM layers over a relational DB —
        // they should merge with any specific SQL-DB node (postgres, mysql, etc.)
        // Note: names are cleaned to lowercase alpha-only, so "SQL (Django ORM)" → "sqldjangoorm"
        const SQL_ORM_TERMS = ['jpa', 'jdbc', 'hibernate', 'sequelize', 'djangoorm', 'sqlalchemy', 'eloquent', 'doctrine', 'laravel', 'efcore', 'dapper', 'activerecord', 'sqlgo'];
        const RELATIONAL_DB_TERMS = ['postgres', 'mysql', 'mariadb', 'oracle', 'sqlserver', 'mssql'];
        const isOrm = (s: string) => SQL_ORM_TERMS.some(k => s.includes(k));
        const isRelDb = (s: string) => RELATIONAL_DB_TERMS.some(k => s.includes(k));
        return (isOrm(ac) && isRelDb(bc)) || (isOrm(bc) && isRelDb(ac));
    }

    const final = new Map<string, InfrastructureService>();
    for (const infra of infraMap.values()) {
        // SDK entries (v2 phase 2 #482) bypass the name-similarity merge.
        // Each `sdk:<id>` is already canonicalised on its catalog id, and
        // similar-name collapses (e.g. `Firebase` + `Firebase Cloud
        // Messaging`) would incorrectly hide a distinct SDK from L1.
        if (infra.kind === 'sdk') {
            final.set(infra.id, { ...infra });
            continue;
        }
        // Find if a code-detected entry matches a docker entry by name similarity
        let merged = false;
        for (const existing of final.values()) {
            if (infra.kind === existing.kind && infraNamesMatch(infra.name, existing.name)) {
                // Merge consumedBy lists, prefer the more specific/canonical name (shorter)
                for (const sid of infra.consumedBy) {
                    if (!existing.consumedBy.includes(sid)) {
                        existing.consumedBy.push(sid);
                    }
                }
                merged = true;
                break;
            }
        }
        if (!merged) {
            final.set(infra.id, { ...infra });
        }
    }

    return [...final.values()];
}

/**
 * File-level patterns that signal relevant structural changes for each infra kind.
 * Used by diffInfrastructureServices to detect meaningful changes (not just any code change).
 *
 * database → schema/model definition changes (Mongoose, Sequelize, TypeORM, Knex)
 * cache    → Redis/Memcached key operation patterns (key names added/changed/removed)
 * queue    → Message broker topic/exchange/routing key patterns
 * external → Any URL reference change
 */
const INFRA_FILE_PATTERNS: Record<InfrastructureService['kind'], RegExp[]> = {
    database: [
        /mongoose\.Schema\b|new\s+Schema\s*\(\s*\{/g,               // Mongoose schema definition
        /mongoose\.model\s*\(|\.model\s*\(\s*['"`]\w/g,             // Mongoose model registration
        /DataTypes\.\w+|sequelize\.define\s*\(/g,                    // Sequelize model
        /@Entity\s*\(|@Column\s*\(|@PrimaryColumn\s*\(/g,           // TypeORM decorator
        /createTable\s*\(|addColumn\s*\(|dropTable\s*\(|renameColumn\s*\(/g, // JS DB migrations
        /db\.createCollection\s*\(|db\.collection\s*\(\s*['"`]\w/g, // MongoDB native
        /migrations\.CreateModel\b|migrations\.AddField\b|migrations\.RemoveField\b|migrations\.DeleteModel\b/g, // Django migrations
        /operations\s*=\s*\[\s*(?:migrations\.|RunPython|RunSQL)/g,  // Django migration operations list
        /op\.create_table\s*\(|op\.add_column\s*\(|op\.drop_table\s*\(|op\.drop_column\s*\(/g, // Alembic
        /Schema\s*::\s*(?:create|table|drop)\s*\(/g,                // Laravel migrations
    ],
    cache: [
        /\.(set|get|del|expire|pexpire|hset|hget|hmset|sadd|srem|zadd|zrem|lpush|rpush)\s*\(\s*['"`][^'"` ]{1,100}['"`]/g, // Key by name
        /\.setex\s*\(\s*['"`]|\.psetex\s*\(\s*['"`]/g,             // Key with TTL
        /KEY\s*=\s*['"`][^'"` ]+['"`]|key\s*:\s*['"`][^'"` ]+['"`]/g, // Key constants
    ],
    queue: [
        /channel\.(publish|sendToQueue|consume|assertQueue|assertExchange)\s*\(/g, // RabbitMQ
        /producer\.send\s*\(\s*\{|consumer\.run\s*\(\s*\{/g,       // Kafka producer/consumer
        /exchange\s*:\s*['"`][^'"` ]+['"`]|routingKey\s*:\s*['"`][^'"` ]+['"`]/g, // AMQP routing
        /topic\s*:\s*['"`][^'"` ]+['"`]|topics\s*:\s*\[/g,         // Kafka topic
    ],
    external: [
        /https?:\/\/[^\s'"` )]+/g, // Any URL reference
    ],
    // v2 phase 2 #482 — SDK presence is determined by imports, which the
    // SDK detector re-scans on every refresh. Any file change in a
    // service that consumes the SDK is potentially relevant (a removed
    // import would deletes the SDK; a new one adds it). The empty list
    // means `hasRelevantInfraFileChanges` returns false for SDK kinds —
    // the diff is computed from the FULL detector re-run, not from
    // per-pattern file probing, so this is correct.
    sdk: [],
};

/**
 * Check whether any files in the services that consume this infra have changed
 * in ways relevant to the infra kind (schema changes, key changes, topic changes).
 */
function hasRelevantInfraFileChanges(
    infra: InfrastructureService,
    baselineSnapshot: Snapshot,
    workingSnapshot: Snapshot,
    workingServices: Record<string, ServiceRecord>,
    getBaselineContent?: ContentProvider,
    getWorkingContent?: ContentProvider,
): boolean {
    const patterns = INFRA_FILE_PATTERNS[infra.kind] ?? [];

    // Collect rootPaths for all consumedBy services
    const serviceRoots = infra.consumedBy.map(sid => workingServices[sid]?.rootPath ?? '');

    const inConsumedService = (fp: string): boolean =>
        serviceRoots.some(root => root === '' || fp.startsWith(root + '/') || fp === root);

    // Check modified files
    for (const [fp, workFile] of Object.entries(workingSnapshot.files)) {
        if (!inConsumedService(fp)) continue;
        const baseFile = baselineSnapshot.files[fp];
        if (!baseFile) {
            // New file — check if it contains infra-relevant patterns
            const content = readContent(workFile, fp, getWorkingContent);
            if (patterns.some(p => { p.lastIndex = 0; return p.test(content); })) return true;
        } else if (baseFile.hash !== (workFile as any).hash) {
            // Changed file — prefer working content; fall back to baseline if working empty
            const workContent = readContent(workFile, fp, getWorkingContent);
            const content = workContent || readContent(baseFile, fp, getBaselineContent);
            if (patterns.some(p => { p.lastIndex = 0; return p.test(content); })) return true;
        }
    }

    // Check deleted files that were infra-relevant
    for (const [fp, baseFile] of Object.entries(baselineSnapshot.files)) {
        if (!inConsumedService(fp)) continue;
        if (workingSnapshot.files[fp]) continue; // still exists
        const content = readContent(baseFile, fp, getBaselineContent);
        if (patterns.some(p => { p.lastIndex = 0; return p.test(content); })) return true;
    }

    return false;
}

/**
 * Diff infrastructure services between baseline and working snapshots.
 *
 * - New infra not in baseline → 'added'   (🟢 green)
 * - Baseline infra gone in working → 'deleted' (🔴 red)
 * - consumedBy services changed → 'modified'   (🟠 orange)
 * - DB model / Redis key / queue topic files changed → 'modified' (🟠 orange)
 */
export function diffInfrastructureServices(
    baselineInfra: InfrastructureService[],
    workingInfra: InfrastructureService[],
    baselineSnapshot: Snapshot,
    workingSnapshot: Snapshot,
    workingServices: Record<string, ServiceRecord>,
    getBaselineContent?: ContentProvider,
    getWorkingContent?: ContentProvider,
): InfrastructureService[] {
    const result: InfrastructureService[] = [];

    // Build lookup maps — match by id AND by normalised name (handles id format drift)
    const baselineById = new Map(baselineInfra.map(i => [i.id, i]));
    const baselineByNorm = new Map(
        baselineInfra.map(i => [i.name.toLowerCase().replace(/[^a-z0-9]/g, ''), i])
    );

    const findBaseline = (infra: InfrastructureService): InfrastructureService | undefined =>
        baselineById.get(infra.id) ??
        baselineByNorm.get(infra.name.toLowerCase().replace(/[^a-z0-9]/g, ''));

    // Working infra — classify each as added / modified / unchanged
    for (const infra of workingInfra) {
        const base = findBaseline(infra);
        let diff: DiffStatus = 'unchanged';

        if (!base) {
            diff = 'added';
        } else {
            const baseConsumed = new Set(base.consumedBy);
            const workConsumed = new Set(infra.consumedBy);
            const consumedChanged =
                [...workConsumed].some(s => !baseConsumed.has(s)) ||
                [...baseConsumed].some(s => !workConsumed.has(s));

            if (consumedChanged) {
                diff = 'modified';
            } else if (hasRelevantInfraFileChanges(infra, baselineSnapshot, workingSnapshot, workingServices, getBaselineContent, getWorkingContent)) {
                diff = 'modified';
            }
        }

        result.push({ ...infra, diff });
    }

    // Baseline infra no longer in working → deleted
    for (const base of baselineInfra) {
        const stillExists = workingInfra.some(w => {
            const normW = w.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            const normB = base.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            return w.id === base.id || normW === normB;
        });
        if (!stillExists) {
            result.push({ ...base, diff: 'deleted' });
        }
    }

    return result;
}

/**
 * Diff services between baseline and working snapshots.
 * Optionally accepts file records to detect content changes within a service's files.
 */
export function diffServices(
    baseline: Record<string, ServiceRecord>,
    working: Record<string, ServiceRecord>,
    baselineFiles?: Record<string, { hash: string }>,
    workingFiles?: Record<string, { hash: string }>
): Record<string, ServiceRecord> {
    const result: Record<string, ServiceRecord> = {};

    // #426 — a file belongs to the service with the LONGEST matching rootPath
    // (the most specific), mirroring the assignment in `buildFileToServiceMap`.
    // Without this, the workspace-wide `service:main` (rootPath='') would claim
    // every file change in the repo and over-mark itself as modified whenever
    // any specific service got edited.
    const orderedServices = Object.values(working).sort(
        (a, b) => b.rootPath.length - a.rootPath.length,
    );
    function ownerService(fp: string): ServiceRecord | undefined {
        for (const svc of orderedServices) {
            if (svc.rootPath === '' || fp.startsWith(svc.rootPath + '/') || fp === svc.rootPath) {
                return svc;
            }
        }
        return undefined;
    }

    for (const [id, service] of Object.entries(working)) {
        const base = baseline[id];
        let diff: DiffStatus = 'unchanged';

        if (!base) {
            diff = 'added';
        } else if (
            service.exposedApiCount !== base.exposedApiCount ||
            service.technology !== base.technology ||
            JSON.stringify(service.consumedServices.sort()) !== JSON.stringify(base.consumedServices.sort())
        ) {
            diff = 'modified';
        } else if (baselineFiles && workingFiles) {
            const anyFileChanged = Object.keys(workingFiles).some((fp) => {
                // File counts for THIS service only when this service is its
                // most-specific owner — fixes #426 over-marking for the
                // workspace-wide `service:main` fallback.
                if (ownerService(fp)?.id !== service.id) return false;
                const baseHash = baselineFiles[fp]?.hash;
                const workHash = workingFiles[fp]?.hash;
                return baseHash !== undefined && workHash !== undefined && baseHash !== workHash;
            });
            if (anyFileChanged) diff = 'modified';
        }

        result[id] = { ...service, diff };
    }

    for (const [id, service] of Object.entries(baseline)) {
        if (!working[id]) {
            result[`${id}__deleted`] = { ...service, diff: 'deleted' };
        }
    }

    return result;
}
