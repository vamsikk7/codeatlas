/**
 * testData.ts
 *
 * Sample graph data factories for all 8 CodeAtlas diagram layers.
 * Each factory returns a graph matching the shape expected by the webview components.
 * Data is generic (not project-specific) so tests work against any codebase.
 */

// ─── L1: Microservice / System Design ──────────────────────────────────────

export function microserviceGraph() {
    return {
        graphId: 'microservice:workspace',
        type: 'microservice',
        nodes: [
            {
                id: 'service:backend',
                label: 'backend',
                type: 'service',
                diff: 'unchanged',
                meta: {
                    technology: 'express',
                    exposedApiCount: 5,
                    external: false,
                    infra: false,
                    serviceId: 'service:backend',
                    rootPath: 'src/',
                    consumedServices: ['service:frontend'],
                },
                anchor: { filePath: 'src/app.ts' },
            },
            {
                id: 'service:frontend',
                label: 'frontend',
                type: 'service',
                diff: 'modified',
                meta: {
                    technology: 'nextjs',
                    exposedApiCount: 0,
                    external: false,
                    infra: false,
                    serviceId: 'service:frontend',
                    rootPath: 'web/',
                },
                anchor: { filePath: 'web/pages/index.tsx' },
            },
            {
                id: 'infra:postgres',
                label: 'PostgreSQL',
                type: 'service',
                diff: 'unchanged',
                meta: {
                    infra: true,
                    kind: 'database',
                    external: false,
                },
            },
            {
                id: 'external:stripe',
                label: 'Stripe API',
                type: 'service',
                diff: 'unchanged',
                meta: {
                    external: true,
                    infra: false,
                },
            },
        ],
        edges: [
            { id: 'e-be-pg', source: 'service:backend', target: 'infra:postgres', label: 'uses', diff: 'unchanged' },
            { id: 'e-be-stripe', source: 'service:backend', target: 'external:stripe', label: 'calls', diff: 'unchanged' },
            { id: 'e-fe-be', source: 'service:frontend', target: 'service:backend', label: 'API calls', diff: 'modified' },
        ],
        anchors: {},
        meta: { repoName: 'test-project' },
    };
}

// #835 — skeletal/bucketed multi-repo workspace L1 (UX-27 shape: >50 repos
// collapse into AWS-service buckets). The header must caption the
// workspaceInfo serviceCount, not the bucket-node count.
export function skeletalBucketedL1() {
    return {
        graphId: 'microservice:workspace',
        type: 'microservice',
        nodes: Array.from({ length: 10 }, (_, i) => ({
            id: `service:aws:bucket-${i}`,
            type: 'service',
            label: `AWS Service ${i}`,
            subtitle: `«aws» ${10 + i} patterns`,
            diff: 'unchanged',
            meta: {
                serviceId: `aws:bucket-${i}`,
                awsBucket: `bucket-${i}`,
                patternCount: 10 + i,
                skeletal: true,
            },
        })),
        edges: [],
        anchors: {},
        meta: {
            skeletal: true,
            bucketed: true,
            bucketReason: 'aws-services',
            repoCount: 132,
            bucketCount: 10,
            builtAt: 1,
        },
    };
}

// ─── L2a: Feature / Cluster ────────────────────────────────────────────────

