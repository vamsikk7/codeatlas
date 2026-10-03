/**
 * coverageReader.test.ts
 *
 * Tests for LCOV and Istanbul JSON coverage parsing.
 * Product Manager use case: User runs `npm test --coverage`, then
 * runs `CodeAtlas: Load Test Coverage` to see which functions are untested.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadCoverageData } from '../coverageReader';

const TEST_DIR = path.join(__dirname, '__test_coverage_ws__');

beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
    // Recursive cleanup
    try {
        const rm = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            for (const f of fs.readdirSync(dir)) {
                const fp = path.join(dir, f);
                if (fs.statSync(fp).isDirectory()) rm(fp);
                else fs.unlinkSync(fp);
            }
            fs.rmdirSync(dir);
        };
        rm(TEST_DIR);
    } catch { /* ignore */ }
});

// ─── Positive scenarios ──────────────────────────────────────────────────

describe('loadCoverageData — positive', () => {
    it('parses LCOV format from coverage/lcov.info', () => {
        const coverageDir = path.join(TEST_DIR, 'coverage');
        fs.mkdirSync(coverageDir, { recursive: true });
        fs.writeFileSync(path.join(coverageDir, 'lcov.info'), [
            'SF:src/app.ts',
            'FN:1,main',
            'FNDA:5,main',
            'LH:10',
            'LF:12',
            'BRH:3',
            'BRF:4',
            'end_of_record',
        ].join('\n'));

        const report = loadCoverageData(TEST_DIR);
        expect(report).not.toBeNull();
        expect(report!['src/app.ts']).toBeDefined();
        expect(report!['src/app.ts'].lineRate).toBeCloseTo(10 / 12, 2);
        expect(report!['src/app.ts'].branchRate).toBeCloseTo(3 / 4, 2);
        expect(report!['src/app.ts'].functions['main'].hits).toBe(5);
    });

    it('parses multiple files in LCOV', () => {
        const coverageDir = path.join(TEST_DIR, 'coverage');
        fs.mkdirSync(coverageDir, { recursive: true });
        fs.writeFileSync(path.join(coverageDir, 'lcov.info'), [
            'SF:src/a.ts', 'LH:5', 'LF:10', 'end_of_record',
            'SF:src/b.ts', 'LH:8', 'LF:8', 'end_of_record',
        ].join('\n'));

        const report = loadCoverageData(TEST_DIR);
        expect(Object.keys(report!)).toHaveLength(2);
        expect(report!['src/a.ts'].lineRate).toBeCloseTo(0.5);
        expect(report!['src/b.ts'].lineRate).toBeCloseTo(1.0);
    });

    it('parses Istanbul coverage-summary.json', () => {
        const coverageDir = path.join(TEST_DIR, 'coverage');
        fs.mkdirSync(coverageDir, { recursive: true });
        const summary = {
            total: { lines: { total: 100, covered: 80 }, branches: { total: 20, covered: 15 } },
            'src/utils.ts': { lines: { total: 50, covered: 40 }, branches: { total: 10, covered: 8 } },
        };
        fs.writeFileSync(path.join(coverageDir, 'coverage-summary.json'), JSON.stringify(summary));

        const report = loadCoverageData(TEST_DIR);
        expect(report).not.toBeNull();
        expect(report!['src/utils.ts']).toBeDefined();
        expect(report!['src/utils.ts'].lineRate).toBeCloseTo(0.8);
        // 'total' key should be excluded
        expect(report!['total']).toBeUndefined();
    });

    it('strips workspace root prefix from absolute paths in LCOV', () => {
        const coverageDir = path.join(TEST_DIR, 'coverage');
        fs.mkdirSync(coverageDir, { recursive: true });
        fs.writeFileSync(path.join(coverageDir, 'lcov.info'), [
            `SF:${TEST_DIR}/src/app.ts`,
            'LH:5', 'LF:10', 'end_of_record',
        ].join('\n'));

        const report = loadCoverageData(TEST_DIR);
        expect(report!['src/app.ts']).toBeDefined();
    });

    it('prefers LCOV over JSON when both exist', () => {
        const coverageDir = path.join(TEST_DIR, 'coverage');
        fs.mkdirSync(coverageDir, { recursive: true });
        fs.writeFileSync(path.join(coverageDir, 'lcov.info'), 'SF:from-lcov.ts\nLH:1\nLF:1\nend_of_record\n');
        fs.writeFileSync(path.join(coverageDir, 'coverage-summary.json'), JSON.stringify({ 'from-json.ts': { lines: { total: 1, covered: 1 } } }));

        const report = loadCoverageData(TEST_DIR);
        expect(report!['from-lcov.ts']).toBeDefined();
        expect(report!['from-json.ts']).toBeUndefined();
    });
});

// ─── Negative scenarios ──────────────────────────────────────────────────

describe('loadCoverageData — negative', () => {
    it('returns null when no coverage files exist', () => {
        const report = loadCoverageData(TEST_DIR);
        expect(report).toBeNull();
    });

    it('returns null for empty lcov.info', () => {
        const coverageDir = path.join(TEST_DIR, 'coverage');
        fs.mkdirSync(coverageDir, { recursive: true });
        fs.writeFileSync(path.join(coverageDir, 'lcov.info'), '');

        const report = loadCoverageData(TEST_DIR);
        // Empty LCOV parses to empty object (not null — it's still valid)
        expect(report).toBeDefined();
        expect(Object.keys(report!)).toHaveLength(0);
    });

    it('handles malformed LCOV gracefully (no crash)', () => {
        const coverageDir = path.join(TEST_DIR, 'coverage');
        fs.mkdirSync(coverageDir, { recursive: true });
        fs.writeFileSync(path.join(coverageDir, 'lcov.info'), 'THIS IS NOT LCOV FORMAT\nRANDOM TEXT\n');

        const report = loadCoverageData(TEST_DIR);
        expect(report).toBeDefined();
        // No valid records → empty report
        expect(Object.keys(report!)).toHaveLength(0);
    });

    it('handles malformed JSON gracefully', () => {
        const coverageDir = path.join(TEST_DIR, 'coverage');
        fs.mkdirSync(coverageDir, { recursive: true });
        fs.writeFileSync(path.join(coverageDir, 'coverage-summary.json'), '{not valid json}');

        // LCOV doesn't exist, JSON is broken → should return empty or null
        const report = loadCoverageData(TEST_DIR);
        // parseCoverageSummaryJson catches parse error → returns empty object
        expect(report).toBeDefined();
    });

    it('file with 0 lines total → lineRate 0', () => {
        const coverageDir = path.join(TEST_DIR, 'coverage');
        fs.mkdirSync(coverageDir, { recursive: true });
        fs.writeFileSync(path.join(coverageDir, 'lcov.info'), 'SF:empty.ts\nLH:0\nLF:0\nend_of_record\n');

        const report = loadCoverageData(TEST_DIR);
        expect(report!['empty.ts'].lineRate).toBe(0);
    });
});
