/**
 * slsResourceExtractor.ts — UX-54c (2026-06-06)
 *
 * Walks a Serverless Framework `serverless.yml` for AWS resource
 * declarations in the `resources.Resources` block (raw CloudFormation
 * embedded inside the SLS template).
 *
 * SLS canonicalises every declared resource down to the same
 * CloudFormation `Type` fields the SAM extractor recognises, so this
 * file is a thin adapter: it locates the right YAML subtree and hands
 * a synthetic Resources block to `parseSamResources`, then reuses
 * the SAM `*.ToInfraServices` helper so the L1 graph treats SAM and
 * SLS resources identically.
 *
 * SLS also supports plugin-driven resources (`resources.extensions`,
 * `resources.Outputs`, etc.) — we focus on `resources.Resources` here
 * since that's what the serverless-patterns corpus uses for AWS
 * services. Plugin-extension shapes are a follow-up.
 */

import * as yaml from 'js-yaml';
import {
    parseSamResources,
    samResourcesToInfraServices,
    type SamResourceHit,
} from './samResourceExtractor';
import type { InfrastructureService } from '../graph/graphTypes';

/**
 * SLS recognises a few aliases; the canonical path for embedded CFN
 * resources is `resources.Resources.<LogicalId>.Type`.
 */
export function isSlsLikely(filePath: string, content?: string): boolean {
    const base = filePath.toLowerCase();
    if (base.endsWith('serverless.yaml') || base.endsWith('serverless.yml')) return true;
    if (typeof content === 'string') {
        // service + functions + provider is the canonical SLS shape.
        return /^\s*service\s*:/m.test(content) && /^\s*provider\s*:/m.test(content);
    }
    return false;
}

/**
 * Parse SLS `resources.Resources` into resource hits. Returns [] when
 * the file isn't valid SLS or has no embedded CFN resources.
 */
export function parseSlsResources(yamlText: string): SamResourceHit[] {
    if (!yamlText || !yamlText.trim()) return [];
    let doc: any;
    try {
        doc = yaml.load(yamlText);
    } catch {
        return [];
    }
    if (!doc || typeof doc !== 'object') return [];
    // SLS keeps embedded CFN under `resources.Resources`. Some templates
    // declare it directly at top level when there are no other SLS
    // configuration blocks — check both.
    const candidates = [
        (doc as any).resources?.Resources,
        (doc as any).Resources,
    ];
    for (const Resources of candidates) {
        if (Resources && typeof Resources === 'object') {
            // Reuse the SAM extractor by handing it a synthetic
            // top-level Resources block. js-yaml will round-trip the
            // shape cleanly.
            const synthetic = yaml.dump({ Resources });
            const hits = parseSamResources(synthetic);
            if (hits.length > 0) return hits;
        }
    }
    return [];
}

/** Convenience: hits → InfrastructureService. */
export function slsResourcesToInfraServices(
    hits: SamResourceHit[],
    hostServiceId: string,
): InfrastructureService[] {
    return samResourcesToInfraServices(hits, hostServiceId);
}