export function featureGraph() {
    return {
        graphId: 'feature:workspace',
        type: 'feature',
        nodes: [
            {
                id: 'cluster:auth',
                label: 'auth',
                subtitle: 'Authentication & authorization',
                type: 'cluster',
                diff: 'unchanged',
                meta: {
                    clusterId: 'cluster:auth',
                    cohesion: 82,
                    domainPhrase: 'Authenticate users',
                    files: ['src/auth/login.ts', 'src/auth/register.ts', 'src/auth/middleware.ts'],
                    entryPoints: ['POST /login', 'POST /register'],
                    // #L2merge — full ApiRecord[] (the real shape the merged L2a renders as rows).
                    apisInCluster: [
                        { apiId: 'auth-login', method: 'POST', route: '/login', handlerName: 'loginHandler', filePath: 'src/auth/login.ts' },
                        { apiId: 'auth-register', method: 'POST', route: '/register', handlerName: 'registerHandler', filePath: 'src/auth/register.ts' },
                    ],
                    serviceId: 'service:backend',
                },
                anchor: {},
            },
            {
                id: 'cluster:payments',
                label: 'payments',
                subtitle: 'Payment processing',
                type: 'cluster',
                diff: 'added',
                meta: {
                    clusterId: 'cluster:payments',
                    cohesion: 68,
                    files: ['src/payments/stripe.ts', 'src/payments/invoice.ts'],
                    entryPoints: ['POST /pay'],
                    apisInCluster: [
                        { apiId: 'pay-charge', method: 'POST', route: '/pay', handlerName: 'payHandler', filePath: 'src/payments/stripe.ts', diff: 'added' },
                    ],
                    serviceId: 'service:backend',
                },
                anchor: {},
            },
            {
                id: 'cluster:users',
                label: 'users',
                subtitle: 'User profile management',
                type: 'cluster',
                diff: 'unchanged',
                meta: {
                    clusterId: 'cluster:users',
                    cohesion: 75,
                    files: ['src/users/profile.ts', 'src/users/service.ts'],
                    entryPoints: ['GET /users/:id'],
                    apisInCluster: [
                        { apiId: 'users-get', method: 'GET', route: '/users/:id', handlerName: 'getUserHandler', filePath: 'src/users/profile.ts' },
                    ],
                    serviceId: 'service:backend',
                },
                anchor: {},
            },
            {
                // #L2merge — an internal/utility cluster with NO entry point, to exercise
                // the trailing "Internal modules · no entry points" group.
                id: 'cluster:utils',
                label: 'utils',
                subtitle: 'Internal helpers',
                type: 'cluster',
                diff: 'unchanged',
                meta: {
                    clusterId: 'cluster:utils',
                    cohesion: 40,
                    files: ['src/utils/format.ts', 'src/utils/logger.ts'],
                    entryPoints: [],
                    apisInCluster: [],
                    serviceId: 'service:backend',
                },
                anchor: {},
            },
        ],
        edges: [
            { id: 'e-auth-users', source: 'cluster:auth', target: 'cluster:users', label: '3 calls', diff: 'unchanged', callCount: 3 },
            { id: 'e-pay-users', source: 'cluster:payments', target: 'cluster:users', label: '1 call', diff: 'added', callCount: 1 },
        ],
        anchors: {},
        meta: { clusterCount: 4, serviceId: 'service:backend' },
    };
}

// ─── L2b: API List ─────────────────────────────────────────────────────────

export function apiListGraph() {
    return {
        graphId: 'api-list:cluster:auth',
        type: 'api-list',
        nodes: [],
        edges: [],
        anchors: {},
        meta: {
            clusterId: 'cluster:auth',
            clusterLabel: 'auth',
            serviceId: 'service:backend',
            apis: [
                { apiId: 'api:get-login', method: 'GET', route: '/login', handlerName: 'showLoginPage', filePath: 'src/auth/login.ts', diff: 'unchanged' },
                { apiId: 'api:post-login', method: 'POST', route: '/login', handlerName: 'loginHandler', filePath: 'src/auth/login.ts', diff: 'modified' },
                { apiId: 'api:post-register', method: 'POST', route: '/register', handlerName: 'registerHandler', filePath: 'src/auth/register.ts', diff: 'unchanged' },
                { apiId: 'api:delete-session', method: 'DELETE', route: '/session', handlerName: 'logoutHandler', filePath: 'src/auth/login.ts', diff: 'unchanged' },
            ],
            files: ['src/auth/login.ts', 'src/auth/register.ts'],
            entryPoints: ['POST /login', 'POST /register'],
            subsystems: [
                { label: 'PostgreSQL (users)', kind: 'database', filePath: 'src/db/client.ts' },
                { label: 'Redis Cache', kind: 'database' },
            ],
        },
    };
}

