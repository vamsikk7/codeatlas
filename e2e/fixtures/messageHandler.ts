/**
 * messageHandler.ts
 *
 * Mock message handler that simulates the extension host for E2E tests.
 * Routes browser messages and responds with appropriate test data.
 */

import type { WsBridge } from '../../src/server/wsBridge';
import * as testData from './testData';

function sendNavigateTo(
    bridge: WsBridge,
    clientId: string,
    graphId: string,
    mode: string,
    graph: any,
    label: string,
) {
    bridge.sendTo(clientId, { type: 'navigateTo', graphId, mode, graph, label });
}

function handleRequestRoute(bridge: WsBridge, clientId: string, msg: any) {
    switch (msg.route) {
        case 'system-design':
            // #835 — `#/system-design/skeletal-multi` simulates a large
            // multi-repo workspace: bucketed skeletal L1 + a workspaceInfo
            // whose serviceCount (209) the header must caption.
            if (msg.param === 'skeletal-multi') {
                bridge.sendTo(clientId, testData.workspaceInfo({ serviceCount: 209, isMultiRepo: true }));
                sendNavigateTo(bridge, clientId, 'microservice:workspace', 'microservice',
                    testData.skeletalBucketedL1(), 'System Design');
                // The `ready` handshake races this branch and re-broadcasts
                // the default workspaceInfo (serviceCount 2) — re-send the
                // override after it settles, like the prSelected flow does.
                setTimeout(() => {
                    bridge.sendTo(clientId, testData.workspaceInfo({ serviceCount: 209, isMultiRepo: true }));
                }, 250);
                break;
            }
            sendNavigateTo(bridge, clientId, 'microservice:workspace', 'microservice',
                testData.microserviceGraph(), 'System Design: test-project');
            break;
        case 'features':
            sendNavigateTo(bridge, clientId,
                msg.param ? `feature:${msg.param}` : 'feature:workspace',
                'feature', testData.featureGraph(),
                msg.param ? `Features: ${msg.param}` : 'Feature Areas');
            break;
        case 'apis':
            sendNavigateTo(bridge, clientId, `api-list:${msg.param || 'cluster:auth'}`,
                'api-list', testData.apiListGraph(), `APIs: ${msg.param || 'auth'}`);
            break;
        case 'sequence':
            sendNavigateTo(bridge, clientId, `sequence:${msg.param || 'src/auth/login.ts:loginHandler'}`,
                'sequence', testData.sequenceGraph(), msg.param || 'loginHandler');
            break;
        case 'file':
            sendNavigateTo(bridge, clientId, `file:${msg.param || 'src/auth/login.ts'}`,
                'file', testData.fileGraph(), msg.param?.split('/').pop() || 'login.ts');
            break;
        case 'flow':
            sendNavigateTo(bridge, clientId,
                `flow:${msg.param || 'src/auth/login.ts'}:${msg.param2 || 'loginHandler'}`,
                'flow', testData.flowGraph(), `Flow: ${msg.param2 || 'loginHandler'}`);
            break;
        case 'health':
            sendNavigateTo(bridge, clientId, 'health:report', 'health',
                testData.healthGraph(), 'Health Report');
            break;
        default:
            // Unknown route — send home-compatible data
            break;
    }
}

