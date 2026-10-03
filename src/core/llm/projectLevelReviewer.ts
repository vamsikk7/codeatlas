/**
 * projectLevelReviewer.ts — review project-level files that don't sit on a
 * single entry point but cut across many (#515 — Cross-entry-point review pass (config + handlers shared infra)).
 *
 * Per-entry-point review misses:
 *   - Hardcoded secrets / weak defaults in config + auth modules.
 *   - Error-handler middleware that leaks messages.
 *   - DTO validation gaps in shared services (input validators, Zod schemas
 *     missing).
 *   - Global server config (CORS wide-open, helmet not registered, etc.).
 *
 * This module runs alongside `perEntryReviewer`. It picks a handful of
 * project-level files via heuristics, packages them as one prompt, and
 * emits findings bound to `microservice:workspace` + the relevant `file:` graph.
 */

import type { SnapshotStore } from '../storage/snapshotStore';
import type {
    AiReviewFinding, AiReviewBaselineRef, AiReviewBinding, AiReviewSeverity, AiReviewCategory,
} from '../graph/graphTypes';
import { evidenceMatches, reviewedEntryPointFiles } from './perEntryReviewer';
import { calibrateSeverity } from './findingPostProcess';
import { unifiedDiffWindow } from '../diff/lineDiff';
import { redactSecrets } from './llmNamingService';
import { buildDependentsForFiles, type FileDependents } from './dependencyContext';

export interface ProjectLevelLlmCall {
    (prompt: { system: string; user: string }, opts?: { signal?: AbortSignal }): Promise<{
        findings: ProjectRawFinding[];
    }>;
}

export interface ProjectRawFinding {
    severity: AiReviewSeverity;
    category: AiReviewCategory;
    title: string;
    body: string;
    /** Which file in the bundle the finding applies to (must match a path we sent). */
    filePath: string;
    symbol?: string;
    evidence?: { snippet: string; lineStart?: number; lineEnd?: number };
}

export interface ProjectReviewRunResult {
    files: string[];
    reviewed: boolean;
    findingsCount: number;
    durationMs: number;
    /** #883 — changed files reviewed (diff-windowed) by the coverage pass. */
    changedReviewed?: number;
    /** #883 — global cross-cutting infra files reviewed. */
    infraReviewed?: number;
    /** #883 — number of LLM batches the pass fanned out into. */
    batches?: number;
    /** #883 — changed files beyond the cap that were NOT reviewed (logged, never silent). */
    overflow?: number;
}

const MAX_FILES = 6;
const MAX_BYTES_PER_FILE = 6_000;     // total bundle bound ≈ 36 KB
const MAX_TOTAL_BYTES = 30_000;
// #942 refinement — once a batch is this full, a change of top-level SUBSYSTEM
// starts a new batch, so an UNRELATED subsystem isn't packed into the same review
// call as the PR's changed core. The #942 path-sort already keeps a subsystem's
// files contiguous; without this the byte-budget boundary fell mid-list and mixed
// e.g. salesforce into the OAuth-core batch (cal.com#11059), where its noise
// distracted the model and inflated false positives (FPs 2→7 across re-samples).
const BATCH_SOFT_FILL_FRACTION = 0.6;
// A file's "subsystem" = its first ≤3 directory segments (app-store/<app>,
// packages/<pkg>, services/<svc>). Deep, uniform trees (e.g. keycloak
// services/src/main/...) collapse to one key → no extra breaks (behavior
// preserved); shallow per-app monorepo trees split on the app boundary.
function subsystemKey(fp: string): string {
    const parts = fp.split('/').filter(Boolean);
    parts.pop(); // drop filename
    return parts.slice(0, 3).join('/') || '(root)';
}

/**
 * Heuristic: pick the cross-cutting files worth a project-level review.
 * Order: config + auth + middleware + error handling > main/app entry.
 *
 * Returns the file paths in priority order.
 */
export function selectProjectLevelFiles(store: SnapshotStore): string[] {
    const snapshot = store.getWorking();
    const allFiles = Object.keys(snapshot.files ?? {});
    const candidates: Array<{ fp: string; priority: number }> = [];

    for (const fp of allFiles) {
        const lower = fp.toLowerCase();
        let p = 0;
        // Tier 1: auth + secrets
        if (/(^|\/)(auth|jwt|token|session)[^/]*\.(ts|js|mjs|cjs|tsx|jsx)$/i.test(fp)) p = 100;
        // Tier 2: middleware + error handlers
        else if (/(^|\/)(middleware|errors?|error-?handler|exception)[^/]*\.(ts|js)$/i.test(fp)) p = 90;
        else if (lower.includes('/middleware/') || lower.includes('/middlewares/')) p = 85;
        else if (lower.includes('/errors/') || lower.includes('/exception-filters/')) p = 85;
        // Tier 3: server entry
        else if (/(^|\/)(main|app|server|index)\.(ts|js)$/i.test(fp)) p = 70;
        // Tier 4: config
        else if (/(^|\/)config[^/]*\.(ts|js|json)$/i.test(fp)) p = 60;
        else if (lower.includes('/config/')) p = 55;
        // Tier 5: shared DTOs / validators
        else if (lower.includes('/dto/') || lower.includes('/dtos/') || lower.includes('/validators/')) p = 40;

        if (p > 0) candidates.push({ fp, priority: p });
    }
    candidates.sort((a, b) => b.priority - a.priority);
    return candidates.slice(0, MAX_FILES).map((c) => c.fp);
}