// ─── L3: Sequence ──────────────────────────────────────────────────────────

export function sequenceGraph() {
    return {
        graphId: 'sequence:src/auth/login.ts:loginHandler',
        type: 'sequence',
        nodes: [
            {
                id: 'p:client',
                label: 'API Client',
                type: 'participant',
                diff: 'unchanged',
                meta: { kind: 'external', participantIndex: 0 },
                anchor: {},
            },
            {
                id: 'p:loginHandler',
                label: 'loginHandler',
                type: 'participant',
                diff: 'modified',
                meta: { kind: 'handler', participantIndex: 1 },
                anchor: { filePath: 'src/auth/login.ts', symbol: 'loginHandler' },
            },
            {
                id: 'p:UserService',
                label: 'UserService',
                type: 'participant',
                diff: 'modified',
                meta: { kind: 'function', participantIndex: 2 },
                anchor: { filePath: 'src/users/service.ts', symbol: 'UserService' },
            },
        ],
        edges: [
            { id: 'msg-1', source: 'p:client', target: 'p:loginHandler', label: 'POST /login', diff: 'unchanged', edgeType: 'message', meta: { messageIndex: 0 } },
            // Edge is 'unchanged' but target participant is 'modified' — tests diff propagation
            { id: 'msg-2', source: 'p:loginHandler', target: 'p:UserService', label: 'findUser(email)', diff: 'unchanged', edgeType: 'message', meta: { messageIndex: 1 } },
            { id: 'msg-3', source: 'p:UserService', target: 'p:loginHandler', label: 'return user', diff: 'unchanged', edgeType: 'message', meta: { messageIndex: 2 } },
        ],
        anchors: {},
        meta: {
            handlerName: 'loginHandler',
            filePath: 'src/auth/login.ts',
            method: 'POST',
            route: '/login',
        },
    };
}

// ─── L4: File Diagram ──────────────────────────────────────────────────────

export function fileGraph() {
    return {
        graphId: 'file:src/auth/login.ts',
        type: 'file',
        nodes: [
            { id: 'imp:express', label: 'express', type: 'import', diff: 'unchanged', anchor: { filePath: 'node_modules/express/index.js' } },
            { id: 'imp:UserService', label: 'UserService', type: 'import', diff: 'unchanged', anchor: { filePath: 'src/users/service.ts', symbol: 'UserService' } },
            { id: 'var:router', label: 'router', subtitle: 'Router', type: 'variable', diff: 'unchanged', anchor: { filePath: 'src/auth/login.ts', symbol: 'router' } },
            { id: 'fn:loginHandler', label: 'loginHandler', subtitle: 'async function', type: 'function', diff: 'modified', anchor: { filePath: 'src/auth/login.ts', symbol: 'loginHandler' } },
            { id: 'fn:validateToken', label: 'validateToken', subtitle: 'function', type: 'function', diff: 'unchanged', anchor: { filePath: 'src/auth/login.ts', symbol: 'validateToken' } },
        ],
        edges: [
            { id: 'e-login-user', source: 'fn:loginHandler', target: 'imp:UserService', label: 'calls', diff: 'unchanged' },
            { id: 'e-login-router', source: 'fn:loginHandler', target: 'var:router', label: 'uses', diff: 'unchanged' },
            { id: 'e-validate-express', source: 'fn:validateToken', target: 'imp:express', label: 'uses', diff: 'unchanged' },
        ],
        anchors: {},
        meta: { filePath: 'src/auth/login.ts', language: 'typescript' },
    };
}

// ─── L5: Function Flow ─────────────────────────────────────────────────────

