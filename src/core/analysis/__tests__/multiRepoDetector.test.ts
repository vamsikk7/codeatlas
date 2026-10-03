/**
 * multiRepoDetector.test.ts — unit tests for the multi-repo workspace
 * detector. We build small tmpdir scaffolds for each scenario so the
 * file-system probing runs against real inodes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectMultiRepoMode, repoRootForFile } from '../multiRepoDetector';

let tmpRoot: string;

function mkdir(p: string): void { fs.mkdirSync(p, { recursive: true }); }
function write(p: string, content: string = '{}'): void {
    mkdir(path.dirname(p));
    fs.writeFileSync(p, content, 'utf-8');
}

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-repo-test-'));
});

afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('detectMultiRepoMode', () => {
    it('fires when ≥2 sibling dirs each have a manifest and root has none', () => {
        write(path.join(tmpRoot, 'svc-a', 'package.json'));
        write(path.join(tmpRoot, 'svc-b', 'package.json'));
        write(path.join(tmpRoot, 'svc-c', 'go.mod'), 'module x');

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
        expect(r.repos.map(x => x.name).sort()).toEqual(['svc-a', 'svc-b', 'svc-c']);
        expect(r.rootHasManifest).toBe(false);
    });

    it('does NOT fire when only one child looks standalone', () => {
        write(path.join(tmpRoot, 'svc-a', 'package.json'));
        mkdir(path.join(tmpRoot, 'docs'));
        write(path.join(tmpRoot, 'docs', 'readme.txt'), 'hello');

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(false);
        expect(r.repos.map(x => x.name)).toEqual(['svc-a']);
    });

    it('suppresses when root has a `workspaces` field (yarn / npm monorepo)', () => {
        write(path.join(tmpRoot, 'package.json'), JSON.stringify({
            name: 'monorepo', workspaces: ['packages/*'],
        }));
        write(path.join(tmpRoot, 'packages', 'a', 'package.json'));
        write(path.join(tmpRoot, 'packages', 'b', 'package.json'));

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(false);
        expect(r.orchestratorFile).toBe('package.json#workspaces');
    });

    it('suppresses when root has pnpm-workspace.yaml', () => {
        write(path.join(tmpRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
        write(path.join(tmpRoot, 'apps', 'a', 'package.json'));
        write(path.join(tmpRoot, 'apps', 'b', 'package.json'));

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(false);
        expect(r.orchestratorFile).toBe('pnpm-workspace.yaml');
    });

    it('suppresses for nx / turbo / lerna / rush', () => {
        for (const orch of ['nx.json', 'turbo.json', 'lerna.json', 'rush.json']) {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
            try {
                write(path.join(root, orch));
                write(path.join(root, 'a', 'package.json'));
                write(path.join(root, 'b', 'package.json'));
                const r = detectMultiRepoMode(root);
                expect(r.isMultiRepo, `orchestrator=${orch}`).toBe(false);
                expect(r.orchestratorFile).toBe(orch);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        }
    });

    it('requires a stronger threshold when root has a manifest', () => {
        // Single root package.json (not a workspaces monorepo) + 2 standalone
        // sibling dirs = ambiguous → don't fire.
        write(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'app' }));
        write(path.join(tmpRoot, 'svc-a', 'package.json'));
        write(path.join(tmpRoot, 'svc-b', 'package.json'));

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(false);
        expect(r.rootHasManifest).toBe(true);

        // 3 standalone children clears the higher bar.
        write(path.join(tmpRoot, 'svc-c', 'package.json'));
        const r2 = detectMultiRepoMode(tmpRoot);
        expect(r2.isMultiRepo).toBe(true);
    });

    it('accepts .git/ as a strong signal even without a manifest', () => {
        // Two repos that don't have a root manifest but do have their own .git/.
        mkdir(path.join(tmpRoot, 'r1', '.git'));
        mkdir(path.join(tmpRoot, 'r2', '.git'));
        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
        expect(r.repos.every(x => x.signals.includes('git'))).toBe(true);
    });

    it('accepts skeleton signal (src + README) for repos without manifests', () => {
        // Mirrors fixtures like csharp-aspnet / kotlin-android that ship in
        // the e2e/real-repos fixture without a root manifest.
        write(path.join(tmpRoot, 'app1', 'README.md'), '# app1');
        mkdir(path.join(tmpRoot, 'app1', 'src'));
        write(path.join(tmpRoot, 'app2', 'README.md'), '# app2');
        mkdir(path.join(tmpRoot, 'app2', 'src'));

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
        expect(r.repos.every(x => x.signals.includes('skeleton'))).toBe(true);
    });

    it('ignores noise dirs (node_modules, dist, .git, etc.)', () => {
        write(path.join(tmpRoot, 'node_modules', 'whatever', 'package.json'));
        write(path.join(tmpRoot, 'dist', 'package.json'));
        write(path.join(tmpRoot, '.git', 'package.json'));
        write(path.join(tmpRoot, 'a', 'package.json'));
        write(path.join(tmpRoot, 'b', 'package.json'));

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
        expect(r.repos.map(x => x.name).sort()).toEqual(['a', 'b']);
    });

    it('skips children that have no manifest, no .git, no skeleton', () => {
        write(path.join(tmpRoot, 'a', 'package.json'));
        write(path.join(tmpRoot, 'b', 'package.json'));
        mkdir(path.join(tmpRoot, 'random-folder')); // empty — should not count
        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
        expect(r.repos.map(x => x.name).sort()).toEqual(['a', 'b']);
    });

    it('captures the framework entry-point signal (vite/next/django/dockerfile/etc.)', () => {
        // Three repos, each carrying a different framework entry-point file.
        write(path.join(tmpRoot, 'web-vite/package.json'));
        write(path.join(tmpRoot, 'web-vite/vite.config.ts'), 'export default {};');

        write(path.join(tmpRoot, 'api-django/requirements.txt'));
        write(path.join(tmpRoot, 'api-django/manage.py'), '#!/usr/bin/env python\n');

        write(path.join(tmpRoot, 'svc-docker/README.md'));
        mkdir(path.join(tmpRoot, 'svc-docker/src'));
        write(path.join(tmpRoot, 'svc-docker/Dockerfile'), 'FROM node:20\n');

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
        const byName = Object.fromEntries(r.repos.map(x => [x.name, x.signals]));
        expect(byName['web-vite']).toContain('entry-point');
        expect(byName['api-django']).toContain('entry-point');
        expect(byName['svc-docker']).toContain('entry-point');
    });

    it('captures content-scan entry-points (Go main, Cargo [[bin]], Rails Gemfile, npm scripts)', () => {
        // Go: main.go with `package main`
        write(path.join(tmpRoot, 'go-svc/main.go'), 'package main\n\nfunc main() {}\n');
        write(path.join(tmpRoot, 'go-svc/go.mod'), 'module x\n');

        // Rust: Cargo.toml with [[bin]]
        write(path.join(tmpRoot, 'rs-svc/Cargo.toml'), '[package]\nname="x"\n\n[[bin]]\nname="x"\npath="src/main.rs"\n');

        // Rails: Gemfile with rails
        write(path.join(tmpRoot, 'rails-svc/Gemfile'), 'source "https://rubygems.org"\ngem "rails", "~> 7.0"\n');

        // npm scripts.start
        write(path.join(tmpRoot, 'node-svc/package.json'), '{"name":"x","scripts":{"start":"node server.js"}}');

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
        const byName = Object.fromEntries(r.repos.map(x => [x.name, x.signals]));
        expect(byName['go-svc']).toContain('entry-point');
        expect(byName['rs-svc']).toContain('entry-point');
        expect(byName['rails-svc']).toContain('entry-point');
        expect(byName['node-svc']).toContain('entry-point');
    });

    it('does NOT count a content-only Cargo.toml without [[bin]] as entry-point', () => {
        // Library crate (no [[bin]] section) shouldn't get the runnable signal.
        write(path.join(tmpRoot, 'rs-lib/Cargo.toml'), '[package]\nname="x"\n\n[lib]\nname="x"\npath="src/lib.rs"\n');
        write(path.join(tmpRoot, 'rs-app/Cargo.toml'), '[package]\nname="x"\n\n[[bin]]\nname="x"\npath="src/main.rs"\n');
        const r = detectMultiRepoMode(tmpRoot);
        const byName = Object.fromEntries(r.repos.map(x => [x.name, x.signals]));
        expect(byName['rs-lib']?.includes('entry-point')).toBe(false);
        expect(byName['rs-app']).toContain('entry-point');
    });

    it('applies the stronger threshold when root has manifest AND its own entry point', () => {
        // Root looks like a real project (Vite app) with sibling examples/packages.
        // Should NOT auto-fire multi-repo without overwhelming sibling evidence.
        write(path.join(tmpRoot, 'package.json'), '{"name":"web","scripts":{"dev":"vite"}}');
        write(path.join(tmpRoot, 'vite.config.ts'), 'export default {};');
        // Two child packages — passive sub-folders, not real sibling repos.
        write(path.join(tmpRoot, 'pkg-a/package.json'));
        write(path.join(tmpRoot, 'pkg-b/package.json'));
        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(false);

        // Three or more, OR two with both git+entry-point, escalates.
        write(path.join(tmpRoot, 'pkg-c/package.json'));
        const r2 = detectMultiRepoMode(tmpRoot);
        expect(r2.isMultiRepo).toBe(true);
    });

    it('escalates to multi-repo when ≥2 children carry BOTH git+entry-point even with a strong root project', () => {
        // Root has its own project signal, but the children look like real
        // standalone apps with their own .git AND framework entry points.
        write(path.join(tmpRoot, 'package.json'), '{"name":"top","scripts":{"dev":"vite"}}');
        write(path.join(tmpRoot, 'vite.config.ts'), 'export default {};');

        mkdir(path.join(tmpRoot, 'app1/.git'));
        write(path.join(tmpRoot, 'app1/package.json'), '{"scripts":{"start":"node srv.js"}}');

        mkdir(path.join(tmpRoot, 'app2/.git'));
        write(path.join(tmpRoot, 'app2/Dockerfile'), 'FROM alpine\n');

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
    });

    it('returns empty when workspaceRoot does not exist', () => {
        const r = detectMultiRepoMode(path.join(tmpRoot, 'does-not-exist'));
        expect(r.isMultiRepo).toBe(false);
        expect(r.repos).toEqual([]);
    });
});

describe('detectMultiRepoMode — UX-24/25: IaC templates count as a standalone-repo signal', () => {
    it('fires when ≥2 sibling dirs each carry a template.yaml (SAM) and root has none', () => {
        // Mirrors aws-samples/sessions-with-aws-sam: each session dir has
        // template.yaml at depth 1, no package.json at the root.
        write(path.join(tmpRoot, 'session-a', 'template.yaml'), 'Transform: AWS::Serverless-2016-10-31\nResources: {}');
        write(path.join(tmpRoot, 'session-b', 'template.yaml'), 'Transform: AWS::Serverless-2016-10-31\nResources: {}');
        write(path.join(tmpRoot, 'session-c', 'template.yml'), 'Transform: AWS::Serverless-2016-10-31\nResources: {}');

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
        expect(r.repos.map(x => x.name).sort()).toEqual(['session-a', 'session-b', 'session-c']);
        for (const repo of r.repos) {
            expect(repo.signals).toContain('iac');
        }
    });

    it('fires when ≥2 sibling dirs each carry a serverless.yml (Serverless Framework)', () => {
        write(path.join(tmpRoot, 'ex-a', 'serverless.yml'), 'service: a\nprovider: { name: aws }');
        write(path.join(tmpRoot, 'ex-b', 'serverless.yml'), 'service: b\nprovider: { name: aws }');

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
        expect(r.repos.map(x => x.name).sort()).toEqual(['ex-a', 'ex-b']);
        for (const repo of r.repos) {
            expect(repo.signals).toContain('iac');
        }
    });

    it('mixes iac signal with manifest signal — both count', () => {
        write(path.join(tmpRoot, 'with-pkg', 'package.json'));
        write(path.join(tmpRoot, 'with-pkg', 'template.yaml'), 'Resources: {}');
        write(path.join(tmpRoot, 'only-sam', 'template.yaml'), 'Resources: {}');

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
        const withPkg = r.repos.find(x => x.name === 'with-pkg')!;
        const onlySam = r.repos.find(x => x.name === 'only-sam')!;
        expect(withPkg.signals).toEqual(expect.arrayContaining(['manifest', 'iac']));
        expect(onlySam.signals).toContain('iac');
    });

    it('detects depth-2 IaC containers (parent dir has 2+ sub-dirs each with template.yaml)', () => {
        // Mirrors sessions-with-aws-sam/custom-domains layout: parent
        // has no template.yaml of its own, but 4 immediate sub-dirs
        // each carry one. The parent should still be detected as a
        // single repo via the depth-2 fallback so its per-repo worker's
        // scan can find all nested templates.
        write(path.join(tmpRoot, 'custom-domains', 'both-implied', 'template.yaml'), 'Resources: {}');
        write(path.join(tmpRoot, 'custom-domains', 'http', 'template.yaml'), 'Resources: {}');
        write(path.join(tmpRoot, 'custom-domains', 'both-declared', 'template.yaml'), 'Resources: {}');
        write(path.join(tmpRoot, 'custom-domains', 'rest', 'template.yaml'), 'Resources: {}');
        // A second top-level standalone for multi-repo threshold.
        write(path.join(tmpRoot, 'plain-sam', 'template.yaml'), 'Resources: {}');

        const r = detectMultiRepoMode(tmpRoot);
        expect(r.isMultiRepo).toBe(true);
        const cd = r.repos.find(x => x.name === 'custom-domains');
        expect(cd).toBeDefined();
        expect(cd!.signals).toContain('iac');
    });

    it('depth-2 fallback also promotes parent with a SINGLE nested template (single-app container)', () => {
        // Real-world: `sessions-with-aws-sam/starter-templates/web-app/template.yaml`.
        // The parent has no template of its own but the one nested sub-dir
        // makes it a clear single-app container — promote it so the
        // per-repo orchestrator runs scanIacTemplates over it.
        write(path.join(tmpRoot, 'starter-templates', 'web-app', 'template.yaml'), 'Resources: {}');
        write(path.join(tmpRoot, 'plain-sam', 'template.yaml'), 'Resources: {}');

        const r = detectMultiRepoMode(tmpRoot);
        const starter = r.repos.find(x => x.name === 'starter-templates');
        expect(starter).toBeDefined();
        expect(starter!.signals).toContain('iac');
    });

    it('skips non-IaC YAML files (arbitrary config)', () => {
        // A folder with an arbitrary `config.yaml` shouldn't count as a
        // SAM/Serverless-Framework repo. We require the canonical
        // template names: template.yaml/.yml/serverless.yml/.yaml.
        write(path.join(tmpRoot, 'has-config', 'config.yaml'), 'foo: 1');
        // A real SAM session for contrast.
        write(path.join(tmpRoot, 'real-sam', 'template.yaml'), 'Resources: {}');

        const r = detectMultiRepoMode(tmpRoot);
        // Only real-sam should be detected with an 'iac' signal — `has-config`
        // has no recognized standalone-repo signal so it's not in `repos`.
        const samRepo = r.repos.find(x => x.name === 'real-sam');
        expect(samRepo).toBeDefined();
        expect(samRepo!.signals).toContain('iac');
        expect(r.repos.find(x => x.name === 'has-config')).toBeUndefined();
    });
});

describe('repoRootForFile', () => {
    it('maps a path back to its owning repo when multi-repo mode is on', () => {
        const detection = {
            isMultiRepo: true,
            rootHasManifest: false,
            repos: [
                { name: 'svc-a', rootPath: 'svc-a', signals: ['manifest' as const] },
                { name: 'svc-b', rootPath: 'svc-b', signals: ['manifest' as const] },
            ],
        };
        expect(repoRootForFile(detection, 'svc-a/src/index.ts')).toBe('svc-a');
        expect(repoRootForFile(detection, 'svc-b/lib/main.go')).toBe('svc-b');
        expect(repoRootForFile(detection, 'svc-a')).toBe('svc-a');
        expect(repoRootForFile(detection, 'root-config.json')).toBe(null);
    });

    it('returns null when not in multi-repo mode', () => {
        const detection = {
            isMultiRepo: false,
            rootHasManifest: true,
            repos: [
                { name: 'svc-a', rootPath: 'svc-a', signals: ['manifest' as const] },
            ],
        };
        expect(repoRootForFile(detection, 'svc-a/src/index.ts')).toBe(null);
    });

    it('uses longest-prefix match so nested repo dirs win', () => {
        const detection = {
            isMultiRepo: true,
            rootHasManifest: false,
            repos: [
                { name: 'apps', rootPath: 'apps', signals: ['manifest' as const] },
                { name: 'web', rootPath: 'apps/web', signals: ['manifest' as const] },
            ],
        };
        expect(repoRootForFile(detection, 'apps/web/src/index.ts')).toBe('apps/web');
        expect(repoRootForFile(detection, 'apps/other/x.ts')).toBe('apps');
    });
});
