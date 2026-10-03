/**
 * settings.test.ts — pins the four-layer config resolution:
 *   env var > workspace file > home file > built-in default
 *
 * Edge cases covered: env coercion (boolean / number / array), missing
 * config files (silent fallback), malformed JSON (silent fallback),
 * stringified-JSON arrays via env var.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSettingsResolver, STANDALONE_DEFAULTS } from '../settings';

describe('SettingsResolver — precedence', () => {
    const WORKSPACE = '/tmp/some/workspace';
    const HOME = '/tmp/some/home';

    function mkResolver(args: {
        env?: Record<string, string | undefined>;
        workspaceJson?: string;
        homeJson?: string;
    }) {
        return createSettingsResolver({
            workspaceRoot: WORKSPACE,
            env: args.env ?? {},
            homeDir: HOME,
            readFile: (p) => {
                if (p === `${WORKSPACE}/.codeatlas-sa/config.json`) return args.workspaceJson ?? null;
                if (p === `${HOME}/.codeatlas/config.json`) return args.homeJson ?? null;
                return null;
            },
        });
    }

    it('returns the built-in default when no other source provides the key', () => {
        const r = mkResolver({});
        expect(r.get('codeatlas.browserPort')).toBe(STANDALONE_DEFAULTS['codeatlas.browserPort']);
        expect(r.get('codeatlas.browserPort')).toBe(7842);
    });

    it('home config overrides default', () => {
        const r = mkResolver({ homeJson: JSON.stringify({ 'codeatlas.browserPort': 8000 }) });
        expect(r.get('codeatlas.browserPort')).toBe(8000);
    });

    it('workspace config overrides home + default', () => {
        const r = mkResolver({
            homeJson: JSON.stringify({ 'codeatlas.browserPort': 8000 }),
            workspaceJson: JSON.stringify({ 'codeatlas.browserPort': 9999 }),
        });
        expect(r.get('codeatlas.browserPort')).toBe(9999);
    });

    it('env var overrides everything', () => {
        const r = mkResolver({
            env: { CODEATLAS_BROWSER_PORT: '5050' },
            homeJson: JSON.stringify({ 'codeatlas.browserPort': 8000 }),
            workspaceJson: JSON.stringify({ 'codeatlas.browserPort': 9999 }),
        });
        expect(r.get('codeatlas.browserPort')).toBe(5050);
    });
});

describe('SettingsResolver — env-var coercion', () => {
    const WORKSPACE = '/tmp/ws';
    const r = (env: Record<string, string | undefined>) =>
        createSettingsResolver({ workspaceRoot: WORKSPACE, env, homeDir: '/tmp/h', readFile: () => null });

    it('boolean: "true"/"1"/"yes" → true; everything else → false', () => {
        expect(r({ CODEATLAS_LLM_NAMING: 'true' }).get('codeatlas.llmNaming')).toBe(true);
        expect(r({ CODEATLAS_LLM_NAMING: '1' }).get('codeatlas.llmNaming')).toBe(true);
        expect(r({ CODEATLAS_LLM_NAMING: 'YES' }).get('codeatlas.llmNaming')).toBe(true);
        expect(r({ CODEATLAS_LLM_NAMING: 'on' }).get('codeatlas.llmNaming')).toBe(true);
        expect(r({ CODEATLAS_LLM_NAMING: 'false' }).get('codeatlas.llmNaming')).toBe(false);
        expect(r({ CODEATLAS_LLM_NAMING: '0' }).get('codeatlas.llmNaming')).toBe(false);
        expect(r({ CODEATLAS_LLM_NAMING: 'banana' }).get('codeatlas.llmNaming')).toBe(false);
    });

    it('number: parsed via Number(); malformed → fallback to default', () => {
        expect(r({ CODEATLAS_SEQUENCE_TRAVERSAL_DEPTH: '15' }).get('codeatlas.sequenceTraversalDepth')).toBe(15);
        expect(r({ CODEATLAS_SEQUENCE_TRAVERSAL_DEPTH: 'banana' }).get('codeatlas.sequenceTraversalDepth')).toBe(8);
    });

    it('array: comma-separated env value parses to string[]', () => {
        const got = r({ CODEATLAS_IGNORE: '**/foo/**,**/bar/**' }).get<string[]>('codeatlas.ignore');
        expect(got).toEqual(['**/foo/**', '**/bar/**']);
    });

    it('array: JSON env value also parses', () => {
        const got = r({ CODEATLAS_IGNORE: '["**/a/**","**/b,c/**"]' }).get<string[]>('codeatlas.ignore');
        expect(got).toEqual(['**/a/**', '**/b,c/**']);
    });

    it('string: passes through as-is', () => {
        expect(r({ CODEATLAS_LLM_PROVIDER: 'anthropic' }).get('codeatlas.llmProvider')).toBe('anthropic');
    });
});

describe('SettingsResolver — robustness', () => {
    it('silently ignores a missing workspace config', () => {
        const r = createSettingsResolver({
            workspaceRoot: '/x', homeDir: '/y',
            readFile: () => null, // both files absent
        });
        expect(r.get('codeatlas.browserPort')).toBe(7842);
    });

    it('silently ignores malformed JSON in either config file', () => {
        const r = createSettingsResolver({
            workspaceRoot: '/x', homeDir: '/y',
            readFile: (p) => p.includes('/.codeatlas-sa/') ? '{ malformed' : null,
        });
        expect(r.get('codeatlas.browserPort')).toBe(7842);
    });

    it('all() returns every default key', () => {
        const r = createSettingsResolver({ workspaceRoot: '/x', homeDir: '/y', readFile: () => null });
        const all = r.all();
        for (const key of Object.keys(STANDALONE_DEFAULTS)) {
            expect(all).toHaveProperty(key);
        }
    });
});

// ─── set() — used by setLlmConfig + future settings UI flows ──────────────

describe('SettingsResolver — set()', () => {
    let workspaceRoot: string;
    beforeEach(() => {
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-settings-set-'));
    });
    afterEach(() => {
        try { require('node:fs').rmSync(workspaceRoot, { recursive: true, force: true }); } catch {}
    });

    it('persists a value to .codeatlas-sa/config.json', () => {
        const r = createSettingsResolver({ workspaceRoot, homeDir: '/y', readFile: () => null });
        const ok = r.set('codeatlas.llmProvider', 'anthropic');
        expect(ok).toBe(true);

        const fs = require('node:fs');
        const path = require('node:path');
        const written = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.codeatlas-sa', 'config.json'), 'utf-8'));
        expect(written['codeatlas.llmProvider']).toBe('anthropic');
    });

    it('merges into an existing config (does not overwrite unrelated keys)', () => {
        const fs = require('node:fs');
        const path = require('node:path');
        const cfgDir = path.join(workspaceRoot, '.codeatlas-sa');
        fs.mkdirSync(cfgDir, { recursive: true });
        fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
            'codeatlas.llmProvider': 'openrouter',
            'codeatlas.browserPort': 9090,
        }));

        const r = createSettingsResolver({ workspaceRoot, homeDir: '/y' });
        r.set('codeatlas.llmModel', 'claude-3-5-sonnet');

        const written = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf-8'));
        expect(written['codeatlas.llmModel']).toBe('claude-3-5-sonnet');
        // Pre-existing keys are preserved.
        expect(written['codeatlas.llmProvider']).toBe('openrouter');
        expect(written['codeatlas.browserPort']).toBe(9090);
    });

    it('subsequent get() returns the new value without reconstructing the resolver', () => {
        const r = createSettingsResolver({ workspaceRoot, homeDir: '/y', readFile: () => null });
        expect(r.get('codeatlas.llmProvider')).toBe('openrouter'); // default
        r.set('codeatlas.llmProvider', 'ollama');
        expect(r.get('codeatlas.llmProvider')).toBe('ollama');
    });
});