export function flowGraph() {
    return {
        graphId: 'flow:src/auth/login.ts:loginHandler',
        type: 'flow',
        nodes: [
            { id: 'flow:entry', label: 'loginHandler(req, res)', type: 'terminal', diff: 'unchanged', meta: { nodeKind: 'entry' }, anchor: { filePath: 'src/auth/login.ts', span: { start: 100 } } },
            {
                id: 'flow:block1', label: 'const { email, password } = req.body\nconst user = await findUser(email)\nconst isValid = verifyPassword(password, user.hash)', type: 'statement', diff: 'modified',
                meta: {
                    nodeKind: 'block',
                    statements: [
                        { label: 'const { email, password } = req.body', diff: 'unchanged', span: { start: 150, end: 190 } },
                        { label: 'const user = await findUser(email)', diff: 'modified', diffDetail: { deleted: 'const user = await getUser(email)', added: 'const user = await findUser(email)' }, span: { start: 195, end: 230 } },
                        { label: 'const isValid = verifyPassword(password, user.hash)', diff: 'added', span: { start: 235, end: 280 } },
                    ],
                },
                anchor: { filePath: 'src/auth/login.ts', span: { start: 150, end: 280 } },
            },
            { id: 'flow:d1', label: 'user !== null?', type: 'decision', diff: 'unchanged', meta: { nodeKind: 'decision' }, anchor: { filePath: 'src/auth/login.ts', span: { start: 285 } } },
            { id: 'flow:s2', label: 'res.json({ token })', type: 'statement', diff: 'unchanged', meta: { nodeKind: 'statement' }, anchor: { filePath: 'src/auth/login.ts', span: { start: 320 } } },
            { id: 'flow:ret', label: 'res.status(401).end()', type: 'return', diff: 'unchanged', meta: { nodeKind: 'return' }, anchor: { filePath: 'src/auth/login.ts', span: { start: 370 } } },
        ],
        edges: [
            { id: 'fe-entry-s1', source: 'flow:entry', target: 'flow:s1', label: '', diff: 'unchanged' },
            { id: 'fe-s1-d1', source: 'flow:s1', target: 'flow:d1', label: '', diff: 'unchanged' },
            { id: 'fe-d1-s2', source: 'flow:d1', target: 'flow:s2', label: 'true', diff: 'unchanged' },
            { id: 'fe-d1-ret', source: 'flow:d1', target: 'flow:ret', label: 'false', diff: 'unchanged' },
            { id: 'fe-s2-ret', source: 'flow:s2', target: 'flow:ret', label: '', diff: 'unchanged' },
        ],
        anchors: {},
        meta: { functionName: 'loginHandler', filePath: 'src/auth/login.ts' },
    };
}

// ─── Health Dashboard ──────────────────────────────────────────────────────

export function healthGraph() {
    return {
        graphId: 'health:report',
        type: 'health',
        nodes: [],
        edges: [],
        anchors: {},
        meta: {
            health: {
                deadFunctions: ['src/legacy/old.ts::unusedHelper', 'src/utils/deprecated.ts::formatDate'],
                godFiles: ['src/core/mega-module.ts'],
                highCouplingFiles: ['src/shared/index.ts', 'src/core/types.ts'],
                cyclicDependencies: [['src/a.ts', 'src/b.ts', 'src/c.ts']],
                orphanedClusters: ['cluster:legacy-utils'],
            },
        },
    };
}

// ─── Workspace info (sent on client ready) ─────────────────────────────────

export function workspaceInfo(overrides: Record<string, any> = {}) {
    return {
        type: 'workspaceInfo' as const,
        name: 'test-project',
        fileCount: 42,
        apiCount: 8,
        serviceCount: 2,
        clusterCount: 3,
        initialized: true,
        isAuthenticated: true,
        hasGitRemote: true,
        gitHubConnected: false,
        gitRemoteOwner: 'test-org',
        gitRemoteRepo: 'test-project',
        llmProvider: 'openrouter',
        llmModel: 'openrouter/free',
        llmEndpoint: '',
        ...overrides,
    };
}

// ─── Explorer data (sent on client ready) ──────────────────────────────────

