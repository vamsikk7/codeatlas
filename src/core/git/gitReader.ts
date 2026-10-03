import { execSync, spawnSync } from 'child_process';
import * as path from 'path';

export interface CommitInfo {
    hash: string;
    shortHash: string;
    subject: string;
    relativeDate: string;
    author: string;
}

const SUPPORTED_EXTS = new Set([
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
    '.py', '.pyw', '.java', '.kt', '.kts', '.go', '.rb', '.php',
    '.cs', '.rs', '.swift', '.scala', '.c', '.cpp', '.h', '.hpp',
    // Issue 227: extend to common adjacent file types so commit-diff and
    // git-replay see them. These are not parsed for AST but DO show up in
    // file diagrams and diff annotations.
    '.dart', '.groovy', '.yml', '.yaml', '.proto', '.graphql', '.sql', '.css', '.scss',
]);

function isSupportedFile(filePath: string): boolean {
    return SUPPORTED_EXTS.has(path.extname(filePath).toLowerCase());
}

/**
 * Run a git command, surfacing buffer overflows as a distinct error class
 * (Issue #226). Node's `execSync` throws `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
 * when stdout exceeds `maxBuffer`; we wrap that as a `GitOutputTooLargeError`
 * so callers can distinguish "file too big to read at all" from "git
 * actually failed". 100MB is generous enough that hitting it means a real
 * pathology (e.g. git show on an LFS-pointer-by-mistake commit).
 */
export class GitOutputTooLargeError extends Error {
    constructor(cmd: string) {
        super(`git output exceeded 100MB buffer for command: ${cmd}`);
        this.name = 'GitOutputTooLargeError';
    }
}

function run(cmd: string, cwd: string): string {
    // INVARIANT: avoid execSync's shell. The MCP server consumes the parent's
    // stdin for the JSON-RPC transport which can cascade into EBADF on the
    // child shell's stdio inheritance. spawnSync with shell:false directly
    // execs the binary so there's no `/bin/sh -c` middleman and no stdin
    // inheritance race.
    //
    // Parse the command as the standalone uses straightforward git invocations
    // with no complex shell features. Splits on whitespace, preserving
    // quoted arguments (rare in our call sites but supported defensively).
    const tokens = tokenizeCommand(cmd);
    const bin = tokens[0];
    const args = tokens.slice(1);
    try {
        const result = spawnSync(bin, args, {
            cwd,
            encoding: 'utf-8',
            maxBuffer: 100 * 1024 * 1024,
            // 'pipe' for all three creates fresh pipes — necessary when the
            // host (MCP stdio transport) has put parent FDs into a state that
            // makes 'inherit' / 'ignore' fail with EBADF on Node 20+.
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            input: '',
        });
        if (result.error) {
            // EBADF, ENOENT, etc.
            throw result.error;
        }
        if (result.status !== 0) {
            const err: any = new Error(`Command failed: ${cmd}\n${String(result.stderr ?? '').slice(0, 500)}`);
            err.status = result.status;
            err.stderr = result.stderr;
            throw err;
        }
        return String(result.stdout ?? '');
    } catch (err: any) {
        if (err && typeof err === 'object' && (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(err.message ?? ''))) {
            throw new GitOutputTooLargeError(cmd);
        }
        throw err;
    }
}

/**
 * Tokenize a shell-style command into argv tokens. Supports single and double
 * quotes and backslash escapes — enough to handle the git invocations the
 * codebase issues. Strips the surrounding quotes from quoted tokens.
 */
function tokenizeCommand(cmd: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escape = false;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (escape) { current += ch; escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (!inSingle && ch === '"') { inDouble = !inDouble; continue; }
        if (!inDouble && ch === '\'') { inSingle = !inSingle; continue; }
        if (!inSingle && !inDouble && /\s/.test(ch)) {
            if (current.length > 0) { tokens.push(current); current = ''; }
            continue;
        }
        current += ch;
    }
    if (current.length > 0) tokens.push(current);
    return tokens;
}

/** Validate that a string is a safe git hex ref (SHA hash or short hash). */
function isValidHex(ref: string): boolean {
    return /^[0-9a-fA-F]{4,64}$/.test(ref);
}

/** Issue 168: Validate file paths to prevent command injection in git show/diff.
 * Rejects paths containing shell metacharacters that could be exploited. */
function isValidFilePath(fp: string): boolean {
    // Allow alphanumeric, slashes, dots, hyphens, underscores, spaces, @, +, =, and common path chars
    // Reject: $, `, ;, |, &, <, >, (, ), {, }, !, ?, *, ~, newlines, null bytes
    return /^[a-zA-Z0-9_.\-/@ +=,\[\]]+$/.test(fp) && !fp.includes('\x00');
}

