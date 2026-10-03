/**
 * extractionConfidence.ts — #917
 *
 * Turns the snapshot into an honest extraction-confidence signal so the UI can
 * distinguish "this is genuinely a small API surface" from "the tool detected a
 * framework but couldn't extract its routes" (an under-detection gap). Without
 * this, a thin diagram silently reads as "nothing to see" and trust erodes the
 * first time a user spots a route they know exists.
 *
 * Pure function over the snapshot — no I/O — so it's trivially testable and can
 * run on both the extension-host and standalone `workspaceInfo` paths.
 */
import type { Snapshot, ServiceRecord } from '../graph/graphTypes';

/** Service technologies that EXPOSE HTTP routes — a detected one with 0 routes is a gap. */
const HTTP_FRAMEWORKS: ReadonlySet<ServiceRecord['technology']> = new Set([
    'express', 'fastify', 'koa', 'nestjs',
    'django', 'flask', 'fastapi', 'starlette',
    'spring', 'micronaut',
    'gin', 'echo', 'chi', 'fiber',
    'actix', 'axum', 'rocket',
    'aspnet', 'laravel', 'symfony',
    'rails', 'sinatra', 'vapor', 'serverless',
]);

export interface ExtractionGap {
    /** Service display name. */
    service: string;
    /** The detected HTTP framework that yielded 0 routes. */
    technology: string;
}

export interface ExtractionConfidence {
    /** Total entry points (HTTP routes + other detected entry points) in the snapshot. */
    totalEntryPoints: number;
    /** Distinct HTTP frameworks detected across services. */
    frameworkCount: number;
    /** Services where a known HTTP framework was detected but 0 routes were extracted. */
    gaps: ExtractionGap[];
}

export function computeExtractionConfidence(snapshot: Pick<Snapshot, 'apiIndex' | 'services'>): ExtractionConfidence {
    const services = Object.values(snapshot.services ?? {}) as ServiceRecord[];
    const totalEntryPoints = Object.keys(snapshot.apiIndex ?? {}).length;
    const frameworks = new Set<string>();
    const gaps: ExtractionGap[] = [];
    for (const svc of services) {
        if (!HTTP_FRAMEWORKS.has(svc.technology)) continue;
        frameworks.add(svc.technology);
        if ((svc.exposedApiCount ?? 0) === 0) {
            gaps.push({ service: svc.name, technology: svc.technology });
        }
    }
    return { totalEntryPoints, frameworkCount: frameworks.size, gaps };
}

/**
 * Render the per-repo GAP banner text, or null when there's nothing to warn
 * about. Kept here so the extension + standalone + webview share one wording.
 */
export function renderExtractionGapBanner(conf: ExtractionConfidence): string | null {
    if (conf.gaps.length === 0) return null;
    const list = conf.gaps.slice(0, 4).map((g) => `${g.service} (${g.technology})`).join(', ');
    const more = conf.gaps.length > 4 ? ` +${conf.gaps.length - 4} more` : '';
    const n = conf.gaps.length;
    return `Detected ${n === 1 ? 'a known framework' : `${n} services with known frameworks`} but found 0 routes: ${list}${more} — possible detection gap, not necessarily an empty API.`;
}