export function explorerData() {
    return {
        type: 'explorerData' as const,
        // UX-50 (2026-06-06) — every explorer item now carries an
        // `action` field that mirrors what the extension's
        // `buildExplorerData` emits. The HomePage scope picker dispatches
        // these verbatim on pick, so the mock must include them for the
        // browser-navigation tests to drive the picker end-to-end.
        services: [
            { id: 'service:backend', label: 'backend', technology: 'express',
              action: { type: 'openFeatureForService', serviceId: 'service:backend' } },
            { id: 'service:frontend', label: 'frontend', technology: 'nextjs',
              action: { type: 'openFeatureForService', serviceId: 'service:frontend' } },
        ],
        features: [
            { id: 'cluster:auth', label: 'auth', fileCount: 3,
              action: { type: 'openApiListForCluster', clusterId: 'cluster:auth', serviceId: '' } },
            { id: 'cluster:payments', label: 'payments', fileCount: 2,
              action: { type: 'openApiListForCluster', clusterId: 'cluster:payments', serviceId: '' } },
            { id: 'cluster:users', label: 'users', fileCount: 2,
              action: { type: 'openApiListForCluster', clusterId: 'cluster:users', serviceId: '' } },
        ],
        apis: [
            {
                id: 'api:post-login',
                label: 'POST /login',
                subtitle: 'src/auth/login.ts',
                action: { type: 'openSequenceForApi', apiId: 'api:post-login' },
            },
            {
                id: 'api:post-register',
                label: 'POST /register',
                subtitle: 'src/auth/register.ts',
                action: { type: 'openSequenceForApi', apiId: 'api:post-register' },
            },
        ],
        files: [],
        functions: [],
    };
}

// ─── Sample commits ────────────────────────────────────────────────────────

export function sampleCommits() {
    return [
        { hash: 'abc1234567890abcdef1234567890abcdef123456', shortHash: 'abc1234', subject: 'feat: add login endpoint', author: 'Alice', relativeDate: '2 hours ago' },
        { hash: 'def4567890abcdef1234567890abcdef123456789a', shortHash: 'def4567', subject: 'fix: password validation', author: 'Bob', relativeDate: '1 day ago' },
        { hash: '1112223334445556667778889990001112223334a', shortHash: '1112223', subject: 'chore: update dependencies', author: 'Alice', relativeDate: '3 days ago' },
        { hash: 'aaa1111bbb2222ccc3333ddd4444eee5555fff666', shortHash: 'aaa1111', subject: 'refactor: extract user service', author: 'Charlie', relativeDate: '1 week ago' },
        { hash: 'bbb2222ccc3333ddd4444eee5555fff6666aaa111', shortHash: 'bbb2222', subject: 'init: project setup', author: 'Alice', relativeDate: '2 weeks ago' },
    ];
}

// ─── Sample branches ───────────────────────────────────────────────────────

export function sampleBranches() {
    return [
        { name: 'main', isCurrent: true, isRemote: false },
        { name: 'feature/login', isCurrent: false, isRemote: false },
        { name: 'origin/develop', isCurrent: false, isRemote: true },
    ];
}

// ─── Sample pull requests ──────────────────────────────────────────────────

export function samplePrs() {
    return [
        { number: 142, title: 'fix: login validation', author: 'alice', branch: 'fix/login', updatedAt: '2026-04-18T02:00:00Z', isDraft: false },
        { number: 139, title: 'feat: add payment processing', author: 'bob', branch: 'feature/payments', updatedAt: '2026-04-17T10:00:00Z', isDraft: false },
        { number: 137, title: 'chore: update dependencies', author: 'alice', branch: 'chore/deps', updatedAt: '2026-04-15T08:00:00Z', isDraft: true },
    ];
}

// ─── Sample search items ───────────────────────────────────────────────────

