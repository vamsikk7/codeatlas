/**
 * invariants.test.ts
 *
 * Strict per-repo invariants that document what CodeAtlas *should* produce
 * for each real-world repo. Unlike `verify.test.ts` (which asserts ≥-baseline
 * to catch regressions), this suite encodes "thou shalt not produce zero APIs
 * for a NestJS realworld app" style truths.
 *
 * Failures here are diagnostic: each one points to a specific coverage gap
 * tracked as a numbered issue in ISSUES.md (issues 153+).
 *
 * Run with `npm run verify:real:invariants` — passes when CodeAtlas correctly
 * analyzes every repo in repos.json. Failures map to outstanding issues.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runVerifyForRepo, type RepoSpec, type VerifyResult } from './runVerify';
import { isBackendRepo } from './repoCategories';

const cache = new Map<string, Promise<VerifyResult>>();
function verifyCached(repoPath: string, spec: RepoSpec): Promise<VerifyResult> {
    const existing = cache.get(spec.id);
    if (existing) return existing;
    const p = runVerifyForRepo(repoPath, spec);
    cache.set(spec.id, p);
    return p;
}

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_REPOS = path.join(ROOT, 'e2e', 'real-repos');
const MANIFEST = path.join(__dirname, 'repos.json');

interface Manifest { repos: RepoSpec[]; }

const fullManifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;
const FAST_IDS = new Set(['js-express', 'ts-nestjs', 'py-django', 'go-gin', 'rust-axum']);
const manifest: Manifest = process.env.VERIFY_FAST === '1'
    ? { repos: fullManifest.repos.filter(r => FAST_IDS.has(r.id)) }
    : fullManifest;

/**
 * Per-repo invariants. A `false` value means the assertion is intentionally
 * relaxed (e.g., a curated examples repo with no real "service" boundaries).
 *
 * `null` means "we don't yet know what to assert for this language/framework
 * combination" — leave it for the maintainer.
 */
interface Invariants {
    /** Repo represents a web app — must detect at least one API route. */
    hasApis: boolean;
    /** Repo has executable code paths — buildFlowGraph must produce graphs. */
    hasFlowGraphs: boolean;
    /** Detected APIs must produce sequence graphs. */
    hasSequenceGraphs: boolean;
    /** Anonymous handlers (if any) must all be resolvable at init time. */
    anonymousFullyResolved: boolean;
    /** Workspace produces at least one feature cluster. */
    hasFeatureClusters: boolean;
}

