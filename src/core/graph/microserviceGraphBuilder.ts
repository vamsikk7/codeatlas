/**
 * microserviceGraphBuilder.ts
 *
 * Builds the L1 system design diagram for the workspace.
 *
 * Nodes:
 *   - Service nodes: top-level directories / detected microservices
 *   - Infrastructure nodes: databases, caches, queues (MongoDB, Redis, etc.)
 *
 * Edges:
 *   - Inter-service calls (fetch/axios to sibling services, relative API calls)
 *   - Service → infrastructure connections (mongoose.connect, pg.Pool, etc.)
 *
 * The graph title shows the repo name (basename of workspaceRoot).
 * Clicking a service node zooms into its feature clusters.
 */

import * as path from 'path';
import type {
    DiagramGraph,
    GraphNode,
    GraphEdge,
    Anchor,
    ApiRecord,
    ServiceRecord,
    Snapshot,
    DiffStatus,
    InfrastructureService,
} from './graphTypes';
import { detectServices, diffServices, detectInfrastructureServices, diffInfrastructureServices, detectAllTechnologies, isInternalApiBaseEnv, type ContentProvider } from '../analysis/serviceDetector';
import { bucketServicesByAwsService } from '../analysis/awsServiceBucketing';

let idCounter = 0;
function nextId(prefix = 'node'): string {
    return `${prefix}_${++idCounter}`;
}
function resetIds(): void {
    idCounter = 0;
}

const TECH_ICONS: Record<string, string> = {
    express: 'Express',
    fastify: 'Fastify',
    nestjs: 'NestJS',
    koa: 'Koa',
    django: 'Django',
    flask: 'Flask',
    fastapi: 'FastAPI',
    spring: 'Spring',
    micronaut: 'Micronaut',
    gin: 'Gin',
    echo: 'Echo',
    chi: 'Chi',
    fiber: 'Fiber',
    actix: 'Actix',
    axum: 'Axum',
    rocket: 'Rocket',
    aspnet: 'ASP.NET',
    laravel: 'Laravel',
    symfony: 'Symfony',
    rails: 'Rails',
    sinatra: 'Sinatra',
    vapor: 'Vapor',
    // BUG-EXP-5 — SPA UI-framework labels so a React/Vue/Svelte/Angular frontend
    // renders «React» etc. instead of the generic «Service» fallback.
    nextjs: 'Next.js',
    react: 'React',
    vue: 'Vue',
    svelte: 'Svelte',
    angular: 'Angular',
    unknown: 'Service',
};

const INFRA_KIND_LABELS: Record<InfrastructureService['kind'], string> = {
    database: 'database',
    cache: 'cache',
    queue: 'message queue',
    external: 'external',
    // v2 phase 2 #482 — third-party SDK imported by an FE/mobile service.
    // Displayed as `«sdk»` in the L1 subtitle; per-SDK icon mapping in
    // the renderer keys off `meta.sdkId`.
    sdk: 'sdk',
};

/**
 * Compute the diff status of API endpoints exposed by a service.
 * Drives edge color between a consumer and this service:
 *   - 'deleted'  → routes were removed (consumers will break)
 *   - 'added'    → new routes appeared
 *   - 'modified' → existing route implementations changed (handler file hash differs)
 *   - 'unchanged'→ no API-level change detected
 */
function computeApiEdgeDiff(
    rootPath: string,
    workingApiIndex: Record<string, ApiRecord>,
    baselineApiIndex: Record<string, ApiRecord>,
    workingFiles: Record<string, { hash: string }>,
    baselineFiles: Record<string, { hash: string }>
): DiffStatus {
    const inService = (fp: string): boolean =>
        rootPath === '' || fp.startsWith(rootPath + '/') || fp === rootPath;

    const wApis = Object.values(workingApiIndex).filter(a => inService(a.filePath));
    const bApis = Object.values(baselineApiIndex).filter(a => inService(a.filePath));

    const wKeys = new Set(wApis.map(a => `${a.method}:${a.route}`));
    const bKeys = new Set(bApis.map(a => `${a.method}:${a.route}`));

    // Route deletions break consumers — highest severity
    if (bApis.some(a => !wKeys.has(`${a.method}:${a.route}`))) return 'deleted';
    // New routes added
    if (wApis.some(a => !bKeys.has(`${a.method}:${a.route}`))) return 'added';
    // Handler implementations changed (same routes, different file content)
    const apiFiles = new Set(wApis.map(a => a.filePath));
    for (const fp of apiFiles) {
        if (workingFiles[fp]?.hash !== baselineFiles[fp]?.hash) return 'modified';
    }
    return 'unchanged';
}

