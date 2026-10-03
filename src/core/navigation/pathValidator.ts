/**
 * pathValidator.ts
 *
 * Shared path validation utility for workspace boundary checks.
 * Used by extension.ts message handlers to prevent path traversal.
 */

import * as path from 'path';
import * as fs from 'fs';

/**
 * Resolve a relative or absolute filePath and verify it stays within the workspace.
 * Issue 235: Uses fs.realpathSync to follow symlinks before boundary check,
 * preventing symlink-based path traversal attacks.
 *
 * @param workspaceRoot - Absolute path to the workspace root directory
 * @param filePath - User-provided file path (relative or absolute)
 * @returns Resolved absolute path within workspace, or null if outside
 */
export function safeResolve(workspaceRoot: string, filePath: string): string | null {
    const resolved = path.resolve(workspaceRoot, filePath);
    // Issue 235: Resolve symlinks to detect symlink escape attacks
    let realPath: string;
    let realRoot: string;
    try {
        // Resolve symlinks when possible; fall back to logical path if not on disk
        try { realRoot = fs.realpathSync(workspaceRoot); } catch { realRoot = workspaceRoot; }
        try { realPath = fs.realpathSync(resolved); } catch { realPath = resolved; }
    } catch {
        return null;
    }
    if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
        return null;
    }
    return realPath;
}