export function searchItems() {
    return [
        { id: 'api:post-login', label: 'POST /login', description: 'src/auth/login.ts', kind: 'API' },
        { id: 'file:src/auth/login.ts', label: 'login.ts', description: 'src/auth/login.ts', kind: 'File' },
        { id: 'cluster:auth', label: 'auth', description: 'Authentication cluster', kind: 'Feature' },
        { id: 'service:backend', label: 'backend', description: 'Express service', kind: 'Service' },
    ];
}

// ─── AI Review mock data ──────────────────────────────────────────────────

export function aiReviewResult() {
    const items = [
        {
            id: 'review_0_file:src/auth/login.ts_n1',
            graphId: 'file:src/auth/login.ts',
            targetId: 'n1',
            targetType: 'node',
            severity: 'error',
            status: 'open',
            title: 'SQL injection vulnerability',
            body: 'User input is concatenated directly into the query string. Use parameterized queries instead.',
            category: 'security',
            anchor: { filePath: 'src/auth/login.ts', symbol: 'loginHandler' },
        },
        {
            id: 'review_1_file:src/auth/login.ts_n2',
            graphId: 'file:src/auth/login.ts',
            targetId: 'n2',
            targetType: 'node',
            severity: 'warning',
            status: 'open',
            title: 'Missing error handling',
            body: 'The async call lacks a try-catch block. Unhandled rejections will crash the server.',
            category: 'code-quality',
            anchor: { filePath: 'src/auth/login.ts', symbol: 'validateToken' },
        },
        {
            id: 'review_2_flow:src/auth/login.ts:loginHandler_n3',
            graphId: 'flow:src/auth/login.ts:loginHandler',
            targetId: 'n3',
            targetType: 'node',
            severity: 'info',
            status: 'open',
            title: 'Consider early return',
            body: 'The nested if-else can be simplified with an early return pattern.',
            category: 'code-quality',
            anchor: { filePath: 'src/auth/login.ts', symbol: 'loginHandler' },
        },
    ];
    const byGraph: Record<string, any[]> = {};
    for (const item of items) {
        if (!byGraph[item.graphId]) byGraph[item.graphId] = [];
        byGraph[item.graphId].push(item);
    }
    return {
        items,
        byGraph,
        summary: { error: 1, warning: 1, info: 1, total: 3 },
        meta: { model: 'test-model', totalTokens: 450, durationMs: 1500 },
    };
}

/**
 * Findings shape for the new Code Review GA flow (#531/#606 — `requestFullReview` orchestrator).
 * Mirrors the `AiReviewFinding` interface in `graphTypes.ts`: keyed by `entryPointId`
 * (`method:route`), with `bindings` array spanning multiple layer graphIds,
 * `baselineRef` provenance, optional `auditTrail`, optional `blastRadius`.
 */
