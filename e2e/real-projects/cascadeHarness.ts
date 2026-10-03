/**
 * cascadeHarness.ts
 *
 * Drives a real fixture repo through the full CodeAtlas pipeline lifecycle
 * (initialize → scripted edit → rebuildFile cascade → snapshot query) inside
 * a unit-test process with no VS Code dependency.
 *
 * This is the missing tier between unit tests (synthetic graphs in isolation)
 * and the live VS Code extension (manual click-through). Every today's-session
 * bug — L4 cascade regression, redaction-driven false positives, timeline-replay
 * "no working changes", React Flow stale layout — sat on the seam between
 * the snapshot store, the orchestrator cascade, and the navigation handlers.
 * One scenario test exercises every link in that chain.
 *
 * Usage:
 *
 *   const r = await runScenario({
 *       repoPath: realRepos.tsExpressRealworld,
 *       edits: [{ filePath: 'src/.../auth.service.ts', op: 'replace', oldText: '...', newText: '...' }],
 *   });
 *   const l4 = r.working.graphs[`file:${EDITED_PATH}`];
 *   expect(modifiedFunctionLabels(l4)).toEqual(['getCurrentUser']);
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SyncOrchestrator } from '../../src/core/sync/syncOrchestrator';
import { SnapshotStore } from '../../src/core/storage/snapshotStore';
import { CommentStore } from '../../src/core/storage/commentStore';
import { setGrammarsDir, resetTreeSitterForTesting } from '../../src/core/parser/treeSitterParser';
import type { DiagramGraph, Snapshot } from '../../src/core/graph/graphTypes';

export type EditOp =
    | { op: 'replace'; oldText: string; newText: string }
    | { op: 'addLinesToFunction'; fnName: string; afterMatching?: string; lines: string[] }
    | { op: 'overwriteFile'; newContent: string }
    /** Append a verbatim function declaration at the end of the file (Issue #379 — added). */
    | { op: 'addFunction'; declaration: string }
    /** Remove the named function declaration from the file (Issue #379 — deleted). */
    | { op: 'deleteFunction'; fnName: string }
    /** Rename occurrences of `\bfromName\b` to `toName` (Issue #379 — added+deleted pair). */
    | { op: 'renameFunction'; fromName: string; toName: string }
    /**
     * Create a new file (rather than editing an existing one). The
     * `filePath` on `ScenarioEdit` becomes the new file's path. Used to
     * verify L4/L5/L2a/L1 cascade when a brand-new file appears (Issue #379).
     */
    | { op: 'createFile'; content: string };

export interface ScenarioEdit {
    /** repo-relative path */
    filePath: string;
    /** what to do to the file content */
    op: EditOp;
}

export interface ScenarioOptions {
    /** absolute path to a fixture repo (typically under e2e/real-repos/) */
    repoPath: string;
    /** edits to apply after the initial scan */
    edits: ScenarioEdit[];
}

export interface ScenarioResult {
    store: SnapshotStore;
    sync: SyncOrchestrator;
    baseline: Snapshot;
    working: Snapshot;
    /** graph ids touched by rebuildFile, in order */
    rebuiltGraphIds: string[];
    /** the edit set, with the resolved new content per file */
    appliedEdits: Array<{ filePath: string; oldContent: string; newContent: string }>;
    /**
     * Save the current store to disk, then instantiate a FRESH SnapshotStore
     * against the same `.codeatlas` directory and load it. Returns the
     * rehydrated snapshots so persistence-round-trip tests can assert the
     * diff state survives serialization. The original `store` is unaffected.
     * Issue #381.
     */
    reloadFromDisk: () => Promise<{ store: SnapshotStore; baseline: Snapshot; working: Snapshot }>;
    /** Absolute path to the tmpdir copy of the fixture (so tests can drift files for resync scenarios). */
    repoCopyDir: string;
    /** disposes both tmpdirs (.codeatlas + repo copy) + resets tree-sitter */
    dispose: () => void;
}

