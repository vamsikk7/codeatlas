/**
 * fixtureSafety.ts — Issue #390
 *
 * Centralised guard that protects `e2e/real-repos/<fixture>` from being
 * mutated by a buggy scenario harness. Every scenario test file pays a
 * single one-liner to opt in:
 *
 *     import { installFixtureSafetyGuard } from './fixtureSafety';
 *     installFixtureSafetyGuard();
 *
 * The guard hashes every fixture's canonical file at module load and
 * re-hashes them at suite teardown — throws if any drift is detected.
 *
 * Why per-suite rather than truly global: vitest runs each test file in a
 * separate worker with its own process, so a single globalSetup file
 * doesn't see all the suites. Re-installing the guard per file is the
 * pragmatic seam.
 */

import { afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { PRESENT_FIXTURES } from './cascadeFixtures';

let installed = false;

export function installFixtureSafetyGuard(): void {
    if (installed) return;
    installed = true;

    // Hash every present fixture's canonical file at module load. Anything
    // beyond this point that mutates the source has its hash drift; the
    // afterAll throws and fails the suite.
    const sentinels = new Map<string, string>();
    for (const f of PRESENT_FIXTURES) {
        const abs = path.join(f.repoPath, f.canonical.relativePath);
        sentinels.set(abs, createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
    }

    afterAll(() => {
        for (const [abs, expected] of sentinels) {
            const live = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
            if (live !== expected) {
                throw new Error(
                    `Source fixture at ${abs} was mutated during this suite. ` +
                    `The harness must run against a tmpdir copy — this is a regression.`,
                );
            }
        }
    });
}