const INVARIANTS: Record<string, Invariants> = {
    'js-express':    { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'ts-express-realworld': { hasApis: true, hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true, hasFeatureClusters: true },
    'js-koa':        { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'js-fastify':    { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'ts-nestjs':     { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'ts-hono':       { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'js-nextjs':     { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'ts-nuxt':       { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: false,  hasFeatureClusters: true },
    'ts-remix':      { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    // Issue 349: pure frontend SvelteKit repo (no `+server.ts` handlers).
    // Previous baseline of 5 APIs was the JS apiDetector matching client
    // `api.post('articles', …)` calls as if they were API definitions; the
    // route guard added in this round correctly suppresses those.
    'ts-sveltekit':  { hasApis: false, hasFlowGraphs: true, hasSequenceGraphs: false, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'ts-trpc':       { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'ts-apollo':     { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: false,  hasFeatureClusters: true },
    'py-django':     { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'py-fastapi':    { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'py-flask':      { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'java-spring':   { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    // Issue 354: Ktor's deeply-nested patterns are now fully resolved after
    // multi-content string template support, label-return guard, and HTTP
    // client filter (preventing `client.get(...)` false positives).
    'kotlin-ktor':   { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true, hasFeatureClusters: true },
    // Issue 348: when route patterns capture an inline lambda / non-named-fn
    // handler and the framework detector falls back to a junk identifier
    // (`null`/`when`/single-char), addApi now substitutes anonymous@ instead
    // of dropping the route. The body-finders for these languages don't yet
    // recognise every such pattern so a fraction stays unresolved.
    'go-gin':        { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'go-echo':       { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: false,  hasFeatureClusters: true },
    'go-chi':        { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: false,  hasFeatureClusters: true },
    'go-fiber':      { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: false,  hasFeatureClusters: true },
    'php-laravel':   { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'php-symfony':   { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: false,  hasFeatureClusters: true },
    'ruby-rails':    { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'ruby-sinatra':  { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: false,  hasFeatureClusters: true },
    // Issue 354: actix Shape 2 (`web::resource("/").route(web::get().to(...))`
    // and direct `.to(<closure>)`) now fully resolves after the receiver-walk
    // and closure-body extraction handle match/async-block bodies and the
    // scoped_identifier last-token fix.
    'rust-actix':    { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true, hasFeatureClusters: true },
    'rust-axum':     { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true, hasFeatureClusters: true },
    'rust-rocket':   { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'csharp-aspnet': { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'swift-vapor':   { hasApis: true,  hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    // Mobile repos: server-side APIs absent; UI items (SCREEN/NAV_ROUTE/NETWORK)
    // are detected via mobileDetector, but server-style "APIs" + sequence graphs
    // are not the right invariants. Just check parse + clusters + flow graphs.
    'ts-react-native': { hasApis: false, hasFlowGraphs: true,  hasSequenceGraphs: false, anonymousFullyResolved: false, hasFeatureClusters: true },
    'dart-flutter':    { hasApis: false, hasFlowGraphs: true,  hasSequenceGraphs: false, anonymousFullyResolved: false, hasFeatureClusters: true },
    'kotlin-android':  { hasApis: false, hasFlowGraphs: true,  hasSequenceGraphs: false, anonymousFullyResolved: false, hasFeatureClusters: true },
    'swift-ios':       { hasApis: false, hasFlowGraphs: true,  hasSequenceGraphs: false, anonymousFullyResolved: false, hasFeatureClusters: true },
    // Tier 1 fixtures (Issue 364) — production library/sample repos for the
    // new entry-point detectors. anonymousFullyResolved gates: spring-kafka /
    // celery have 0/0 anonymous handlers (trivially resolved); sidekiq has
    // 35/42 due to Ruby ERB-style anonymous block handlers in examples.
    'java-spring-kafka':  { hasApis: true, hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'py-django-celery':   { hasApis: true, hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: true,  hasFeatureClusters: true },
    'ruby-rails-sidekiq': { hasApis: true, hasFlowGraphs: true, hasSequenceGraphs: true, anonymousFullyResolved: false, hasFeatureClusters: true },
};

describe('Real-world invariants', () => {
    for (const spec of manifest.repos) {
        const repoPath = path.join(REAL_REPOS, spec.id);
        const cloned = fs.existsSync(repoPath);
        const inv = INVARIANTS[spec.id];

        if (!isBackendRepo(spec.id)) {
            it.skip(`[${spec.id}] frontend/mobile — currently de-prioritized (see repoCategories.ts)`, () => { /* skipped */ });
            continue;
        }
        if (!cloned) {
            it.skip(`[${spec.id}] not cloned — run \`npm run fetch:real-projects\``, () => { /* skipped */ });
            continue;
        }
        if (!inv) {
            it.skip(`[${spec.id}] no invariants defined yet`, () => { /* skipped */ });
            continue;
        }

        describe(`[${spec.id}] (${spec.language}/${spec.framework})`, () => {
            it('detects at least one API route', { timeout: 120_000 }, async () => {
                if (!inv.hasApis) return;
                const r = await verifyCached(repoPath, spec);
                expect(r.initialized).toBe(true);
                expect(r.apiCount, `${spec.id}: ${spec.framework} should detect APIs`).toBeGreaterThan(0);
            });

            it('builds flow graphs for executable code', { timeout: 120_000 }, async () => {
                if (!inv.hasFlowGraphs) return;
                const r = await verifyCached(repoPath, spec);
                expect(r.flowGraphs, `${spec.id}: should build flow graphs for ${spec.language} code`).toBeGreaterThan(0);
            });

            it('builds sequence graphs for detected APIs', { timeout: 120_000 }, async () => {
                if (!inv.hasSequenceGraphs) return;
                const r = await verifyCached(repoPath, spec);
                if (r.apiCount === 0) return; // covered by the hasApis test
                expect(r.sequenceGraphs, `${spec.id}: ${r.apiCount} APIs detected but 0 sequence graphs`).toBeGreaterThan(0);
            });

            it('sequence count <= route APIs minus handler-name collapses (Issue 369)', { timeout: 120_000 }, async () => {
                if (!inv.hasSequenceGraphs) return;
                const r = await verifyCached(repoPath, spec);
                if (r.routeApiCount === 0) return;
                // Sequence graphs are built per `(filePath, handlerName)` pair —
                // multiple ApiRecords pointing at the same method body collapse
                // to a single sequence graph (e.g. Spring `@KafkaListener` ×
                // N topics on one Java method → N records, 1 sequence graph).
                //
                // This invariant enforces the UPPER BOUND: the number of
                // sequence graphs can never exceed routeApiCount minus the
                // dedup collapse count. Anything more would indicate the
                // sequence builder is double-emitting or leaking graphs from
                // another rebuild.
                //
                // The LOWER BOUND (sequences >= some floor) is already guarded
                // per repo by `minSequenceGraphs` in `expectations.json` and
                // checked in `verify.test.ts`. Some legitimate gaps below
                // the upper bound exist (orchestrator skips empty-body
                // sequence graphs at `seqGraph.nodes.length === 0`).
                const upperBound = r.routeApiCount - r.dedupedHandlerCollapses;
                expect(
                    r.sequenceGraphs,
                    `${spec.id}: sequence-graph upper bound violated. ` +
                    `Got ${r.sequenceGraphs} sequence graphs, but routeApis=${r.routeApiCount} ` +
                    `with ${r.dedupedHandlerCollapses} dedup collapses caps at ${upperBound}. ` +
                    `Either the sequence builder is double-emitting, or dedup tracking is wrong.`,
                ).toBeLessThanOrEqual(upperBound);
            });

            it('resolves all anonymous handlers at init time', { timeout: 120_000 }, async () => {
                if (!inv.anonymousFullyResolved) return;
                const r = await verifyCached(repoPath, spec);
                if (r.anonymousHandlers === 0) return;
                expect(
                    r.anonymousResolved,
                    `${spec.id}: ${r.anonymousResolved}/${r.anonymousHandlers} anonymous handlers resolved`,
                ).toBe(r.anonymousHandlers);
            });

            it('produces at least one feature cluster', { timeout: 120_000 }, async () => {
                if (!inv.hasFeatureClusters) return;
                const r = await verifyCached(repoPath, spec);
                expect(r.featureClusters, `${spec.id}: no feature clusters formed`).toBeGreaterThan(0);
            });

            // Issue #496: no L2b api-list should contain APIs from outside its
            // own cluster. The user reported on node-express-realworld-example-app
            // that editing `getCurrentUser` caused 15 article routes to appear
            // in the auth panel (4 + 15 = 19 visible). The defensive guard in
            // apiListGraphBuilder + commitDiffer.buildApiListGraphsForSnapshots
            // filters by `clusterFileSet.has(api.filePath)`. This invariant
            // catches cross-cluster contamination on init for every backend
            // framework, so a future regression surfaces here instead of
            // shipping to users.
            it('L2b api-list panels contain only APIs from their own cluster (#496)', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                expect(
                    r.apiListsWithForeignApis,
                    `${spec.id}: ${r.apiListsWithForeignApis} api-list graphs contain ${r.foreignApiTotal} foreign APIs ` +
                    `(meta.apis with filePath outside cluster.files). Cross-cluster contamination — pre-#496 symptom.`,
                ).toBe(0);
                expect(r.foreignApiTotal, `${spec.id}: foreign API count must be 0`).toBe(0);
            });

            // Issue #426: every cluster's `serviceId` must point at a real
            // service in working.services. The historically-worst offenders
            // were repos where service detection picked a single subdir as
            // the only service (e.g. ts-remix `remix.init/`, go-echo
            // `website/`) and the actual app code lived under a different
            // prefix — leaving 90%+ of clusters orphan and disappearing from
            // L2a feature graphs. Fixed via the `service:main` workspace-wide
            // fallback in serviceDetector.ts.
            it('every cluster references a real service (#426)', { timeout: 120_000 }, async () => {
                if (!inv.hasFeatureClusters) return;
                const r = await verifyCached(repoPath, spec);
                expect(
                    r.clusterOrphanCount,
                    `${spec.id}: ${r.clusterOrphanCount} of ${r.featureClusters} clusters reference no real service ` +
                    `(serviceId is undefined OR not in working.services). Pre-#426 symptom — clusters disappear from L2a + L1.`,
                ).toBe(0);
            });
        });
    }
});
