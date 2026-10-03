import * as path from 'path';
import * as crypto from 'crypto';
import { collectTopLevelEntities } from '../parser/symbolExtractor';
import { detectApis } from '../parser/apiDetector';
import { detectLanguage } from '../parser/treeSitterParser';
import { extractFileSymbolsMultiLang } from '../parser/treeSitterExtractor';
import { detectFrameworkApis } from '../parser/frameworkDetector';
import { isTestPath, isVendoredPath } from '../parser/testPathFilter';
import { buildFileGraph, buildFileGraphFromAnalysis } from '../graph/fileGraphBuilder';
import { buildFlowGraph, buildFlowGraphFromNode } from '../graph/flowGraphBuilder';
import { buildSequenceGraph, buildSequenceGraphFromAnalysis } from '../graph/sequenceGraphBuilder';
import { buildFeatureGraph } from '../graph/featureGraphBuilder';
import { buildMicroserviceGraph } from '../graph/microserviceGraphBuilder';
import { buildCallGraph } from '../graph/callGraphResolver';
import { detectCommunities } from '../analysis/communityDetector';
import { detectServices } from '../analysis/serviceDetector';
import type { Snapshot, FileRecord, ApiRecord } from '../graph/graphTypes';

const JS_TS_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

function isJsOrTs(filePath: string): boolean {
    return JS_TS_EXTS.has(path.extname(filePath).toLowerCase());
}

function hashContent(content: string): string {
    return crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);
}

export interface FileInput {
    relativePath: string;
    content: string;
}

/**
 * Build a complete Snapshot from a list of in-memory file contents.
 * This mirrors SyncOrchestrator.initialize() but takes file content as input
 * instead of reading from disk — used by the git diff feature.
 */
