/**
 * silentErrorParity.test.ts
 *
 * Browser-mode UX guard: every editor-only `vscode.window.show*Message` in
 * the handler files must be paired with `ctx.notifyBrowser` (or be in a
 * code path browser users can't reach — auth flow, activation-time, modal
 * dialogs that take user input). This test reads the source files and
 * asserts the parity, catching regressions where a future contributor adds
 * a silent error that browser users never see.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HANDLERS_DIR = path.join(process.cwd(), 'src/handlers');

function findSilentSites(filePath: string): Array<{ line: number; text: string }> {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const silent: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/vscode\.window\.show\w+Message/.test(line)) continue;
        // Look in a 5-line window around the show-message for a paired notifyBrowser.
        const windowText = lines.slice(Math.max(0, i - 2), i + 5).join('\n');
        if (/notifyBrowser/.test(windowText)) continue;
        // Modal dialogs that await a user choice can't be replicated in the
        // browser — they're allowed to be editor-only. Recognized by the
        // pattern `await vscode.window.show*Message(...)` followed by `,` and
        // action button labels.
        const next3 = lines.slice(i, i + 3).join('\n');
        if (/^\s*(?:const\s+\w+\s*=\s*)?await\s+vscode\.window\.show/.test(next3) && /,\s*['"]/.test(next3)) continue;
        silent.push({ line: i + 1, text: line.trim().slice(0, 120) });
    }
    return silent;
}

describe('silent-error parity in handlers (Issue 325 family)', () => {
    const handlerFiles = fs.readdirSync(HANDLERS_DIR)
        .filter(f => f.endsWith('Handlers.ts') || f === 'handlerContext.ts')
        .map(f => path.join(HANDLERS_DIR, f));

    for (const handlerFile of handlerFiles) {
        it(`${path.basename(handlerFile)}: every show*Message paired with notifyBrowser`, () => {
            const silent = findSilentSites(handlerFile);
            expect(
                silent,
                `Silent editor-only messages found (browser users would see no feedback):\n` +
                silent.map(s => `  ${path.basename(handlerFile)}:${s.line} → ${s.text}`).join('\n'),
            ).toEqual([]);
        });
    }
});
