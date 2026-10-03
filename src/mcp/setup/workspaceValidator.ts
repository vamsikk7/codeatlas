/**
 * workspaceValidator.ts — sanity-check a path before we write it as the
 * indexed-workspace argument into an MCP client's config.
 *
 * Without this, `codeatlas-mcp setup` happily wires configs pointing at
 * `~/Downloads` or `/tmp`, and the user then gets a working MCP server
 * that returns empty results for every tool call. They'll suspect the
 * install is broken when really their config points nowhere useful.
 *
 * The validator returns a structured assessment — caller decides whether
 * to refuse, warn, or proceed. The default policy in `setup.ts`:
 *
 *   - `looks-like-workspace` → proceed silently.
 *   - `no-signals`           → error out unless `--force` is passed.
 *   - `path-missing`         → error out unconditionally.
 *
 * Heuristics mirror the simpler half of `multiRepoDetector`'s detection
 * stack: any one of {`.git/`, top-level manifest, project skeleton} is
 * enough to call this a code workspace. We don't require ALL of them —
 * a Python repo with just `requirements.txt` should pass the check.
 */

import * as fs from 'fs';
import * as path from 'path';

export type ValidationVerdict =
    | 'looks-like-workspace'
    | 'no-signals'
    | 'path-missing'
    | 'path-not-directory';

export interface WorkspaceValidation {
    verdict: ValidationVerdict;
    /** Which positive signals fired (empty for the negative verdicts). */
    signals: ReadonlyArray<'git' | 'manifest' | 'skeleton' | 'src-dir'>;
    /** Human-readable explanation of why this verdict was returned. */
    reason: string;
}

const MANIFEST_FILES = [
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'setup.py',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'go.mod',
    'Cargo.toml',
    'composer.json',
    'Gemfile',
    'Package.swift',
    'pubspec.yaml',
    'mix.exs',
    'project.clj',
] as const;

const SKELETON_DIRS = ['src', 'app', 'lib', 'pages', 'public'] as const;

const PROJECT_INDICATORS = [
    'README.md', 'README', 'README.rst', 'Makefile',
    'Dockerfile', '.editorconfig', '.gitignore',
] as const;

export function validateWorkspace(workspacePath: string): WorkspaceValidation {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(workspacePath);
    } catch {
        return {
            verdict: 'path-missing',
            signals: [],
            reason: `Path does not exist: ${workspacePath}`,
        };
    }
    if (!stat.isDirectory()) {
        return {
            verdict: 'path-not-directory',
            signals: [],
            reason: `Path is not a directory: ${workspacePath}`,
        };
    }

    const signals: Array<'git' | 'manifest' | 'skeleton' | 'src-dir'> = [];

    if (existsDir(path.join(workspacePath, '.git'))) signals.push('git');

    for (const m of MANIFEST_FILES) {
        if (existsFile(path.join(workspacePath, m))) {
            signals.push('manifest');
            break;
        }
    }

    // Skeleton = source-dir AND a project-indicator file in the same dir.
    // The two-signal requirement avoids false-positives on stray dirs that
    // happen to contain `src/`.
    const hasSrc = SKELETON_DIRS.some(d => existsDir(path.join(workspacePath, d)));
    const hasIndicator = PROJECT_INDICATORS.some(f => existsFile(path.join(workspacePath, f)));
    if (hasSrc && hasIndicator) signals.push('skeleton');
    // A weaker `src-dir` signal exists when only the src/ side fires —
    // useful for surfacing "you might have meant your repo root" hints.
    else if (hasSrc) signals.push('src-dir');

    if (signals.includes('git') || signals.includes('manifest') || signals.includes('skeleton')) {
        return {
            verdict: 'looks-like-workspace',
            signals,
            reason: `Detected: ${signals.join(', ')}`,
        };
    }

    return {
        verdict: 'no-signals',
        signals,
        reason: signals.includes('src-dir')
            ? 'Found a src/ directory but no manifest or README. This might be a subdirectory of your repo — try the repo root.'
            : 'No .git/, no recognized manifest (package.json, requirements.txt, pom.xml, go.mod, Cargo.toml, …), and no project skeleton (src/ + README).',
    };
}

function existsDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function existsFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}
