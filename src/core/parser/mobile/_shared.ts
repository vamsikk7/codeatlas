/**
 * mobile/_shared.ts — Helpers shared across all four mobile-platform
 * plugins (Android, iOS, React, Flutter). Kept thin on purpose: each
 * helper is small enough to read in one pass and is used by ≥2
 * plugins (test-file detection + ApiRecord factory).
 *
 * Platform-specific gates (`isAndroidFile`, `isIOSFile`, etc.) and
 * platform-specific constants (e.g. `ANDROID_SCREEN_BASES`) deliberately
 * live in their respective plugin files — they're not shared, and
 * inlining them keeps each plugin self-contained for readers + reviewers.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * Test files are excluded from mobile entry-point detection.
 *
 * Matches Jest / Vitest / XCTest / JUnit conventions across all four
 * platforms — the common case is shared so plugins don't reinvent the
 * pattern (and risk drift between platforms).
 */
export function isTestFile(filePath: string): boolean {
    return /(?:__tests__|test\/|tests\/|\.test\.|\.spec\.|src\/test\/)/.test(filePath);
}

/**
 * Build an `ApiRecord` for a detected mobile entry point.
 *
 * Mobile items use synthetic method values (`SCREEN`, `NAV_ROUTE`,
 * `NETWORK`, `DI_BINDING`, `LIFECYCLE`, `PUSH_HANDLER`, `BG_TASK`,
 * `WIDGET`) so they flow through the same diff / cluster / sequence
 * machinery as HTTP routes.
 *
 * The `apiId` shape is stable and dedup-friendly across rebuilds —
 * matches the format the SnapshotStore expects.
 */
export function makeItem(
    method: string,
    route: string,
    handlerName: string,
    filePath: string,
    offset: number,
): ApiRecord {
    const apiId = `${method}:${route}::${filePath}::${handlerName}`;
    const anchor: Anchor = { filePath, symbol: handlerName, span: { start: offset, end: offset + 1 } };
    return { apiId, method, route, handlerName, filePath, anchor };
}
