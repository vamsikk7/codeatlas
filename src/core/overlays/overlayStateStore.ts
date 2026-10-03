/**
 * overlayStateStore.ts — #826 R2b persistence (2026-06-11).
 *
 * v1 persists overlay toggle rows to
 * `<workspaceRoot>/<storageDir>/overlay-state.json` — additive (no DB
 * schema bump), shared by both transports, and the row shape already
 * carries the optional `layer` field so the v2 per-layer override and a
 * future table migration stay mechanical.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { OverlayStatePersistence } from './overlayRegistry';
import type { OverlayStateRow } from './overlayTypes';

export function createFileOverlayPersistence(
    workspaceRoot: string,
    storageDirName = '.codeatlas',
    log: (msg: string) => void = () => { /* silent */ },
): OverlayStatePersistence {
    const filePath = path.join(workspaceRoot, storageDirName, 'overlay-state.json');
    return {
        loadRows(): OverlayStateRow[] | undefined {
            try {
                if (!fs.existsSync(filePath)) return undefined;
                const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                if (!Array.isArray(parsed)) return undefined;
                return parsed.filter((r) => r && typeof r.overlayId === 'string' && typeof r.enabled === 'boolean');
            } catch (err: any) {
                log(`[overlayState] load failed: ${err?.message ?? err}`);
                return undefined;
            }
        },
        saveRows(rows: OverlayStateRow[]): void {
            try {
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
            } catch (err: any) {
                log(`[overlayState] save failed: ${err?.message ?? err}`);
            }
        },
    };
}