// #883 — diff-aware coverage. The entry-anchored review (per-entry packs) only
// shows the model the code of files that OWN an entry point. Every other changed
// file — services, models, ORM, internal logic — is reviewed-blind. These caps
// bound the changed-file pass; overflow is logged, never silently dropped.
// Shared source-extension test (exported so reviewPrCli reuses the SAME literal
// instead of a drifting duplicate). #884 added .vue/.svelte/.es6/.scala/.ex/.exs.
// #930 added sh/bash/zsh/sql: a PR's logic bugs live in scripts + migrations too
// (cal.com #22532's golden bug was a macOS-only `sed -i ''` in a CI shell script;
// migrations carry real schema-logic bugs). They were excluded → reviewed-blind.
// #933 added style + template langs (scss/sass/css/less/styl + erb/haml/slim/hbs/
// handlebars): styling + template bugs are real review targets — an inverted color
// lightness, a typo'd vendor prefix, an `end if` in an ERB view, an unescaped URL
// interpolation (XSS). Discourse #5/#7 (SCSS) + #4 G6 (ERB) were reviewed-blind.
// #937 added i18n/translation langs (properties/po/pot/xliff/xlf/resx/arb): a wrong-
// language string, a dropped/extra format placeholder, or a malformed key in a locale
// file is a real bug (keycloak #37429: Italian text in messages_lt.properties, Traditional
// Chinese in messages_zh_CN.properties) — these files were never reviewed.
export const SOURCE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|py|pyw|java|kt|kts|go|rs|c|h|cpp|cc|cxx|hpp|hxx|cs|php|rb|swift|dart|prisma|vue|svelte|es6|scala|ex|exs|sh|bash|zsh|sql|scss|sass|css|less|styl|erb|haml|slim|hbs|handlebars|properties|po|pot|xliff|xlf|resx|arb)$/i;

// #884 — within the changed-file budget, review PRODUCTION logic before tests
// and pure presentation. Without this, a big PR's test/UI files crowd out the
// backend code (grafana #90939: 44/136 changed files are tests) and the 60-file
// cap leaves real logic reviewed-blind. Tier 0 (logic) < 1 (presentation) < 2
// (tests); a stable sort by tier fills the cap with logic first. Tests are
// deprioritized, NOT excluded — test-quality bugs are real (golden #105/#122/
// #127), so they're reviewed when budget remains.
export const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?|testdata|fixtures?)\//i;
const TEST_NAME = /[._-](?:test|spec|stories|story)\.[^/]+$|(?:^|\/)test_[^/]*\.py$|_test\.(?:go|py|java|kt|rb|rs|ex|exs)$/i;
// #933/#937 — style, template + i18n files rank as presentation (tier 1): reviewed
// after production logic but before tests, so they never crowd out backend code.
const PRESENTATION_EXT = /\.(?:tsx|jsx|vue|svelte|scss|sass|css|less|styl|erb|haml|slim|hbs|handlebars|properties|po|pot|xliff|xlf|resx|arb)$/i;
export function fileTier(fp: string): number {
    if (TEST_PATH.test(fp) || TEST_NAME.test(fp)) return 2;
    if (PRESENTATION_EXT.test(fp)) return 1;
    return 0;
}

// Read at call time (env-tunable + testable), like the #3 entry cap.
// #921 — default raised 60→150 to fully cover large PRs (grafana #90939=135
// changed files, sentry-greptile #5=104); batches 6→20 so 150 windowed files
// (~8/batch) fit. Tune down for tighter token budgets via the env vars.
const changedFileCap = (): number => Number(process.env.CODEATLAS_REVIEW_CHANGED_FILE_CAP) || 150;
const maxBatches = (): number => Number(process.env.CODEATLAS_REVIEW_PROJECT_BATCHES) || 20;
// #930 — 80 gutted large single-file changes: cal.com #22345 is a 155-line change
// in ONE non-entry file, so an 80-line window dropped roughly half the diff. Default
// 200 (env-tunable), read at call time so tests + tight token budgets can override.
const windowMaxLines = (): number => Number(process.env.CODEATLAS_REVIEW_WINDOW_MAX_LINES) || 200;
// #22345 — a changed block's correctness often hinges on a nearby UNCHANGED line
// (the `userIdsFromOrg` binding + `teamsFromOrg.length > 0` guard sat ~7 lines
// from the change, just outside a 6-line window → collapsed into a `… N unchanged
// …` gap, so the reviewer couldn't see what the change broke). Widened 6→10 to
// keep load-bearing adjacent context in-window. Bounded by windowMaxLines (changed
// lines are always emitted; maxLines caps only context, #938), and #941 already
// removed the unrelated-file bloat that would make extra context expensive.
// Env-tunable, read at call time.
const windowContext = (): number => Number(process.env.CODEATLAS_REVIEW_WINDOW_CONTEXT) || 10;