/**
 * Apply a single EditOp to a string and return the new content.
 * `op: 'addLinesToFunction'` finds the function body opener and inserts the
 * provided lines on the line immediately after the opening brace (or after
 * the first match of `afterMatching` inside the function body when provided).
 */
export function applyEditOp(content: string, op: EditOp): string {
    switch (op.op) {
        case 'replace': {
            if (!content.includes(op.oldText)) {
                throw new Error(`applyEditOp/replace: oldText not found in content`);
            }
            return content.replace(op.oldText, op.newText);
        }
        case 'overwriteFile': {
            return op.newContent;
        }
        case 'addLinesToFunction': {
            // #420 (arrow detection): handle arrow functions BEFORE the
            // JS-strict regex. The original regex `[^\{]*?\{[ \t]*\n` is
            // lazy across line boundaries (so `const f = x => expr\n
            // function g() {` silently grabs g's `{`) AND fails on
            // destructured object parameters (`= ({ a, b }) => {` — the
            // `[^\{]*?` stops at the destructured `{`, the `\{[ \t]*\n`
            // then fails because `{ a, b }` is not followed by `\n`, the
            // walker falls through to the brace fallback which picks up
            // a call site somewhere else and mis-inserts). Find the `=>`
            // for this name and inspect the next non-whitespace character.
            const arrowHeaderRe = new RegExp(
                String.raw`\b${op.fnName}\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>`,
            );
            const arrowMatch = arrowHeaderRe.exec(content);
            let bodyStart: number;
            if (arrowMatch) {
                let i = arrowMatch.index + arrowMatch[0].length;
                while (i < content.length && /\s/.test(content[i]) && content[i] !== '\n') i++;
                if (content[i] !== '{') {
                    throw new Error(`applyEditOp/addLinesToFunction: ${op.fnName} is a bodyless arrow function (expression body) — cannot insert lines without a block body`);
                }
                // Block-body arrow: skip past `{` and walk to the next `\n`.
                i++; // past `{`
                while (i < content.length && content[i] !== '\n') i++;
                if (i >= content.length) throw new Error(`applyEditOp/addLinesToFunction: no newline after body opener for ${op.fnName}`);
                bodyStart = i + 1;
            } else {
                // Not an arrow assigned to a const/let/var — try the JS-strict
                // declaration regex. The previous second alternative
                // (`\bname\s*=\s*[^\{]*?\{[ \t]*\n`) was overly greedy across
                // line boundaries: for a Java/C# variable init like
                // `Owner george = george();` it would consume the rest of
                // the file until the next `{\n` and insert into an unrelated
                // method. JS arrow-with-block-body is already handled by the
                // arrow-detection branch above; named function expressions
                // (`const handler = function (...) {...}`) are still caught by
                // this first alternative because `[^\{]*?` is lazy.
                const jsHeaderRe = new RegExp(
                    String.raw`(?:const|function|let|var|async)\s+${op.fnName}\b[^\{]*?\{[ \t]*\n`,
                );
                const jsMatch = jsHeaderRe.exec(content);
                if (jsMatch) {
                    bodyStart = jsMatch.index + jsMatch[0].length;
                } else {
                // Ruby `def name … end` (#421). The walker's `(`-then-`{`
                // strategy can't handle Ruby because there's no body opener
                // character — the body starts on the line after the `def`
                // header. Match the `def` line and treat the next line as
                // the body start.
                const rubyDefRe = new RegExp(
                    String.raw`^[ \t]*def\s+${op.fnName}\b[^\n]*\n`,
                    'm',
                );
                const rubyMatch = rubyDefRe.exec(content);
                if (rubyMatch) {
                    bodyStart = rubyMatch.index + rubyMatch[0].length;
                } else {
                    // Fallback path (Java / Python / Go / Kotlin / Rust / C# …).
                    // Find `<fnName>(`, walk past the argument list, walk to body
                    // opener (`{` for brace languages, `:\n` for Python), advance
                    // to the line after the opener.
                    //
                    // Scan ALL occurrences and skip those that are CALL sites
                    // (preceded by `=`/`.`/`(`/operator) — the picker for
                    // multi-language repos like java-spring (`Owner george =
                    // george()`) and rust-rocket (`let task = strict("…")`)
                    // would otherwise pick the call site instead of the
                    // definition and walk to the next unrelated `{`.
                    const nameRe = new RegExp(String.raw`\b${op.fnName}\s*\(`, 'g');
                    const CALL_CONTEXT_CHARS = new Set([
                        '=', '.', ',', '(', '+', '-', '*', '/', '&', '|', '?', ':', '!', '<', '>',
                    ]);
                    let m: RegExpExecArray | null = null;
                    let candidate: RegExpExecArray | null;
                    while ((candidate = nameRe.exec(content)) !== null) {
                        let j = candidate.index - 1;
                        while (j >= 0 && /\s/.test(content[j])) j--;
                        // Start-of-file or non-expression-context char → looks like a definition.
                        if (j < 0 || !CALL_CONTEXT_CHARS.has(content[j])) {
                            m = candidate;
                            break;
                        }
                    }
                    if (!m) throw new Error(`applyEditOp/addLinesToFunction: could not find ${op.fnName}( definition (every match looks like a call site)`);
                    let i = m.index + m[0].length;
                    let depth = 1; // consumed the opening paren of the name match
                    while (i < content.length && depth > 0) {
                        if (content[i] === '(') depth++;
                        else if (content[i] === ')') depth--;
                        i++;
                    }
                    while (i < content.length) {
                        if (content[i] === '{') { i++; break; }
                        if (content[i] === ':') {
                            let j = i + 1;
                            while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
                            if (content[j] === '\n') { i = j + 1; break; }
                        }
                        i++;
                    }
                    if (i >= content.length) throw new Error(`applyEditOp/addLinesToFunction: no body opener for ${op.fnName}`);
                    while (i < content.length && content[i] !== '\n') i++;
                    if (i >= content.length) throw new Error(`applyEditOp/addLinesToFunction: no newline after body opener for ${op.fnName}`);
                    bodyStart = i + 1;
                }
                }
            }
            const tail = content.slice(bodyStart);
            const indentMatch = /^[ \t]+/.exec(tail);
            const indent = indentMatch?.[0] ?? '    ';
            const insert = op.lines.map(line => `${indent}${line}`).join('\n') + '\n';
            return content.slice(0, bodyStart) + insert + content.slice(bodyStart);
        }
        case 'addFunction': {
            const sep = content.endsWith('\n') ? '\n' : '\n\n';
            return content + sep + op.declaration + (op.declaration.endsWith('\n') ? '' : '\n');
        }
        case 'deleteFunction': {
            // Find the function header. Support both `export const X = ... => {`
            // and `function X(...) {` styles. Then walk the braces to the matching
            // close; trim the trailing `;\n` if present (arrow-style decls).
            const headerRe = new RegExp(
                String.raw`(?:export\s+)?(?:const|let|var)\s+${op.fnName}\s*=\s*[^\{]*?\{|(?:export\s+)?(?:async\s+)?function\s+${op.fnName}\b[^\{]*?\{`,
            );
            const m = headerRe.exec(content);
            if (!m) throw new Error(`applyEditOp/deleteFunction: could not find declaration for ${op.fnName}`);
            const start = m.index;
            let depth = 1;
            let i = m.index + m[0].length;
            while (i < content.length && depth > 0) {
                const ch = content[i];
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
                i++;
            }
            if (depth !== 0) throw new Error(`applyEditOp/deleteFunction: unbalanced braces for ${op.fnName}`);
            // Eat trailing `;\n` for arrow-style decls.
            while (content[i] === ';' || content[i] === '\n') i++;
            return content.slice(0, start) + content.slice(i);
        }
        case 'renameFunction': {
            // Word-boundary rename — sufficient for the cascade-scenario use case.
            // Matches inside strings/comments are acceptable: the parser would
            // see them in both baseline and working anyway.
            const re = new RegExp(String.raw`\b${op.fromName}\b`, 'g');
            if (!re.test(content)) {
                throw new Error(`applyEditOp/renameFunction: ${op.fromName} not found in file`);
            }
            return content.replace(re, op.toName);
        }
        case 'createFile': {
            return op.content;
        }
    }
}