export function aiReviewFindings() {
    const now = new Date().toISOString();
    return [
        {
            id: 'f_login_sec_1',
            entryPointId: 'POST:/api/users/login',
            bindings: [
                { graphId: 'file:src/auth/login.ts', targetId: 'loginHandler', targetType: 'node' as const, layer: 'file' as const },
                { graphId: 'sequence:src/auth/login.ts:loginHandler', targetId: 'POST:/api/users/login::entry', targetType: 'node' as const, layer: 'sequence' as const },
            ],
            severity: 'error' as const,
            category: 'security' as const,
            title: 'SQL injection in login handler',
            body: 'User input is concatenated directly into the query string. Use parameterized queries instead.',
            anchor: { filePath: 'src/auth/login.ts', symbol: 'loginHandler', snippet: "db.query(`SELECT * FROM users WHERE email='${req.body.email}'`)", lineStart: 12, lineEnd: 12 },
            status: 'open' as const,
            model: 'gpt-4o-mini',
            guidelinesHash: 'gh-test',
            baselineRef: { kind: 'git' as const, ref: 'abc1234', capturedAt: now },
            createdAt: now,
            updatedAt: now,
            auditTrail: [{ ts: now, fromStatus: null, toStatus: 'open' as const, actor: 'gpt-4o-mini' }],
        },
        {
            id: 'f_login_quality_1',
            entryPointId: 'POST:/api/users/login',
            bindings: [
                { graphId: 'file:src/auth/login.ts', targetId: 'loginHandler', targetType: 'node' as const, layer: 'file' as const },
            ],
            severity: 'warning' as const,
            category: 'code-quality' as const,
            title: 'Missing error handling on async call',
            body: 'The async DB call lacks a try-catch block. Unhandled rejections will crash the server.',
            anchor: { filePath: 'src/auth/login.ts', symbol: 'loginHandler', snippet: 'const user = await db.query(...)', lineStart: 15, lineEnd: 15 },
            status: 'open' as const,
            model: 'gpt-4o-mini',
            guidelinesHash: 'gh-test',
            baselineRef: { kind: 'git' as const, ref: 'abc1234', capturedAt: now },
            createdAt: now,
            updatedAt: now,
            auditTrail: [{ ts: now, fromStatus: null, toStatus: 'open' as const, actor: 'gpt-4o-mini' }],
        },
        {
            id: 'f_users_info_1',
            entryPointId: 'GET:/api/users',
            bindings: [
                { graphId: 'sequence:src/users/users.controller.ts:getAllUsers', targetId: 'GET:/api/users::entry', targetType: 'node' as const, layer: 'sequence' as const },
            ],
            severity: 'info' as const,
            category: 'code-quality' as const,
            title: 'Consider pagination',
            body: 'This endpoint returns all users without pagination. Add limit/offset for large datasets.',
            anchor: { filePath: 'src/users/users.controller.ts', symbol: 'getAllUsers' },
            status: 'open' as const,
            model: 'gpt-4o-mini',
            guidelinesHash: 'gh-test',
            baselineRef: { kind: 'git' as const, ref: 'abc1234', capturedAt: now },
            createdAt: now,
            updatedAt: now,
            auditTrail: [{ ts: now, fromStatus: null, toStatus: 'open' as const, actor: 'gpt-4o-mini' }],
        },
    ];
}

/**
 * Pre-flight cost estimate shape (#608-UI) — populates the confirm modal
 * before "Start review" fires. Tweak `estimatedUSD` / `willExceedCap` to
 * drive the modal into auto-skip ($0) or budget-warning states.
 */
export function reviewCostEstimate(overrides: Record<string, any> = {}) {
    return {
        entryPointCount: 8,
        estimatedUSD: 0.12,
        model: 'gpt-4o-mini',
        provider: 'openrouter',
        pricingIsEstimate: false,
        budgetCapUSD: 1.0,
        willExceedCap: false,
        summary: 'gpt-4o-mini · 8 entry points · ~$0.12',
        ...overrides,
    };
}

/**
 * Helper: aggregate `FindingCounts` (matches `aiReviewFindingsStore.counts()`).
 * Used by the messageHandler fixture so `aiFindings` broadcasts carry the
 * same shape the real backend would emit.
 */
export function computeFindingCounts(findings: any[]): any {
    const out = {
        byGraph: {} as Record<string, { error: number; warning: number; info: number; total: number }>,
        byEntryPoint: {} as Record<string, number>,
        bySeverity: { error: 0, warning: 0, info: 0 },
        total: 0,
    };
    for (const f of findings) {
        if (f.status && f.status !== 'open') continue;
        out.total += 1;
        out.bySeverity[f.severity as 'error' | 'warning' | 'info'] += 1;
        out.byEntryPoint[f.entryPointId] = (out.byEntryPoint[f.entryPointId] ?? 0) + 1;
        const seen = new Set<string>();
        for (const b of f.bindings ?? []) {
            if (seen.has(b.graphId)) continue;
            seen.add(b.graphId);
            const cell = out.byGraph[b.graphId] ?? { error: 0, warning: 0, info: 0, total: 0 };
            cell[f.severity as 'error' | 'warning' | 'info'] += 1;
            cell.total += 1;
            out.byGraph[b.graphId] = cell;
        }
    }
    return out;
}