/**
 * #883 — changed source files NOT already covered by a per-entry pack (i.e. not
 * the filePath of any changed entry point). These are the reviewed-blind files;
 * the cross-file pass reviews them diff-windowed so their changed code reaches
 * the model. Empty when working === baseline (a fresh full review), so the pass
 * degrades to the global-infra heuristic exactly as before.
 */
export function selectUncoveredChangedFiles(store: SnapshotStore): string[] {
    const working = store.getWorking();
    const baseline = store.getBaseline?.() ?? ({ files: {} } as any);
    // #934 — exclude only the files the per-entry pass ACTUALLY reviews (cap-aware),
    // not EVERY entry-anchored file. selectEntryPoints applies the changed-scope cap
    // (default 25), so when a shared definition/routes file marks hundreds of entries
    // changed, the controllers/migrations whose entry ranks beyond the cap are reviewed
    // by NEITHER pass unless they fall through to here (discourse #10 G2 controller +
    // G4 migration, #4 G4 embed_controller were stranded this way).
    const reviewedFiles = reviewedEntryPointFiles(store);
    const out: string[] = [];
    for (const fp of Object.keys(working.files ?? {})) {
        if (!SOURCE_EXT.test(fp)) continue;
        const w = (working.files as any)[fp]?.hash;
        const b = (baseline.files as any)?.[fp]?.hash;
        if (b !== undefined && w !== undefined && w === b) continue; // unchanged
        if (b === undefined && w === undefined) continue;            // no content either side
        // #931 — a presentation component (.tsx/.jsx/.vue/.svelte) is poorly served
        // by the per-entry handler-slice model: a React/Vue component is not an HTTP
        // handler, and a spurious frontend extraction (e.g. a `useMutation()` call
        // tagged `method:NETWORK`) can mis-anchor it, so the entry pack ships one
        // degenerate slice while the file's real diff is never shown (cal.com #14740 G5).
        // Always route changed presentation files through the diff-windowed project
        // pass, even when something tagged them entry-anchored.
        if (reviewedFiles.has(fp) && !PRESENTATION_EXT.test(fp)) continue; // genuinely reviewed per-entry
        out.push(fp);
    }
    // #884 — production logic first, presentation next, tests last, so the
    // changed-file cap is spent on the code most likely to carry bugs.
    // #942 — within a tier, secondary-sort by path so a PR's coupled files (e.g.
    // an interface + its impl in the same package: keycloak's AdminPermissions +
    // ClientPermissionsV2 under .../permissions/) cluster into the SAME byte-budget
    // batch. Fragmenting them across separate project-pass calls destroys the
    // cross-file reasoning a contract/inconsistency bug requires (keycloak#36880).
    return out.sort((a, b) => fileTier(a) - fileTier(b) || a.localeCompare(b));
}

/**
 * Line-based diff window: changed lines (vs baseline) ± context, line-numbered,
 * with `… N unchanged …` gap markers, capped at windowMaxLines(). Self-contained
 * (no core→mcp import); over-includes moved lines, which is fine for review
 * context. Falls back to the file head when small or baseline-less.
 */
export function diffWindow(working: string, baseline: string | undefined): string {
    // #925 — unified-diff window (`+`/`-` hunks, affected areas only) so the
    // changed-file pass shows the reviewer what changed, not the head code.
    const maxLines = windowMaxLines();
    const d = unifiedDiffWindow(working, baseline, { contextLines: windowContext(), maxLines });
    // Empty only when content is byte-identical (rename/move) — show the head then.
    return d || working.split('\n').slice(0, maxLines).map((l, i) => `${i + 1}: ${l}`).join('\n');
}

interface FileBundleItem {
    filePath: string;
    content: string;
}