/**
 * Run a scenario.
 *
 * **Fixture safety contract:** the source repo at `opts.repoPath` is NEVER
 * mutated. The harness copies the fixture into a fresh tmpdir
 * (`/tmp/cascade-repo-*`) and runs the orchestrator against that copy. All
 * writes — edits, the `.codeatlas` SQLite store, build outputs — live in
 * the tmpdir. `dispose()` removes the tmpdir so the test process leaves no
 * artefacts behind.
 *
 * Pipeline: copy fixture → load store → initialize → save → apply edits
 * on the tmpdir copy → rebuildFile(absPath) with no content arg (so the
 * orchestrator's `if (!content)` post-save cascade fires — L4/L5 inline
 * diff + L3/L2b/L2a/L1 upgrade passes + the api-list rebuild). This is
 * the same code path the live extension takes on a file save.
 *
 * Skipping `store.load()` before save() makes both `save()` and
 * `getFileContent()` silent no-ops (snapshotStore lines 147 / 437).
 * Skipping `content === undefined` on rebuildFile bypasses the upper-
 * layer rebuild (syncOrchestrator line ~1694) and L1/L2a/L2b stay at
 * their init-time state.
 */
/**
 * Issue 391: tmpdirs created inside `runScenario` were orphaned when the
 * `beforeAll` block threw before the result (with `dispose()`) reached
 * the caller. Track every tmpdir we create on a module-level set and
 * register a single `process.on('exit')` sweep so partial-init failures
 * don't accumulate `cascade-*` dirs across CI runs.
 */
