/**
 * editorOpener.ts — standalone replacement for `vscode.window.showTextDocument`.
 *
 * Lives outside `src/handlers/` so the test surface is small and the
 * implementation is fully sandboxable. Used by the standalone npm package's
 * `openSource` WS handler so click-to-source still works when there's no
 * VS Code host.
 *
 * Resolution order for the editor to spawn:
 *   1. `CODEATLAS_EDITOR` env var (full command, e.g. `cursor`)
 *   2. `EDITOR` env var (standard Unix convention)
 *   3. fallback chain: `code`, `cursor`, `subl`, `nvim`, `vim`
 *
 * Each candidate is `spawn`-ed detached + unref'd so the standalone server
 * doesn't block on the editor's lifetime. If no candidate succeeds, the file
 * path is returned so callers can copy it to the clipboard / show a toast.
 */

import { spawn } from 'node:child_process';

const FALLBACK_EDITORS = ['code', 'cursor', 'subl', 'nvim', 'vim'] as const;

export interface EditorOpenResult {
    /** True when an editor was spawned; false when none of the candidates ran. */
    spawned: boolean;
    /** The command that was used (or the last attempted command on failure). */
    editor: string;
    /** Path that the caller should surface to the user when `spawned===false`. */
    fallbackPath?: string;
    /** Caller-facing toast text. */
    toast: string;
}

interface OpenOptions {
    /**
     * Optional async spawner override for tests. When provided, this is called
     * INSTEAD of `child_process.spawn`. Should resolve to true if the spawn
     * succeeded (the test can inspect the args), false to simulate "command
     * not found" and force the loop to try the next candidate.
     */
    spawner?: (command: string, args: string[]) => Promise<boolean>;
    /**
     * Env override for tests. Defaults to `process.env`.
     */
    env?: Record<string, string | undefined>;
}

/**
 * Open `filePath` (optionally at `line`) in the user's editor.
 * Honors the resolution order documented at the top of this file.
 */
export async function openInEditor(
    filePath: string,
    line: number | undefined,
    opts: OpenOptions = {},
): Promise<EditorOpenResult> {
    const env = opts.env ?? process.env;
    const spawner = opts.spawner ?? defaultSpawner;

    const candidates: string[] = [];
    if (env.CODEATLAS_EDITOR) candidates.push(env.CODEATLAS_EDITOR);
    if (env.EDITOR && env.EDITOR !== env.CODEATLAS_EDITOR) candidates.push(env.EDITOR);
    for (const cmd of FALLBACK_EDITORS) {
        if (!candidates.includes(cmd)) candidates.push(cmd);
    }

    let lastTried = '';
    for (const cmd of candidates) {
        const args = buildEditorArgs(cmd, filePath, line);
        const ok = await spawner(cmd, args);
        if (ok) {
            return {
                spawned: true,
                editor: cmd,
                toast: `Opened ${shortName(filePath)} in ${cmd}`,
            };
        }
        lastTried = cmd;
    }

    // Nothing worked — return the path so the caller can copy to clipboard +
    // toast. Standalone servers should never throw on an editor-spawn failure;
    // it's an interaction nicety, not a correctness requirement.
    return {
        spawned: false,
        editor: lastTried,
        fallbackPath: line ? `${filePath}:${line}` : filePath,
        toast: `No editor available — path: ${line ? `${filePath}:${line}` : filePath}`,
    };
}

/**
 * Build the argv for a given editor command. Most modern editors share the
 * `--goto <path>:<line>` or `-g <path>:<line>` convention; vim uses
 * `+<line>`. Unknown commands get the path alone, which still works for most
 * GUI editors.
 */
export function buildEditorArgs(command: string, filePath: string, line?: number): string[] {
    // `code` / `cursor` / `subl` all accept `-g <path>:<line>`.
    if (command === 'code' || command === 'cursor' || command === 'subl') {
        return line ? ['-g', `${filePath}:${line}`] : [filePath];
    }
    if (command === 'vim' || command === 'nvim' || command === 'vi') {
        return line ? [`+${line}`, filePath] : [filePath];
    }
    // Unknown editor — just pass the path (works for atom, emacs --no-wait,
    // open(1), etc.). Line-arg conventions vary too much to guess.
    return [filePath];
}

function shortName(p: string): string {
    const idx = p.lastIndexOf('/');
    return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Real-world spawner. Resolves true when the child process spawned, false on
 * ENOENT (command not found in PATH). Other errors are reported as false so
 * the loop tries the next candidate.
 */
async function defaultSpawner(command: string, args: string[]): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        try {
            const child = spawn(command, args, {
                detached: true,
                stdio: 'ignore',
            });
            child.on('error', (err: any) => {
                if (err?.code === 'ENOENT') resolve(false);
                else resolve(false); // any spawn failure → try next candidate
            });
            // If we reach 'spawn' without 'error', the binary launched.
            // unref so the parent can exit independently.
            child.on('spawn', () => {
                try { child.unref(); } catch { /* noop */ }
                resolve(true);
            });
            // Safety net: some Node versions fire neither event on EACCES;
            // resolve after a tick if nothing fired. This is best-effort —
            // callers treat false as "try the next editor".
            setTimeout(() => resolve(false), 100).unref();
        } catch {
            resolve(false);
        }
    });
}