export async function buildSnapshotFromFiles(
    files: FileInput[],
    workspaceRoot: string,
    log: (msg: string) => void = () => {},
): Promise<Snapshot> {
    const snapshot: Snapshot = { files: {}, apiIndex: {}, graphs: {} };

    type NonJsSeqWork = {
        analysis: import('../parser/treeSitterExtractor').FileAnalysis;
        apis: ApiRecord[];
        relPath: string;
    };
    const nonJsSeqWork: NonJsSeqWork[] = [];

    type JsSeqWork = { code: string; relativePath: string; apis: ApiRecord[] };
    const jsSeqWork: JsSeqWork[] = [];

    // Sequence resolver that reads from the in-memory snapshot being built
    const sequenceResolver = (importPath: string, currentFilePath: string) => {
        try {
            let base = importPath;
            if (base.endsWith('.js') || base.endsWith('.ts')) {
                base = base.substring(0, base.lastIndexOf('.'));
            }
            const dir = path.dirname(path.join(workspaceRoot, currentFilePath));
            const exts = ['.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts'];
            for (const ext of exts) {
                const fullPath = path.resolve(dir, base + ext);
                const relPath = fullPath.replace(workspaceRoot + '/', '');
                const f = snapshot.files[relPath];
                if (f && typeof f.content === 'string') {
                    return { code: f.content, filePath: relPath };
                }
            }
        } catch { /* ignore */ }
        return undefined;
    };

    // Phase 1: per-file parsing
    for (const { relativePath, content: code } of files) {
        try {
            const fileRecord: FileRecord = {
                path: relativePath,
                hash: hashContent(code),
                mtime: 0,
                content: code,
                symbols: { functions: [], variables: [], imports: [] },
            };

            if (isJsOrTs(relativePath)) {
                // ── JS/TS: Babel pipeline ────────────────────────────────────
                // BUG-EXP-12 — route-like patterns in test files are scaffolding,
                // not production entry points; skip them so L1/L2a/L2b agree.
                const apis = (isTestPath(relativePath) || isVendoredPath(relativePath)) ? [] : detectApis(code, relativePath);
                for (const api of apis) {
                    snapshot.apiIndex[api.apiId] = api;
                }

                const fileGraph = buildFileGraph(code, relativePath);
                snapshot.graphs[fileGraph.graphId] = fileGraph;

                const analysis = collectTopLevelEntities(code, relativePath);
                for (const entity of analysis.entities) {
                    if (entity.kind === 'function') {
                        fileRecord.symbols.functions.push({
                            name: entity.name,
                            kind: entity.kind,
                            span: { start: entity.node?.start ?? 0, end: entity.node?.end ?? 0 },
                            signature: entity.signature,
                            bodyText: entity.bodyText,
                            stableKey: entity.key,
                        });
                    } else if (entity.kind === 'variable') {
                        fileRecord.symbols.variables.push({
                            name: entity.name,
                            kind: entity.kind,
                            span: { start: entity.node?.start ?? 0, end: entity.node?.end ?? 0 },
                            signature: entity.signature,
                            bodyText: entity.bodyText,
                            stableKey: entity.key,
                        });
                    }
                }
                for (const [local, source] of analysis.importsByLocal.entries()) {
                    fileRecord.symbols.imports.push({
                        source,
                        specifiers: [{ local, imported: local }],
                        span: { start: 0, end: 0 },
                        stableKey: `import:${source}`,
                    });
                }
                snapshot.files[relativePath] = fileRecord;

                for (const fn of analysis.funcs.values()) {
                    if (fn.node) {
                        try {
                            const fnCode = code.slice(fn.node.start, fn.node.end);
                            const flowGraph = buildFlowGraph(fnCode, relativePath, fn.name, undefined, undefined, fn.node.start);
                            snapshot.graphs[flowGraph.graphId] = flowGraph;
                        } catch (err: any) {
                            log(`[SnapshotBuilder] Flow skipped for ${fn.name} in ${relativePath}: ${err?.message ?? err}`);
                        }
                    }
                }

                if (apis.length > 0) {
                    jsSeqWork.push({ code, relativePath, apis });
                }
            } else {
                // ── Non-JS: tree-sitter pipeline ─────────────────────────────
                const filePath = path.join(workspaceRoot, relativePath);
                const language = detectLanguage(filePath);
                if (language) {
                    const analysis = await extractFileSymbolsMultiLang(code, relativePath, language);
                    const apis = (isTestPath(relativePath) || isVendoredPath(relativePath)) ? [] : detectFrameworkApis(code, relativePath, language); // BUG-EXP-12 + TICKET-DETECT-1

                    for (const api of apis) {
                        snapshot.apiIndex[api.apiId] = api;
                    }

                    const fileGraph = buildFileGraphFromAnalysis(analysis, relativePath);
                    snapshot.graphs[fileGraph.graphId] = fileGraph;

                    for (const entity of analysis.entities) {
                        if (entity.kind === 'function' || entity.kind === 'class') {
                            fileRecord.symbols.functions.push({
                                name: entity.name,
                                kind: 'function',
                                span: { start: 0, end: 0 },
                                signature: entity.signature,
                                bodyText: entity.bodyText,
                                stableKey: entity.key,
                                calls: Array.from(entity.calls || []),
                                memberCalls: entity.memberCalls
                                    ? Object.fromEntries([...entity.memberCalls.entries()].map(([k, v]) => [k, Array.from(v)]))
                                    : undefined,
                                localVarTypes: entity.localVarTypes
                                    ? Object.fromEntries(entity.localVarTypes.entries())
                                    : undefined,
                            });
                        } else if (entity.kind === 'variable') {
                            fileRecord.symbols.variables.push({
                                name: entity.name,
                                kind: entity.kind,
                                span: { start: 0, end: 0 },
                                signature: entity.signature,
                                bodyText: entity.bodyText,
                                stableKey: entity.key,
                            });
                        }
                    }
                    for (const [local, source] of analysis.importsByLocal.entries()) {
                        fileRecord.symbols.imports.push({
                            source,
                            specifiers: [{ local, imported: local }],
                            span: { start: 0, end: 0 },
                            stableKey: `import::${source}::${local}`,
                        });
                    }
                    fileRecord.symbols.injectedDeps = analysis.injectedDeps
                        ? Object.fromEntries(analysis.injectedDeps.entries())
                        : undefined;

                    snapshot.files[relativePath] = fileRecord;

                    if (apis.length > 0) {
                        nonJsSeqWork.push({ analysis, apis, relPath: relativePath });
                    }

                    for (const entity of analysis.entities) {
                        if (entity.kind === 'function' && entity.node) {
                            try {
                                const flowGraph = buildFlowGraphFromNode(entity.node, code, relativePath, entity.name);
                                snapshot.graphs[flowGraph.graphId] = flowGraph;
                            } catch (err: any) {
                                log(`[SnapshotBuilder] Flow skipped for ${entity.name} in ${relativePath}: ${err?.message ?? err}`);
                            }
                        }
                    }
                } else {
                    snapshot.files[relativePath] = fileRecord;
                }
            }
        } catch (err: any) {
            log(`[SnapshotBuilder] Skipped ${relativePath}: ${err?.message ?? err}`);
        }
    }

    // Phase 1B: Non-JS sequence graphs (after all files are stored)
    const nonJsResolver = (importPath: string, currentFilePath?: string) => {
        const lastSegment = importPath.includes('/')
            ? importPath.split('/').pop()
            : importPath.split('.').pop();
        if (!lastSegment) return undefined;
        const allFiles = Object.keys(snapshot.files);

        if (importPath.startsWith('.') && currentFilePath) {
            const currentDir = currentFilePath.includes('/')
                ? currentFilePath.substring(0, currentFilePath.lastIndexOf('/'))
                : '';
            for (const f of allFiles) {
                const fDir = f.includes('/') ? f.substring(0, f.lastIndexOf('/')) : '';
                if (fDir !== currentDir) continue;
                const nameWithoutExt = (f.split('/').pop() || f).replace(/\.[^/.]+$/, '');
                if (nameWithoutExt === lastSegment) return { code: '', filePath: f };
            }
        }
        for (const f of allFiles) {
            const nameWithoutExt = (f.split('/').pop() || f).replace(/\.[^/.]+$/, '');
            if (nameWithoutExt === lastSegment) return { code: '', filePath: f };
        }
        return undefined;
    };

    // Phase 1B: JS sequence graphs — built after all files are stored so the
    // sequenceResolver finds peer files (e.g. article.service.ts when processing
    // article.controller.ts). This mirrors the nonJsSeqWork pattern above.
    for (const { code, relativePath, apis } of jsSeqWork) {
        const handlersSeen = new Set<string>();
        for (const api of apis) {
            if (handlersSeen.has(api.handlerName)) continue;
            handlersSeen.add(api.handlerName);
            try {
                const seqGraph = buildSequenceGraph(code, relativePath, undefined, sequenceResolver, undefined, api.handlerName);
                snapshot.graphs[seqGraph.graphId] = seqGraph;
            } catch (err: any) {
                log(`[SnapshotBuilder] Sequence skipped for ${api.handlerName} in ${relativePath}: ${err?.message ?? err}`);
            }
        }
    }

    for (const { analysis, apis, relPath } of nonJsSeqWork) {
        const handlersSeen = new Set<string>();
        for (const api of apis) {
            if (handlersSeen.has(api.handlerName)) continue;
            handlersSeen.add(api.handlerName);
            const seqGraph = buildSequenceGraphFromAnalysis(
                { ...analysis, funcs: analysis.funcs },
                relPath,
                apis,
                api.handlerName,
                undefined,
                undefined,
                nonJsResolver,
                snapshot.files,
            );
            snapshot.graphs[seqGraph.graphId] = seqGraph;
        }
    }

    // Phase 2: call graph, clusters, services, L1/L2 graphs
    try {
        const callGraph = buildCallGraph(snapshot);
        snapshot.callGraph = callGraph.serialize();

        const services = detectServices(workspaceRoot, snapshot);
        snapshot.services = services;

        const clusters = detectCommunities(snapshot, callGraph, services);
        snapshot.clusters = clusters;

        const featureGraph = buildFeatureGraph(snapshot);
        snapshot.graphs[featureGraph.graphId] = featureGraph;

        // Build per-service feature graphs so L1→L2a navigation works in git diff mode
        for (const serviceId of Object.keys(services)) {
            const serviceFeatureGraph = buildFeatureGraph(snapshot, undefined, serviceId);
            snapshot.graphs[serviceFeatureGraph.graphId] = serviceFeatureGraph;
        }

        const msGraph = buildMicroserviceGraph(workspaceRoot, snapshot);
        snapshot.graphs[msGraph.graphId] = msGraph;
    } catch (err: any) {
        log(`[SnapshotBuilder] Phase 2 failed: ${err?.message ?? err}`);
    }

    return snapshot;
}
