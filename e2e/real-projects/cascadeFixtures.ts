/**
 * cascadeFixtures.ts
 *
 * Registry of fixture repos that the cascade + timeline-replay scenarios
 * exercise. Each entry pins:
 *   - the source repo path (under e2e/real-repos/);
 *   - one canonical function inside the repo to edit;
 *   - the expected diff state per layer for that edit.
 *
 * Adding a new framework is one row — no code changes needed in the
 * scenario test files. See Issue #378 for rationale and #385 / #388 for the
 * planned multi-framework rollout.
 */

import * as path from 'path';
import * as fs from 'fs';

export interface CascadeExpectations {
    /** L4 function-node labels expected to flip to `modified` for the edit. */
    l4FunctionLabels: string[];
    /** Label of the L2a cluster that owns the edited file (accept LLM or raw id). */
    l2aClusterLabel: RegExp;
    /**
     * Framework-specific assertions. Optional — fixtures that don't expose
     * a stable L3 sequence / L2b api-list per route (e.g. mobile, or
     * frameworks where the cluster/sequence ids are unstable across LLM
     * naming runs) can leave these undefined and the scenarios will skip
     * those checks. The universal L4/L5/L2a/L1 assertions always run.
     */
    sequenceGraphId?: string;
    siblingSequenceIds?: string[];
    apiListClusterId?: string;
    apiListModifiedRoutes?: RegExp[];
    /**
     * Per-fixture flags for cascade behaviour that diverges between language
     * pipelines. Each gap below is also logged in ISSUES.md as a known
     * production inconsistency that should converge over time. Once the
     * production code is unified, the corresponding flag goes away.
     */
    flags?: {
        /** Section labels carry "(N changed + M)" counts (Issue #395 — JS path only today). */
        sectionLabelHasCounts?: boolean;
        /** Cross-handler L3→L4 parity test is meaningful (Issue #396 — JS path only today). */
        crossHandlerParity?: boolean;
        /** L5 flow:graph for the edited function has modified nodes (Issue #397 — Go gap today). */
        l5Modified?: boolean;
        /** L2a feature:workspace marks exactly 1 cluster modified (Issue #398 — Go gap today). */
        l2aSingleClusterModified?: boolean;
        /** L1 microservice:workspace marks exactly 1 service modified (Issue #399 — Python gap today). */
        l1SingleServiceModified?: boolean;
    };
}

export interface ScenarioFixture {
    id: string;
    repoPath: string;
    language: string;
    framework: string;
    canonical: {
        relativePath: string;
        fnName: string;
        /**
         * Override for the L5 flow:graph id when the production code names
         * methods with a class prefix (e.g. Java tree-sitter emits
         * `ClassName.methodName`). When unset, defaults to `fnName`.
         */
        l5FnName?: string;
        /**
         * Language-appropriate probe lines to insert into the function body
         * during edit scenarios. Defaults to a JS console.log statement;
         * Python/Java/Go fixtures should override.
         */
        probeLines?: string[];
        expectedModified: CascadeExpectations;
    };
}

/** Default per-language probe lines for body-edit scenarios. */
export function probeLinesFor(f: ScenarioFixture): string[] {
    if (f.canonical.probeLines) return f.canonical.probeLines;
    // Issue #397: non-JS flow builders strip comments — use a real statement
    // so the L5 flow:graph picks up the new node.
    if (f.language === 'python') return [`print('cascade-probe only-this-fn')`];
    if (f.language === 'java') return [`System.out.println("cascade-probe only-this-fn");`];
    if (f.language === 'go') return [`println("cascade-probe only-this-fn")`];
    return [`console.log('[cascade-probe] only-this-fn');`];
}

const REAL_REPOS_DIR = path.join(__dirname, '..', 'real-repos');

