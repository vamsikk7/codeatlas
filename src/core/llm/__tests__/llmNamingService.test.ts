import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LlmNamingService, redactSecrets } from '../llmNamingService';
import { GitRefProvider } from '../../storage/gitRefProvider';
import { SqliteStore } from '../../storage/sqliteStore';
import type { FeatureCluster, ApiRecord, ServiceRecord } from '../../graph/graphTypes';

// Mock the openRouterClient module
vi.mock('../openRouterClient', () => ({
    sendOpenRouterRequest: vi.fn(),
    DEFAULT_OPENROUTER_CONFIG: { model: 'test-model', timeoutMs: 1000 },
}));

import { sendOpenRouterRequest } from '../openRouterClient';
const mockSend = sendOpenRouterRequest as unknown as ReturnType<typeof vi.fn>;

let tmpDir: string;
let sqlite: SqliteStore;
let service: LlmNamingService;

function makeCluster(id: string, files: string[]): FeatureCluster {
    return {
        id,
        label: id.replace('cluster:', ''),
        files,
        entryPoints: [],
        internalCallCount: 0,
        externalCallCount: 0,
    };
}

async function makeSqlite(workspaceRoot: string): Promise<SqliteStore> {
    const provider = new GitRefProvider(workspaceRoot);
    const s = new SqliteStore(workspaceRoot, provider);
    await s.init();
    return s;
}

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-test-'));
    fs.mkdirSync(path.join(tmpDir, '.codeatlas'), { recursive: true });
    sqlite = await makeSqlite(tmpDir);
    service = new LlmNamingService(tmpDir, sqlite);
    mockSend.mockReset();
});

afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LlmNamingService — configuration', () => {
    it('isConfigured is false by default', () => {
        expect(service.isConfigured).toBe(false);
    });

    it('isConfigured is true after configure()', () => {
        service.configure('sk-test-key');
        expect(service.isConfigured).toBe(true);
    });

    it('isConfigured is true for ollama with empty API key', () => {
        service.configure('', 'llama3', 'ollama');
        expect(service.isConfigured).toBe(true);
    });

    it('isConfigured is true for custom with empty API key', () => {
        service.configure('', 'my-model', 'custom');
        expect(service.isConfigured).toBe(true);
    });

    it('isConfigured is false for openrouter with empty API key', () => {
        service.configure('', 'test', 'openrouter');
        expect(service.isConfigured).toBe(false);
    });
});