/**
 * Build a system design / microservice interaction diagram.
 *
 * @param workspaceRoot - absolute path to the workspace root
 * @param workingSnapshot - current snapshot
 * @param baselineSnapshot - baseline for diff (optional)
 * @param getWorkingContent - lazy fetcher for working-snapshot file content
 *   (FileRecord.content is dropped after save — pass a DB-backed provider
 *   so DB / queue / cache infrastructure is still detected post-save)
 * @param getBaselineContent - lazy fetcher for baseline-snapshot file content
 */
export function buildMicroserviceGraph(
    workspaceRoot: string,
    workingSnapshot: Snapshot,
    baselineSnapshot?: Snapshot,
    getWorkingContent?: ContentProvider,
    getBaselineContent?: ContentProvider,
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};

    const repoName = path.basename(workspaceRoot) || 'workspace';

    // Always re-detect services from the filesystem — never use the snapshot's cached
    // service data, which may be stale (e.g., old single-service detection from state.json).
    const workingServices: Record<string, ServiceRecord> = detectServices(workspaceRoot, workingSnapshot, getWorkingContent);

    // Diff services if baseline provided
    let servicesWithDiff: Record<string, ServiceRecord> = workingServices;
    if (baselineSnapshot) {
        const baselineServices: Record<string, ServiceRecord> = detectServices(workspaceRoot, baselineSnapshot, getBaselineContent);
        servicesWithDiff = diffServices(
            baselineServices,
            workingServices,
            baselineSnapshot.files,
            workingSnapshot.files
        );
    }

    // Detect infrastructure services (databases, caches, queues) and diff them
    const workingInfra = detectInfrastructureServices(workspaceRoot, workingSnapshot, workingServices, getWorkingContent);
    let infraServices = workingInfra;
    if (baselineSnapshot) {
        const baselineServices: Record<string, ServiceRecord> =
            baselineSnapshot.services ?? detectServices(workspaceRoot, baselineSnapshot, getBaselineContent);
        const baselineInfra = detectInfrastructureServices(workspaceRoot, baselineSnapshot, baselineServices, getBaselineContent);
        infraServices = diffInfrastructureServices(
            baselineInfra,
            workingInfra,
            baselineSnapshot,
            workingSnapshot,
            workingServices,
            getBaselineContent,
            getWorkingContent,
        );
    }

    // UX-27 (2026-06-05) — when the workspace has > 50 services
    // (serverless-patterns has 796), render L1 as one node per AWS
    // service-of-interest instead of one node per pattern. Without
    // this the diagram is unreadable and click-through to anything
    // useful is impossible. The bucketing helper is in
    // `src/core/analysis/awsServiceBucketing.ts` and is unit-tested.
    // Issue #790 #8 — lifted threshold from 50 → 300 so 132-sub-repo
    // monorepos like `serverless/examples` render each sub-project as
    // its own L1 service node. Below this cap the layered-grouped
    // MicroserviceView layout (cloud-banded, same as the Knowledge
    // Map) is readable and the user's expectation of "see my services"
    // matches what's shown. The bucket collapse stays for genuine
    // 500+-pattern workspaces where the canvas would otherwise be
    // unusable.
    const AWS_BUCKET_THRESHOLD = 300;
    const serviceCount = Object.keys(servicesWithDiff).length;
    if (serviceCount > AWS_BUCKET_THRESHOLD) {
        try {
            const flat = Object.entries(servicesWithDiff).map(([id, s]) => ({ id, name: s.name }));
            const buckets = bucketServicesByAwsService(flat) as Array<{ awsService: string; label: string; members: Array<{ id: string; name: string }> }>;
            const bucketNodes: GraphNode[] = [];
            const bucketAnchors: Record<string, Anchor> = {};
            for (const b of buckets) {
                if (b.members.length === 0) continue;
                const memberServices = b.members.map((m) => servicesWithDiff[m.id]).filter(Boolean);
                const totalRoutes = memberServices.reduce((acc, s) => acc + (s.exposedApiCount ?? 0), 0);
                const node: GraphNode = {
                    id: nextId('service'),
                    type: 'service',
                    label: b.label,
                    subtitle: `«aws» ${b.members.length} pattern${b.members.length !== 1 ? 's' : ''}${totalRoutes > 0 ? ` · ${totalRoutes} HTTP route${totalRoutes !== 1 ? 's' : ''}` : ''}`,
                    body: '',
                    diff: 'unchanged',
                    serviceId: `aws:${b.awsService}`,
                    anchor: { filePath: '' },
                    meta: {
                        awsBucket: b.awsService,
                        bucketedFrom: b.members.map((m) => m.id),
                        patternCount: b.members.length,
                        exposedApiCount: totalRoutes,
                    },
                };
                bucketNodes.push(node);
                bucketAnchors[node.id] = node.anchor!;
            }
            // Skip the per-service node loop + infra + edges entirely
            // when bucketing — the user just needs a navigable L1 to
            // start drilling. Per-AWS-service drill-down (click → list
            // of patterns) is a follow-up.
            return {
                graphId: 'microservice:workspace',
                type: 'microservice',
                nodes: bucketNodes,
                edges: [],
                anchors: bucketAnchors,
                meta: {
                    bucketed: true,
                    bucketReason: 'aws-services',
                    originalServiceCount: serviceCount,
                    bucketCount: bucketNodes.length,
                    repoName,
                },
            };
        } catch (err: any) {
            // Fall through to the regular per-service build on any
            // bucketing failure — better to render too many cards than none.
            // eslint-disable-next-line no-console
            console.error('[microserviceGraphBuilder] AWS bucketing failed:', err);
        }
    }

    const serviceNodeIds = new Map<string, string>(); // serviceId → nodeId

    // Build service nodes
    for (const [serviceId, service] of Object.entries(servicesWithDiff)) {
        const isDeleted = service.diff === 'deleted';
        const techLabel = TECH_ICONS[service.technology] ?? 'Service';

        // Detect secondary technologies for polyglot services
        const serviceFiles: Record<string, any> = {};
        for (const [fp, rec] of Object.entries(workingSnapshot.files)) {
            if (service.rootPath === '' || fp.startsWith(service.rootPath + '/') || fp === service.rootPath) {
                serviceFiles[fp] = rec;
            }
        }
        const allTechs = detectAllTechnologies(serviceFiles, getWorkingContent);
        // BUG-EXP-5 — don't surface the generic `unknown` (→ «Service») as a
        // secondary tech; it produced noise like «React + Service».
        const secondaryTechs = allTechs.filter(t => t !== service.technology && t !== 'unknown').slice(0, 2);
        const techSuffix = secondaryTechs.length > 0 ? ` + ${secondaryTechs.map(t => TECH_ICONS[t] ?? t).join(', ')}` : '';

        const node: GraphNode = {
            id: nextId('service'),
            type: 'service',
            label: isDeleted ? `${service.name} (deleted)` : service.name,
            // #142 — `exposedApiCount` is the HTTP-route count (per #171:
            // excludes signals / middleware / DI / static-paths / etc.). The
            // homepage shows the total apiIndex including those, so labeling
            // this `N APIs` looked like a discrepancy when the user compared
            // L1 to homepage. Calling it `N HTTP routes` makes the semantic
            // explicit — singletons reasonably keep "route" too.
            //
            // Phase 2 #6 residual (2026-06-07): FE / mobile services don't
            // EXPOSE routes; they CONSUME them. Surface
            // `consumedApiCount` instead so the label reads "N API calls"
            // for those categories. Backend label unchanged.
            subtitle: (() => {
                const cat = service.category;
                const isFE = cat === 'frontend' || cat === 'mobile';
                if (isFE) {
                    const c = (service as any).consumedApiCount ?? 0;
                    return c > 0
                        ? `«${techLabel}${techSuffix}» ${c} API call${c !== 1 ? 's' : ''}`
                        : `«${techLabel}${techSuffix}»`;
                }
                return service.exposedApiCount > 0
                    ? `«${techLabel}${techSuffix}» ${service.exposedApiCount} HTTP route${service.exposedApiCount !== 1 ? 's' : ''}`
                    : `«${techLabel}${techSuffix}»`;
            })(),
            body: service.rootPath || '.',
            diff: service.diff ?? 'unchanged',
            serviceId,
            anchor: { filePath: service.rootPath || '' },
            meta: {
                serviceId,
                rootPath: service.rootPath,
                technology: service.technology,
                category: service.category,
                exposedApiCount: service.exposedApiCount,
                consumedApiCount: (service as any).consumedApiCount ?? 0,
                consumedUrls: service.consumedUrls,
                consumedServices: service.consumedServices,
                // Multi-repo grouping (undefined in single-repo / monorepo
                // workspaces). MicroserviceView reads this and lays out
                // nodes grouped by repoId — one card per repo.
                repoId: service.repoId,
            },
        };
        nodes.push(node);
        serviceNodeIds.set(serviceId, node.id);
        anchors[node.id] = node.anchor!;
    }

    // Build inter-service edges from consumedServices relationships
    const edgeSeen = new Set<string>();
    for (const [serviceId, service] of Object.entries(servicesWithDiff)) {
        const sourceNodeId = serviceNodeIds.get(serviceId);
        if (!sourceNodeId) continue;

        for (const targetServiceId of service.consumedServices ?? []) {
            const targetNodeId = serviceNodeIds.get(targetServiceId);
            if (!targetNodeId) continue;

            const edgeKey = `${serviceId}|${targetServiceId}`;
            if (edgeSeen.has(edgeKey)) continue;
            edgeSeen.add(edgeKey);

            const sourceService = servicesWithDiff[serviceId];
            const targetService = servicesWithDiff[targetServiceId];

            let edgeDiff: DiffStatus = 'unchanged';

            // Service added/deleted takes priority (whole boundary changed)
            if (sourceService?.diff === 'added' || targetService?.diff === 'added') {
                edgeDiff = 'added';
            } else if (sourceService?.diff === 'deleted' || targetService?.diff === 'deleted') {
                edgeDiff = 'deleted';
            } else if (baselineSnapshot) {
                // API-level diff: only turn colored when actual API endpoints change
                edgeDiff = computeApiEdgeDiff(
                    targetService?.rootPath ?? '',
                    workingSnapshot.apiIndex,
                    baselineSnapshot.apiIndex,
                    workingSnapshot.files as Record<string, { hash: string }>,
                    baselineSnapshot.files as Record<string, { hash: string }>
                );
            }

            // Count APIs exposed by target so label can be informative
            const targetRootPath = targetService?.rootPath ?? '';
            const inTarget = (fp: string) => targetRootPath === '' || fp.startsWith(targetRootPath + '/') || fp === targetRootPath;
            const targetApiCount = Object.values(workingSnapshot.apiIndex).filter(a => inTarget(a.filePath)).length;
            const edgeLabel = targetApiCount > 0 ? `calls · ${targetApiCount} API${targetApiCount !== 1 ? 's' : ''}` : 'calls';

            edges.push({
                id: nextId('edge'),
                source: sourceNodeId,
                target: targetNodeId,
                label: edgeLabel,
                edgeType: 'inter-service',
                diff: edgeDiff,
            });
        }
    }

    // Add external system nodes for consumed URLs that aren't known services
    const knownServiceIds = new Set(Object.keys(servicesWithDiff));
    const externalNodes = new Map<string, string>(); // urlPattern → nodeId
    const externalDiff = new Map<string, DiffStatus>(); // urlPattern → worst diff

    // Collect baseline external URLs for diff comparison
    const baselineExternalKeys = new Set<string>();
    if (baselineSnapshot) {
        const baselineServices = detectServices(workspaceRoot, baselineSnapshot, getBaselineContent);
        for (const service of Object.values(baselineServices)) {
            for (const url of service.consumedUrls ?? []) {
                if (url === 'relative-api:same-origin') continue;
                // Skip FE-client path captures — same rationale as the
                // working-side loop below.
                if (url.startsWith('path:')) continue;
                // BUG-EXP-4 — internal API-base env vars resolve to the sibling
                // backend (consumedServices), not a phantom external node.
                if (url.startsWith('env:') && isInternalApiBaseEnv(url.slice('env:'.length))) continue;
                let name = url;
                if (url.startsWith('env:')) {
                    name = url.replace('env:', '').toLowerCase().replace(/_url$/, '').replace(/_uri$/, '').replace(/_/g, '-');
                } else {
                    try { name = new URL(url).hostname; } catch { name = url.slice(0, 30); }
                }
                baselineExternalKeys.add(name.toLowerCase());
            }
        }
    }

    for (const [serviceId, service] of Object.entries(servicesWithDiff)) {
        const sourceNodeId = serviceNodeIds.get(serviceId);
        if (!sourceNodeId) continue;

        for (const url of service.consumedUrls ?? []) {
            // Skip relative API marker (handled via consumedServices)
            if (url === 'relative-api:same-origin') continue;
            // v2 phase 2 #483 — `path:/api/foo` entries are FE-client
            // path captures resolved via the post-process route matcher;
            // they don't belong as external L1 nodes.
            if (url.startsWith('path:')) continue;
            // BUG-EXP-4 — internal API-base env vars (VITE_API_URL, API_BASE_URL, …)
            // resolve to the sibling backend service, not a phantom external node.
            if (url.startsWith('env:') && isInternalApiBaseEnv(url.slice('env:'.length))) continue;

            let externalName = url;
            if (url.startsWith('env:')) {
                externalName = url.replace('env:', '').toLowerCase().replace(/_url$/, '').replace(/_uri$/, '').replace(/_/g, '-');
            } else {
                try {
                    const u = new URL(url);
                    externalName = u.hostname;
                } catch {
                    externalName = url.slice(0, 30);
                }
            }

            // v2 follow-up #715 — Skip when the URL hostname EXACTLY
            // matches a workspace service name (case-insensitive).
            // Previously this used substring match on the full URL,
            // so a workspace service named `api` collapsed every
            // `https://api.stripe.com/...` external call into the
            // workspace service — silently dropping the third-party
            // edge. Hostname equality is the right precision: the
            // workspace service can't have a third-party hostname.
            const externalKey = externalName.toLowerCase();
            const matchesService = service.consumedServices?.some((sid) => {
                const svcName = sid.replace('service:', '').toLowerCase();
                return svcName === externalKey;
            });
            if (matchesService) continue;

            // Track diff: new external = added, source service changed = modified
            const srcDiff = servicesWithDiff[serviceId]?.diff ?? 'unchanged';
            let nodeDiff: DiffStatus = 'unchanged';
            if (!baselineExternalKeys.has(externalKey)) {
                nodeDiff = 'added';
            } else if (srcDiff === 'modified' || srcDiff === 'added') {
                nodeDiff = 'modified';
            }

            if (!externalNodes.has(externalKey)) {
                const extNode: GraphNode = {
                    id: nextId('ext'),
                    type: 'service',
                    label: externalName,
                    subtitle: '«external»',
                    diff: nodeDiff,
                    anchor: { filePath: '' },
                    meta: { external: true },
                };
                nodes.push(extNode);
                externalNodes.set(externalKey, extNode.id);
                externalDiff.set(externalKey, nodeDiff);
                anchors[extNode.id] = extNode.anchor!;
            } else {
                // Escalate diff: added > modified > unchanged
                const prev = externalDiff.get(externalKey) ?? 'unchanged';
                if (nodeDiff === 'added' || (nodeDiff === 'modified' && prev === 'unchanged')) {
                    const existingNode = nodes.find(n => n.id === externalNodes.get(externalKey));
                    if (existingNode) existingNode.diff = nodeDiff;
                    externalDiff.set(externalKey, nodeDiff);
                }
            }

            const targetNodeId = externalNodes.get(externalKey)!;
            const edgeKey = `${sourceNodeId}|${targetNodeId}`;
            if (!edgeSeen.has(edgeKey)) {
                edgeSeen.add(edgeKey);
                edges.push({
                    id: nextId('edge'),
                    source: sourceNodeId,
                    target: targetNodeId,
                    label: 'calls',
                    edgeType: 'inter-service',
                    diff: srcDiff === 'added' ? 'added' : srcDiff === 'deleted' ? 'deleted' : srcDiff === 'modified' ? 'modified' : 'unchanged',
                });
            }
        }
    }

    // Add infrastructure nodes (databases, caches, queues) and edges to them
    const infraNodeIds = new Map<string, string>(); // infraId → nodeId

    for (const infra of infraServices) {
        const infraNode: GraphNode = {
            id: nextId('infra'),
            type: 'service',
            label: infra.diff === 'deleted' ? `${infra.name} (removed)` : infra.name,
            // v2 phase 2 #482 — SDK nodes show the function category
            // (`«payments»`, `«auth»`, `«observability»`, ...) under the
            // `sdk` umbrella so the L1 subtitle row reads naturally.
            // Other kinds keep today's literal kind label.
            subtitle: infra.kind === 'sdk' && infra.sdkCategory
                ? `«sdk · ${infra.sdkCategory}»`
                : `«${INFRA_KIND_LABELS[infra.kind]}»`,
            diff: infra.diff ?? 'unchanged',
            anchor: { filePath: '' },
            meta: {
                external: true,
                infra: true,
                kind: infra.kind,
                // Surface the catalog id + category for the renderer's
                // icon mapping (v2 phase 2 #482-PR-C).
                ...(infra.kind === 'sdk' ? { sdkId: infra.sdkId, sdkCategory: infra.sdkCategory } : {}),
            },
        };
        nodes.push(infraNode);
        infraNodeIds.set(infra.id, infraNode.id);
        anchors[infraNode.id] = infraNode.anchor!;
    }

    for (const infra of infraServices) {
        const targetNodeId = infraNodeIds.get(infra.id);
        if (!targetNodeId) continue;

        const infraDiff = infra.diff ?? 'unchanged';
        // v2 phase 2 #482 — SDK consumers carry an `imports` edge label
        // so L1 viewers can distinguish "FE app imports Stripe" from
        // "service stores in Postgres".
        const edgeLabel =
            infra.kind === 'database' ? 'stores' :
            infra.kind === 'cache' ? 'caches' :
            infra.kind === 'queue' ? 'publishes' :
            infra.kind === 'sdk' ? 'imports' : 'uses';

        for (const serviceId of infra.consumedBy) {
            const sourceNodeId = serviceNodeIds.get(serviceId);
            if (!sourceNodeId) continue;

            const serviceDiff = servicesWithDiff[serviceId]?.diff ?? 'unchanged';

            // Edge color = infra's own diff (schema/connection changed).
            // Only propagate service 'added'/'deleted' — NOT 'modified' (any file change
            // in the service should not make the stores/caches/publishes edge turn orange).
            let edgeDiff: DiffStatus = infraDiff;
            if (serviceDiff === 'added') edgeDiff = 'added';
            else if (serviceDiff === 'deleted') edgeDiff = 'deleted';

            const edgeKey = `${sourceNodeId}|${targetNodeId}`;
            if (!edgeSeen.has(edgeKey)) {
                edgeSeen.add(edgeKey);
                edges.push({
                    id: nextId('edge'),
                    source: sourceNodeId,
                    target: targetNodeId,
                    label: edgeLabel,
                    edgeType: 'inter-service',
                    diff: edgeDiff,
                });
            }
        }
    }

    // Tier 1 (Issue 364 — Same TS file parsed up to 5× per save) — Worker nodes for JOB and MQ_CONSUMER records.
    // Each service that owns at least one job or queue consumer gets a
    // sibling Worker node (rendered with `meta.worker: true`) so the system
    // design diagram surfaces the asynchronous side of the architecture
    // alongside HTTP services + databases. Edges are drawn from the
    // service to its workers ("runs"), and from each worker to any broker
    // infra it consumes from ("consumes"). Brokers are matched by route
    // prefix (`kafka:`, `rabbit:`/`amqp:`, `redis:`/`sidekiq:`, `jms:`).
    //
    // Issue 367: workers + their broker edges now carry diff annotations:
    //   • added    — first JOB/MQ_CONSUMER appears in a service that had
    //                none in baseline
    //   • deleted  — last JOB/MQ_CONSUMER removed (worker existed in
    //                baseline, vanished in working)
    //   • modified — job/consumer set changed (added/removed jobs, added/
    //                removed broker subscriptions, changed topic names)
    const matchBroker = (route: string): string | null => {
        if (/(?:^|[/:])kafka:/i.test(route)) return 'kafka';
        if (/(?:^|[/:])(?:rabbit|amqp):/i.test(route)) return 'rabbit';
        if (/(?:^|[/:])(?:redis|sidekiq):/i.test(route)) return 'redis';
        if (/(?:^|[/:])jms:/i.test(route)) return 'jms';
        return null;
    };
    const collectWorkers = (
        snap: Snapshot | undefined,
        services: Record<string, ServiceRecord>,
    ): Map<string, { jobs: ApiRecord[]; consumers: ApiRecord[]; brokers: Set<string>; routeKeys: Set<string> }> => {
        const out = new Map<string, { jobs: ApiRecord[]; consumers: ApiRecord[]; brokers: Set<string>; routeKeys: Set<string> }>();
        if (!snap) return out;
        for (const api of Object.values(snap.apiIndex ?? {})) {
            if (api.method !== 'JOB' && api.method !== 'MQ_CONSUMER') continue;
            for (const [sid, service] of Object.entries(services)) {
                const owns = service.rootPath === '' ||
                    api.filePath.startsWith(service.rootPath + '/') ||
                    api.filePath === service.rootPath;
                if (!owns) continue;
                const bucket = out.get(sid) ?? { jobs: [], consumers: [], brokers: new Set<string>(), routeKeys: new Set<string>() };
                if (api.method === 'JOB') bucket.jobs.push(api);
                else bucket.consumers.push(api);
                const broker = matchBroker(api.route ?? '');
                if (broker) bucket.brokers.add(broker);
                bucket.routeKeys.add(`${api.method}::${api.route}::${api.handlerName}`);
                out.set(sid, bucket);
                break;
            }
        }
        return out;
    };
    const workerByService = collectWorkers(workingSnapshot, servicesWithDiff);
    const baselineServicesForWorkers: Record<string, ServiceRecord> = baselineSnapshot
        ? (baselineSnapshot.services ?? detectServices(workspaceRoot, baselineSnapshot, getBaselineContent))
        : {};
    const baselineWorkerByService = collectWorkers(baselineSnapshot, baselineServicesForWorkers);

    // Walk both working + baseline service ids so we capture deleted workers.
    const allWorkerServiceIds = new Set<string>([
        ...workerByService.keys(),
        ...baselineWorkerByService.keys(),
    ]);
    for (const sid of allWorkerServiceIds) {
        const cur = workerByService.get(sid);
        const base = baselineWorkerByService.get(sid);
        const curTotal = (cur?.jobs.length ?? 0) + (cur?.consumers.length ?? 0);
        const baseTotal = (base?.jobs.length ?? 0) + (base?.consumers.length ?? 0);
        if (curTotal === 0 && baseTotal === 0) continue;

        // Determine worker-level diff
        let workerDiff: DiffStatus = 'unchanged';
        if (curTotal === 0 && baseTotal > 0) workerDiff = 'deleted';
        else if (curTotal > 0 && baseTotal === 0) workerDiff = 'added';
        else if (cur && base) {
            // Compare the route+handler key sets. Any diff = modified.
            if (cur.routeKeys.size !== base.routeKeys.size) workerDiff = 'modified';
            else {
                for (const k of cur.routeKeys) {
                    if (!base.routeKeys.has(k)) { workerDiff = 'modified'; break; }
                }
            }
        }

        // Build the worker node (use working bucket for label; if deleted,
        // fall back to baseline so the user still sees what was there).
        const bucket = cur ?? base!;
        const parts: string[] = [];
        if (bucket.jobs.length > 0) parts.push(`${bucket.jobs.length} job${bucket.jobs.length !== 1 ? 's' : ''}`);
        if (bucket.consumers.length > 0) parts.push(`${bucket.consumers.length} consumer${bucket.consumers.length !== 1 ? 's' : ''}`);
        const serviceName = servicesWithDiff[sid]?.name ?? baselineServicesForWorkers[sid]?.name ?? sid.replace('service:', '');
        const labelSuffix = workerDiff === 'deleted' ? ' (removed)' : '';
        const workerNode: GraphNode = {
            id: nextId('worker'),
            type: 'service',
            label: `Workers · ${serviceName}${labelSuffix}`,
            subtitle: `«worker» ${parts.join(' · ')}`,
            diff: workerDiff,
            anchor: { filePath: servicesWithDiff[sid]?.rootPath ?? baselineServicesForWorkers[sid]?.rootPath ?? '' },
            meta: {
                worker: true,
                serviceId: sid,
                jobCount: bucket.jobs.length,
                consumerCount: bucket.consumers.length,
            },
        };
        nodes.push(workerNode);
        anchors[workerNode.id] = workerNode.anchor!;

        const sourceServiceNodeId = serviceNodeIds.get(sid);
        if (sourceServiceNodeId) {
            const ekey = `${sourceServiceNodeId}|${workerNode.id}`;
            if (!edgeSeen.has(ekey)) {
                edgeSeen.add(ekey);
                edges.push({
                    id: nextId('edge'),
                    source: sourceServiceNodeId,
                    target: workerNode.id,
                    label: 'runs',
                    edgeType: 'inter-service',
                    // Edge inherits worker diff so add/remove of workers
                    // shows on the connecting edge too.
                    diff: workerDiff,
                });
            }
        }

        const consumedBrokers = bucket.brokers;
        const baseBrokers = base?.brokers ?? new Set<string>();
        for (const brokerName of consumedBrokers) {
            const matchedInfra = infraServices.find(i =>
                i.name.toLowerCase().replace(/[^a-z]/g, '').includes(brokerName)
            );
            if (!matchedInfra) continue;
            const targetId = infraNodeIds.get(matchedInfra.id);
            if (!targetId) continue;
            const ekey = `${workerNode.id}|${targetId}`;
            if (edgeSeen.has(ekey)) continue;
            edgeSeen.add(ekey);
            // Edge diff: 'added' if broker is new for this service, 'deleted'
            // if it was in baseline but no longer in working, 'modified' if
            // worker itself is modified, else 'unchanged'.
            let edgeDiff: DiffStatus = 'unchanged';
            if (workerDiff === 'deleted') edgeDiff = 'deleted';
            else if (!baseBrokers.has(brokerName)) edgeDiff = 'added';
            else if (workerDiff === 'modified') edgeDiff = 'modified';
            edges.push({
                id: nextId('edge'),
                source: workerNode.id,
                target: targetId,
                label: 'consumes',
                edgeType: 'inter-service',
                diff: edgeDiff,
            });
        }
    }

    const hasChanges = nodes.some((n) => n.diff && n.diff !== 'unchanged');

    return {
        graphId: 'microservice:workspace',
        type: 'microservice',
        nodes,
        edges,
        anchors,
        meta: {
            repoName,
            serviceCount: Object.keys(servicesWithDiff).length,
            infraCount: infraServices.length,
            workerCount: workerByService.size,
            hasChanges,
        },
    };
}