const orphanTmpdirs = new Set<string>();
let exitHookRegistered = false;
function registerExitHook(): void {
    if (exitHookRegistered) return;
    exitHookRegistered = true;
    const sweep = () => {
        for (const d of orphanTmpdirs) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
        orphanTmpdirs.clear();
    };
    process.on('exit', sweep);
    process.on('SIGINT', () => { sweep(); process.exit(130); });
    process.on('SIGTERM', () => { sweep(); process.exit(143); });
}

export async function runScenario(opts: ScenarioOptions): Promise<ScenarioResult> {
    resetTreeSitterForTesting();
    setGrammarsDir(path.join(process.cwd(), 'grammars'));
    registerExitHook();

    const codeatlasDir = fs.mkdtempSync(path.join(os.tmpdir(), `cascade-`));
    orphanTmpdirs.add(codeatlasDir);
    const repoCopyDir = fs.mkdtempSync(path.join(os.tmpdir(), `cascade-repo-`));
    orphanTmpdirs.add(repoCopyDir);
    copyDirSync(opts.repoPath, repoCopyDir, { exclude: ['.git', 'node_modules', '.codeatlas'] });

    const store = new SnapshotStore(codeatlasDir);
    // load() initializes the SQLite backing layer. Without it, save() and
    // getFileContent() are no-ops (see snapshotStore lines 147 / 437).
    await store.load();
    const commentStore = new CommentStore([]);
    const sync = new SyncOrchestrator(repoCopyDir, store, commentStore);

    await sync.initialize();
    store.save();

    const appliedEdits: ScenarioResult['appliedEdits'] = [];
    const rebuiltGraphIds: string[] = [];

    for (const edit of opts.edits) {
        const absPath = path.join(repoCopyDir, edit.filePath);
        let oldContent: string;
        let newContent: string;
        if (edit.op.op === 'createFile') {
            // The file doesn't exist yet — skip the disk read and ensure
            // the parent directory exists before writing.
            oldContent = '';
            newContent = edit.op.content;
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
        } else {
            oldContent = fs.readFileSync(absPath, 'utf-8');
            newContent = applyEditOp(oldContent, edit.op);
        }
        // Write to disk so the orchestrator picks the new content via
        // fs.readFileSync inside rebuildFile, which keeps the `!content`
        // branch in syncOrchestrator that runs the upper-layer cascade.
        fs.writeFileSync(absPath, newContent, 'utf-8');
        appliedEdits.push({ filePath: edit.filePath, oldContent, newContent });

        // rebuildFile expects an absolute path — it strips the workspaceRoot
        // prefix internally to derive the repo-relative path. Calling it
        // with a relative path makes statSync throw → silent no-op.
        const result = await sync.rebuildFile(absPath);
        rebuiltGraphIds.push(...result.graphIds);
    }

    store.save();

    const baseline = store.getBaseline();
    const working = store.getWorking();

    const reloadedStores: SnapshotStore[] = [];

    return {
        store,
        sync,
        baseline,
        working,
        rebuiltGraphIds,
        appliedEdits,
        repoCopyDir,
        reloadFromDisk: async () => {
            // Persist current state to SQLite.
            store.save();
            // Build a fresh store backed by the same .codeatlas dir.
            const reloaded = new SnapshotStore(codeatlasDir);
            await reloaded.load();
            reloadedStores.push(reloaded);
            return {
                store: reloaded,
                baseline: reloaded.getBaseline(),
                working: reloaded.getWorking(),
            };
        },
        dispose: () => {
            try { fs.rmSync(codeatlasDir, { recursive: true, force: true }); } catch {}
            try { fs.rmSync(repoCopyDir, { recursive: true, force: true }); } catch {}
            orphanTmpdirs.delete(codeatlasDir);
            orphanTmpdirs.delete(repoCopyDir);
        },
    };
}

