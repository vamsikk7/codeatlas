/**
 * mobileDetector.ts — Thin dispatcher over the mobile platform registry.
 *
 * As of Issue #703 (Phase 2), all per-platform detection logic
 * (Android / iOS / React / Flutter) lives in `mobile/<platform>.ts`
 * plugins and is wired through `mobilePlatformRegistry` (see
 * `mobile/index.ts`). This module is the public entry point the rest of
 * the parser uses; it stays small on purpose so platform changes happen
 * in one focused file each.
 *
 * The `detectAndroidManifestItems` helper stays here because it scans
 * AndroidManifest.xml (not source code) and is invoked separately by the
 * orchestrator after the main source-file pass — it isn't part of the
 * per-platform plugin contract.
 */

import type { ApiRecord } from '../graph/graphTypes';
import type { SupportedLanguage } from './treeSitterParser';
import { mobilePlatformRegistry } from './mobile';

// ─── Tier 3: AndroidManifest.xml scanner ─────────────────────────────────────

/**
 * Tier 3 (Issue 366 — In-flight LLM requests not aborted on supersede) — extract DEEP_LINK and WIDGET / BG_SERVICE / CONTENT_PROVIDER
 * entry points from one AndroidManifest.xml file.
 *
 * AndroidManifest.xml is XML (not source code) and isn't picked up by the
 * normal file scanner. The orchestrator calls this separately after the
 * main scan and merges its output into the working apiIndex.
 *
 * Patterns extracted:
 *   - `<intent-filter>` blocks containing `android.intent.action.VIEW`
 *     + `android.intent.category.BROWSABLE` + `<data android:host="…" />` →
 *     `DEEP_LINK` per host (multiple hosts in one filter emit one record each).
 *   - `<receiver android:name="X">` → `WIDGET` (widget receivers) or `BG_TASK`
 *     for non-widget receivers.
 *   - `<service android:name="X">` → `BG_TASK`.
 *   - `<provider android:name="X">` → `CONTENT_PROVIDER`.
 */
export function detectAndroidManifestItems(source: string, filePath: string): ApiRecord[] {
    if (!/AndroidManifest\.xml$/i.test(filePath)) return [];
    const items: ApiRecord[] = [];

    // Deep links: walk every <intent-filter> block and check for VIEW + BROWSABLE.
    const filterPattern = /<intent-filter\b[\s\S]*?<\/intent-filter>/g;
    let m: RegExpExecArray | null;
    while ((m = filterPattern.exec(source)) !== null) {
        const block = m[0];
        if (!/android\.intent\.action\.VIEW/.test(block)) continue;
        if (!/android\.intent\.category\.BROWSABLE/.test(block)) continue;
        // Walk every <data> tag for scheme/host pairs.
        const dataPattern = /<data\b[^>]*\/>/g;
        let dm: RegExpExecArray | null;
        while ((dm = dataPattern.exec(block)) !== null) {
            const data = dm[0];
            const scheme = data.match(/android:scheme\s*=\s*"([^"]+)"/)?.[1];
            const host = data.match(/android:host\s*=\s*"([^"]+)"/)?.[1];
            const pathPrefix = data.match(/android:pathPrefix\s*=\s*"([^"]+)"/)?.[1];
            if (!scheme && !host) continue;
            const route = [scheme && `${scheme}://`, host, pathPrefix].filter(Boolean).join('');
            if (!route) continue;
            const offset = m.index + (dm.index ?? 0);
            items.push({
                apiId: `DEEP_LINK:${route}::${filePath}::deeplink`,
                method: 'DEEP_LINK',
                route,
                handlerName: route,
                filePath,
                anchor: { filePath, span: { start: offset, end: offset + 1 } },
            });
        }
    }

    // Widget receivers — distinguished by presence of an
    // `android.appwidget.action.APPWIDGET_UPDATE` intent-filter inside the receiver.
    const receiverPattern = /<receiver\b[^>]*android:name\s*=\s*"([^"]+)"[\s\S]*?<\/receiver>/g;
    while ((m = receiverPattern.exec(source)) !== null) {
        const receiverName = m[1];
        const isWidget = /android\.appwidget\.action\.APPWIDGET_UPDATE/.test(m[0]);
        const method = isWidget ? 'WIDGET' : 'BG_TASK';
        const route = isWidget ? `widget:${receiverName}` : `receiver:${receiverName}`;
        items.push({
            apiId: `${method}:${route}::${filePath}::${receiverName}`,
            method,
            route,
            handlerName: receiverName,
            filePath,
            anchor: { filePath, span: { start: m.index, end: m.index + 1 } },
        });
    }

    // Self-closing receivers (`<receiver android:name="..." />`) — same logic
    // but no body, so widget detection lives in the surrounding `<application>`
    // declaration. Treat all self-closing receivers as `BG_TASK`.
    const selfClosingReceiver = /<receiver\b[^>]*android:name\s*=\s*"([^"]+)"[^>]*\/>/g;
    while ((m = selfClosingReceiver.exec(source)) !== null) {
        const name = m[1];
        items.push({
            apiId: `BG_TASK:receiver:${name}::${filePath}::${name}`,
            method: 'BG_TASK',
            route: `receiver:${name}`,
            handlerName: name,
            filePath,
            anchor: { filePath, span: { start: m.index, end: m.index + 1 } },
        });
    }

    // Background services — `<service android:name="X">`.
    const servicePattern = /<service\b[^>]*android:name\s*=\s*"([^"]+)"/g;
    while ((m = servicePattern.exec(source)) !== null) {
        const name = m[1];
        items.push({
            apiId: `BG_TASK:service:${name}::${filePath}::${name}`,
            method: 'BG_TASK',
            route: `service:${name}`,
            handlerName: name,
            filePath,
            anchor: { filePath, span: { start: m.index, end: m.index + 1 } },
        });
    }

    // Content providers — `<provider android:name="X">`.
    const providerPattern = /<provider\b[^>]*android:name\s*=\s*"([^"]+)"/g;
    while ((m = providerPattern.exec(source)) !== null) {
        const name = m[1];
        items.push({
            apiId: `CONTENT_PROVIDER:${name}::${filePath}::${name}`,
            method: 'CONTENT_PROVIDER',
            route: `provider:${name}`,
            handlerName: name,
            filePath,
            anchor: { filePath, span: { start: m.index, end: m.index + 1 } },
        });
    }

    return items;
}

// ─── Main detection function ─────────────────────────────────────────────────

/**
 * Detect mobile/UI framework items in source code.
 * Returns ApiRecord[] with synthetic method values: SCREEN, NAV_ROUTE, NETWORK, DI_BINDING.
 *
 * @param source - File source code
 * @param filePath - Workspace-relative file path
 * @param language - Detected language
 * @returns Items for screens, navigation, network calls, and DI bindings
 */
export function detectMobileItems(
    source: string,
    filePath: string,
    language: SupportedLanguage,
): ApiRecord[] {
    const items: ApiRecord[] = [];
    for (const plugin of mobilePlatformRegistry.getForLanguage(language)) {
        items.push(...plugin.detect(source, filePath, language));
    }
    return items;
}