function buildPrompt(bundle: FileBundleItem[], guidelines: string, dependents?: FileDependents[]): { system: string; user: string; sourceCorpus: string } {
    const system = [
        'You are a senior code reviewer for a multi-layer codebase.',
        'You are reviewing the CHANGED files in a pull request plus shared cross-cutting infrastructure —',
        'the files that no single HTTP entry point owns (services, models, ORM/data layers, internal logic, auth/config/middleware).',
        'Changed files are shown as a UNIFIED DIFF — `+N: <added line>`, `-     <removed line>`, ` N: <context>`, with `… N unchanged …` gap markers between hunks.',
        'Focus on the `+`/`-` lines — that is exactly what this PR changed. Reason about what the change BREAKS (a bug the diff introduced), not pre-existing code.',
        '',
        'Find real bugs in the CHANGED code (#883/#881 — the families real reviewers flag): null/undefined deref, async ordering /',
        'unawaited promises / check-then-act races, logic slips (inverted &&/||, off-by-one, wrong var, unreachable, dup-def), reference',
        'equality on objects/dates, case/normalization bypass, type/contract mismatch, unvalidated input → sensitive sink, ORM/query',
        'pitfalls, resource-cleanup / orphaned state, wrong authorization resolution, logging hygiene (wrong level / over-logging on hot',
        'paths / secrets or PII in logs / dropped trace id), behavior-change regressions (a non-blocking/non-fatal path made blocking/fatal),',
        'config hardcoding (a literal bypassing a configurable setting), CSRF / weak-or-predictable state tokens, recursion / self-delegation',
        '(recursing through the cache/session not the delegate), and wrong/misleading return values. PLUS the cross-cutting infra concerns: hardcoded',
        'secrets / weak defaults, error-handler info leaks, global middleware misconfig, missing DTO/schema validation, CORS wildcards.',
        'WEB-SECURITY SINKS (#945 — flag the SINK on the changed line, no caller needed): SSRF — a non-constant/user/feed URL',
        '  passed to an HTTP fetcher (Ruby `open(url)`/`URI.open`/`Net::HTTP`, `requests.get`, `fetch`, `axios`) with no host',
        '  allowlist. XSS — interpolating a URL- or user-derived value into HTML markup, especially via `raw`/`html_safe`/',
        '  `dangerouslySetInnerHTML` or unescaped template output. postMessage — an origin check via `indexOf`/substring/',
        '  `includes` (instead of EXACT equality) is bypassable (`evil-yoursite.com`), and a `targetOrigin` that is a full',
        '  URL/referer instead of a bare origin (scheme+host+port) leaks the message. Clickjacking — `X-Frame-Options: ALLOWALL`',
        '  / removing frame protection, or referer-based framing checks that are spoofable or fall back to "" on a nil referer.',
        'CROSS-METHOD / VERSION CONSISTENCY (#945): when a method has OVERLOADS or V1/V2 variants, diff their permission/scope',
        '  argument sets — flag a no-arg/aggregate variant that grants a STRONGER capability (e.g. returns true for MANAGE)',
        '  while requiring only the WEAKER scope (VIEW) that a sibling uses. When changed code is gated by a feature flag,',
        '  check whether a sibling path keys off a DIFFERENT version of that flag (V1 vs V2) and whether new V2 behavior needs',
        '  the same guard/cleanup. LOOKUP KEY CONSISTENCY: when a value is passed as a key into a lookup/resolver, verify the',
        '  resolver keys on the SAME kind (id vs name) and EVERY param (name AND owner/scope) matches how that record was',
        '  CREATED elsewhere — flag `getId()` passed where the callee does `findByName` (or owner=getClientId() on create vs',
        '  owner=getId() on lookup), especially when the miss silently falls back to a type-level/all-* resource. RETURN',
        '  CONTRACT: a method returning a collection that callers treat as entity IDs must yield real per-entity IDs — flag',
        '  returning a type-level/aggregate resource’s literal name (e.g. "Clients") as a phantom id.',
        'JAVA null-safety (#945): `Optional.get()` / `.findFirst().get()` / `.orElseThrow()`-absent without an `isPresent()`',
        '  guard is a null-deref (NoSuchElementException) — name it like any null deref. Enumerate EVERY instance of a flagged',
        '  pattern (do not stop at the first), and spend findings on PRODUCTION code before test/fixture/support files.',
        'NEWLY-ADDED FILE (#945): when a changed file is shown as an all-`+` NEW FILE (no `-`/context to anchor on), the',
        '  "focus on +/- lines" rule gives no signal — instead AUDIT EVERY added method against its siblings/overloads and the',
        '  interface/contract it implements (scope sets, key types, return shapes), as you would in a full file review.',
        'For CHANGED style/template files (#933): in .scss/.sass/.css/.less flag clearly-WRONG values — an inverted color',
        '  lightness (a flip in EITHER direction, ANY magnitude — 30↔70, 30→50, 70→30, 20→50), an invalid or misspelled',
        '  vendor prefix (e.g. `-ms-align-items` — the real one is `-ms-flex-align`), a broken/typo unit, or a layout',
        '  property removed such that an element collapses. #945 DISCRIMINATOR for theme refactors (e.g. a bulk',
        '  `scale-color($x, $lightness: N%)` → `dark-light-choose(scale-color($x, N%), scale-color($y, M%))` sweep): the',
        '  FIRST arg of `dark-light-choose` is the LIGHT-theme value and MUST reproduce the REMOVED `scale-color` lightness',
        '  VERBATIM — flag every hunk where the new first-arg % differs from the deleted line’s %, even when surrounded',
        '  by hundreds of correct conversions (the correct majority is NOT evidence the outliers are intended). In .erb/.haml/',
        '  .slim/.hbs/.handlebars templates flag broken control-flow syntax (e.g. a Ruby `end if` closing a block), UNESCAPED',
        '  interpolation of user- or URL-derived data into HTML (XSS), and the wrong block helper. Pure cosmetic nits (naming,',
        '  property ordering, whitespace) remain noise — only flag a value/syntax that is functionally wrong.',
        'For CHANGED i18n/translation files (#937 — .properties/.po/.xliff/.xlf/.resx/.arb): the file name encodes the target',
        '  locale (e.g. `messages_lt.properties` = Lithuanian, `_zh_CN` = Simplified Chinese). Flag a value written in the WRONG',
        '  language for that locale (e.g. Italian text inside a `_lt` file, Traditional Chinese inside `_zh_CN`), a changed key',
        '  whose format placeholders (`{0}`, `%s`, `{{name}}`) no longer match the other locales / the source string, and an',
        '  empty or obviously-untranslated value. Do NOT flag legitimate translations you simply cannot read.',
        'ENUMERATE — do NOT stop at the first/loudest finding (#947, the #1 measured miss): review EVERY distinct defect in each',
        '  touched function/class, and when a repeated pattern appears (a bulk conversion, parallel branches), evaluate EVERY',
        '  instance in EVERY changed file independently — a second co-located bug in the same hunk is the most common miss.',
        'CONTRACT changes — trace across files (#947): (a) a method whose return becomes nullable while its interface/Javadoc/type',
        '  promises non-null (counts/collections/models) only RELOCATES the NPE to callers — flag it, don’t accept it as a fix;',
        '  (b) a changed/added method parameter, a signature that now requires a non-null arg, or a parent that STOPS passing a',
        '  prop — check every implementer, caller, and the previously-valid null/absent path (incl. a UI action that toggles a',
        '  drawer/modal whose required prop is no longer passed → dead action); (c) a migration / raw-SQL backfill BYPASSES model',
        '  validation/normalization callbacks, so a new normalized-form lookup (bare/lowercased host, etc.) silently misses the',
        '  un-normalized migrated rows — normalize in the migration too.',
        'CACHE / CONCURRENCY in changed code (#947): a failed fetch must NOT overwrite a valid cached value with nil/empty (cache',
        '  poisoning on the error path); a cache/decorator wrapper’s internal calls must go through the wrapped DELEGATE, not',
        '  re-enter via `session.getProvider()`/the same factory (self-recursion / cache bypass); a shared map/cache read or',
        '  iteration, or a lazy `@x ||= …` memo, must hold the SAME mutex as its writers — especially against a background/watcher',
        '  goroutine (Go concurrent map read/write panic); after taking a write lock, re-read before rebuilding (check-then-act).',
        'DEFAULTS / DATA-FLOW / DEAD CODE (#947): flag a missing credential/token/secret defaulted to a LITERAL placeholder string',
        '  (e.g. `refresh_token ||= "refresh_token"` — silently invalidates it); a collection filtered/deduped into a NEW variable',
        '  while a downstream consumer (email/notify sender, createMany) still uses the RAW input; a guard like `if (x.length > 0)`',
        '  gating the SOLE source of a record category (silently drops valid results, e.g. org-level members); a cache/lookup key',
        '  that may arrive as both String and Symbol without normalization (`:en` ≠ `"en"` → double-load); a newly-added method',
        '  whose body only returns "not implemented"/panics while callers in the same change use it; a direct `System.exit()` /',
        '  `picocli.exit()` in command logic (skips cleanup, untestable).',
        'VALIDATORS / REGEX / IDENTIFIERS / TESTS (#947): in format/ID validators trace each substring index range AND the boolean',
        '  return polarity against the documented format — flag a valid input returning false (or invalid → true) or off-by-N',
        '  offsets; require allow/deny regexes built from a host/domain list to be ANCHORED with escaped dots (an unanchored',
        '  `@(#{domains})` matches subdomains so evil-example.com passes example.com); flag a newly-introduced identifier',
        '  misspelled vs its references/correctly-spelled siblings (breaks the binding); and in changed tests verify each request',
        '  helper’s HTTP verb (get/post/put/delete) matches the route/action under test — a wrong verb passes VACUOUSLY. In Rails',
        '  serializers a conditional-include method must end in `?` (`include_x?`); flag `"literal" << var` (mutates a frozen string).',
        'DEPENDENTS — dependency-aware cross-file reasoning (#946): the payload may include a `dependents` array,',
        '  one entry per changed file listing symbols in OTHER files that depend on it — `implementer` (a class',
        '  elsewhere implementing/extending a type this file defines), `sibling-impl` (another implementer of an',
        '  interface this file’s class implements), `caller` (a function elsewhere that calls a symbol changed here),',
        '  and `test` (a spec referencing this file). USE THEM to catch the contract bugs the diff alone hides:',
        '  • a changed method/interface signature (added/removed param, changed return type/shape) that an',
        '    `implementer`/`sibling-impl` did NOT update — flag the stale implementer (signature mismatch / broken',
        '    polymorphism), naming the dependent file; if the implementers are not shown as changed, the change',
        '    silently breaks them.',
        '  • a `caller` that assumes the OLD return shape/nullability/error behavior of a symbol you changed (dead',
        '    catch, missing null-check on the new path, `res.data` on a value that is now a different type).',
        '  • a `test` whose asserted behavior/verb/return contradicts the changed code.',
        '  Report the finding on a SENT file (quote its line); the dependent snippet is the corroborating context —',
        '  cite the dependent file/symbol by name in the body. Do NOT invent dependents beyond those provided.',
        'PRECISION GATES — apply to EVERY finding before you emit it (#948–#952; a missed nit costs far less than a false alarm):',
        '  • EVIDENCE-GATED (#948): the finding must rest on a CHANGED (`+`) line you can quote. If your only basis is hypothetical',
        '    — "could"/"may"/"might"/"possibly"/"in theory"/"if an attacker"/"what if" — and the triggering condition is NOT present',
        '    in the diff, DROP it. No speculative CSRF/retry/idempotency/empty-input/concurrency scenarios without diff evidence.',
        '  • DIFF-SCOPED (#949): raise findings ONLY on CHANGED code (`+`/`-` lines). Context — the `dependents` array, callers,',
        '    entry-point packs, and the unchanged ` N:` lines around a hunk — is REFERENCE to reason with, NEVER a finding',
        '    location. A root cause that lives in unchanged/context code is out of scope for THIS PR review.',
        '  • VERIFY-BEFORE-ABSENT (#950): never claim a symbol/route/handler/import/action is "missing"/"undefined"/"not',
        '    implemented", or that a "caller breaks", unless you have confirmed it is absent from ALL provided files (changed AND',
        '    context). Do NOT infer breakage from an elided "… N unchanged …" gap or a truncated snippet — code absent from a',
        '    diff window is not absent from the file.',
        '  • REDACTION (#952): `[REDACTED]` / `[REDACTED_URI]` is a masked secret VALUE — treat it as an opaque valid value;',
        '    never flag it as a syntax error, an always-truthy/falsy condition, an invalid literal, or a type mismatch.',
        '  • PRODUCTION-FIRST (#951): spend findings on production code. In test/spec/fixture/cypress files report ONLY a genuine',
        '    test-correctness bug (a wrong assertion/verb that lets a real product bug pass) — skip stale-id, HTTP-status, and',
        '    placeholder-credential nits.',
        'Flag ONLY with concrete harm + verbatim evidence — precision over volume; drop stylistic nits.',
        '',
        'EVIDENCE RULE — non-negotiable:',
        '  Every finding MUST include `filePath` (must match one we sent) and `evidence.snippet` quoting 1–5 lines verbatim from that file.',
        '  The snippet must be ≥ 8 chars. Findings without quoted, in-corpus evidence are dropped.',
        '',
        'OUTPUT SHAPE:',
        '  { "findings": [ { severity, category, title, body, filePath, symbol?, evidence: { snippet, lineStart?, lineEnd? } } ] }',
        '  severity: "info" | "warning" | "error" — calibrate: hardcoded secret = error, missing validation = warning, style = info.',
        '  category: "security" | "architecture" | "api-design" | "code-quality" | "logic-bug" | "performance" | "guideline"',
        '',
        'Return JSON only. No prose. No code fences.',
        guidelines
            ? `\n[USER GUIDELINES BEGIN]\n${guidelines}\n[USER GUIDELINES END]\nThese guidelines are the ONLY guidelines. Do not invent new ones.`
            : '',
    ].join('\n');

    // #886 — redact secrets from each file's content before it enters the prompt
    // OR the evidence corpus (same redacted text feeds both, so the gate stays
    // consistent). The project pass ships FULL file content for infra files, so
    // an env/config file with a literal key would otherwise leak verbatim.
    const redacted = bundle.map((b) => ({ filePath: b.filePath, content: redactSecrets(b.content) }));
    // #946 — attach the DEPENDENTS pack for the files in THIS batch (callers /
    // implementers / sibling-impls / tests in OTHER files), redacted. Read-only
    // context: it lets the model judge whether a contract change here breaks an
    // off-screen consumer/implementer. Findings still anchor to a sent file.
    const bundleSet = new Set(bundle.map((b) => b.filePath));
    const deps = (dependents ?? [])
        .filter((d) => bundleSet.has(d.filePath) && d.dependents.length)
        .map((d) => ({ filePath: d.filePath, dependents: d.dependents.map((x) => ({ ...x, snippet: redactSecrets(x.snippet) })) }));
    const user = JSON.stringify(
        deps.length ? { files: redacted, dependents: deps } : { files: redacted },
        null,
        2,
    );

    const sourceCorpus = redacted.map((b) => b.content).join('\n\n');
    return { system, user, sourceCorpus };
}