function handleRunCommand(bridge: WsBridge, clientId: string, command: string) {
    switch (command) {
        case 'codeatlas.search':
            bridge.sendTo(clientId, {
                type: 'showSearchPicker',
                items: testData.searchItems(),
            });
            break;
        case 'codeatlas.showHealthReport':
            sendNavigateTo(bridge, clientId, 'health:report', 'health',
                testData.healthGraph(), 'Health Report');
            break;
        case 'codeatlas.openApiExplorer':
            sendNavigateTo(bridge, clientId, 'api-list:cluster:auth', 'api-list',
                testData.apiListGraph(), 'APIs: auth');
            break;
        case 'codeatlas.openFunctionFlow':
            bridge.sendTo(clientId, {
                type: 'showFunctionPicker',
                functions: [
                    { name: 'loginHandler', filePath: 'src/auth/login.ts' },
                    { name: 'validateToken', filePath: 'src/auth/login.ts' },
                ],
            });
            break;
        case 'codeatlas.resyncEverything':
            bridge.sendTo(clientId, {
                type: 'showNotification',
                level: 'info',
                message: 'Re-sync complete. Baseline updated.',
            });
            break;
        case 'codeatlas.openPrDiff':
            bridge.sendTo(clientId, {
                type: 'showPrPicker',
                owner: 'test-org',
                repo: 'test-project',
                prs: testData.samplePrs(),
            });
            break;
        case 'codeatlas.analyzeImpact':
            bridge.sendTo(clientId, {
                type: 'showFilePicker',
                files: [
                    { path: 'src/auth/login.ts', label: 'login.ts' },
                    { path: 'src/users/service.ts', label: 'service.ts' },
                ],
            });
            break;
        case 'codeatlas.exportArchitectureDocs':
            bridge.sendTo(clientId, {
                type: 'showNotification',
                level: 'info',
                message: 'Architecture docs exported to .codeatlas/architecture.md',
            });
            break;
        case 'codeatlas.timelineReplay':
            bridge.sendTo(clientId, {
                type: 'showCommitRangePicker',
                commits: testData.sampleCommits(),
                branches: testData.sampleBranches(),
                currentBranch: 'main',
                baselineHash: testData.sampleCommits()[3]?.hash,
            });
            break;
        default:
            bridge.sendTo(clientId, {
                type: 'showNotification',
                level: 'info',
                message: `Command executed: ${command}`,
            });
            break;
    }
}