export const FIXTURES: ScenarioFixture[] = [
    {
        id: 'ts-express-realworld',
        repoPath: path.join(REAL_REPOS_DIR, 'ts-express-realworld'),
        language: 'typescript',
        framework: 'express',
        canonical: {
            relativePath: 'src/app/routes/auth/auth.service.ts',
            fnName: 'getCurrentUser',
            expectedModified: {
                l4FunctionLabels: ['getCurrentUser'],
                sequenceGraphId:
                    'sequence:src/app/routes/auth/auth.controller.ts:anonymous@GET:/user',
                siblingSequenceIds: [
                    'sequence:src/app/routes/auth/auth.controller.ts:anonymous@POST:/users',
                    'sequence:src/app/routes/auth/auth.controller.ts:anonymous@PUT:/user',
                ],
                apiListClusterId: 'api-list:cluster:auth',
                // Issue 417: composite `Router().use(...).use(...)` chain in
                // routes.ts resolves the `/api` mount prefix on every
                // sub-router, so `/user` is rendered as `/api/user` in L2b.
                apiListModifiedRoutes: [/^GET \/api\/user$/],
                l2aClusterLabel: /^(auth|.*Authentication.*)$/i,
                flags: {
                    sectionLabelHasCounts: true,
                    crossHandlerParity: true,
                    l5Modified: true,
                    l2aSingleClusterModified: true,
                    l1SingleServiceModified: true,
                },
            },
        },
    },
    {
        // Java Spring controller method — exercises class-level @RequestMapping
        // + method-level mapping composition. Function label in L4 is
        // composed as `ClassName.methodName` (tree-sitter entity extraction).
        id: 'java-spring',
        repoPath: path.join(REAL_REPOS_DIR, 'java-spring'),
        language: 'java',
        framework: 'spring',
        canonical: {
            relativePath: 'src/main/java/org/springframework/samples/petclinic/system/WelcomeController.java',
            fnName: 'welcome',
            // Tree-sitter Java emits methods as `ClassName.methodName` so the
            // flow:graph id is `flow:...:WelcomeController.welcome`.
            l5FnName: 'WelcomeController.welcome',
            expectedModified: {
                l4FunctionLabels: ['WelcomeController.welcome'],
                l2aClusterLabel: /^system$/i,
                flags: {
                    // Issue #395 fix applied — tree-sitter section labels now
                    // carry the "(N changed + M)" suffix.
                    sectionLabelHasCounts: true,
                    // Cross-handler parity uses buildFileGraph (JS-only Babel
                    // path) so it can't verify Java tree-sitter results.
                    // Tracked in Issue #396.
                    crossHandlerParity: true,
                    // Issue #397 partial: L5 flow:graph now found via
                    // `l5FnName` override (class-prefixed `ClassName.method`).
                    l5Modified: true,
                    l2aSingleClusterModified: true,
                    l1SingleServiceModified: true,
                },
            },
        },
    },
    {
        // Python FastAPI route handler — class-less function-decorator style.
        id: 'py-fastapi',
        repoPath: path.join(REAL_REPOS_DIR, 'py-fastapi'),
        language: 'python',
        framework: 'fastapi',
        canonical: {
            relativePath: 'backend/app/api/routes/items.py',
            fnName: 'read_item',
            expectedModified: {
                l4FunctionLabels: ['read_item'],
                // Observed: the cluster owning items.py is labelled 'backend'.
                l2aClusterLabel: /^backend$/i,
                flags: {
                    sectionLabelHasCounts: true,
                    crossHandlerParity: true,
                    l5Modified: true,
                    l2aSingleClusterModified: true,
                    // Issue #399 fix: top-level dirs with project manifests
                    // (pyproject.toml etc.) now count as services even when
                    // they have no source files at depth 1.
                    l1SingleServiceModified: true,
                },
            },
        },
    },
    {
        // Java Spring Kafka @KafkaListener — non-API entry point.
        // Issue #400: this fixture used to trigger ERR_INTERNAL_ASSERTION
        // inside Vitest's worker pool when run alongside the others.
        // Mitigation: vitest config uses `pool: 'forks'` so each test file
        // runs in a separate process — tree-sitter wasm state can't leak
        // across.
        id: 'java-spring-kafka',
        repoPath: path.join(REAL_REPOS_DIR, 'java-spring-kafka'),
        language: 'java',
        framework: 'spring-kafka',
        canonical: {
            relativePath: 'spring-kafka-docs/src/main/java/org/springframework/kafka/jdocs/started/noboot/Listener.java',
            fnName: 'listen1',
            l5FnName: 'Listener.listen1',
            expectedModified: {
                l4FunctionLabels: ['Listener.listen1'],
                l2aClusterLabel: /^noboot$/i,
                flags: {
                    sectionLabelHasCounts: true,
                    crossHandlerParity: true,
                    l5Modified: true,
                    // Both flipped to true 2026-05-13. L2a feature:workspace
                    // already only marked the `noboot` cluster modified for
                    // the canonical `listen1` edit (Issue 398 cascade fix);
                    // L1 modifiedServiceLabels now excludes the derived
                    // Worker / infra nodes so `spring-kafka-docs` is the
                    // single real-service modification.
                    l2aSingleClusterModified: true,
                    l1SingleServiceModified: true,
                },
            },
        },
    },
    {
        // Go Gin handler — func(c *gin.Context) shape.
        id: 'go-gin',
        repoPath: path.join(REAL_REPOS_DIR, 'go-gin'),
        language: 'go',
        framework: 'gin',
        canonical: {
            relativePath: 'articles/routers.go',
            fnName: 'ArticleCreate',
            expectedModified: {
                l4FunctionLabels: ['ArticleCreate'],
                // Issue #398 resolved: per-service feature graph
                // (`feature:service:articles`) correctly marks the
                // articles cluster modified. The original test only
                // checked feature:workspace which doesn't exist when
                // multiple services are detected.
                l2aClusterLabel: /^articles$/i,
                flags: {
                    sectionLabelHasCounts: true,
                    crossHandlerParity: true,
                    // Issue #397 partial fix: probe lines are now real
                    // statements (println(...)) instead of comments — the
                    // tree-sitter Go parser strips comments so the diff
                    // pass had nothing to flag.
                    l5Modified: true,
                    // Issue #398 resolved (test-side): check per-service
                    // feature graph instead of only feature:workspace.
                    l2aSingleClusterModified: true,
                    l1SingleServiceModified: true,
                },
            },
        },
    },
];

/** Fixtures whose source files exist on disk right now. Scenarios should skip cleanly when the fetch step was not run. */
export const PRESENT_FIXTURES = FIXTURES.filter(f =>
    fs.existsSync(path.join(f.repoPath, f.canonical.relativePath)),
);