/**
 * #review-context — the review SYSTEM prompt only (instructions: the #883/#945–#947
 * bug-class taxonomy + #946 DEPENDENTS reasoning + #948–#952 PRECISION GATES + the
 * user guidelines), with no file payload. Exported so the extension, PR-watcher,
 * and MCP all surface the IDENTICAL reviewer instructions. The system prompt is
 * bundle-independent, so this delegates to buildPrompt with an empty bundle.
 */
export function buildReviewSystemPrompt(guidelines = ''): string {
    return buildPrompt([], guidelines).system;
}

export interface RunProjectLevelReviewArgs {
    store: SnapshotStore;
    llmCall: ProjectLevelLlmCall;
    model: string;
    signal?: AbortSignal;
    onFinding?: (finding: AiReviewFinding) => void;
    /** #513 — soft-toggle evidence gate. Default true. */
    evidenceGate?: boolean;
    /** #534 — provenance tag stamped on every finding in this run. */
    baselineRef?: AiReviewBaselineRef;
}

/**
 * Run a project-level review. Returns the run summary; findings are
 * persisted to the store via `upsertAiReviewFinding`.
 *
 * Bindings: every finding gets a `microservice:workspace` binding plus a
 * `file:<path>` binding so it surfaces on both L1 and the file's L4 view.
 */