export function createMessageHandler(bridge: WsBridge) {
    let currentTheme: 'dark' | 'light' = 'dark';
    let llmConfig: Record<string, any> = {};

    return (msg: any, clientId: string) => {
        switch (msg.type) {
            case 'ready':
                bridge.sendTo(clientId, testData.workspaceInfo(llmConfig));
                bridge.sendTo(clientId, testData.explorerData());
                break;

            case 'requestExplorerData':
                bridge.sendTo(clientId, testData.explorerData());
                break;

            case 'requestRoute':
                handleRequestRoute(bridge, clientId, msg);
                break;

            case 'toggleTheme':
                currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
                bridge.sendTo(clientId, { type: 'setTheme', theme: currentTheme });
                break;

            case 'setLlmConfig':
                if (msg.provider) llmConfig.llmProvider = msg.provider;
                if (msg.model) llmConfig.llmModel = msg.model;
                if (msg.endpoint !== undefined) llmConfig.llmEndpoint = msg.endpoint;
                bridge.sendTo(clientId, { type: 'showNotification', level: 'info', message: 'LLM configuration saved.' });
                bridge.sendTo(clientId, testData.workspaceInfo(llmConfig));
                break;

            case 'requestGitDiff':
                bridge.sendTo(clientId, {
                    type: 'showCommitPicker',
                    commits: testData.sampleCommits(),
                    mode: 'both',
                });
                break;

            case 'requestBranchDiff':
                bridge.sendTo(clientId, {
                    type: 'showBranchPicker',
                    branches: testData.sampleBranches(),
                });
                break;

            case 'runCommand':
                handleRunCommand(bridge, clientId, msg.command);
                break;

            case 'prSelected': {
                // Simulate PR diff flow: progress → navigateTo + setGitDiffContext
                const prNum = msg.prNumber ?? 142;
                bridge.sendTo(clientId, { type: 'initProgress', phase: 'pr-diff', progress: 0.3, message: `Fetching PR #${prNum} from GitHub...` });
                setTimeout(() => {
                    bridge.sendTo(clientId, { type: 'initProgress', phase: 'pr-diff', progress: 0.7, message: `Building diff graphs for PR #${prNum}...` });
                    setTimeout(() => {
                        sendNavigateTo(bridge, clientId, 'microservice:workspace', 'microservice',
                            testData.microserviceGraph(), 'System Design: test-project');
                        bridge.sendTo(clientId, {
                            type: 'setGitDiffContext',
                            baseHash: 'abc1234567890',
                            headHash: 'def4567890abc',
                            baseLabel: `abc1234 main (PR #${prNum}: fix login)`,
                            headLabel: `def4567 feature/login (PR #${prNum}: fix login)`,
                        });
                    }, 100);
                }, 100);
                break;
            }

            case 'openMicroserviceDiagram':
                sendNavigateTo(bridge, clientId, 'microservice:workspace', 'microservice',
                    testData.microserviceGraph(), 'System Design: test-project');
                break;

            case 'openFeatureDiagram':
            case 'openFeatureForService':
                sendNavigateTo(bridge, clientId, 'feature:workspace', 'feature',
                    testData.featureGraph(), 'Feature Areas');
                break;

            case 'openApiListForCluster':
                sendNavigateTo(bridge, clientId,
                    `api-list:${msg.clusterId || 'cluster:auth'}`, 'api-list',
                    testData.apiListGraph(), `APIs: ${msg.clusterId || 'auth'}`);
                break;

            case 'openSequenceForApi':
                sendNavigateTo(bridge, clientId,
                    'sequence:src/auth/login.ts:loginHandler', 'sequence',
                    testData.sequenceGraph(), 'loginHandler');
                break;

            case 'openFileDiagram':
                sendNavigateTo(bridge, clientId,
                    `file:${msg.filePath || 'src/auth/login.ts'}`, 'file',
                    testData.fileGraph(), msg.filePath?.split('/').pop() || 'login.ts');
                break;

            case 'openFunctionFlow':
                sendNavigateTo(bridge, clientId,
                    `flow:${msg.filePath || 'src/auth/login.ts'}:${msg.functionName || 'loginHandler'}`,
                    'flow', testData.flowGraph(), `Flow: ${msg.functionName || 'loginHandler'}`);
                break;

            case 'clearGitDiff':
                bridge.sendTo(clientId, { type: 'clearGitDiffContext' });
                break;

            case 'panelNavigated':
            case 'nodeClicked':
            case 'edgeClicked':
            case 'navigateHome':
                // No-op — these are informational
                break;

            // Timeline Replay
            case 'startTimelineReplay': {
                const commits = msg.commits ?? [];
                if (commits.length < 2) break;
                // Send first commit + first step synchronously, then pause
                // (avoids setTimeout bleed between tests)
                const base = commits[0];
                const head = commits[1];
                const totalCommits = commits.length - 1;
                const firstGraph = testData.flowGraph();
                bridge.sendTo(clientId, { type: 'timelineReplayCommitStart', index: 0, total: totalCommits, hash: head.hash, subject: head.subject });
                bridge.sendTo(clientId, { type: 'setGitDiffContext', baseHash: base.hash, headHash: head.hash, baseLabel: `${base.shortHash} ${base.subject}`, headLabel: `${head.shortHash} ${head.subject}` });
                bridge.sendTo(clientId, { type: 'timelineReplayStep', step: { commitHash: head.hash, commitSubject: head.subject, commitIndex: 0, totalCommits, graphId: firstGraph.graphId, mode: 'flow', label: 'L5 Flow: test', layer: 'L5 Flow', changedEntity: 'testFn', globalIndex: 0, totalSteps: totalCommits * 5 } });
                bridge.sendTo(clientId, { type: 'navigateTo', graphId: firstGraph.graphId, mode: 'flow', graph: firstGraph, label: 'L5 Flow: test' });
                bridge.sendTo(clientId, { type: 'timelineReplayPaused' });
                break;
            }

            case 'timelineReplayControl': {
                if (msg.action === 'stop') {
                    bridge.sendTo(clientId, { type: 'clearGitDiffContext' });
                    bridge.sendTo(clientId, { type: 'timelineReplayEnd' });
                } else if (msg.action === 'pause' || msg.action === 'next' || msg.action === 'prev') {
                    bridge.sendTo(clientId, { type: 'timelineReplayPaused' });
                } else if (msg.action === 'resume') {
                    bridge.sendTo(clientId, { type: 'timelineReplayResumed' });
                }
                break;
            }

            // Replay from diff badge / HomePage replay actions / working changes
            case 'replayCurrentDiff':
            case 'replayWorkingDiff':
            case 'replayFromFile': {
                // Simulate replay: send initial state synchronously (no timers to avoid test bleed)
                const firstGraph = testData.flowGraph();
                bridge.sendTo(clientId, { type: 'setGitDiffContext', baseHash: 'base000', headHash: 'head111', baseLabel: 'Baseline', headLabel: 'Working' });
                bridge.sendTo(clientId, { type: 'timelineReplayCommitStart', index: 0, total: 1, hash: 'head111', subject: 'Working changes' });
                bridge.sendTo(clientId, { type: 'timelineReplayStep', step: { commitHash: 'head111', commitSubject: 'Working changes', commitIndex: 0, totalCommits: 1, graphId: firstGraph.graphId, mode: 'flow', label: 'L5 Flow: test', layer: 'L5 Flow', changedEntity: 'testFn', globalIndex: 0, totalSteps: 5 } });
                bridge.sendTo(clientId, { type: 'navigateTo', graphId: firstGraph.graphId, mode: 'flow', graph: firstGraph, label: 'L5 Flow: test' });
                // Start paused so controls are immediately visible and stable
                bridge.sendTo(clientId, { type: 'timelineReplayPaused' });
                break;
            }
            // Replay PR/Branch: trigger normal picker flow, then auto-replay after diff
            case 'requestPrDiffReplay': {
                bridge.sendTo(clientId, {
                    type: 'showPrPicker',
                    owner: 'test-org',
                    repo: 'test-project',
                    prs: testData.samplePrs(),
                });
                break;
            }
            case 'requestBranchDiffReplay': {
                bridge.sendTo(clientId, {
                    type: 'showBranchPicker',
                    branches: testData.sampleBranches(),
                });
                break;
            }

            // Comments
            case 'addComment': {
                // Send updated graph with commentCount on the commented node
                const commentGraph = testData.fileGraph();
                // Set commentCount on the target node — try all matching strategies
                for (const node of commentGraph.nodes) {
                    const idMatch = node.id === msg.targetId;
                    const anchorMatch = msg.anchor?.symbol && node.anchor?.symbol === msg.anchor.symbol;
                    if (idMatch || anchorMatch) {
                        if (!node.meta) node.meta = {};
                        (node.meta as any).commentCount = 1;
                    }
                }
                // Fallback: if nothing matched, mark loginHandler (most prominent node)
                const loginNode = commentGraph.nodes.find((n: any) => n.id === 'fn:loginHandler');
                if (loginNode && !(loginNode.meta as any)?.commentCount) {
                    if (!loginNode.meta) loginNode.meta = {};
                    (loginNode.meta as any).commentCount = 1;
                }
                bridge.sendTo(clientId, { type: 'updateGraph', graphId: commentGraph.graphId, graph: commentGraph });
                setTimeout(() => {
                    bridge.sendTo(clientId, {
                        type: 'showNotification',
                        level: 'info',
                        message: `Comment added: "${msg.body}"`,
                    });
                }, 100);
                break;
            }

            // AI Review mock handler — maintains cached result per client for status mutations
            case 'requestAiReview': {
                bridge.sendTo(clientId, { type: 'aiReviewLoading', loading: true, progress: 'Preparing review...' });
                const reviewResult = testData.aiReviewResult();
                (bridge as any).__aiReviewCache = (bridge as any).__aiReviewCache || {};
                (bridge as any).__aiReviewCache[clientId] = reviewResult;
                setTimeout(() => {
                    bridge.sendTo(clientId, { type: 'aiReviewLoading', loading: false });
                    bridge.sendTo(clientId, { type: 'aiReviewResult', result: reviewResult });
                }, 200);
                break;
            }
            case 'clearAiReview':
                if ((bridge as any).__aiReviewCache) delete (bridge as any).__aiReviewCache[clientId];
                bridge.sendTo(clientId, { type: 'aiReviewCleared' });
                break;
            case 'resolveAiReview':
            case 'ignoreAiReview':
            case 'reopenAiReview': {
                const cachedResult = (bridge as any).__aiReviewCache?.[clientId];
                if (!cachedResult) break;
                const newStatus = msg.type === 'resolveAiReview' ? 'resolved'
                    : msg.type === 'ignoreAiReview' ? 'ignored' : 'open';
                const item = cachedResult.items.find((r: any) => r.id === msg.reviewId);
                if (item) {
                    item.status = newStatus;
                    const gi = cachedResult.byGraph[item.graphId]?.find((r: any) => r.id === msg.reviewId);
                    if (gi) gi.status = newStatus;
                }
                bridge.sendTo(clientId, { type: 'aiReviewResult', result: cachedResult });
                break;
            }

            // ── Code Review GA flow (#531/#606/#608/#613) ──────────────────
            // The fixture mocks the full per-entry orchestrator without
            // hitting a real LLM. State (findings, guidelines, evidence
            // gate, cost-estimate config) lives per-client on the bridge.
            case 'requestReviewCostEstimate': {
                const cfg = (bridge as any).__costEstimate?.[clientId] ?? testData.reviewCostEstimate();
                bridge.sendTo(clientId, { type: 'reviewCostEstimate', ...cfg });
                break;
            }
            case 'requestFullReview': {
                const findings = testData.aiReviewFindings();
                (bridge as any).__aiFindingsCache = (bridge as any).__aiFindingsCache || {};
                (bridge as any).__aiFindingsCache[clientId] = findings;
                const counts = testData.computeFindingCounts(findings);
                const startedAt = Date.now();
                const baselineRef = { kind: 'git', ref: 'abc1234', capturedAt: new Date().toISOString() };
                bridge.sendTo(clientId, { type: 'aiReviewStarted', kind: 'full', scope: msg.scope ?? 'all', startedAt, baselineRef });
                bridge.sendTo(clientId, { type: 'aiReviewLoading', loading: true, progress: `Starting ${msg.mode ?? 'incremental'} review…` });
                // Stream progress + findings per entry so the UI exercises
                // the same event sequence the real orchestrator emits.
                const seenEntries = new Set<string>();
                for (let i = 0; i < findings.length; i++) {
                    const f = findings[i];
                    if (!seenEntries.has(f.entryPointId)) {
                        seenEntries.add(f.entryPointId);
                        bridge.sendTo(clientId, {
                            type: 'aiReviewProgress',
                            message: `Reviewing ${f.entryPointId}`,
                            completed: seenEntries.size,
                            total: 8,
                        });
                    }
                    bridge.sendTo(clientId, { type: 'aiFindingAdded', entryPointId: f.entryPointId, findings: [f] });
                }
                bridge.sendTo(clientId, { type: 'aiReviewLoading', loading: false });
                bridge.sendTo(clientId, {
                    type: 'aiReviewComplete',
                    summary: {
                        totalEntryPoints: 8,
                        reviewed: seenEntries.size,
                        failed: 0,
                        findingsCount: findings.length,
                        projectFindings: 0,
                        durationMs: 250,
                        kind: 'full',
                        mode: msg.mode ?? 'incremental',
                    },
                    counts,
                });
                break;
            }
            case 'requestSpecificReview': {
                const startedAt = Date.now();
                bridge.sendTo(clientId, { type: 'aiReviewStarted', kind: 'specific', startedAt, prompt: String(msg.prompt ?? '').slice(0, 200) });
                bridge.sendTo(clientId, { type: 'aiReviewLoading', loading: true, progress: 'Running specific review…' });
                setTimeout(() => {
                    const findings = (bridge as any).__aiFindingsCache?.[clientId] ?? [];
                    const counts = testData.computeFindingCounts(findings);
                    bridge.sendTo(clientId, { type: 'aiReviewLoading', loading: false });
                    bridge.sendTo(clientId, {
                        type: 'aiReviewComplete',
                        summary: { totalEntryPoints: 0, reviewed: 0, failed: 0, findingsCount: 0, projectFindings: 1, durationMs: 200, kind: 'specific' },
                        counts,
                    });
                }, 50);
                break;
            }
            case 'cancelFullReview':
            case 'cancelAiReview': {
                bridge.sendTo(clientId, { type: 'aiReviewCancelled', reason: 'user' });
                bridge.sendTo(clientId, { type: 'aiReviewLoading', loading: false });
                break;
            }
            case 'requestAiFindings': {
                const findings = (bridge as any).__aiFindingsCache?.[clientId] ?? [];
                const counts = testData.computeFindingCounts(findings);
                bridge.sendTo(clientId, { type: 'aiFindings', items: findings, counts });
                break;
            }
            case 'requestAiFindingsForNode': {
                const findings = (bridge as any).__aiFindingsCache?.[clientId] ?? [];
                const items = findings.filter((f: any) =>
                    f.bindings?.some((b: any) => b.graphId === msg.graphId && b.targetId === msg.nodeId),
                );
                bridge.sendTo(clientId, { type: 'aiFindingsForNode', graphId: msg.graphId, nodeId: msg.nodeId, items });
                break;
            }
            case 'searchAiFindings': {
                const findings = (bridge as any).__aiFindingsCache?.[clientId] ?? [];
                const q = String(msg.query ?? '').toLowerCase();
                const matched = findings.filter((f: any) =>
                    f.title?.toLowerCase().includes(q) || f.body?.toLowerCase().includes(q),
                );
                bridge.sendTo(clientId, { type: 'aiFindingsSearchResult', result: { items: matched, intent: { query: q } } });
                break;
            }
            case 'updateAiFindingStatus': {
                const findings = (bridge as any).__aiFindingsCache?.[clientId] ?? [];
                const f = findings.find((x: any) => x.id === msg.findingId);
                if (f) {
                    const fromStatus = f.status;
                    f.status = msg.status;
                    f.updatedAt = new Date().toISOString();
                    if (!Array.isArray(f.auditTrail)) f.auditTrail = [];
                    // Skip same-status no-ops (matches store semantics).
                    if (fromStatus !== msg.status) {
                        f.auditTrail.push({
                            ts: f.updatedAt,
                            fromStatus,
                            toStatus: msg.status,
                            actor: msg.actor ?? 'test-user',
                            ...(msg.note ? { note: msg.note } : {}),
                        });
                    }
                    bridge.sendTo(clientId, {
                        type: 'aiFindingUpdated',
                        finding: f,
                        counts: testData.computeFindingCounts(findings),
                    });
                }
                break;
            }
            case 'clearFindings': {
                const cache = (bridge as any).__aiFindingsCache?.[clientId] ?? [];
                const removed = cache.length;
                if (!(bridge as any).__aiFindingsCache) (bridge as any).__aiFindingsCache = {};
                (bridge as any).__aiFindingsCache[clientId] = [];
                bridge.sendTo(clientId, { type: 'aiFindingsCleared', count: removed, scope: msg.scope ?? null });
                bridge.sendTo(clientId, { type: 'aiFindings', items: [], counts: testData.computeFindingCounts([]) });
                break;
            }
            case 'requestReviewGuidelines': {
                const stored = (bridge as any).__guidelines?.[clientId] ?? { text: '', hash: '', updatedAt: 0 };
                bridge.sendTo(clientId, { type: 'reviewGuidelines', guidelines: stored });
                break;
            }
            case 'saveReviewGuidelines': {
                const text = String(msg.text ?? '');
                // Simple stable hash for the fixture (matches the
                // 16-char SHA-256 prefix shape the real store emits).
                let h = 0;
                for (let i = 0; i < text.length; i++) {
                    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
                }
                const hash = text ? Math.abs(h).toString(16).padStart(8, '0').slice(0, 16) : '';
                const guidelines = { text, hash, updatedAt: Date.now() };
                if (!(bridge as any).__guidelines) (bridge as any).__guidelines = {};
                (bridge as any).__guidelines[clientId] = guidelines;
                bridge.sendTo(clientId, { type: 'reviewGuidelinesUpdated', guidelines });
                break;
            }
            case 'requestEvidenceGate': {
                const enabled = (bridge as any).__evidenceGate?.[clientId];
                bridge.sendTo(clientId, { type: 'evidenceGate', enabled: enabled !== false });
                break;
            }
            case 'setEvidenceGate': {
                if (!(bridge as any).__evidenceGate) (bridge as any).__evidenceGate = {};
                (bridge as any).__evidenceGate[clientId] = !!msg.enabled;
                bridge.sendTo(clientId, { type: 'evidenceGate', enabled: !!msg.enabled });
                break;
            }

            case 'requestChangeLog':
                bridge.sendTo(clientId, { type: 'changeLogFull', entries: [] });
                break;

            default:
                // Log unhandled messages for debugging
                if (process.env.DEBUG_E2E) {
                    console.log(`[e2e] Unhandled message: ${msg.type}`);
                }
                break;
        }
    };
}