/** Issue 224: Validate that a branch name is safe for use in git commands.
 * Relaxed to allow colons (release:v1.0), @, +, = (common in branch naming). */
function isValidBranchName(name: string): boolean {
    if (!name || name.length > 256) return false;
    // Reject shell metacharacters, control chars, spaces, backticks, $, pipes
    if (/[\s\x00-\x1f\x7f`$|&<>\\!?*"']/.test(name)) return false;
    // Reject git-special sequences
    if (name.includes('..') || name.startsWith('-') || name.endsWith('.lock')) return false;
    return true;
}

export interface BranchInfo {
    name: string;
    isCurrent: boolean;
    isRemote: boolean;
}

/**
 * List local and remote branches.
 */
export function listBranches(workspaceRoot: string): BranchInfo[] {
    try {
        const out = run('git branch -a --no-color', workspaceRoot);
        return out
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .filter(line => !line.includes('HEAD ->'))  // skip "remotes/origin/HEAD -> origin/main"
            .map(line => {
                const isCurrent = line.startsWith('* ');
                const name = line.replace(/^\*\s+/, '').replace(/^remotes\//, '');
                const isRemote = line.includes('remotes/');
                return { name, isCurrent, isRemote };
            });
    } catch {
        return [];
    }
}

/**
 * Resolve a branch name or ref to a full commit hash. Returns null on failure.
 */
export function resolveRef(workspaceRoot: string, ref: string): string | null {
    if (!isValidBranchName(ref) && !isValidHex(ref)) return null;
    try {
        return run(`git rev-parse "${ref}"`, workspaceRoot).trim();
    } catch {
        return null;
    }
}

/**
 * Find the merge-base (common ancestor) of two refs. Returns null on failure.
 */
export function mergeBase(workspaceRoot: string, ref1: string, ref2: string): string | null {
    if ((!isValidBranchName(ref1) && !isValidHex(ref1)) ||
        (!isValidBranchName(ref2) && !isValidHex(ref2))) return null;
    try {
        return run(`git merge-base "${ref1}" "${ref2}"`, workspaceRoot).trim();
    } catch {
        return null;
    }
}

/**
 * List recent commits from the local git repository.
 *
 * Uses NUL (\x00) as the field separator so that commit subjects containing
 * pipe characters do not corrupt the parse result.  The format tokens are:
 *   %H  — full hash
 *   %s  — subject (one-line summary; may contain any printable char except NUL)
 *   %ar — relative date
 *   %an — author name
 */
export function listCommits(workspaceRoot: string, limit = 100, ref?: string): CommitInfo[] {
    try {
        // Use %x00 (NUL) as a field delimiter — safe because git subjects never
        // contain NUL bytes, and the outer record delimiter is a literal newline.
        const refArg = ref && isValidBranchName(ref) ? ` "${ref}"` : '';
        const out = run(`git log --format="%H%x00%s%x00%ar%x00%an" -${limit}${refArg}`, workspaceRoot);
        return out
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                const parts = line.split('\x00');
                const hash = parts[0] ?? '';
                const subject = parts[1] ?? '';
                const relativeDate = parts[2] ?? '';
                const author = parts[3] ?? '';
                return {
                    hash,
                    shortHash: hash.slice(0, 7),
                    subject,
                    relativeDate,
                    author,
                };
            });
    } catch {
        return [];
    }
}

/**
 * Get the list of source files present in a commit tree.
 */
export function getFileListAtCommit(workspaceRoot: string, hash: string): string[] {
    if (!isValidHex(hash)) return [];
    try {
        const out = run(`git ls-tree -r --name-only ${hash}`, workspaceRoot);
        return out
            .split('\n')
            .map(l => l.trim())
            .filter(f => f && isSupportedFile(f));
    } catch {
        return [];
    }
}

/**
 * Get the content of a file at a specific commit. Returns null if not found.
 *
 * The filePath is passed after a literal `--` so that paths beginning with `-`
 * are not misinterpreted as flags, and it is double-quoted to handle spaces.
 * The hash is validated to contain only hex digits and colons so that it
 * cannot be injected as a shell token.
 */
export function getFileContentAtCommit(
    workspaceRoot: string,
    hash: string,
    filePath: string,
): string | null {
    if (!isValidHex(hash)) return null;
    // Issue 168: Validate filePath to prevent command injection
    if (!isValidFilePath(filePath)) return null;
    try {
        // Use the <tree-ish>:<path> form of git-show so git never interprets
        // filePath as a flag.  Wrap filePath in double quotes for the shell.
        return run(`git show "${hash}:${filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, workspaceRoot);
    } catch {
        return null;
    }
}

/**
 * #review-diff — files changed between base and head for a code review (3-dot,
 * merge-base aware). `base`/`head` may be branch names OR commit hashes; both are
 * resolved first. Unlike getChangedFilesBetweenCommits this does NOT filter by
 * extension — the review pipeline does its own source/tier selection, and the
 * off-diff FP filter needs the COMPLETE changed-file set. Returns [] on failure.
 */
/**
 * Paths that must NEVER appear in a review's changed-file set:
 *   • CodeAtlas's OWN state dirs (`.codeatlas`, `.codeatlas-sa`, …) — the daemon
 *     creates them, so a `working` review (which lists untracked files via
 *     `git ls-files --others`) pulled the tool's own `state.db` / lock file into
 *     the diff when the fixture didn't gitignore them. Self-inflicted noise.
 *   • OS / editor droppings (`.DS_Store`, `Thumbs.db`).
 * These are filtered regardless of the repo's `.gitignore`.
 */
export function isReviewNoiseFile(p: string): boolean {
    return /(^|\/)\.codeatlas(-[a-z0-9_-]+)?(\/|$)/i.test(p)
        || /(^|\/)\.DS_Store$/.test(p)
        || /(^|\/)Thumbs\.db$/i.test(p);
}

export function getReviewChangedFiles(workspaceRoot: string, base: string, head: string): string[] {
    const b = resolveRef(workspaceRoot, base);
    const h = resolveRef(workspaceRoot, head);
    if (!b || !h) return [];
    try {
        const out = run(`git diff --name-only ${b}...${h}`, workspaceRoot);
        return out.split('\n').map((l) => l.trim()).filter(Boolean).filter((p) => !isReviewNoiseFile(p));
    } catch {
        return [];
    }
}

/**
 * #review-diff — unified diff TEXT for base...head (3-dot). `base`/`head` may be
 * branch names or hashes. Returns '' on failure. Used to give an LLM the raw diff
 * for a diff/branch/PR review via MCP.
 */
export function getUnifiedDiff(workspaceRoot: string, base: string, head: string): string {
    const b = resolveRef(workspaceRoot, base);
    const h = resolveRef(workspaceRoot, head);
    if (!b || !h) return '';
    try {
        return run(`git diff ${b}...${h}`, workspaceRoot);
    } catch {
        return '';
    }
}

/**
 * #review-diff — the working-tree unified diff vs HEAD (tracked, staged+unstaged).
 * '' on failure. Companion to getWorkingTreeChangedFiles for a "review my current
 * changes" flow that needs `+`/`-` markers.
 */
export function getWorkingTreeDiff(workspaceRoot: string): string {
    try {
        return run('git diff HEAD', workspaceRoot);
    } catch {
        return '';
    }
}

/**
 * #review-diff — files changed in the WORKING TREE vs HEAD: tracked modifications
 * (staged + unstaged) plus untracked-but-not-ignored new files. The set a
 * pre-commit / "review my current changes" flow needs. Returns [] on failure.
 */
export function getWorkingTreeChangedFiles(workspaceRoot: string): string[] {
    const set = new Set<string>();
    try {
        const tracked = run('git diff --name-only HEAD', workspaceRoot);
        for (const l of tracked.split('\n')) { const t = l.trim(); if (t) set.add(t); }
    } catch { /* no HEAD yet / git failure — fall through */ }
    try {
        const untracked = run('git ls-files --others --exclude-standard', workspaceRoot);
        for (const l of untracked.split('\n')) { const t = l.trim(); if (t) set.add(t); }
    } catch { /* ignore */ }
    // Drop CodeAtlas's own state dirs + OS noise so a `working` review never
    // reviews the tool's `state.db`/lock (self-inflicted when a repo doesn't
    // gitignore `.codeatlas*`).
    return [...set].filter((p) => !isReviewNoiseFile(p));
}

/**
 * Get the list of files that changed between two commits.
 */
export function getChangedFilesBetweenCommits(
    workspaceRoot: string,
    base: string,
    head: string,
): string[] {
    if (!isValidHex(base) || !isValidHex(head)) return [];
    try {
        // #228: use 3-dot syntax `base...head` so git compares against the
        // merge-base of base and head when head is a merge commit. 2-dot
        // (`base..head`) would surface content from BOTH parents of a merge
        // as added+deleted phantoms — see Issue #228.
        const out = run(`git diff --name-only ${base}...${head}`, workspaceRoot);
        return out
            .split('\n')
            .map(l => l.trim())
            .filter(f => f && isSupportedFile(f));
    } catch {
        return [];
    }
}
