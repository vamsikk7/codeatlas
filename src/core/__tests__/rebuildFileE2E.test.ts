/**
 * rebuildFileE2E.test.ts
 *
 * Issue 309: end-to-end coverage for `SyncOrchestrator.rebuildFile` (the
 * incremental file-save path). Creates a tmp workspace, initializes, edits
 * a file, calls rebuildFile, and asserts the snapshot reflects the edit
 * (new function appears in flow graphs; baseline retains the old version).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setGrammarsDir, resetTreeSitterForTesting } from '../parser/treeSitterParser';
import { SyncOrchestrator } from '../sync/syncOrchestrator';
import { SnapshotStore } from '../storage/snapshotStore';
import { CommentStore } from '../storage/commentStore';

beforeAll(() => {
    resetTreeSitterForTesting();
    setGrammarsDir(path.join(process.cwd(), 'grammars'));
});

describe('SyncOrchestrator.rebuildFile (Issue 309)', () => {
    it('reflects an edit to an existing file in the working snapshot', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-'));
        const codeatlasDir = path.join(workspace, '.codeatlas');
        fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });

        const filePath = 'src/app.js';
        const fullPath = path.join(workspace, filePath);
        fs.writeFileSync(fullPath, `
function greet(name) { return 'hi ' + name; }
function farewell(name) { return 'bye ' + name; }
module.exports = { greet, farewell };
`);

        const store = new SnapshotStore(codeatlasDir);
        const sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();

        const initialFlowKey = `flow:${filePath}:greet`;
        expect(store.getWorking().graphs[initialFlowKey]).toBeDefined();

        // Edit: rename `farewell` to `bye`, add a new function.
        const newCode = `
function greet(name) { return 'hi ' + name; }
function bye(name) { return 'bye ' + name; }
function shout(name) { return name.toUpperCase(); }
module.exports = { greet, bye, shout };
`;
        fs.writeFileSync(fullPath, newCode);

        const result = await sync.rebuildFile(filePath, newCode);
        expect(result).toBeDefined();
        expect(result.graphIds).toContain(`flow:${filePath}:bye`);
        expect(result.graphIds).toContain(`flow:${filePath}:shout`);

        const w = store.getWorking();
        // New flow graphs visible in working
        expect(w.graphs[`flow:${filePath}:bye`]).toBeDefined();
        expect(w.graphs[`flow:${filePath}:shout`]).toBeDefined();
        // Deleted `farewell` is preserved as a 'deleted'-diff ghost so the L5
        // panel can show the user what disappeared. We assert that it carries
        // the deleted marker rather than that the graph is gone.
        const farewell = w.graphs[`flow:${filePath}:farewell`];
        if (farewell) {
            // Either the graph itself is tagged deleted, or its nodes carry the
            // deleted diff — either is acceptable.
            const ghost = farewell.nodes?.some(n => n.diff === 'deleted') ?? false;
            expect(ghost || (farewell as any).diff === 'deleted').toBe(true);
        }

        // Baseline still has the original snapshot (`farewell`)
        const b = store.getBaseline();
        expect(b.graphs[`flow:${filePath}:farewell`]).toBeDefined();
        // and does NOT yet have the new functions (they're working-only until baseline shifts)
        expect(b.graphs[`flow:${filePath}:bye`]).toBeUndefined();

        fs.rmSync(workspace, { recursive: true, force: true });
    }, 60_000);

    // Issue 372: when a file contains secret-shaped tokens (anything the
    // redactSecretsInContent pass replaces), the stored baseline `content`
    // column has a different byte length than the live disk file. Spans on
    // `symbols.functions` were computed against the unredacted source, so
    // slicing the redacted content at those spans yields misaligned text.
    // Pre-fix, this caused `buildDiffMap` to fail-and-swallow inside
    // `buildFlowGraph`, leaving every node on the rebuilt flow graph marked
    // `unchanged` — the diff cascade silently failed for any function in a
    // file containing a secret-shaped token. Lock the post-fix behaviour:
    // rebuildFile must produce a flow graph whose new statements carry
    // `diff: 'added'` even when baseline content is redacted.
    it('produces added/deleted diff annotations when baseline content was redacted (Issue 372)', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-redacted-'));
        const codeatlasDir = path.join(workspace, '.codeatlas');
        fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });

        const filePath = 'src/auth.ts';
        const fullPath = path.join(workspace, filePath);
        // Original source contains a Postgres-style connection URI — the
        // redactor will strip it on save, shifting all subsequent byte
        // offsets so symbols.functions spans no longer slice the stored
        // content correctly.
        fs.writeFileSync(fullPath, `
const DB_URL = 'postgres://user:supersecretpassword@db.internal:5432/app';
// NOTE: deliberately NOT a vendor-shaped key. This used to be Stripe's
// published doc example (sk_live_4eC...), which is not a real credential but
// still trips GitHub secret scanning and push protection — blocking the push
// for us and for every fork. redactSecretsInContent matches on the IDENTIFIER
// (TOKEN/SECRET/API_KEY = '...'), not the value, so a synthetic value keeps
// this fixture doing its job. Do not "improve" it back to a realistic key.
const TOKEN = 'fixture_token_not_a_real_secret0';

export const getCurrentUser = async (id: number) => {
  if (!id) {
    throw new Error('id required');
  }
  return { id, db: DB_URL, token: TOKEN };
};
`);

        const store = new SnapshotStore(codeatlasDir);
        const sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();

        // Confirm the test fixture actually triggers redaction at scan time —
        // if redactSecretsInContent stops stripping these tokens later, this
        // test loses its meaning, so guard on the precondition.
        const baselineContent = store.getFileContent('baseline', filePath);
        expect(baselineContent, 'precondition: redactor must alter the secret tokens')
            .not.toEqual(fs.readFileSync(fullPath, 'utf-8'));

        // Edit: add a log statement at the top of getCurrentUser — exactly the
        // shape the user's "add logs in getCurrentUser" scenario produces.
        const editedCode = `
const DB_URL = 'postgres://user:supersecretpassword@db.internal:5432/app';
const TOKEN = 'fixture_token_not_a_real_secret0';

export const getCurrentUser = async (id: number) => {
  console.log(\`[getCurrentUser] called with id=\${id}\`);
  if (!id) {
    throw new Error('id required');
  }
  return { id, db: DB_URL, token: TOKEN };
};
`;
        fs.writeFileSync(fullPath, editedCode);
        await sync.rebuildFile(fullPath);

        const flow = store.getWorking().graphs[`flow:${filePath}:getCurrentUser`];
        expect(flow, 'flow graph for getCurrentUser must exist after rebuild').toBeDefined();

        // The added console.log statement should carry diff: 'added'. Pre-fix
        // every node was 'unchanged' regardless of the edit.
        const added = flow.nodes.filter(n => n.diff === 'added');
        expect(added.length, `expected at least one 'added' node, got ${flow.nodes.length} total — none added. Pre-fix this was the silent regression.`).toBeGreaterThan(0);
        expect(added.some(n => (n.label ?? '').includes('console.log')), 'the added node should be the new console.log line').toBe(true);

        // #376: L4 file graph must reflect the body change on the function node.
        // Pre-fix, every node stayed `unchanged` because `baselineFile.content`
        // was empty after the lazy-content drop, so `buildFileGraph` ran in
        // non-diff mode.
        const fileGraph = store.getWorking().graphs[`file:${filePath}`];
        expect(fileGraph, 'file graph must exist after rebuild').toBeDefined();
        const fnNode = fileGraph.nodes.find(n => n.type === 'function' && n.label === 'getCurrentUser');
        expect(fnNode, 'getCurrentUser function node must exist on the L4 file graph').toBeDefined();
        expect(fnNode!.diff, `L4 getCurrentUser node must be 'modified' after body edit. Got ${fnNode!.diff}.`).toBe('modified');

        fs.rmSync(workspace, { recursive: true, force: true });
    }, 60_000);

    // Issue 375: when a handler function's body is edited but the inner call
    // expressions inside it are byte-identical, the sequence graph for the
    // route should mark ONLY the edge INTO the handler as modified — the
    // edges OUT of it (call sites whose label text didn't change) must stay
    // `unchanged`. Pre-fix, adding a `console.log` to `getCurrentUser` caused
    // every outgoing call edge (`prisma.user.findUnique(...)`, `generateToken
    // (user.id)`) to be marked modified, even though those call expressions
    // were textually unchanged.
    it('does not over-mark outgoing call edges inside a modified handler (Issue 375)', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-overmark-'));
        const codeatlasDir = path.join(workspace, '.codeatlas');
        fs.mkdirSync(path.join(workspace, 'src/routes'), { recursive: true });
        fs.mkdirSync(path.join(workspace, 'src/utils'), { recursive: true });
        fs.mkdirSync(path.join(workspace, 'prisma'), { recursive: true });

        // token.utils.ts — generateToken delegates to jsonwebtoken.sign
        fs.writeFileSync(path.join(workspace, 'src/utils/token.utils.ts'), `
import * as jwt from 'jsonwebtoken';
export default function generateToken(id: number): string {
    return jwt.sign({ user: { id } }, 'secret', { expiresIn: '60d' });
}
`);

        // prisma client (matches user's real workspace shape: `import prisma from '../../../prisma/prisma-client'`)
        fs.writeFileSync(path.join(workspace, 'prisma/prisma-client.ts'), `
const prisma = { user: { findUnique: async (_: any) => ({ id: 1, email: 'x', username: 'x' }) } };
export default prisma;
`);

        // auth.service.ts — getCurrentUser is the function under test.
        fs.writeFileSync(path.join(workspace, 'src/routes/auth.service.ts'), `
import generateToken from '../utils/token.utils';
import prisma from '../../prisma/prisma-client';

export const getCurrentUser = async (id: number) => {
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, username: true } });
    if (!user) throw new Error('not found');
    return { ...user, token: generateToken(user.id) };
};
`);

        // auth.controller.ts — the route handler that invokes getCurrentUser.
        const controllerPath = 'src/routes/auth.controller.ts';
        const controllerFullPath = path.join(workspace, controllerPath);
        fs.writeFileSync(controllerFullPath, `
import { Router } from 'express';
import { getCurrentUser } from './auth.service';
const router = Router();
router.get('/user', async (req: any, res: any) => {
    const u = await getCurrentUser(req.auth?.user?.id);
    res.json({ user: u });
});
export default router;
`);

        const store = new SnapshotStore(codeatlasDir);
        const sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();

        // Add 2 log lines INSIDE getCurrentUser. The inner call expressions
        // (`prisma.user.findUnique(...)`, `generateToken(user.id)`) are
        // byte-identical to baseline; only the body of getCurrentUser grew.
        fs.writeFileSync(path.join(workspace, 'src/routes/auth.service.ts'), `
import generateToken from '../utils/token.utils';
import prisma from '../../prisma/prisma-client';

export const getCurrentUser = async (id: number) => {
    console.log(\`[getCurrentUser] called with id=\${id}\`);
    console.log(\`[getCurrentUser] PROBE verifying diff cascade\`);
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, username: true } });
    if (!user) throw new Error('not found');
    return { ...user, token: generateToken(user.id) };
};
`);
        await sync.rebuildFile(path.join(workspace, 'src/routes/auth.service.ts'));

        // Find the sequence graph for the GET /user route on the controller.
        const w = store.getWorking();
        const seqId = Object.keys(w.graphs).find(k =>
            k.startsWith('sequence:src/routes/auth.controller.ts:')
        );
        expect(seqId, 'expected a sequence graph for the GET /user route').toBeDefined();
        const seq = w.graphs[seqId!];
        expect(seq, 'sequence graph must exist').toBeDefined();

        const messageEdges = seq.edges.filter(e => e.edgeType === 'message');
        const modified = messageEdges.filter(e => e.diff === 'modified');
        const labels = (es: typeof messageEdges) => es.map(e => `${e.diff}: ${e.label}`).join('\n');

        // Edge INTO getCurrentUser (call site in the controller) must be marked
        // modified — it points at a function whose body changed.
        const intoHandler = messageEdges.find(e => (e.label ?? '').startsWith('getCurrentUser('));
        expect(intoHandler, 'edge into getCurrentUser must exist').toBeDefined();
        expect(intoHandler!.diff, `edge into getCurrentUser should be modified.\nAll edges:\n${labels(messageEdges)}`).toBe('modified');

        // Edges OUT of getCurrentUser: their call expression text didn't
        // change, so they must NOT be marked modified.
        const findUniqueEdge = messageEdges.find(e => (e.label ?? '').includes('findUnique'));
        const generateTokenEdge = messageEdges.find(e => (e.label ?? '').startsWith('generateToken('));
        expect(findUniqueEdge, 'edge for prisma.user.findUnique must exist').toBeDefined();
        expect(generateTokenEdge, 'edge for generateToken must exist').toBeDefined();
        expect(findUniqueEdge!.diff, `prisma.user.findUnique edge must stay unchanged — its call text didn't change.\nAll edges:\n${labels(messageEdges)}`).not.toBe('modified');
        expect(generateTokenEdge!.diff, `generateToken edge must stay unchanged — its call text didn't change.\nAll edges:\n${labels(messageEdges)}`).not.toBe('modified');

        // Sanity: exactly one edge in the entire graph should be `modified`
        // (the one into getCurrentUser). More than that = over-cascade.
        expect(modified.length, `expected exactly 1 modified edge (into getCurrentUser). Got ${modified.length}:\n${labels(modified)}`).toBe(1);

        fs.rmSync(workspace, { recursive: true, force: true });
    }, 60_000);

    // Issue 381: User reinitialized when the function had 8 log lines INSIDE
    // its body, then REMOVED the logs. Baseline now contains the "logs version"
    // and working contains the "no-logs version". Symbols.functions[3].bodyText
    // differs (991 chars baseline vs 543 chars working) so the L4 entity diff
    // SHOULD report getCurrentUser as modified. Live observation: every L4
    // function node stays `unchanged`. Reproducer: full E2E with init→edit→
    // rebuildFile→inspect L4 file graph for `modified` annotation.
    it('reports getCurrentUser as modified in L4 after removing log lines from its body (#381)', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'l4-remove-logs-'));
        const codeatlasDir = path.join(workspace, '.codeatlas');
        fs.mkdirSync(path.join(workspace, 'src/auth'), { recursive: true });

        const filePath = 'src/auth/auth.service.ts';
        const fullPath = path.join(workspace, filePath);

        // Initial state: getCurrentUser has 8 log lines (the user's reinit state).
        // Other functions contain `password: hashedPassword` (triggers the redactor)
        // — this is the exact pattern in the user's auth.service.ts.
        fs.writeFileSync(fullPath, `
import bcrypt from 'bcryptjs';
const prisma = { user: {
    findUnique: async (_: any) => ({ id: 1 }),
    create: async (_: any) => ({ id: 2 }),
    update: async (_: any) => ({ id: 3 }),
} };

export const createUser = async (input: { username: string; password: string }) => {
    const hashedPassword = await bcrypt.hash(input.password, 10);
    const user = await prisma.user.create({ data: { username: input.username, password: hashedPassword } });
    return user;
};

export const getCurrentUser = async (id: number) => {
    console.info(\`[gcu] Request received for id=\${id ?? 'undefined'}\`);
    if (!id) {
        console.warn('[gcu] Missing authenticated user id');
        throw new Error('id required');
    }
    try {
        console.info(\`[gcu] Fetching user from database id=\${id}\`);
        const user = await prisma.user.findUnique({ where: { id } });
        if (!user) {
            console.warn(\`[gcu] User not found for id=\${id}\`);
            throw new Error('not found');
        }
        console.info(\`[gcu] Loaded current user id=\${id}\`);
        return user;
    } catch (error) {
        console.error(\`[gcu] Failed to load current user id=\${id}\`, error);
        throw error;
    }
};

export const updateUser = async (input: { password?: string }, id: number) => {
    let hashedPassword;
    if (input.password) hashedPassword = await bcrypt.hash(input.password, 10);
    const user = await prisma.user.update({ where: { id }, data: { password: hashedPassword } });
    return user;
};
`);

        const store = new SnapshotStore(codeatlasDir);
        // Production parity: extension.ts calls store.load() during activation,
        // which initializes SQLite. Without it, save() silently returns and
        // getFileContent always returns undefined.
        await store.load();
        const sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();

        // Sanity: baseline captured with logs
        const baselineFn = store.getBaseline().files[filePath]?.symbols?.functions?.find(f => f.name === 'getCurrentUser');
        expect(baselineFn?.bodyText?.length, 'baseline getCurrentUser must contain the logs').toBeGreaterThan(400);

        // initialize() ends with save() which drops in-memory content. The
        // production state at rebuildFile-fire time is therefore: SQLite has
        // baseline content, in-memory baselineFile.content is undefined,
        // getFileContent reads from SQLite.
        const baselineContentViaFallback = store.getFileContent('baseline', filePath);
        expect(baselineContentViaFallback?.length, 'getFileContent must return baseline content from SQLite post-save').toBeGreaterThan(400);

        // Now REMOVE the logs — match the user's exact scenario.
        // createUser + updateUser bodies are UNCHANGED — only getCurrentUser shrinks.
        fs.writeFileSync(fullPath, `
import bcrypt from 'bcryptjs';
const prisma = { user: {
    findUnique: async (_: any) => ({ id: 1 }),
    create: async (_: any) => ({ id: 2 }),
    update: async (_: any) => ({ id: 3 }),
} };

export const createUser = async (input: { username: string; password: string }) => {
    const hashedPassword = await bcrypt.hash(input.password, 10);
    const user = await prisma.user.create({ data: { username: input.username, password: hashedPassword } });
    return user;
};

export const getCurrentUser = async (id: number) => {
    if (!id) throw new Error('id required');
    try {
        const user = await prisma.user.findUnique({ where: { id } });
        if (!user) throw new Error('not found');
        return user;
    } catch (error) {
        throw error;
    }
};

export const updateUser = async (input: { password?: string }, id: number) => {
    let hashedPassword;
    if (input.password) hashedPassword = await bcrypt.hash(input.password, 10);
    const user = await prisma.user.update({ where: { id }, data: { password: hashedPassword } });
    return user;
};
`);
        await sync.rebuildFile(fullPath);

        const w = store.getWorking();
        const fileGraph = w.graphs[`file:${filePath}`];
        expect(fileGraph, 'file graph must exist').toBeDefined();
        const fnNode = fileGraph.nodes.find(n => n.type === 'function' && n.label === 'getCurrentUser');
        expect(fnNode, 'getCurrentUser function node must exist on L4').toBeDefined();

        const fnDiffs = fileGraph.nodes
            .filter(n => n.type === 'function')
            .map(n => `${n.label}=${n.diff}`)
            .join(', ');
        expect(fnNode!.diff,
            `L4 getCurrentUser must be 'modified' after removing log lines. Got '${fnNode!.diff}'. All function diffs: ${fnDiffs}`
        ).toBe('modified');

        // createUser and updateUser bodies didn't change — they must NOT be
        // marked modified (no false positives from redaction byte-shift)
        const createUserNode = fileGraph.nodes.find(n => n.type === 'function' && n.label === 'createUser');
        const updateUserNode = fileGraph.nodes.find(n => n.type === 'function' && n.label === 'updateUser');
        expect(createUserNode?.diff, `createUser body unchanged — must NOT be modified. All: ${fnDiffs}`).toBe('unchanged');
        expect(updateUserNode?.diff, `updateUser body unchanged — must NOT be modified. All: ${fnDiffs}`).toBe('unchanged');

        fs.rmSync(workspace, { recursive: true, force: true });
    }, 60_000);

    // Issue 378: when a route's handler function body is edited but the file
    // containing the function is NOT a member of the route's cluster, the L2a
    // feature graph (workspace variant) should STILL mark that cluster as
    // `modified` via the L2b cascade. Pre-fix observation: api-list:cluster:auth
    // correctly reported GET /user as modified (its sequence graph picked up
    // the body change), but feature:workspace's auth cluster stayed
    // `unchanged` because the rebuildFile cascade's upgrade pass didn't reach
    // every feature graph that contains the cluster.
    it('upgrades feature:workspace cluster diff when a route handler body changes (#378)', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-cascade-'));
        const codeatlasDir = path.join(workspace, '.codeatlas');
        fs.mkdirSync(path.join(workspace, 'src/routes/auth'), { recursive: true });

        // auth.service.ts holds the function we'll edit
        fs.writeFileSync(path.join(workspace, 'src/routes/auth/auth.service.ts'), `
export const getCurrentUser = async (id: number) => {
    if (!id) throw new Error('id required');
    return { id, name: 'user' };
};
`);
        // auth.controller.ts holds the route — this is the file in the auth
        // cluster's member files (cluster membership tracks controllers, not
        // service-layer files)
        fs.writeFileSync(path.join(workspace, 'src/routes/auth/auth.controller.ts'), `
import { Router } from 'express';
import { getCurrentUser } from './auth.service';
const router = Router();
router.get('/user', async (req: any, res: any) => {
    const u = await getCurrentUser(req.auth?.user?.id);
    res.json({ user: u });
});
export default router;
`);

        const store = new SnapshotStore(codeatlasDir);
        const sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();

        // Edit getCurrentUser body — adds lines that won't change any cluster
        // membership (auth.service.ts isn't in any cluster's files), but its
        // flow graph + the GET /user sequence graph + auth's api-list must
        // all reflect the change → feature:workspace cluster:auth modified.
        fs.writeFileSync(path.join(workspace, 'src/routes/auth/auth.service.ts'), `
export const getCurrentUser = async (id: number) => {
    console.log('VERIFY-378 line 1');
    console.log('VERIFY-378 line 2');
    if (!id) throw new Error('id required');
    return { id, name: 'user' };
};
`);
        await sync.rebuildFile(path.join(workspace, 'src/routes/auth/auth.service.ts'));

        const w = store.getWorking();
        // L4 / flow / sequence must all show the change (sanity guardrails)
        const flow = w.graphs[`flow:src/routes/auth/auth.service.ts:getCurrentUser`];
        expect(flow, 'flow graph must exist').toBeDefined();
        expect(flow.nodes.some(n => n.diff === 'added' || n.diff === 'modified'), 'flow graph must reflect added/modified lines').toBe(true);

        // L2b api-list must mark the GET /user route modified
        const authClusterId = Object.keys(w.clusters ?? {}).find(k => k.includes('auth'));
        expect(authClusterId, 'expected an auth cluster').toBeDefined();
        const apiList = w.graphs[`api-list:${authClusterId}`];
        expect(apiList, 'api-list for the auth cluster must exist').toBeDefined();
        const modifiedApis = ((apiList.meta as any).apis as any[]).filter(a => a.diff && a.diff !== 'unchanged');
        expect(modifiedApis.length, 'L2b auth api-list must have at least one modified route').toBeGreaterThan(0);

        // L2a feature:workspace must mark cluster:auth modified.
        // Pre-fix: the cascade didn't reach the workspace variant and this assertion failed.
        const fw = w.graphs['feature:workspace'];
        expect(fw, 'feature:workspace must exist').toBeDefined();
        const authNode = fw.nodes.find(n => n.clusterMembership === authClusterId);
        const allClusterDiffs = fw.nodes
            .filter(n => n.type === 'cluster')
            .map(n => `${n.label}(${n.clusterMembership})=${n.diff}`)
            .join(', ');
        expect(authNode, `auth cluster node must exist in feature:workspace. Cluster nodes: ${allClusterDiffs}`).toBeDefined();
        expect(authNode!.diff,
            `feature:workspace cluster:auth must be modified after route handler body edit. Got '${authNode!.diff}'. All cluster diffs: ${allClusterDiffs}`
        ).toBe('modified');

        fs.rmSync(workspace, { recursive: true, force: true });
    }, 60_000);

    // Issue #423 Pattern A — Non-Express APIs (SCREEN / mobile / framework) get
    // incorrectly REMOVED from working.apiIndex on every rebuildFile, because
    // the removal loop at line 1356-1363 compares against `detectApis(...)`
    // output only — which is Express-only — instead of the union of all
    // detectors that produced apis at init time. Net effect: edit + revert
    // leaves the working snapshot missing one (or more) apis per cascade,
    // which then propagates up through service.exposedApiCount → L1 service
    // node permanently marked `modified` even after the file is byte-restored.
    //
    // Reproduces in js-nextjs (9 of 12 FAIL_REVERT_NOT_CLEAN repos affected):
    // app/[page]/page.tsx::Page produces a SCREEN api at init. A rebuild
    // (with identical content!) drops it. baseline has 8 apis for service:app,
    // working has 7 → diffServices reports modified.
    // Issue #423 (ts-apollo residual) — cascade rebuild of an IMPORTING file's
    // class-method flow graph reconstructs `oldFnCode` from
    // `baselineFn.signature + bodyText`. For a class method, the stored
    // `signature` is method-shape ("async reportSchema(args)") with NO
    // `function` keyword. The reconstruction `${signature} {\n${bodyText}\n}`
    // yields `async reportSchema(args) { ... }` — NOT a valid top-level
    // function declaration. parseFirstFunction either throws or fails to find
    // a function → diffMap is null → and worse, the *new* `fnCode` for the
    // same method DOES get a `function ` prefix at line 1310, so newCode is
    // valid but oldCode isn't. The asymmetric parse produces an EMPTY
    // baseline-flat set → every working statement looks `added`. The
    // affected flow graph for ts-apollo's `schemaReporter.ts::reportSchema`
    // shows 11 nodes as `added` after revert even though the file is
    // byte-identical to baseline. Identical fix: prepend `function ` to the
    // reconstructed signature when it lacks the keyword, mirroring the
    // existing `fnCode` reconstruction.
    it('rebuilds importing-file class-method flow graphs without phantom added nodes (#423 ts-apollo)', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-class-import-'));
        const codeatlasDir = path.join(workspace, '.codeatlas');
        fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });

        // Importer: a class with a method.
        fs.writeFileSync(path.join(workspace, 'src/reporter.ts'), `
import { helper } from './helper';

export class Reporter {
    async reportSchema(payload: string) {
        const data = await helper(payload);
        if (!data) {
            throw new Error('no data');
        }
        return data;
    }
}
`);
        // Imported file (the one we'll edit).
        fs.writeFileSync(path.join(workspace, 'src/helper.ts'), `
export function helper(input: string) {
    return { value: input.length };
}
`);

        const store = new SnapshotStore(codeatlasDir);
        const sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();

        // Precondition: flow graph for the class method exists at baseline.
        const flowKey = 'flow:src/reporter.ts:reportSchema';
        const baselineFlow = store.getBaseline().graphs[flowKey];
        expect(baselineFlow, `baseline must have ${flowKey}`).toBeDefined();
        const baselineAddedCount = baselineFlow.nodes.filter(n => n.diff === 'added').length;
        // At baseline (no edit), no nodes should be `added`.
        expect(baselineAddedCount, 'baseline flow should have zero added nodes').toBe(0);

        // Edit + revert the IMPORTED file (helper.ts). This triggers the
        // cascade-rebuild of importer files (reporter.ts), which exercises
        // the oldFnCode reconstruction path for the class method.
        const helperPath = path.join(workspace, 'src/helper.ts');
        fs.writeFileSync(helperPath, `
export function helper(input: string) {
    const _probe_marker_123 = 42;
    return { value: input.length };
}
`);
        await sync.rebuildFile(helperPath);

        // Revert
        fs.writeFileSync(helperPath, `
export function helper(input: string) {
    return { value: input.length };
}
`);
        await sync.rebuildFile(helperPath);

        // After revert, the importer's class-method flow graph should have
        // zero `added` nodes — the function body is unchanged in BOTH
        // working and baseline. Pre-fix: 5+ statements show `added` because
        // oldFnCode parses to nothing.
        const workingFlow = store.getWorking().graphs[flowKey];
        expect(workingFlow, `working must have ${flowKey}`).toBeDefined();
        const addedNodes = workingFlow.nodes.filter(n => n.diff === 'added');
        expect(
            addedNodes.length,
            `class-method flow should have zero added nodes when its body matches baseline. Got: ${addedNodes.map(n => n.label?.slice(0, 50)).join(', ')}`,
        ).toBe(0);

        fs.rmSync(workspace, { recursive: true, force: true });
    }, 60_000);

    it('preserves Next.js SCREEN apis across edit + revert rebuildFile cycle (Issue #423 Pattern A)', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-screen-'));
        const codeatlasDir = path.join(workspace, '.codeatlas');
        fs.mkdirSync(path.join(workspace, 'app', '[page]'), { recursive: true });

        const filePath = 'app/[page]/page.tsx';
        const fullPath = path.join(workspace, filePath);
        const content = `
import Footer from "components/layout/footer";

export default function Page() {
  return (
    <>
      <div className="w-full">
        <div className="mx-8 max-w-2xl py-20 sm:mx-auto">Content</div>
      </div>
      <Footer />
    </>
  );
}
`;
        fs.writeFileSync(fullPath, content);

        const store = new SnapshotStore(codeatlasDir);
        const sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();

        // Precondition: init detected the SCREEN api for the page file.
        const screenApiId = `SCREEN:/[page]::${filePath}::Page`;
        const wBefore = store.getWorking();
        expect(
            wBefore.apiIndex[screenApiId],
            `precondition: init should detect SCREEN api ${screenApiId}, found apis for ${filePath}: ${Object.values(wBefore.apiIndex).filter(a => a.filePath === filePath).map(a => a.apiId).join(', ')}`,
        ).toBeDefined();

        // Step 1: apply an edit (insert a probe statement in Page body, like the live driver does)
        const edited = content.replace(
            'export default function Page() {',
            'export default function Page() {\n  const _probe_marker = 12345;',
        );
        fs.writeFileSync(fullPath, edited);
        await sync.rebuildFile(fullPath);

        // After the edit rebuild, the SCREEN api should still be present
        // (the body change doesn't remove the default export).
        const wAfterEdit = store.getWorking();
        expect(
            wAfterEdit.apiIndex[screenApiId],
            `post-edit: SCREEN api ${screenApiId} should remain. ` +
            `apis for ${filePath}: ${Object.values(wAfterEdit.apiIndex).filter(a => a.filePath === filePath).map(a => a.apiId).join(', ')}`,
        ).toBeDefined();

        // Step 2: revert the file back to original content
        fs.writeFileSync(fullPath, content);
        await sync.rebuildFile(fullPath);

        const wAfterRevert = store.getWorking();
        const screenApi = wAfterRevert.apiIndex[screenApiId];
        expect(
            screenApi,
            `post-revert: SCREEN api ${screenApiId} should still be present. ` +
            `apis for ${filePath}: ${Object.values(wAfterRevert.apiIndex).filter(a => a.filePath === filePath).map(a => a.apiId).join(', ')}`,
        ).toBeDefined();

        fs.rmSync(workspace, { recursive: true, force: true });
    }, 60_000);

    // BUG-EXPLORE-1 (2026-07-15): a single-file rebuild of a mounted sub-router
    // must KEEP the mount prefix. The `/api` mount (`app.use('/api', router)`)
    // lives in a DIFFERENT file (app.ts) whose in-memory `.content` is dropped
    // after the initial save() (lazy-content #354/#355). rebuildFile re-runs
    // applyMountPrefixes, but it built its mount table from `rec.content` only —
    // so the mount file was invisible during rebuild and the edited router's
    // routes came out UNPREFIXED (`/api/tags` → `/tags`). Their apiId then no
    // longer matched the prefixed baseline → every route in the edited file was
    // falsely flagged `added`, and an edit+revert never returned to clean. The
    // fix falls back to the lazily-persisted content via getFileContent.
    it('preserves the cross-file mount prefix across a single-file rebuild + revert (BUG-EXPLORE-1)', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-mount-'));
        const codeatlasDir = path.join(workspace, '.codeatlas');
        fs.mkdirSync(path.join(workspace, 'src', 'routes'), { recursive: true });

        // Entry file declares the `/api` mount for the tags sub-router.
        fs.writeFileSync(path.join(workspace, 'src', 'app.ts'), `
import express from 'express';
import tagsRouter from './routes/tag.controller';
const app = express();
app.use('/api', tagsRouter);
export default app;
`);
        const tagFile = 'src/routes/tag.controller.ts';
        const tagFull = path.join(workspace, tagFile);
        const original = `
import { Router } from 'express';
const router = Router();
router.get('/tags', async (req, res) => { res.json({ tags: [] }); });
export default router;
`;
        fs.writeFileSync(tagFull, original);

        const store = new SnapshotStore(codeatlasDir);
        const sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();

        const tagRoutes = (w: ReturnType<typeof store.getWorking>) =>
            Object.values(w.apiIndex).filter(a => a.filePath === tagFile).map(a => a.route).sort();

        // Init: the mount prefix is applied.
        expect(tagRoutes(store.getWorking()), 'init should mount /api/tags').toEqual(['/api/tags']);

        // Edit: add a sibling route (shifts byte offsets, forces a rebuild).
        fs.writeFileSync(tagFull, `
import { Router } from 'express';
const router = Router();
router.get('/tags', async (req, res) => { res.json({ tags: [] }); });
router.get('/tags/trending', async (req, res) => { res.json({ tags: [] }); });
export default router;
`);
        await sync.rebuildFile(tagFull);

        // Regression: BOTH routes must keep the /api prefix — none should be the
        // bare unprefixed form the lazy-content bug produced.
        const afterEdit = tagRoutes(store.getWorking());
        expect(afterEdit, 'rebuild must preserve the /api mount prefix').toEqual(['/api/tags', '/api/tags/trending']);
        expect(afterEdit.some(r => r === '/tags'), 'no route should lose its prefix').toBe(false);

        // Revert: back to the clean single prefixed route (edit+revert is clean).
        fs.writeFileSync(tagFull, original);
        await sync.rebuildFile(tagFull);
        expect(tagRoutes(store.getWorking()), 'revert should restore just /api/tags').toEqual(['/api/tags']);

        fs.rmSync(workspace, { recursive: true, force: true });
    }, 60_000);

    // PERF (2026-07-15): the VSIX `requestRoute` handler re-cascaded live diff
    // annotations on EVERY navigation (~1s/drill-down). `needsLiveGraphCascade`
    // gates it: set on file change, cleared by the cascade, so read-only
    // navigation skips the redundant pass.
    it('needsLiveGraphCascade gates the per-navigation cascade (PERF)', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-gate-'));
        fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
        const filePath = 'src/app.js';
        const fullPath = path.join(workspace, filePath);
        fs.writeFileSync(fullPath, `function greet(n){ return 'hi ' + n; }\nmodule.exports = { greet };\n`);

        const store = new SnapshotStore(path.join(workspace, '.codeatlas'));
        const sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();

        // A cascade clears the flag → the next read-only navigation can skip it.
        sync.applyDiffCascadeToLiveGraphs();
        expect(sync.needsLiveGraphCascade, 'clean after a cascade').toBe(false);

        // A file save re-arms it synchronously (before the debounced rebuild).
        fs.writeFileSync(fullPath, `function greet(n){ return 'hey ' + n; }\nmodule.exports = { greet };\n`);
        sync.handleFileSave(fullPath);
        expect(sync.needsLiveGraphCascade, 'dirty after a file save').toBe(true);

        // Cascading again clears it.
        sync.applyDiffCascadeToLiveGraphs();
        expect(sync.needsLiveGraphCascade, 'clean again after re-cascade').toBe(false);

        fs.rmSync(workspace, { recursive: true, force: true });
    }, 60_000);
});