/**
 * Initialise a fresh git repo at `dir` and create one commit per entry in
 * `commits`. Each commit's `edits` are applied (via `applyEditOp`) before
 * the commit is made. Returns the resolved commit hashes in order, so a
 * `commitDiffScenarios.test.ts` can drive `buildCommitDiffGraphs` between
 * any two of them.
 *
 * Issue #401. Used by the synthetic-history harness for testing the
 * commit / branch / PR diff paths without needing a real git remote.
 */
export interface GitCommitSpec {
    /** Commit message for `git commit -m`. */
    message: string;
    /** Edits to apply on top of the previous commit's state. */
    edits: ScenarioEdit[];
}
export async function initGitHistory(dir: string, commits: GitCommitSpec[]): Promise<string[]> {
    const cp = await import('child_process');
    const run = (cmd: string, env?: NodeJS.ProcessEnv): string =>
        cp.execSync(cmd, { cwd: dir, stdio: 'pipe', env: env ? { ...process.env, ...env } : process.env })
            .toString().trim();
    run('git init -q -b main');
    // Local-only identity so commits don't depend on system git config.
    run('git config user.email "t3-harness@codeatlas.test"');
    run('git config user.name "T3 Harness"');
    // Make commit hashes deterministic w.r.t. content + index by pinning
    // author / committer dates per commit.
    const hashes: string[] = [];
    let idx = 0;
    for (const spec of commits) {
        for (const edit of spec.edits) {
            const abs = path.join(dir, edit.filePath);
            if (edit.op.op === 'createFile') {
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                fs.writeFileSync(abs, edit.op.content, 'utf-8');
            } else {
                const oldContent = fs.readFileSync(abs, 'utf-8');
                fs.writeFileSync(abs, applyEditOp(oldContent, edit.op), 'utf-8');
            }
        }
        run('git add -A');
        const epoch = String(1700000000 + idx * 60);
        // --allow-empty for the first commit if it had no edits.
        const escaped = spec.message.replace(/"/g, '\\"');
        run(`git commit --allow-empty -q -m "${escaped}"`, {
            GIT_AUTHOR_DATE: epoch,
            GIT_COMMITTER_DATE: epoch,
        });
        hashes.push(run('git rev-parse HEAD'));
        idx++;
    }
    return hashes;
}

export function copyDirSync(src: string, dest: string, opts?: { exclude?: string[] }): void {
    const excluded = new Set(opts?.exclude ?? []);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (excluded.has(entry.name)) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(s, d, opts);
        } else if (entry.isFile()) {
            fs.copyFileSync(s, d);
        }
    }
}

