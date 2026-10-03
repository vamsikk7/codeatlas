/**
 * manifestDrift.test.ts
 *
 * Guards `expectations.json` against silent drift:
 *  - every entry in `repos.json` must have a matching entry in `expectations.json`
 *  - `expectations.json` must not contain entries for repos no longer in the manifest
 *  - the schema fields must be present on every entry
 *
 * Catches the common mistake of adding a repo to `repos.json` and forgetting
 * to run `npm run verify:real:update` to refresh the baseline.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MANIFEST = path.join(__dirname, 'repos.json');
const EXPECTATIONS = path.join(__dirname, 'expectations.json');

interface RepoSpec { id: string }
interface Manifest { repos: RepoSpec[] }
interface Expectation {
    minFileCount: number;
    minApiCount: number;
    minGraphCount: number;
    minFileGraphs: number;
    minFlowGraphs: number;
    minSequenceGraphs: number;
    minFeatureClusters: number;
    minMicroservices: number;
    minFlowGraphsWithDecision: number;
    minAnonymousResolutionRate: number;
    minRouteApiCount: number;
    minMobileItemCount: number;
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;
const expectations = fs.existsSync(EXPECTATIONS)
    ? JSON.parse(fs.readFileSync(EXPECTATIONS, 'utf8')) as Record<string, Expectation>
    : {};

const REQUIRED_FIELDS: (keyof Expectation)[] = [
    'minFileCount', 'minApiCount', 'minGraphCount', 'minFileGraphs',
    'minFlowGraphs', 'minSequenceGraphs', 'minFeatureClusters',
    'minMicroservices', 'minFlowGraphsWithDecision', 'minAnonymousResolutionRate',
    'minRouteApiCount', 'minMobileItemCount',
];

describe('expectations.json drift guard', () => {
    it('every manifest repo has an expectations entry', () => {
        const missing = manifest.repos
            .map(r => r.id)
            .filter(id => !expectations[id]);
        expect(
            missing,
            `Missing expectations for: ${missing.join(', ')}. Run \`npm run verify:real:update\`.`,
        ).toEqual([]);
    });

    it('every expectations entry maps to a manifest repo', () => {
        const manifestIds = new Set(manifest.repos.map(r => r.id));
        const orphans = Object.keys(expectations).filter(id => !manifestIds.has(id));
        expect(
            orphans,
            `Orphaned expectations entries (no matching manifest): ${orphans.join(', ')}`,
        ).toEqual([]);
    });

    it('every expectations entry has all required schema fields', () => {
        const violations: string[] = [];
        for (const [id, exp] of Object.entries(expectations)) {
            for (const field of REQUIRED_FIELDS) {
                if (typeof exp[field] !== 'number') {
                    violations.push(`${id}.${field} (got ${typeof exp[field]})`);
                }
            }
        }
        expect(
            violations,
            `Schema violations in expectations.json: ${violations.join(', ')}`,
        ).toEqual([]);
    });

    it('all min* values are non-negative', () => {
        const negatives: string[] = [];
        for (const [id, exp] of Object.entries(expectations)) {
            for (const field of REQUIRED_FIELDS) {
                const v = exp[field];
                if (typeof v === 'number' && v < 0) negatives.push(`${id}.${field}=${v}`);
            }
        }
        expect(negatives, `Negative expectation values: ${negatives.join(', ')}`).toEqual([]);
    });
});
