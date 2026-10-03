import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SnapshotStore } from '../core/storage/snapshotStore';
import { listEntryPoints, getDiffSummary } from './contextPack';

export function registerMcpResources(server: Server, snapshotStore: SnapshotStore) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        return {
            resources: [
                {
                    uri: 'codeatlas://workspace/microservices',
                    name: 'Workspace Microservices',
                    mimeType: 'application/json',
                    description: 'A map of all detected microservices, backend apps, and their interconnectivity.',
                },
                {
                    uri: 'codeatlas://workspace/apis',
                    name: 'Workspace Exposed APIs',
                    mimeType: 'application/json',
                    description: 'A list of all detected REST API routes, webhooks, and controllers.',
                },
                {
                    uri: 'codeatlas://workspace/features',
                    name: 'Workspace Feature Clusters',
                    mimeType: 'application/json',
                    description: 'A list of related file clusters mapping to high-level features.',
                },
                {
                    uri: 'codeatlas://workspace/entrypoints',
                    name: 'Workspace Entry Points (all categories)',
                    mimeType: 'application/json',
                    description: 'Every architectural entry point in the workspace — HTTP routes, background jobs, MQ consumers, CLI commands, mobile screens, navigation routes, DB migrations/seeds, websockets, GraphQL subscriptions, model hooks, etc. Each entry includes its file, cluster, service, auth status, and middleware chain.',
                },
                {
                    uri: 'codeatlas://workspace/diff-summary',
                    name: 'Workspace Diff Summary',
                    mimeType: 'application/json',
                    description: 'What changed since the baseline snapshot — added/deleted/modified entry points, modified clusters, changed file list. Single-call answer to "what is this PR/branch touching?".',
                },
                // ─── AI review resources (#508 — MCP resources for findings + guidelines + summary) ───────────────────────────
                {
                    uri: 'codeatlas://workspace/ai-findings',
                    name: 'AI Review Findings',
                    mimeType: 'application/json',
                    description: 'Full list of AI-review findings on the workspace. Each finding includes layer bindings, severity, category, and an optional file/symbol anchor.',
                },
                {
                    uri: 'codeatlas://workspace/review-guidelines',
                    name: 'Review Guidelines',
                    mimeType: 'application/json',
                    description: 'User-supplied review guidelines injected into every AI review prompt (≤8 KB).',
                },
                {
                    uri: 'codeatlas://workspace/review-summary',
                    name: 'Review Summary',
                    mimeType: 'application/json',
                    description: 'Aggregate review state — counts by layer + severity, last guidelines hash, sample top findings.',
                },
            ],
        };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;
        const snapshot = snapshotStore.getWorking();

        if (uri === 'codeatlas://workspace/microservices') {
            const services = Object.values(snapshot.services || {}).map((srv) => ({
                id: srv.id,
                name: srv.name,
                rootPath: srv.rootPath,
                technology: srv.technology,
                exposedApiCount: srv.exposedApiCount,
                // #232: scrub `env:VAR` placeholders so the MCP surface
                // doesn't leak environment-variable names to AI assistants.
                consumesUrlPatterns: (srv.consumedUrls ?? []).map((u: string) =>
                    typeof u === 'string' ? u.replace(/env:[A-Z_][A-Z0-9_]*/g, 'env:[REDACTED]') : u,
                ),
                consumesServices: srv.consumedServices,
            }));

            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify(services, null, 2),
                    },
                ],
            };
        }

        if (uri === 'codeatlas://workspace/apis') {
            // Fixed: emit the real handlerName (was 'unknown') and surface the
            // session-fix metadata (auth, middlewares, dynamicRange, webhook,
            // error) so an LLM can decide whether the route needs auth handling
            // without a second tool call.
            const apis = Object.values(snapshot.apiIndex || {}).map((api) => ({
                method: api.method,
                route: api.route,
                filePath: api.filePath,
                handlerName: api.handlerName,
                auth: api.meta?.auth,
                middlewares: api.meta?.middlewares,
                error: api.meta?.error,
                webhook: api.meta?.webhook,
                webhookProvider: api.meta?.webhookProvider,
                dynamicRangeCount: api.meta?.dynamicRange?.count,
                diff: api.diff,
            }));

            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify(apis, null, 2),
                    },
                ],
            };
        }

        if (uri === 'codeatlas://workspace/entrypoints') {
            const eps = listEntryPoints(snapshot);
            return {
                contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(eps, null, 2) }],
            };
        }

        if (uri === 'codeatlas://workspace/diff-summary') {
            const summary = getDiffSummary(snapshot, snapshotStore.getBaseline());
            return {
                contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(summary, null, 2) }],
            };
        }

        if (uri === 'codeatlas://workspace/features') {
            const features = Object.values(snapshot.clusters || {}).map((cluster) => ({
                id: cluster.id,
                concept: cluster.label,
                files: cluster.files,
            }));

            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify(features, null, 2),
                    },
                ],
            };
        }

        // ─── AI review resources (#508 — MCP resources for findings + guidelines + summary) ───────────────────────────────────
        if (uri === 'codeatlas://workspace/ai-findings') {
            const findings = snapshotStore.listAiReviewFindings();
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(findings, null, 2) }] };
        }
        if (uri === 'codeatlas://workspace/review-guidelines') {
            const g = snapshotStore.getReviewGuidelines();
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(g, null, 2) }] };
        }
        if (uri === 'codeatlas://workspace/review-summary') {
            const counts = snapshotStore.getAiReviewFindingCounts();
            const guidelines = snapshotStore.getReviewGuidelines();
            const topErrors = snapshotStore.listAiReviewFindings({ severity: 'error', status: 'open' }).slice(0, 5);
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ counts, guidelines: { hash: guidelines.hash, updatedAt: guidelines.updatedAt }, topErrors }, null, 2) }] };
        }

        throw new Error(`Resource not found: ${uri}`);
    });
}