// ─── Snapshot-query helpers ─────────────────────────────────────────────────

/** Function-node labels whose diff is not 'unchanged' inside a single file: graph. */
export function modifiedFunctionLabels(fileGraph: DiagramGraph | undefined): string[] {
    if (!fileGraph) return [];
    return fileGraph.nodes
        .filter(n => n.type === 'function' && n.diff && n.diff !== 'unchanged')
        .map(n => (n.label as string) ?? '')
        .sort();
}

/** Cluster-node labels whose diff is not 'unchanged' inside the L2a graph. */
export function modifiedClusterLabels(featureGraph: DiagramGraph | undefined): string[] {
    if (!featureGraph) return [];
    return featureGraph.nodes
        .filter(n => n.diff && n.diff !== 'unchanged')
        .map(n => (n.label as string) ?? '')
        .sort();
}

/**
 * Real-service-node labels whose diff is not 'unchanged' inside the L1
 * graph. Excludes (a) Worker bundle nodes (`meta.worker === true`) — the
 * "Workers · <service>" sibling that's modified-by-construction whenever
 * its owning service has a modified job/consumer (CLAUDE.md L1 section);
 * (b) infra nodes (`type === 'infra'`) — databases, queues, brokers —
 * which carry their own diff signal independent of code edits.
 *
 * Counting only real services gives the test "exactly one service
 * modified per single-file edit" the precise semantics it always meant:
 * exactly one application service has changed, ignoring derived nodes
 * the cascade legitimately fans out to.
 */
export function modifiedServiceLabels(microGraph: DiagramGraph | undefined): string[] {
    if (!microGraph) return [];
    return microGraph.nodes
        .filter(n => n.diff && n.diff !== 'unchanged')
        .filter(n => (n as any).type !== 'infra')
        .filter(n => (n as any).meta?.worker !== true)
        .map(n => (n.label as string) ?? '')
        .sort();
}

/** Modified APIs in an L2b api-list graph: returned as "METHOD route" strings. */
export function modifiedApiListEntries(apiListGraph: DiagramGraph | undefined): string[] {
    if (!apiListGraph) return [];
    const apis = ((apiListGraph as any).meta?.apis ?? []) as Array<any>;
    return apis
        .filter(a => a.diff && a.diff !== 'unchanged')
        .map(a => `${a.method} ${a.route}`)
        .sort();
}

/** Count nodes by diff status inside a graph. */
export function diffCounts(graph: DiagramGraph | undefined): Record<string, number> {
    const out: Record<string, number> = { unchanged: 0, modified: 0, added: 0, deleted: 0 };
    if (!graph) return out;
    for (const n of graph.nodes) out[n.diff ?? 'unchanged'] = (out[n.diff ?? 'unchanged'] ?? 0) + 1;
    return out;
}

/** Predicate: does a snapshot describe a working state that differs from baseline? */
export function workingDiffersByHash(baseline: Snapshot, working: Snapshot): boolean {
    const all = new Set([...Object.keys(baseline.files ?? {}), ...Object.keys(working.files ?? {})]);
    for (const fp of all) {
        if ((baseline.files?.[fp]?.hash ?? '') !== (working.files?.[fp]?.hash ?? '')) return true;
    }
    return false;
}
