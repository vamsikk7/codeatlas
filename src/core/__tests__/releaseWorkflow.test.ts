/**
 * releaseWorkflow.test.ts
 *
 * Issue 316: validate the release CI workflow YAML stays well-formed and
 * keeps the verification suite wired up. Catches accidental drift (someone
 * removes `verify:real` from the workflow) without needing a real tag.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.join(process.cwd(), '.github/workflows/release.yml');

describe('release workflow (Issue 316)', () => {
    const yaml = fs.readFileSync(WORKFLOW, 'utf8');

    it('exists and triggers on tag push', () => {
        expect(yaml).toContain('name: Release');
        expect(yaml).toContain("tags: ['v*']");
    });

    it('runs lint, unit tests, and package', () => {
        expect(yaml).toMatch(/npm run lint/);
        expect(yaml).toMatch(/run: npm test/);
        expect(yaml).toMatch(/npm run package/);
    });

    it('fetches real-world projects and runs the verification suite', () => {
        expect(yaml).toMatch(/fetch:real-projects/);
        expect(yaml).toMatch(/verify:real(?!\:)/);
        expect(yaml).toMatch(/verify:real:invariants/);
    });

    it('caches the real-repos directory keyed on repos.json', () => {
        expect(yaml).toContain('actions/cache');
        expect(yaml).toContain("hashFiles('e2e/real-projects/repos.json')");
    });

    it('packages a VSIX and creates a GitHub Release', () => {
        expect(yaml).toMatch(/@vscode\/vsce package/);
        expect(yaml).toContain('softprops/action-gh-release');
    });
});