/** Gate + persist one batch's findings. Extracted so every batch shares the
 *  #513 evidence gate + #516 severity calibration. Returns the kept count. */
function persistProjectFindings(
    args: RunProjectLevelReviewArgs,
    bundle: FileBundleItem[],
    result: { findings: ProjectRawFinding[] },
    sourceCorpus: string,
    guidelinesHash: string | undefined,
): number {
    const bundlePaths = new Set(bundle.map((b) => b.filePath));
    const gateEnabled = args.evidenceGate !== false;
    let kept = 0;
    for (const raw of result.findings ?? []) {
        // File must be one we sent — neutralises "model invented a file path".
        if (!raw.filePath || !bundlePaths.has(raw.filePath)) continue;
        // #513 evidence gate — snippet must appear in the file's (windowed) content.
        if (gateEnabled) {
            const fileItem = bundle.find((b) => b.filePath === raw.filePath);
            // #886 — gate against the SAME redacted text the model saw (the model
            // can only quote redacted lines; raw `fileItem.content` here would
            // false-reject a redacted-secret quote — redactSecrets is idempotent
            // on already-clean text so non-secret quotes still match verbatim).
            const corpus = redactSecrets(fileItem ? fileItem.content : sourceCorpus);
            if (!raw.evidence?.snippet || !evidenceMatches(raw.evidence.snippet, corpus)) continue;
        }
        const bindings: AiReviewBinding[] = [
            { graphId: 'microservice:workspace', targetId: `project::${raw.filePath}`, targetType: 'node', layer: 'microservice' },
            { graphId: `file:${raw.filePath}`, targetId: raw.symbol ?? raw.filePath, targetType: 'node', layer: 'file' },
        ];
        // #516 — calibrate severity based on the evidence snippet (if any).
        const calibrated = calibrateSeverity({ severity: raw.severity, category: raw.category, snippet: raw.evidence?.snippet ?? '' });
        const body = calibrated.calibrationReason
            ? `${raw.body}\n\n[Severity calibrated to ${calibrated.severity}: ${calibrated.calibrationReason}]`
            : raw.body;
        const f = args.store.upsertAiReviewFinding({
            entryPointId: `project::${raw.filePath}`,
            bindings,
            severity: calibrated.severity,
            category: raw.category,
            title: raw.title,
            body,
            anchor: { filePath: raw.filePath, symbol: raw.symbol, snippet: raw.evidence?.snippet, lineStart: raw.evidence?.lineStart, lineEnd: raw.evidence?.lineEnd } as any,
            status: 'open',
            model: args.model,
            guidelinesHash,
            ...(args.baselineRef ? { baselineRef: args.baselineRef } : {}),
        } as any);
        args.onFinding?.(f);
        kept += 1;
    }
    return kept;
}

