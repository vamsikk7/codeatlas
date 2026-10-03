/**
 * Issue #790 #6 — VS Code-native file watcher adapter for `WorkspaceWatcher`.
 *
 * `vscode.workspace.createFileSystemWatcher(pattern)` lives inside the editor's
 * central watcher pool (the same one VS Code uses for its own file explorer,
 * search, and source-control views). On a 132-sub-repo serverless/examples
 * monorepo the in-process chokidar paths (v5 / v3 / polling / worker_threads)
 * silently dropped deep-tree events; this factory routes events through the
 * editor surface where deep dispatch is battle-tested.
 *
 * The factory returns a `MinimalWatcher` so it drops into `WorkspaceWatcher`'s
 * existing `watcherFactory` DI seam with zero downstream code changes. The
 * MCP standalone surface continues to use the chokidar dynamic-import default —
 * chokidar works fine in a fresh CLI Node process; the bug is specific to the
 * extension host environment.
 */
import * as vscode from 'vscode';
import type { MinimalWatcher } from './workspaceWatcher';

/**
 * Translate a chokidar-style glob (`**\/.codeatlas/**`) into a RegExp.
 * Just handles the patterns we actually use in the extension's ignore
 * list — not a full glob implementation. Splits on `**\/` and matches
 * the head as "any number of leading segments (including zero)" so
 * `**\/.codeatlas/**` matches `.codeatlas/state.db` (root-level) as
 * well as `aws-node-foo/.codeatlas/state.db` (nested).
 */
function globToRegex(glob: string): RegExp {
    // Escape regex metacharacters except `*`, then expand glob tokens.
    let pat = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // `**\/foo/**` → any depth of preceding segments + `foo` + any depth of trailing.
    pat = pat.replace(/\*\*\//g, '(?:.*/)?'); // `**\/`
    pat = pat.replace(/\/\*\*/g, '(?:/.*)?'); // `/**`
    pat = pat.replace(/\*/g, '[^/]*');         // bare `*` (single segment)
    return new RegExp('^' + pat + '$');
}

/**
 * Build a sync watcher factory bound to the given `RelativePattern` glob.
 * VS Code matches the pattern against changed files and dispatches to the
 * three event listeners we wire up below.
 *
 * The glob is broad on purpose — `**\/*` matches everything inside the
 * workspace root. `WorkspaceWatcher.resolveOwner()` does its own per-repo
 * routing on the emitted paths, and `WorkspaceWatcher.handle()` already
 * drops paths inside `.codeatlas/` / `.git/` via the repo-row check. The
 * extra ignore set the chokidar factory respects (`node_modules`, `dist`,
 * etc.) is also enforced by VS Code's own `files.watcherExclude` setting
 * which honours `.gitignore` by default — so for the common case the
 * editor's exclude pool already filters noise before the event reaches us.
 */
export function vscodeFileSystemWatcherFactory(log?: (msg: string) => void): (workspaceRoot: string, ignore: string[]) => MinimalWatcher {
    return function build(workspaceRoot: string, ignore: string[]): MinimalWatcher {
        const pattern = new vscode.RelativePattern(workspaceRoot, '**/*');
        log?.(`[vscode-fs-watcher] creating with base=${workspaceRoot} pattern=**/* folders=${(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath).join('|')}`);
        const vw = vscode.workspace.createFileSystemWatcher(pattern, /* ignoreCreate */ false, /* ignoreChange */ false, /* ignoreDelete */ false);

        // Issue #790 #6 — `vscode.RelativePattern` only supports include
        // patterns; to honour the chokidar-style `ignore` array we filter
        // every emitted event. Without this, every `.codeatlas/state.db`
        // write triggers a watcher event → rebuild → save → watcher event
        // → rebuild → infinite feedback loop (live-verified on the 132-
        // sub-repo monorepo: every save tripled within a second).
        const ignorePatterns = ignore.map(p => globToRegex(p));
        const isIgnored = (absolutePath: string): boolean => {
            const rel = absolutePath.startsWith(workspaceRoot + '/')
                ? absolutePath.slice(workspaceRoot.length + 1)
                : absolutePath;
            for (const re of ignorePatterns) {
                if (re.test(rel)) return true;
            }
            return false;
        };

        type Listener = (...args: any[]) => void;
        const listeners = new Map<string, Set<Listener>>();
        const emit = (event: string, ...args: any[]): void => {
            const set = listeners.get(event);
            if (!set) return;
            for (const fn of set) {
                try { fn(...args); } catch { /* listener owns its errors */ }
            }
        };

        // Map VS Code's three events to chokidar's three events so the
        // downstream WorkspaceWatcher.handle path is unchanged. Skip
        // ignored paths up-front so they never reach the orchestrator.
        const disposables: vscode.Disposable[] = [
            vw.onDidCreate((uri) => {
                if (isIgnored(uri.fsPath)) return;
                log?.(`[vscode-fs-watcher] add ${uri.fsPath}`);
                emit('add', uri.fsPath);
            }),
            vw.onDidChange((uri) => {
                if (isIgnored(uri.fsPath)) return;
                log?.(`[vscode-fs-watcher] change ${uri.fsPath}`);
                emit('change', uri.fsPath);
            }),
            vw.onDidDelete((uri) => {
                if (isIgnored(uri.fsPath)) return;
                log?.(`[vscode-fs-watcher] unlink ${uri.fsPath}`);
                emit('unlink', uri.fsPath);
            }),
        ];

        const watcher: MinimalWatcher = {
            on(event, listener) {
                let set = listeners.get(event);
                if (!set) { set = new Set(); listeners.set(event, set); }
                set.add(listener);
                return this;
            },
            close() {
                for (const d of disposables) {
                    try { d.dispose(); } catch { /* best-effort */ }
                }
                try { vw.dispose(); } catch { /* best-effort */ }
            },
        };
        return watcher;
    };
}
