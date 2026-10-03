/**
 * coverageReader.ts
 *
 * Reads test coverage data from standard output formats (lcov, coverage-summary.json).
 * Returns per-file and per-function coverage percentages.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FileCoverage {
    filePath: string;
    lineRate: number;     // 0.0 – 1.0
    branchRate: number;   // 0.0 – 1.0
    functions: Record<string, { hits: number; lineRate: number }>;
}

export type CoverageReport = Record<string, FileCoverage>;

/**
 * Auto-detect and load coverage data from standard paths.
 * Returns null if no coverage data found.
 */
export function loadCoverageData(workspaceRoot: string): CoverageReport | null {
    // Try lcov.info first
    const lcovPaths = [
        path.join(workspaceRoot, 'coverage', 'lcov.info'),
        path.join(workspaceRoot, '.nyc_output', 'lcov.info'),
        path.join(workspaceRoot, 'lcov.info'),
        path.join(workspaceRoot, 'htmlcov', 'lcov.info'),
    ];

    for (const lcovPath of lcovPaths) {
        try {
            const stat = fs.statSync(lcovPath);
            if (stat.isFile()) {
                const content = fs.readFileSync(lcovPath, 'utf-8');
                return parseLcov(content, workspaceRoot);
            }
        } catch { continue; }
    }

    // Try coverage-summary.json (Istanbul/NYC)
    const jsonPaths = [
        path.join(workspaceRoot, 'coverage', 'coverage-summary.json'),
        path.join(workspaceRoot, '.nyc_output', 'coverage-summary.json'),
    ];

    for (const jsonPath of jsonPaths) {
        try {
            const stat = fs.statSync(jsonPath);
            if (stat.isFile()) {
                const content = fs.readFileSync(jsonPath, 'utf-8');
                return parseCoverageSummaryJson(content, workspaceRoot);
            }
        } catch { continue; }
    }

    return null;
}

/**
 * Parse LCOV format into CoverageReport.
 */
function parseLcov(content: string, workspaceRoot: string): CoverageReport {
    const report: CoverageReport = {};
    let currentFile = '';
    let linesHit = 0;
    let linesTotal = 0;
    let branchesHit = 0;
    let branchesTotal = 0;
    const functions: Record<string, { hits: number; lineRate: number }> = {};

    for (const line of content.split('\n')) {
        if (line.startsWith('SF:')) {
            currentFile = line.slice(3).trim();
            // Make relative to workspace root
            if (currentFile.startsWith(workspaceRoot)) {
                currentFile = currentFile.slice(workspaceRoot.length + 1);
            }
            linesHit = 0;
            linesTotal = 0;
            branchesHit = 0;
            branchesTotal = 0;
        } else if (line.startsWith('FN:')) {
            // FN:lineNumber,functionName
            const parts = line.slice(3).split(',');
            if (parts[1]) functions[parts[1]] = { hits: 0, lineRate: 0 };
        } else if (line.startsWith('FNDA:')) {
            // FNDA:hitCount,functionName
            const parts = line.slice(5).split(',');
            const hits = parseInt(parts[0], 10) || 0;
            const fnName = parts[1] ?? '';
            if (functions[fnName]) functions[fnName].hits = hits;
        } else if (line.startsWith('LH:')) {
            linesHit = parseInt(line.slice(3), 10) || 0;
        } else if (line.startsWith('LF:')) {
            linesTotal = parseInt(line.slice(3), 10) || 0;
        } else if (line.startsWith('BRH:')) {
            branchesHit = parseInt(line.slice(4), 10) || 0;
        } else if (line.startsWith('BRF:')) {
            branchesTotal = parseInt(line.slice(4), 10) || 0;
        } else if (line === 'end_of_record') {
            if (currentFile) {
                report[currentFile] = {
                    filePath: currentFile,
                    lineRate: linesTotal > 0 ? linesHit / linesTotal : 0,
                    branchRate: branchesTotal > 0 ? branchesHit / branchesTotal : 0,
                    functions: { ...functions },
                };
            }
            currentFile = '';
        }
    }

    return report;
}

/**
 * Parse Istanbul coverage-summary.json format.
 */
function parseCoverageSummaryJson(content: string, workspaceRoot: string): CoverageReport {
    const report: CoverageReport = {};
    try {
        const json = JSON.parse(content);
        for (const [filePath, data] of Object.entries(json)) {
            if (filePath === 'total') continue;
            let relPath = filePath;
            if (relPath.startsWith(workspaceRoot)) {
                relPath = relPath.slice(workspaceRoot.length + 1);
            }
            const d = data as any;
            report[relPath] = {
                filePath: relPath,
                lineRate: d.lines?.total > 0 ? (d.lines.covered / d.lines.total) : 0,
                branchRate: d.branches?.total > 0 ? (d.branches.covered / d.branches.total) : 0,
                functions: {},
            };
        }
    } catch { /* ignore parse errors */ }
    return report;
}