describe('LlmNamingService — nameCluster', () => {
    it('returns structural label when not configured', async () => {
        const cluster = makeCluster('cluster:auth', ['src/auth.ts']);
        const result = await service.nameCluster(cluster, {});
        expect(result).toBe('auth');
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('calls OpenRouter and returns LLM name when configured', async () => {
        service.configure('sk-test');
        mockSend.mockResolvedValue({ text: 'User Authentication', model: 'test', usage: null });

        const cluster = makeCluster('cluster:auth', ['src/auth/login.ts', 'src/auth/register.ts']);
        const result = await service.nameCluster(cluster, {
            'src/auth/login.ts': 'export function login() {}',
            'src/auth/register.ts': 'export function register() {}',
        });
        expect(result).toBe('User Authentication');
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('caches result — second call does NOT make HTTP request', async () => {
        service.configure('sk-test');
        mockSend.mockResolvedValue({ text: 'Todo Management', model: 'test', usage: null });

        const cluster = makeCluster('cluster:todos', ['src/todos.ts']);
        await service.nameCluster(cluster, {});
        mockSend.mockClear();

        const result2 = await service.nameCluster(cluster, {});
        expect(result2).toBe('Todo Management');
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('falls back to structural name on API error', async () => {
        service.configure('sk-test');
        mockSend.mockRejectedValue(new Error('OpenRouter 429: rate limited'));

        const cluster = makeCluster('cluster:auth', ['src/auth.ts']);
        const result = await service.nameCluster(cluster, {});
        expect(result).toBe('auth');
    });

    it('sanitizes LLM response: strips quotes and truncates', async () => {
        service.configure('sk-test');
        mockSend.mockResolvedValue({
            text: '"Very Long Name That Has Way Too Many Words For A Cluster Name To Be Useful At All Really"',
            model: 'test',
        });

        const cluster = makeCluster('cluster:x', ['src/x.ts']);
        const result = await service.nameCluster(cluster, {});
        // Should be stripped of quotes and limited to 10 words
        expect(result.split(/\s+/).length).toBeLessThanOrEqual(10);
        expect(result.startsWith('"')).toBe(false);
    });
});

// Issue #429 — LLM cluster naming must reject hallucinated refusal-phrase
// fragments (e.g. "As an AI model developed", "I'm sorry, I cannot...") and
// vague observations ("The module seems to be") rather than caching them
// verbatim. Falls back to the structural label (cluster.label = folder name).
describe('LlmNamingService — Issue #429 refusal-phrase / hallucination guards', () => {
    const HALLUCINATIONS: Array<{ name: string; text: string }> = [
        { name: 'OpenAI/Anthropic refusal preamble', text: 'As an AI model developed by Anthropic, I cannot guess the domain name without more context.' },
        { name: 'short refusal preamble',           text: 'As an AI, I can only suggest a generic name based on what I see.' },
        { name: 'apologetic refusal',               text: "I'm sorry, I cannot provide a name without more context." },
        { name: 'first-person uncertainty',         text: "I don't have enough information to name this module accurately." },
        { name: 'meta-commentary leak',             text: 'The module seems to be a collection of validation middlewares.' },
        { name: 'observation pattern (this)',       text: 'This appears to be a database access layer with some helpers.' },
        { name: 'observation pattern (it)',         text: 'It seems to relate to user authentication and session handling.' },
        { name: 'preamble "Based on"',              text: 'Based on the file names, this would be the Configuration module.' },
        { name: 'cannot determine',                 text: 'I cannot determine the exact domain from these files alone.' },
        { name: 'thinking-out-loud "Let me"',       text: 'Let me think about this — these look like middleware files.' },
    ];

    for (const h of HALLUCINATIONS) {
        it(`rejects "${h.name}" and falls back to structural label`, async () => {
            service.configure('sk-test');
            mockSend.mockResolvedValue({ text: h.text, model: 'test' });
            const cluster = makeCluster('cluster:middlewares', ['src/middlewares/rateLimiter.js']);
            const result = await service.nameCluster(cluster, {});
            // Must NOT return the hallucinated text.
            expect(result, `should reject "${h.text}"`).not.toMatch(/^(As an|I am|I'm|I'd|I don't|I cannot|I can't|Sorry|This appears|This seems|It seems|It appears|The module|The cluster|The folder|The system|The code|The function|Based on|Let me|I think|I believe|I would)/i);
            // Should fall back to the cluster's structural label.
            expect(result).toBe(cluster.label);
        });
    }

    // Issue #768: prompt-echo residues that survived prior sanitization
    // and ended up as actual cluster labels in production (the
    // csharp-aspnet repo showed 4 clusters all named "The domain name
    // of this" — verbatim prompt echo).
    const PROMPT_ECHOES: Array<{ name: string; text: string }> = [
        { name: 'echo: "The domain name of this module is"',  text: 'The domain name of this module is articles.' },
        { name: 'echo: "The domain name of this"',           text: 'The domain name of this' },
        { name: 'echo: "The name for this module would be"', text: 'The name for this module would be tags' },
        { name: 'echo: "Name: Articles"',                    text: 'Name: Articles' },
        { name: 'echo: "Module:"',                           text: 'Module: Profile Management' },
        { name: 'echo: bare "module"',                       text: 'module' },
        { name: 'echo: "this module"',                       text: 'this module' },
    ];
    for (const h of PROMPT_ECHOES) {
        it(`#768 strips/rejects prompt echo: "${h.name}"`, async () => {
            service.configure('sk-test');
            mockSend.mockResolvedValue({ text: h.text, model: 'test' });
            const cluster = makeCluster('cluster:test', ['src/articles/foo.cs']);
            const result = await service.nameCluster(cluster, {});
            // Either falls back to the structural label OR strips the
            // preamble cleanly. Never returns the echo verbatim.
            expect(result).not.toMatch(/^(?:the (?:domain )?name|this module|name:|module:)/i);
        });
    }

    it('legitimate short names pass through unchanged', async () => {
        service.configure('sk-test');
        const okSamples = ['User Authentication', 'Payment Processing', 'Todo Management', 'Configuration'];
        for (const sample of okSamples) {
            mockSend.mockReset();
            mockSend.mockResolvedValue({ text: sample, model: 'test' });
            // Different cluster id each time so cache misses → real call.
            const c = makeCluster(`cluster:ok-${sample.replace(/\s+/g, '')}`, [`src/${sample}.js`]);
            const result = await service.nameCluster(c, {});
            expect(result, `${sample} should pass through`).toBe(sample);
        }
    });

    it('rejected hallucination is NOT cached — second call still tries (and falls back again)', async () => {
        service.configure('sk-test');
        // First call: hallucination. Should not be cached.
        mockSend.mockResolvedValueOnce({ text: 'As an AI model, I cannot determine this.', model: 'test' });
        const cluster = makeCluster('cluster:auth', ['src/auth/user.js']);
        const first = await service.nameCluster(cluster, {});
        expect(first).toBe(cluster.label);

        // Second call: real name. The first hallucination MUST NOT have been
        // cached — otherwise the cluster is stuck with the structural label
        // even after the LLM is fixed / re-prompted.
        mockSend.mockResolvedValueOnce({ text: 'User Authentication', model: 'test' });
        const second = await service.nameCluster(cluster, {});
        expect(second).toBe('User Authentication');
        // Two LLM calls happened (hallucination was retried).
        expect(mockSend).toHaveBeenCalledTimes(2);
    });
});

describe('LlmNamingService — nameClusters batch', () => {
    it('enriches all cluster names', async () => {
        service.configure('sk-test');
        mockSend
            .mockResolvedValueOnce({ text: 'User Authentication', model: 'test' })
            .mockResolvedValueOnce({ text: 'Todo Management', model: 'test' });

        const clusters = {
            'cluster:auth': makeCluster('cluster:auth', ['src/auth.ts']),
            'cluster:todos': makeCluster('cluster:todos', ['src/todos.ts']),
        };
        const result = await service.nameClusters(clusters, {});
        expect(result['cluster:auth'].name).toBe('User Authentication');
        expect(result['cluster:todos'].name).toBe('Todo Management');
    });
});

describe('LlmNamingService — summarizeService', () => {
    it('returns empty string when not configured', async () => {
        const svc: ServiceRecord = {
            id: 'service:backend', label: 'backend', rootPath: 'backend',
            technology: 'express', files: [], exposedUrls: [],
            consumedUrls: [], consumedServices: [],
        };
        const result = await service.summarizeService(svc, []);
        expect(result).toBe('');
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns LLM description when configured', async () => {
        service.configure('sk-test');
        mockSend.mockResolvedValue({ text: 'Manages todo items with CRUD operations.', model: 'test' });

        const svc: ServiceRecord = {
            id: 'service:backend', label: 'backend', rootPath: 'backend',
            technology: 'express', files: [], exposedUrls: [],
            consumedUrls: [], consumedServices: [],
        };
        const apis = [
            { apiId: 'a1', method: 'GET', route: '/todos' },
            { apiId: 'a2', method: 'POST', route: '/todos' },
        ] as ApiRecord[];
        const result = await service.summarizeService(svc, apis);
        expect(result).toContain('todo');
    });
});

describe('LlmNamingService — annotateSequenceFlow', () => {
    it('returns LLM annotation when configured', async () => {
        service.configure('sk-test');
        mockSend.mockResolvedValue({ text: 'Create a new todo item', model: 'test' });

        const api = { apiId: 'a1', method: 'POST', route: '/api/todos' } as ApiRecord;
        const result = await service.annotateSequenceFlow(api);
        expect(result).toBe('Create a new todo item');
    });
});

describe('LlmNamingService — cache persistence', () => {
    it('persists cache to disk and reloads', async () => {
        service.configure('sk-test');
        mockSend.mockResolvedValue({ text: 'Cached Name', model: 'test' });

        const cluster = makeCluster('cluster:x', ['src/x.ts']);
        await service.nameCluster(cluster, {});

        // Create a new service instance pointing to the same DB
        const sqlite2 = await makeSqlite(tmpDir);
        try {
            const service2 = new LlmNamingService(tmpDir, sqlite2);
            expect(service2.isCached(cluster)).toBe(true);
            expect(service2.getCachedName(cluster)).toBe('Cached Name');
        } finally {
            sqlite2.close();
        }
    });

    it('cache is invalidated when membership changes', async () => {
        service.configure('sk-test');
        mockSend.mockResolvedValue({ text: 'First Name', model: 'test' });

        const cluster1 = makeCluster('cluster:x', ['src/a.ts']);
        await service.nameCluster(cluster1, {});

        // Same cluster ID but different files → different hash
        const cluster2 = makeCluster('cluster:x', ['src/a.ts', 'src/b.ts']);
        expect(service.isCached(cluster2)).toBe(false);
    });
});

describe('LlmNamingService — zero HTTP requests when disabled', () => {
    it('makes no HTTP requests when not configured', async () => {
        const clusters = {
            'cluster:a': makeCluster('cluster:a', ['src/a.ts']),
        };
        await service.nameClusters(clusters, {});
        expect(mockSend).not.toHaveBeenCalled();
    });
});

// Issue #429 — deterministic naming requires temperature=0 to flow through
// to every naming-class call so the same input produces the same name across
// rebuilds. Without this, L2a clusters flip `modified` every cascade and the
// pollution bubbles to L1 (#433, #435).
describe('LlmNamingService — Issue #429 deterministic temperature', () => {
    it('nameCluster passes temperature=0 to sendOpenRouterRequest', async () => {
        service.configure('sk-test');
        mockSend.mockResolvedValue({ text: 'Auth', model: 'test' });
        const cluster = makeCluster('cluster:auth', ['src/auth.ts']);
        await service.nameCluster(cluster, { 'src/auth.ts': 'export function login() {}' });
        expect(mockSend).toHaveBeenCalledTimes(1);
        const sentConfig = mockSend.mock.calls[0][0];
        expect(sentConfig.temperature).toBe(0);
    });

    it('summarizeService passes temperature=0', async () => {
        service.configure('sk-test');
        mockSend.mockResolvedValue({ text: 'CRUD over todos', model: 'test' });
        const svc: ServiceRecord = {
            id: 'service:backend', label: 'backend', rootPath: 'backend',
            technology: 'express', files: [], exposedUrls: [],
            consumedUrls: [], consumedServices: [],
        };
        await service.summarizeService(svc, [{ apiId: 'a1', method: 'GET', route: '/x' } as ApiRecord]);
        const sentConfig = mockSend.mock.calls[0][0];
        expect(sentConfig.temperature).toBe(0);
    });

    it('annotateSequenceFlow passes temperature=0', async () => {
        service.configure('sk-test');
        mockSend.mockResolvedValue({ text: 'Create todo', model: 'test' });
        const api = { apiId: 'a1', method: 'POST', route: '/todos' } as ApiRecord;
        await service.annotateSequenceFlow(api);
        const sentConfig = mockSend.mock.calls[0][0];
        expect(sentConfig.temperature).toBe(0);
    });
});

// UX-49 (2026-06-04) — per-provider timeout. Local providers (Ollama,
// custom) need 60-120s for inference; hosted providers (OpenAI / OpenRouter
// / Anthropic) settle in 5-20s. The previous fixed 10s default aborted
// every Ollama nameCluster call.
describe('configure() per-provider timeout — UX-49', () => {
    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-naming-timeout-'));
        sqlite = await makeSqlite(tmpDir);
        service = new LlmNamingService(sqlite);
    });
    afterEach(async () => {
        try { await sqlite.close(); } catch {}
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('uses 120_000 ms timeout when provider is ollama', () => {
        service.configure('', 'llama3', 'ollama');
        expect((service as any).config.timeoutMs).toBe(120_000);
    });

    it('uses 120_000 ms timeout when provider is custom (self-hosted)', () => {
        service.configure('', 'mymodel', 'custom');
        expect((service as any).config.timeoutMs).toBe(120_000);
    });

    it('uses 30_000 ms timeout for openai', () => {
        service.configure('sk-test', 'gpt-4o', 'openai');
        expect((service as any).config.timeoutMs).toBe(30_000);
    });

    it('uses 30_000 ms timeout for anthropic', () => {
        service.configure('sk-ant', 'claude-3-5-sonnet', 'anthropic');
        expect((service as any).config.timeoutMs).toBe(30_000);
    });

    it('uses 30_000 ms timeout for openrouter (default provider)', () => {
        service.configure('sk-or');
        expect((service as any).config.timeoutMs).toBe(30_000);
    });

    it('provider name is case-insensitive', () => {
        service.configure('', 'llama3', 'Ollama');
        expect((service as any).config.timeoutMs).toBe(120_000);
    });
});

describe('#932 — redactSecrets masks values, not code', () => {
    it('does NOT shred identifiers/types/calls that merely CONTAIN a secret word', () => {
        const code = [
            'const accessToken = getAppAccessToken();',
            'const token = res?.data;',
            'export type ZohoToken = { access_token: string };',
            'const refreshAccessToken = (refreshToken: string) => fetch(url);',
            'googleCredentials.access_token = res?.data?.access_token;',
        ].join('\n');
        const out = redactSecrets(code);
        expect(out).not.toContain('[REDACTED]');     // nothing here is a literal secret VALUE
        expect(out).toContain('getAppAccessToken()'); // function call preserved
        expect(out).toContain('const token = res?.data;');
        expect(out).toContain('export type ZohoToken');
        expect(out).toBe(code);                        // fully untouched
    });

    it('masks the literal secret VALUE but keeps the key (quoted + env-style)', () => {
        const out = redactSecrets([
            'const API_KEY = "sk-abc123def456ghi";',
            'password: "hunter2pass",',
            'AUTH_TOKEN=ghp_abc123def456ghi789xyz',
        ].join('\n'));
        expect(out).toContain('API_KEY = "[REDACTED]"');
        expect(out).toContain('password: "[REDACTED]"');
        expect(out).toContain('[REDACTED]');
        expect(out).not.toContain('sk-abc123def456ghi');
        expect(out).not.toContain('hunter2pass');
        expect(out).not.toContain('ghp_abc123def456ghi789xyz');
    });

    it('redacts connection URIs', () => {
        expect(redactSecrets('connect("mongodb://admin:hunter2@db:27017/app")'))
            .toContain('[REDACTED_URI]');
        expect(redactSecrets('connect("mongodb://admin:hunter2@db:27017/app")'))
            .not.toContain('hunter2');
    });

    it('leaves a zod schema / property access using a secret-named key intact', () => {
        const code = 'const schema = z.object({ access_token: z.string(), refresh_token: z.string().optional() });';
        expect(redactSecrets(code)).toBe(code);
    });
});
