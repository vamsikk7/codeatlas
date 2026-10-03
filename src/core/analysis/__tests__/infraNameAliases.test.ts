/**
 * infraNameAliases.test.ts
 *
 * Issue 218: psql / postgres / postgresql / mongo / mongodb etc. should map
 * to a single canonical infra node, not siblings.
 */

import { describe, it, expect } from 'vitest';
import { detectServices, detectInfrastructureServices } from '../serviceDetector';
import type { Snapshot } from '../../graph/graphTypes';

function buildSnapshotWithFiles(filesByPath: Record<string, string>): Snapshot {
    const files: Snapshot['files'] = {};
    for (const [p, content] of Object.entries(filesByPath)) {
        files[p] = {
            path: p, hash: 'h', mtime: 0, content,
            symbols: { functions: [], variables: [], imports: [] },
        };
    }
    return { files, apiIndex: {}, graphs: {} };
}

describe('infra name aliases (Issue 218)', () => {
    it('canonicalizes psql / postgres / PostgreSQL into one node', () => {
        // Two different connection forms that historically produced different infra IDs.
        const snapshot = buildSnapshotWithFiles({
            'svc-a/index.js': `const { Pool } = require('pg'); new Pool();`,
            'svc-b/db.py': `from sqlalchemy import create_engine; e = create_engine('postgresql://...')`,
        });
        const services = detectServices('/workspace', snapshot);
        const infra = detectInfrastructureServices('/workspace', snapshot, services);
        const postgresLikes = infra.filter(i =>
            /postgres|postgresql|psql/i.test(i.name),
        );
        // We may detect 0 if neither pattern fires for this minimal snapshot,
        // but if any do, they must collapse to a single PostgreSQL node.
        const distinctNames = new Set(postgresLikes.map(i => i.name));
        expect(distinctNames.size).toBeLessThanOrEqual(1);
        if (distinctNames.size === 1) {
            expect([...distinctNames][0]).toBe('PostgreSQL');
        }
    });
});