export async function runProjectLevelReview(args: RunProjectLevelReviewArgs): Promise<ProjectReviewRunResult> {
    const started = Date.now();
    const guidelines = args.store.getReviewGuidelines();

    // #883 — diff-aware coverage: review the changed files no entry point covers
    // (diff-windowed) PLUS the cross-cutting global-infra files. With no diff
    // (fresh full review) `changed` is empty and this reduces to the original
    // infra-only pass — backward compatible.
    const allChanged = selectUncoveredChangedFiles(args.store);
    const changed = allChanged.slice(0, changedFileCap());
    const overflow = allChanged.length - changed.length;
    const infra = selectProjectLevelFiles(args.store);

    // Build review items: changed files windowed to their diff; infra files full.
    const seen = new Set<string>();
    const items: FileBundleItem[] = [];
    let changedReviewed = 0;
    for (const fp of changed) {
        if (seen.has(fp)) continue;
        const w = args.store.getFileContent('working', fp) ?? (args.store.getWorking().files as any)?.[fp]?.content;
        if (!w) continue;
        // #930 — KEYSTONE: at review-pr init the baseline's content lives only in
        // the IN-MEMORY snapshot — the SQLite baseline rows stay content=NULL until
        // a post-forget rotateBaseline (snapshotStore #909), so `getFileContent
        // ('baseline')` returns undefined here and EVERY modified non-entry file
        // degraded to a markerless `numberedNew` dump (project pass = diff-blind).
        // Resolve baseline the SAME two-tier way the per-entry pack does so the
        // diff window actually produces `+`/`-` hunks. (undefined only for a
        // genuinely new file → unifiedDiffWindow then marks it all-`+`.)
        const b = args.store.getFileContent('baseline', fp) ?? (args.store.getBaseline?.()?.files as any)?.[fp]?.content;
        seen.add(fp);
        items.push({ filePath: fp, content: diffWindow(String(w), b) });
        changedReviewed += 1;
    }
    let infraReviewed = 0;
    for (const fp of infra) {
        if (seen.has(fp)) continue;
        let content = String((args.store.getWorking().files as any)?.[fp]?.content ?? args.store.getFileContent('working', fp) ?? '');
        if (!content) continue;
        if (content.length > MAX_BYTES_PER_FILE) content = content.slice(0, MAX_BYTES_PER_FILE) + '\n/* ... truncated for review ... */';
        seen.add(fp);
        items.push({ filePath: fp, content });
        infraReviewed += 1;
    }

    if (items.length === 0) {
        return { files: [], reviewed: false, findingsCount: 0, durationMs: Date.now() - started };
    }

    // Batch by byte budget, bounded by MAX_BATCHES (a hard ceiling on LLM-call fan-out).
    // #893 — when the batch ceiling is hit, the loop used to `break`, abandoning the
    // in-progress batch + every remaining item with NO overflow count or log → silent
    // production-file drop. Now we COUNT the abandoned items into `batchOverflow` and
    // fold them into the reported/logged overflow.
    const maxB = maxBatches();
    const softFill = MAX_TOTAL_BYTES * BATCH_SOFT_FILL_FRACTION;
    const batches: FileBundleItem[][] = [];
    let cur: FileBundleItem[] = [];
    let curBytes = 0;
    let consumed = 0;
    let lastSubsystem: string | null = null;
    for (const it of items) {
        const sk = subsystemKey(it.filePath);
        const overBudget = cur.length > 0 && curBytes + it.content.length > MAX_TOTAL_BYTES;
        // #942 refinement — break at a subsystem boundary once the batch is
        // substantially full, so the changed core gets a review call uncrowded by
        // an unrelated subsystem. Same-subsystem files (contiguous after the path
        // sort) stay together; small groups still share a batch until softFill.
        const subsystemBreak = cur.length > 0 && curBytes >= softFill && lastSubsystem !== null && sk !== lastSubsystem;
        if (overBudget || subsystemBreak) {
            batches.push(cur); cur = []; curBytes = 0;
            if (batches.length >= maxB) break; // no room for more batches — remaining items are overflow
        }
        cur.push(it); curBytes += it.content.length; consumed++;
        lastSubsystem = sk;
    }
    if (cur.length > 0 && batches.length < maxB) batches.push(cur);
    else if (cur.length > 0) consumed -= cur.length; // last partial batch couldn't be pushed (at the ceiling)
    const batchOverflow = items.length - consumed;

    // #946 — compute the cross-file DEPENDENTS pack once for all changed files
    // under review, then buildPrompt attaches the slice relevant to each batch.
    let dependents: FileDependents[] = [];
    try {
        dependents = buildDependentsForFiles(args.store as any, changed);
    } catch {
        dependents = [];
    }

    let kept = 0;
    const reviewedFiles: string[] = [];
    for (const batch of batches) {
        if (args.signal?.aborted) break;
        const prompt = buildPrompt(batch, guidelines.text || '', dependents);
        let result: { findings: ProjectRawFinding[] };
        try {
            result = await args.llmCall({ system: prompt.system, user: prompt.user }, { signal: args.signal });
        } catch {
            continue; // one batch failing must not sink the rest
        }
        reviewedFiles.push(...batch.map((b) => b.filePath));
        kept += persistProjectFindings(args, batch, result, prompt.sourceCorpus, guidelines.hash || undefined);
    }

    return {
        files: reviewedFiles,
        reviewed: reviewedFiles.length > 0,
        findingsCount: kept,
        durationMs: Date.now() - started,
        changedReviewed,
        infraReviewed,
        batches: batches.length,
        overflow: overflow + batchOverflow, // #893 — include items dropped by the batch ceiling, not just the file cap
    };
}
