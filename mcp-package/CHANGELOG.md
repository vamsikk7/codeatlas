# Changelog

## 5.3.0

Pairs with `codeatlas-live@9.3.0`. Change reporting now propagates through every layer, and the browser view supports signing in.

```bash
npx @codeatlas/mcp /path/to/repo --browser
# Same usage as before.
```

### Fixed — Change reporting

- Editing a function in a service or helper file (one that owns no route itself) now reports the affected feature, API list, and service as changed — not just the file and its call sequence. Change reporting propagates all the way up to the System Design view.
- Change highlights are preserved when a diagram is reopened, instead of being lost on reload.
- On full-stack projects, editing the backend no longer marks every front-end screen as newly added.

### New

- **Sign in to view diagrams in the browser view.** `--browser` mode now asks for a quick sign-in to open diagrams and use the tools; initializing and re-syncing the workspace still work signed-out, and sign-out is in the header. The **stdio MCP tools are unaffected** — agents keep working without any browser sign-in.
- The browser view header no longer flickers between signed-in and signed-out on first load — it waits until your sign-in status is known before drawing the account controls.
- **Runs alongside the VS Code extension on the same repo.** The workspace write-lock is now scoped to each surface's own storage (`@codeatlas/mcp` uses `.codeatlas-sa`, the extension uses `.codeatlas`), so the two no longer contend or interrupt each other — start the MCP server on a folder that's already open in the editor and both keep working.
- **Cleaner, clickable diagrams in the browser view.** AI code review moved entirely to the home Code Review card; the in-diagram review overlay/markers were removed. Diagrams also no longer open in a forced "Baseline → Working" comparison view on first launch — they're interactive immediately, and the comparison view stays opt-in.

### Notes for existing users

- No tool changes and no resource changes — every tool, schema, and response shape is preserved. No on-disk format change. Drop in and go.
- The stdio tool interface never requires sign-in; only the `--browser` diagram view does.

## 5.2.0

Pairs with `codeatlas-live@9.2.0`. More accurate change reporting for edited endpoints, plus PR reviews you can run in CI.

### Improved — Change reporting

- Edits to routes defined inline (logic on the route itself, not in a separately named function) are now reported as changed at every level — the endpoint, its call sequence, and its flow chart — not just the file.
- An endpoint is reported as changed when its handler changed, even when the route passes through middleware first.
- Change reporting no longer over-reports: shared services and libraries an edited route talks to aren't marked as changed unless they changed themselves.

### New

- **`review-pr` subcommand — PR reviews in your CI.** Run `npx codeatlas-mcp review-pr` from a GitHub Actions workflow on pull requests: it analyzes exactly what the PR changed, runs the evidence-gated AI review over the affected entry points, and posts one review with inline comments pinned to the changed lines plus a summary comment that updates in place on every push (no comment stacking). Findings the diff can't anchor are listed in the summary instead of being dropped, and a run where the AI couldn't review anything fails the job instead of reporting a clean pass. Dry-run mode prints the would-be comments as JSON.

## 3.4.0

Pairs with `codeatlas-live@7.4.0`. Three new tools (now **54** total), a "what should I re-test?" composer, graph overlays exposed to agents, and reliability fixes for large multi-repo workspaces.

```bash
npx @codeatlas/mcp /path/to/repo
# Same usage as before.
```

### New tools

- **`get_regression_scope`** — "what should I re-test for this change?" Composes the working diff, blast radius, test coverage, and cross-repo consumers into a ranked re-test plan. Pass `repoId` in multi-repo workspaces to scope it.
- **`list_overlays`** — lists the registered diagram overlays (change markers, comments, test coverage, TODO/FIXME density) with their paint style and current UI toggle state.
- **`get_overlay`** — fetches one overlay's data points joined to graph entities. UI toggles never gate data access — the agent always gets the points.

### Improved — Large multi-repo workspaces

- File saves keep updating diagrams no matter how many sub-repos the workspace holds — on 50+ repo workspaces the live-update loop could previously go silent until a restart.
- Service counts agree everywhere: the browser home page, the System Design header, and `list_repos` all derive from the same per-repo resolution. Workspaces whose sub-repos share a default service name no longer collapse into one.
- The browser home page in multi-repo workspaces now aggregates files, APIs, and services across every sub-repo instead of showing only the primary repo's numbers.
- The System Design view on very large workspaces (50+ sub-repos) shows the same grouped overview the VS Code extension shows, instead of an unreadable per-service wall.
- Opening an API row, a tour step, or a pasted deep link whose handler has no sequence diagram falls back to its flow chart or file diagram with a note — never a dead end or an endless spinner.

### Improved — Change badges for serverless-style handlers

Editing a handler written as `module.exports.create = (…) => {…}` (the common Serverless Framework / Lambda style) now marks the changed statement on the flow chart. Existing workspaces pick this up fully after their next re-initialization.

### Migration notes

- All 51 existing tools, schemas, and response shapes are preserved — agents upgrade safely. The tool count is now **54**.
- If a client hard-codes "51 tools" in prompts or telemetry, update it to 54.
- The browser surface still listens on `http://localhost:7842` by default. No on-disk migration.

## 3.3.0

Pairs with `codeatlas-live@7.3.0`. A multi-repo polish release. The browser surface now matches the VS Code extension layer-for-layer in multi-repo workspaces — pick a sub-repo and the per-sub-repo System Design, Knowledge Map, picker subtitles, Code Review chip, and per-repo guidelines all behave identically across `code .` and `npx @codeatlas/mcp <workspace> --browser`. Tool count is unchanged at 51; no schema breaking changes.

### Improved — Multi-repo aware browser surface

When MCP standalone opens a workspace with several sub-repositories it now broadcasts the same multi-repo state the VS Code extension does, so the bundled browser UI (`localhost:7842`) shows:

- A two-step picker on **API List**, **Sequence**, and **Flow Chart** — pick the sub-repo first, then the entry point.
- Real per-sub-repo subtitles in the picker (`aws-golang-rest-api-with-dynamodb · serverless · 5 APIs`) so you can choose without drilling in.
- A scope chip inside the **Code Review** card that you click to pick which sub-repo every review action targets.
- Per-sub-repo Review Guidelines — different rules per service, persisted across sessions.
- System Design + Knowledge Map for the picked sub-repo show that service's slice (its routes, clusters, infrastructure neighbours) instead of the workspace overview.
- A startup progress signal — `Init: 130/132 ready, 2 failed (click for details)` — surfaces which sub-repos parsed cleanly and which still need attention.

These work the same on every MCP client's browser surface (Claude Code, Cursor, Codex, Gemini, VS Code Copilot Chat, Continue) because they all hit the same standalone server.

### Improved — .NET Lambda handlers detected correctly in serverless workspaces

`list_entrypoints` now resolves .NET Lambda handlers written as `Assembly.Name::Namespace.Class::Method` to the right `.cs` file. The handler attaches to its real source location, so subsequent calls like `get_entrypoint_pack`, `get_function_source`, and `trace_call_path` reach the correct symbol. Previously the namespace path was stripped and the handler appeared to have zero APIs attached.

### Improved — AWS managed infrastructure on .NET services

Services written in C# that use `Amazon.DynamoDBv2`, `Amazon.S3`, `Amazon.SQS`, or `Amazon.SimpleNotificationService` now surface the managed infrastructure on `get_workspace_status` / `list_repos` responses next to the service. Same one-glance view Node / Python / Go / Java services already had.

### Improved — Cross-repo HTTP edge staleness

When one sub-repo calls another's HTTP endpoint and that endpoint's response shape changes, the cross-repo edge now carries `diff: 'modified'`. Tools that surface inter-service wires (`list_entrypoints`, `get_diff_summary`, `get_api_surface_diff`) reflect the stale state automatically — no re-fetching required.

### Improved — Per-sub-repo Git Diff sessions

`run_api_chain`, `compare_workspaces`, and the diff-aware variants of `get_diff_summary` / `review_diff_with_baseline` now keep one diff session **per sub-repo**. Pass `repoId` on the request and the right per-sub-repo session is reached; older clients that don't pass `repoId` keep using the workspace-wide session as before.

### Migration notes

- Existing 3.2.x clients keep working unchanged — every 3.2.x tool, schema, and response shape is preserved. The tool count is unchanged at 51.
- If a client hard-codes "51 tools" anywhere in prompts or telemetry, leave it as 51.
- The browser surface still listens on `http://localhost:7842` by default.
- **Multi-repo default scope change:** in multi-repo workspaces, `list_entrypoints` with no `repoId` now returns the **merged** entry-point set across every sub-repo (previously it returned the primary repo only). Agents get a complete picture by default; pass `repoId` (from `list_repos`) to scope to one sub-repo, exactly as before. Single-repo workspaces are unaffected.

## 3.2.0

Pairs with `codeatlas-live@7.2.0`. Two new tools (now 51 total), broader framework coverage, and a default port change so the MCP server and the VS Code extension can run side-by-side.

### New tools

- **`trace_call_path`** — returns the shortest call path between two functions (a `{ filePath, symbolName }` waypoint list). Use it when an agent needs to see how request handler A ends up touching helper B without walking imports manually.
- **`generate_chain`** — proposes a runnable multi-step API call sequence from a natural-language description. Each step is evidence-gated against handler source so the model can't invent fields that don't exist. Pair with `run_api_chain` to author and execute a chain in one session.

### Improved — middleware participants in `get_entrypoint_pack`

Sequence responses now include middleware as separate participant lanes for every framework where CodeAtlas can detect them: Express, Koa, Fastify, Hono, NestJS, Spring, Ktor, Django, Flask, FastAPI, Starlette, Gin, Echo, Chi, Laravel, Symfony, Rails, Actix, Axum. Each middleware participant carries `kind: 'middleware'` so agents can reason about authentication / rate-limiting / logging without inspecting application code.

### Improved — serverless / SAM / CDK routes via `list_entrypoints`

`list_entrypoints` now surfaces routes lifted from `serverless.yml`, AWS SAM (`AWS::Serverless::Function` events), and AWS CDK API Gateway constructs (TypeScript, Python, and Java). Cross-stack CDK routes propagate — when one stack defines an API and another adds methods, both attribute back to the same service. Multi-file definitions resolve correctly.

### Improved — gRPC + GraphQL auth on `ApiRecord.meta`

gRPC auth interceptors (`WithUnaryInterceptor` / `WithStreamInterceptor`) and GraphQL resolver auth (`@directive(auth)` / `@UseGuards()` / Apollo / Nexus / Pothos) populate `meta.authRequired: true` + `meta.authProvider: 'oauth' | 'apiKey' | 'session' | 'custom'` on the corresponding `ApiRecord`. The same auth signal drives the HTTP layer, so agents get one consistent view.

### Improved — multi-repo monorepo aggregation

`list_repos` returns one repo per detected serverless service folder (one `serverless.yml` per subfolder pattern) and one repo per binary entry in multi-binary Go / Rust workspaces. Each repo gets its own indexed slice so per-repo scoping on any tool (`list_entrypoints({ repoId })`, `get_workspace_status({ repoId })`, etc.) reaches the right state.

### Reliability — Background error reporting

Uncaught exceptions in the MCP server are now reported as anonymized stack traces so we can spot real failures without you having to file a ticket. Code snippets never leave your machine. Disable by setting `CODEATLAS_TELEMETRY=0` or `DO_NOT_TRACK=1` in your shell environment — both telemetry and error reporting honor either flag.

### Reliability — Self-correcting LLM calls

When the server asks an LLM for structured output (request body inference, test-case generation, chain proposal) and the response doesn't match the expected shape, the server now sends one quick corrective re-prompt that quotes the validation error back to the model. Recovers a meaningful share of "almost-valid JSON" responses from smaller / cheaper local models that previously got dropped.

### Default browser port is now 7842

`@codeatlas/mcp <workspace> --browser` listens on `http://localhost:7842/` by default (previously 7742). This frees up 7742 for the VS Code extension so both can run simultaneously without colliding. Override with `--port <N>`. **Stdio clients are unaffected** — they don't touch this port.

### Migration notes

Existing MCP clients on 3.1.x keep working unchanged — all 3.1.x tools, schemas, and response shapes are preserved. The two new tools appear automatically in `tools/list`; older clients that don't know about them simply ignore them. If you bookmark the browser surface, update `:7742` → `:7842`. If you hard-code "50 tools" anywhere in client-side prompts, bump it to "51".

## 3.1.1

A polish + bug-fix release. Pairs with `codeatlas-live@7.1.1`. No tool surface changes — the 50-tool MCP API from 3.1.0 is preserved. The standalone server picks up the matching UX hardening from the extension side (Test Connection probe handler, friendly fetch-error hints, Tour anonymous-handler suppression, etc.).

Ships in lock-step with `codeatlas-live@7.1.1`.

### New — `testLlmConnection` handler

The standalone server now responds to a `testLlmConnection` message from the SPA by running a provider-aware probe against the configured LLM endpoint and broadcasting `llmConnectionTestResult { ok, message, latencyMs }`. The browser surface ("Test Connection" button on the LLM Config card) consumes this to let users verify connectivity BEFORE clicking Start review. Probes are free / read-only:

- **OpenAI / OpenRouter** → `GET /v1/models` with `Authorization: Bearer <key>`
- **Anthropic** → `POST /v1/messages` with empty body (400 = auth passed)
- **Ollama** → `GET /api/tags` (rewrites a `/v1/chat/completions` URL into `/api/tags`)
- **Custom** → `HEAD <endpoint>`

10-second `AbortController` timeout. Network failures translate into human-readable messages (`Couldn't resolve the LLM host (DNS)`, `Connection refused — is the server running?`, `Timed out after 10s`).

This is a **webview message** path, not an MCP tool — AI agents don't gain a new capability here. The MCP tool surface itself is unchanged.

### Improved — Tour blurbs no longer expose synthetic handler IDs

The `get_tour` tool's step blurbs used to read `Read /. Handler: \`anonymous@GET:/\`.` for inline arrow-callback routes — the synthetic id leaked through to the AI agent's response. `writeBlurb` in `tourBuilder.ts` now detects `anonymous@…` handler names and suppresses the Handler: tail. Step 1 of the Tour now reads `Read /.` cleanly.

### Improved — Modules layer cluster nodes carry `meta.domainPhrase`

The `feature:workspace` and `feature:service:<name>` graphs that `get_features` / `nl_query` return now include `meta.domainPhrase` on each cluster node when the workspace's domain detector matched verb-phrase domains. AI agents reasoning about a cluster can now read both the structural name (`auth`) AND the business intent (`Authenticate users`) from a single graph fetch.

### Bug fixes (mirroring 7.1.1)

- Outside-route page title pinning (matters for the browser surface only).
- `#/domains` plural-typo alias (browser surface only).
- L2b API row keyboard accessibility (browser surface only).
- "RESPONSE FAILED · fetch failed" friendly hint in the API Testing workbench (browser surface only).
- AI Review cost-estimate `EstimatingCostPanel` timeout + Cancel + Retry with provider-aware endpoint label (browser surface only).

### Migration notes

No action required. Single-repo + multi-repo flows behave exactly like 3.1.0. The new `testLlmConnection` webview handler is additive — older SPA bundles that don't know about it simply never fire the message.

## 3.1.0

A minor release that pairs with `codeatlas-live@7.1.0`. Headline change: **the MCP server now speaks multi-repo monorepo** — point it at a workspace containing N independent repos (each with its own `.git`) and every tool returns repo-aware results so AI agents can reason about which repo a finding lives in. The 50-tool surface from 3.0.0 is preserved.

Ships in lock-step with `codeatlas-live@7.1.0`.

```bash
cd /path/to/monorepo
npm install --save-dev @codeatlas/mcp
# Daemon auto-starts. Each child repo gets its own state.db; the workspace
# root gets a monorepo.db that aggregates summaries across them.
# Browser at http://localhost:7742 shows the unified L1 across all repos.
```

### New — Multi-repo monorepo support (ADR-034)

The MCP server reads from the same per-repo + aggregator store pair the extension uses. Concretely:

- **Per-repo `state.db` + workspace `monorepo.db`.** Each repo gets its own SQLite store; the aggregator holds the cross-repo registry. Backwards compatible — single-repo workspaces behave exactly like 3.0.0.
- **Worker-thread parallelism (Tier-2).** Per-repo orchestrators run in parallel; an 8-repo workspace inits in ~1.5s end-to-end. The dispatcher picks Tier-1 (in-process, ≤3 repos) or Tier-2 (worker-pool, ≥4 repos) automatically.
- **Repo-aware tool results.** `list_services`, `get_microservices`, `get_features`, `get_apis`, `get_call_path`, `get_impact`, `get_changed_items`, `get_tour`, `pre_edit_brief`, `trace_call_path`, `nl_query`, `run_ai_review` etc. all surface per-repo provenance (`repoId`, `repoName`, `rootPath`) in their results.
- **Cross-repo diff propagation.** Editing a file in repo A surfaces the impact in repo B's diff badges if a shared external SDK or HTTP edge is affected. `get_impact` returns the union across all reachable repos.
- **Workspace re-sync atomicity.** The `resync_workspace` tool rotates all per-repo baselines atomically — if any repo fails, the aggregator stays at the prior baseline.
- **Failure isolation.** A parser crash in one repo no longer aborts the fan-out — the failing repo shows a "Failed" status; other repos finish indexing normally and their tools still respond.

### New — Worker-thread cascade pool

Per-repo orchestrators now run in a worker-thread pool sized to `min(8, repoCount)`. Inits and per-save rebuilds parallelise across repos, so a 4-file edit affecting 4 different repos in a monorepo workspace rebuilds in ~4× less wall-clock time.

### Improved — Architecture violations surface

The `get_violations` tool now returns the same set the extension's `#/violations` panel renders: rule id, severity, file + line context, and grouped by service/repo. Rule set is configurable via `~/.config/codeatlas/violations.json`.

### Improved — AI review per-repo scoping

`run_ai_review` accepts an optional `repoId` parameter that scopes the review to a single repo. Without it, the review fans out across the workspace and returns findings grouped by repo. Evidence-gating, severity rubric, and the custom-guidelines plumbing from 3.0.0 are unchanged.

### Improved — Aggregator queries via SQL surface

The read-only SQL tool now supports querying the aggregator (`monorepo.db.repos`, `repos_summaries`, `shared_externals`, `shared_schemas`, `http_edges`) for agents that want to reason about cross-repo topology directly. Same row-cap + read-only guards as 3.0.0.

### Bug fixes — UX hardening

A round of UX fixes carried over from the matching extension release:

- L1 multi-repo card click now resolves to the right per-repo feature graph (was landing on an empty aggregator graph).
- Multi-repo home stats now dedupe services by id (was reporting `8N` for `N` repos due to cross-repo stub rows).
- `#/violations` page title pinned to `Architecture Violations`.
- `#/domains` plural typo aliased to the canonical singular route.
- L2b API rows now expose `role="button"` + `aria-label` + keyboard activation for screen-reader users.
- Tour step bodies no longer leak synthetic `anonymous@<METHOD>:<route>` handler ids.

### Migration notes

No action required. Single-repo flows behave exactly like 3.0.0. Existing `.codeatlas/state.json` files (pre-3.0.0) are silently migrated to the new SQLite store on first MCP request.

## 3.0.0

A major release. **Zero-config install** is the headline change: one `npm install` inside your repo auto-wires every detected MCP client (Claude Desktop, Cursor, Claude Code, Codex, Gemini, VS Code Copilot Chat, Continue) AND starts a per-OS daemon (launchd / systemd / Task Scheduler) so the browser surface and MCP index stay live as you edit — no `npx` chaining, no manual JSON editing, no daemon-mgmt.

The MCP surface also goes from **40 tools to 50** with a new API-testing toolkit (chain runner, SSE, WebSocket, OAuth2, OpenAPI / Postman / Insomnia importer), three evidence-gated LLM generators that ride on the workspace LLM config, and three new exploration tools (`get_tour`, `pre_edit_brief`, `trace_call_path`).

Ships in lock-step with `codeatlas-live@7.0.0`.

```bash
cd /path/to/your/repo
npm install --save-dev @codeatlas/mcp
# Daemon auto-starts. Configs auto-written. Browser at http://localhost:7742.
# 50 tools instead of 40. Same self-init flow if you still prefer `npx`.
```

### New — zero-config install + always-on daemon

The headline UX change. After one `npm install` (must be **inside your repo** — `npm install -g` is blocked with a clear error):

- **Daemon auto-starts on every OS:**
  - macOS — `~/Library/LaunchAgents/com.codeatlas.<id>.plist` loaded via `launchctl bootstrap gui/<uid>`
  - Linux — `~/.config/systemd/user/<id>.service` enabled via `systemctl --user enable --now`
  - Windows — Scheduled Task `CodeAtlas MCP <id>` with ONLOGON trigger registered via `schtasks`
- **Daemon stays running** through your edits, restarts on login, keeps the index fresh via the existing chokidar file-watcher inside the server process. No stale answers when an MCP client next queries.
- **Free-port allocator** picks an available port starting at 7742 and walking upward (recorded in `~/.config/codeatlas/setup-marker.json`). Multiple repos coexist without conflict.
- **MCP client configs auto-written** for every detected client on the host. Atomic via `<file>.codeatlas.tmp` + rename. Original is backed up to `<file>.codeatlas-backup-<ISO>` before first modification. Idempotent — re-running fixes drift without duplicating entries. Local overrides in client configs are preserved (we merge under `mcpServers.codeatlas`, never touch other servers).
- **Recovery file** at `~/.config/codeatlas/last-install.txt` always captures the full install banner, so users whose npm pipes through `tee` / `tail` / a CI buffer can always recover the browser URL with `cat`.

New subcommands:

- `codeatlas-mcp setup [workspace]` — manual rerun of the auto-config (e.g. after `--ignore-scripts` install). Supports `--no-browser` / `--read-only` / `--dry-run` / `--only=<client,client>` / `--client-config <path>` for non-standard clients / `--force` to bypass the workspace-validity check.
- `codeatlas-mcp doctor` — diagnostic dump: platform, Node version, telemetry state, every detected MCP client + whether the CodeAtlas entry is present, current daemon status (`running` / `stopped` / `not-installed`), browser URL.
- `codeatlas-mcp teardown` — remove the per-workspace daemon (LaunchAgent / systemd unit / Task). Configs are left in place so re-installing is one command.

Under-the-hood:

- New `--no-stdio` flag (set automatically by the daemon installers; **never asked of users**) tells the MCP server to skip the StdioServerTransport so launchd / systemd-spawned daemons don't tear themselves down on stdin EOF.
- Cross-platform path resolution centralised in `setup/platformPaths.ts` (Claude Desktop's `~/Library/Application Support` on macOS vs `%APPDATA%` on Windows vs `~/.config` on Linux, etc.).
- JSONC-aware writer for VS Code's `settings.json` — strips line/block comments + trailing commas before parse, never overwrites existing keys.
- `CODEATLAS_TELEMETRY_DEBUG=1` now logs every Mixpanel send attempt + HTTP response to stderr — was missing before, parity with the extension.

### Improved — better error messages

- `get_entrypoint_pack` previously returned `"Entry point not found: undefined undefined"` when called with the wrong shape. Now emits a clear "Expected { method, route }; got { apiId }. Tip: each row from `list_entrypoints` already has `method` + `route`." And when the method+route doesn't match, it lists nearby routes with the same method so the model can self-correct.

### New — supported MCP clients

| Client | Auto-wired? |
|---|:---:|
| Claude Desktop | ✅ |
| Cursor | ✅ |
| Claude Code CLI | ✅ |
| Codex CLI (JSON) | ⚠️ best-effort — Codex may use TOML; doctor flags this |
| Gemini CLI | ✅ (new in 3.0.0) |
| VS Code Copilot Chat | ✅ |
| Continue | ✅ |
| Antigravity / custom | use `--client-config <path>` |

### Token economics — measured

Validated live on the Node Express RealWorld test repo (33 TypeScript files, 27 routes, ~14k tokens of source — the "full file-walk" baseline):

| Query | Tokens | Reduction |
|---|---:|---:|
| `get_workspace_status` | 68 | ~208× |
| `search_workspace({query:'login'})` | 272 | ~52× |
| `get_impact_of_change` | 367 | ~38× |
| `list_architecture_violations` | 817 | ~17× |
| `get_entrypoint_pack` w/ source | 1,181 | ~12× |
| `get_feature_pack` | 1,690 | ~8× |
| `list_entrypoints` (27 routes) | 2,759 | ~5× |

5–200× reduction claim verified. Ratios grow with codebase size — a 100k-LOC monorepo dwarfs these absolute numbers.

### New — API testing toolkit (8 tools)

The same workbench that ships in the extension is now driveable from any MCP client (Claude Code, Cursor, Codex CLI, Gemini CLI, Antigravity, Continue):

- `run_api_chain` — execute an ordered list of HTTP requests, carrying env vars between steps via JSONPath extraction (`$.user.token`), with per-step assertions (status, body contains, header presence). Pass `stopOnFirstFailure: true` to bail at first non-2xx. Returns `{steps, finalEnv, passed, failed, errored, aborted}`.
- `stream_sse` — open an SSE connection, read events until `eof` / timeout / message cap (default 100, max 1000). Honours bearer tokens, custom headers, and env-var substitution.
- `connect_websocket` — open a WS connection, optionally send scripted messages, capture inbound frames, close. Same caps + env-var substitution as `stream_sse`.
- `oauth2_token` — exchange OAuth2 credentials for an access token. Supports `client_credentials`, `authorization_code` (with PKCE via `codeVerifier`), and `refresh` grants.
- `oauth2_authorize_url` — assemble the OAuth2 authorization-endpoint URL the user opens in their browser. Optional PKCE via `pkce: {codeChallenge, codeChallengeMethod}`. Returns `{url, state}`.
- `import_api_collection` — import an OpenAPI 3.x / Swagger 2.0 spec, a Postman v2.1 collection, or an Insomnia v4 export and return an `ApiTestingPayload` with collections + endpoints that plug straight into `run_api_chain`. Format is auto-detected from top-level fields. Pass `spec` as parsed JSON or `specText` as raw JSON; YAML must be converted by the caller.
- `generate_request_body` — propose a single JSON request body for a target endpoint. Reads the handler source from the snapshot, asks the LLM to fill in only the fields the handler actually uses, then strips any field whose evidence line can't be quoted from the handler. Sister tool of `generate_test_cases` — same client, same evidence-gate.
- `generate_chain` — propose an ordered chain of requests that exercises a coherent flow (e.g. login → fetch profile → create article). Asks the LLM to compose a sequence with `extract` recipes carrying env vars between steps. Recipes without source-quoted evidence are dropped before return.
- `generate_test_cases` — generate evidence-gated API test cases for a route. Returns `{name, preconditions, request_overrides, assertions, evidence}[]`. Cases the model can't ground in a quoted source line are dropped. Output is safe to feed directly to `run_api_chain` after wrapping each case in a step with the matching method+URL+body.

All three LLM generators reuse the workspace `codeatlas.llm*` config (`openrouter` / `openai` / `anthropic` / `ollama` / custom URL). Pass `apiKey` + `model` + `provider` directly to override per call.

### New — workspace exploration (3 tools)

- `get_tour` — produce a guided onboarding-tour step list. Two modes: `codebase` orders entry points by call-graph fan-in DESC so a new contributor starts at the most load-bearing routes; `recent` orders by diff status (modified → added → unchanged). Each step carries a one-line "why this matters" + the drill-down graphId.
- `pre_edit_brief` — one-shot context briefing before editing a file/function. Returns the function source (if specified), all entry points that reach it, sibling functions, imports, and current diff state. Replaces 4-5 separate tool calls.
- `trace_call_path` — BFS the workspace call graph for the shortest path between two functions. Returns the actual edge sequence (file::fn → file::fn → …) with edge confidence + kind. Answers "how does GET /articles reach prisma.user.findUnique?" in one call.

### Notes for existing users

- **No tool removals or schema changes.** Every existing tool name and input shape is the same. Only additions.
- **No on-disk migration.** Your existing `.codeatlas/state.db` keeps working. New columns are populated lazily on the next cascade rebuild.
- **No resource changes.** Still 8 resources.
- **Same self-init flow.** First run on a new workspace still bootstraps the snapshot from scratch — no VS Code required.
- **Same 30+ supported frameworks** across JS/TS, Python, Java, Kotlin, Go, Rust, Ruby, PHP, Swift, C#, Dart.

## 2.2.1

A critical bug-fix release for `--browser` mode. **If you're using `npx @codeatlas/mcp` with the browser surface, upgrade.** Two fixes in one release.

```bash
npx @codeatlas/mcp /path/to/repo --browser
# Same usage as before.
```

### Fixed — file edits in `--browser` mode propagate to the diagrams

In `2.2.0`, edits to source files in your workspace silently did not reflect in the live diagrams when `--browser` was on. The file watcher saw the change, the cascade fired, the broadcast went out — but the in-memory snapshot kept reading the pre-edit state, so diagrams looked frozen on your last open commit. Reverting an edit looked correct because the snapshot was already on baseline; making a new edit looked broken because the snapshot never moved.

The underlying issue was a state-refresh wrapper that fired on every internal read (including the ones inside the rebuild path itself), clobbering the in-flight update with the not-yet-saved baseline. We moved the refresh to fire once per incoming MCP tool call instead, which matches the original intent ("sync between requests") without breaking the file-watcher chain. File edits now propagate through all 6 diagram layers on every change.

If you were on `2.2.0` and noticed diagrams that wouldn't update after editing, that's this bug. Upgrading fixes it.

### Better — the browser shows which standalone version is serving it

The browser title + home-screen header now display the actual MCP standalone version (e.g. `CodeAtlas MCP v2.2.1.1`) instead of the bundled extension's compile-time version. End users running `npx @codeatlas/mcp@2.2.1` can confirm at a glance which package they're connected to.

### Fixed — anonymous telemetry now reaches our dashboard reliably

Previous builds defaulted to a no-op sentinel when the telemetry token wasn't explicitly wired in at build time, which silently disabled telemetry on many install paths. The fix uses a real default so anonymous adoption + usage data flows correctly. Same opt-out path as before (`CODEATLAS_TELEMETRY=0` or `DO_NOT_TRACK=1`), same anonymous device-id keying, same scrubbed content.

### Notes for existing users

- No tool changes. No resource changes. No on-disk migration. Drop in and go.
- Total tool count is unchanged at 40. Same 8 resources.
- Same 30+ supported frameworks across JS/TS, Python, Java, Kotlin, Go, Rust, Ruby, PHP, Swift, C#, Dart.

## 2.2.0

This release adds anonymous, opt-out usage telemetry to the standalone binary so we can see which tools agents actually use and where they slow down. It also widens the read-only SQL surface so agents can query frontend, mobile, and screen data directly, and rolls up the reliability fixes from `codeatlas-live@6.2.0`.

```bash
npx @codeatlas/mcp /path/to/repo
# Same usage as before. Telemetry is on by default — see below to disable.
```

### New — anonymous usage telemetry, opt-out

**Heads up — this is a change from `2.1.x`, which shipped with no telemetry from this binary.** We started measuring adoption + usage so we can prioritize the right tools for the next release.

What we capture (Mixpanel, US region):

- `mcp_install` — first time the binary boots on a machine.
- `mcp_version_installed` — every fresh install or upgrade/downgrade. Includes `previous_version`, `new_version`, and a `kind` of `initial` / `upgrade` / `downgrade`.
- `mcp_server_boot` — every server start.
- `mcp_workspace_init_complete` / `..._failed` — bootstrap result, duration, mode (`read_write` / `read_only` / `error`).
- `mcp_session_started` — after the stdio transport connects.
- `mcp_browser_started` / `..._start_failed` — when `--browser` is enabled.
- `mcp_tool_call_start` / `..._complete` / `..._error` — per `tools/call`, with tool name, duration in ms, result size in bytes, and a truncated error message for failures.
- `mcp_heartbeat` — every 5 min while the session is alive.
- `mcp_session_ended` — on graceful shutdown, with session duration.

What we never capture: source code, file paths, file names, route paths, commit hashes, user names, or any content from your workspace. Workspace paths are reduced to a SHA-256 prefix. Error messages are capped at 500 characters so stack traces never ship.

How identity works: anonymous device ID = `SHA-256(hostname + username + node version)`. Stable per machine; never decodable back to the original. If you also use the VS Code extension and signed in there, MCP events stitch with that identity for unified funnels.

**To disable:** set `CODEATLAS_TELEMETRY=0` (also accepts `false` / `off` / `no`). The industry-standard `DO_NOT_TRACK=1` is also honoured. The binary prints a one-time disclosure on the first boot showing the flag.

### Read-only SQL — service / cluster / screen tables added

`query_snapshot` now accepts queries against the `services`, `clusters`, `screens`, and `screen_items` tables in addition to the existing `apis` / `graphs` / `files` / `snapshots` / `comments` / `settings`. Agents can answer frontend / mobile questions directly:

```sql
-- "What screens does this app expose?"
SELECT json_extract(screen_json, '$.routePath') AS route,
       json_extract(screen_json, '$.framework') AS framework
  FROM screens WHERE snapshot_kind='working';

-- "How is this app distributed across services?"
SELECT json_extract(service_json, '$.category') AS category, COUNT(*) AS n
  FROM services WHERE snapshot_kind='working' GROUP BY category;
```

### Inherited reliability fixes (from `codeatlas-live@6.2.0`)

- Edits to large files reliably show up in tool results after long sessions. A subtle parser resource leak that caused rebuilds to silently stop reflecting changes after ~30+ file edits is fixed.
- Reverting an edit cleanly clears change markers across Go test functions, Rust attribute-decorated functions, Go Echo route clusters, and Django+Celery infrastructure nodes.
- System Design results no longer suppress legitimate external connections when a workspace service's name shares a substring with a third-party hostname.
- Flutter and other mobile apps in a monorepo show as distinct services.
- Frontend / mobile services return a flat screen list instead of a backend-style cluster graph.
- Classic Android XML layouts contribute to the per-screen visual inventory.

### Notes for existing users

- No tool changes. No resource changes. No on-disk migration. Drop in and go.
- Total tool count is unchanged at 40. Same 8 resources.
- Same 30+ supported frameworks across JS/TS, Python, Java, Kotlin, Go, Rust, Ruby, PHP, Swift, C#, Dart.

## 2.1.2

A bug-fix release focused on frontend and mobile codebase support. All 39 tools and 8 resources unchanged — every existing agent setup (Claude Code, Cursor, VS Code Copilot, Codex CLI, Gemini CLI, Antigravity, Continue) keeps working with no migration.

```bash
npx @codeatlas/mcp /path/to/repo
# Same usage as before.
```

### What's fixed

- **Flutter and mobile apps in a monorepo are recognised as their own services.** Workspaces with `apps/mobile/pubspec.yaml` alongside `apps/api/package.json` now expose both as distinct services in `list_microservices` and feature pack tools — no more silent collapse into a generic `main`.
- **External service detection no longer shadowed by overlapping workspace names.** A workspace service called `api` or `web` previously suppressed legitimate external connections like `api.stripe.com` or `web.archive.org`. External hostnames are now matched exactly, so third-party dependencies show up reliably in `get_microservice_overview` and the system design pack.
- **Frontend and mobile services return a flat screen list at L2a.** When an agent queries the feature graph of a Next.js, React Native, SwiftUI, Jetpack Compose, or Flutter service, the response now lists every screen the app exposes (route path, framework, file location) instead of a cluster graph meant for backend services. Each screen carries a deep link to its content panel.
- **Android XML layouts contribute to the per-screen visual inventory.** Classic Activities and Fragments that drive their UI from `res/layout/*.xml` files now report Buttons, EditTexts, TextViews, ImageViews, RecyclerViews, ConstraintLayouts, and ProgressBars in the screen-content payload — same shape as the Compose / SwiftUI / Flutter readouts.

### Notes for existing users

- No tool changes. No resource changes. No on-disk migration. Drop in and go.
- Same 30+ supported frameworks across JS/TS, Python, Java, Kotlin, Go, Rust, Ruby, PHP, Swift, C#, Dart.

## 2.1.1

A stability release. All 39 tools and 8 resources unchanged — every existing agent setup (Claude Code, Cursor, VS Code Copilot, Codex CLI, Gemini CLI, Antigravity, Continue) keeps working with no migration.

```bash
npx @codeatlas/mcp /path/to/repo
# Same usage as before.
```

### What's better

- **Steadier framework detection on mixed-stack projects.** Recognition of routes, jobs, queues, migrations, and lifecycle hooks has been tidied so repos that combine multiple frameworks (e.g. Next.js + Spring, or NestJS + Bull + Kafka + GraphQL) return predictable, consistent results. Verified byte-identical against the project's 29-repo framework test set, so any saved snapshots and downstream tool calls keep returning the same shape.
- **More resilient handling of generated files and test fixtures.** Edge cases like GraphQL schema strings in test files, JS template-literal snippets, and gRPC stub comments are filtered more reliably without bleeding into real route counts your agent queries.

### Notes for existing users

- No tool changes. No resource changes. No on-disk migration. Drop in and go.
- Same 30+ supported frameworks across JS/TS, Python, Java, Kotlin, Go, Rust, Ruby, PHP, Swift, C#, Dart.

## 2.1.0

The Code Review browser surface gets a big upgrade — incremental review by default, pre-flight cost estimate, finding history, and a much richer findings summary. All 39 tools and 8 resources unchanged, so existing agents (Claude Code, Cursor, VS Code Copilot, Codex CLI, etc.) keep working with no migration.

```bash
npx @codeatlas/mcp /path/to/repo --browser
# Same flag as before. New behaviour below.
```

### Code Review — incremental by default

- **Only re-reviews what changed.** Click Start review after editing a handler and only that handler is sent to the LLM; every other route reuses its existing finding. The browser progress strip shows the savings live (`Reviewing 1 / 27 (26 reused from last run)`).
- **"↻ Full re-review"** button alongside Start when you want a fresh all-routes pass — useful after editing the prompt template, swapping models, or when a prior run looks off.

### Confirm cost before paying for it

- **Pre-flight modal** opens on Start review showing the estimated cost, the model, the entry-point count, and a warning when the estimate would exceed your budget cap. Free runs (Ollama / local) auto-skip the modal.
- **Mid-review budget guard.** If a paid review crosses your cap during execution, it stops cleanly and keeps every finding already saved.

### Better findings summary

- **Blast radius (issue type → where it lands).** The Findings popover summary now cross-tabulates each detected theme (auth gaps, N+1 queries, validation gaps, etc.) against the feature clusters and routes that carry it. Lets you see "where do I focus first?" at a glance.
- **Real feature names** in the summary instead of "workspace-wide" — the writeup names the cluster (`the article cluster`, `the auth cluster`) so you know exactly where each pattern lands.
- **History on every finding.** Click 📜 History on any finding that's been resolved or ignored — see who took the action, when, and any comment they added.

### Smoother review UX

- **Tab reloads no longer confuse the UI.** The review-in-progress state survives a page reload — Start / Changed / Full re-review / Specific buttons stay disabled and only Cancel renders until the in-flight run actually finishes.
- **Review Guidelines locks during a review.** The Edit button on the guidelines card and the evidence-gate toggle are both disabled while a review is running, preventing race conditions between guideline edits and an in-flight review.
- **Distinct failure-mode banners.** Network drop, bad API key, rate-limit, model-not-found, server error, malformed response, and evidence-gate-too-strict each render their own message with a remediation hint plus a "View raw response" link.

### New optional WS message

A new server-side message lets a custom UI ask whether a review is currently running — useful when embedding the browser surface in another tool:

```jsonc
// → from client
{ "type": "requestAiReviewStatus" }

// ← from server (no run active)
{ "type": "aiReviewLoading", "loading": false }

// ← from server (run in progress)
{ "type": "aiReviewStarted", "kind": "full", "startedAt": 1761268800000 }
{ "type": "aiReviewLoading", "loading": true, "progress": "Review in progress…" }
```

Existing clients that don't post this message keep working with no change.

### Findings export from the browser

- **📥 Markdown download** next to Copy on the Findings popover — saves `codeatlas-findings-{timestamp}.md` with the same content the `summarise_findings` MCP tool produces.

## 2.0.3

Standalone UI polish to match `codeatlas-live@6.0.3`. All 39 tools and 8 resources unchanged — the new behaviour is additive on the browser surface.

```bash
npx @codeatlas/mcp /path/to/repo --browser
# Same flag as before. New UI behaviour below.
```

### What's new

- **Diagram export menu** in the toolbar — PNG (2× retina), SVG (vector), or Markdown + Mermaid (writes `architecture.md`). Replaces the previous single "copy SVG to clipboard" button.
- **Back button now works on deep links.** Open a diagram via a pasted URL or a Cmd+Click and the back arrow takes you Home instead of being hidden.
- **Service-name prefix in breadcrumbs** for multi-service monorepos. When 2+ services are detected, the current service is shown as the first crumb (`backend › Auth › POST /login`). Click it to jump to L1 System Design.
- **Comment badge → Comments panel.** Click a 💬 marker on any diagram node — opens the Comments panel so you can read or resolve threads without leaving the diagram.
- **Helpful empty state at the API list** for library-style repos with no HTTP routes — points users to File and Function Flow layers instead of a dead-end "no APIs" message.

### `workspaceInfo` envelope now carries the service list

The broadcast adds an optional `services: Array<{ id: string; name: string; rootPath: string }>` so any client listening to the WS bridge can show service context in their own UI:

```jsonc
{
  "type": "workspaceInfo",
  "serviceCount": 3,
  "services": [
    { "id": "service:backend", "name": "backend", "rootPath": "backend" },
    { "id": "service:frontend", "name": "frontend", "rootPath": "frontend" },
    { "id": "service:worker", "name": "worker", "rootPath": "worker" }
  ]
  // …existing fields unchanged
}
```

Existing clients that ignore unknown fields keep working with no change.

### Under the hood

- Webview bundle gains `ExportMenu.tsx` (no extra runtime deps — uses native `Image` + `<canvas>` for the PNG path).
- 5 node renderers (`AtlasNode`, `SequenceNode`, `FlowNode`, `MicroserviceView`, `FeatureView`) now dispatch a `codeatlas:open-comments` window event from the badge button — App listens once and opens the Comments panel.
- Lint clean, 265 webview tests + 2818 extension tests green, `verify:real` green across the cloned framework repos.

## 2.0.2

UX + agent-context pass on the Code Review surface. All 39 tools are unchanged — the new behaviour is additive.

```bash
npx @codeatlas/mcp /path/to/repo --browser
# Same flag as before. New behaviour below.
```

### What's new

- **Top-down summary on the browser home page.** When findings exist, the Findings popover now opens with a multi-line summary that names the pattern across all findings (auth gaps, validation risks, secret leakage, N+1 queries…), then breaks down per-layer (which clusters, which routes, which files), and ends with a "Top concerns (focus here first)" shortlist. Capped at ~500 words. No LLM call — pure aggregation from your existing findings.
- **Per-finding actions everywhere.** Resolve / Ignore / Comment / Copy now live on every Findings popover — both the home-page popover and the per-entity popovers inside diagram views. State changes are id-linked, so resolving from one view updates every other open tab immediately.
- **Group copy** — copy all findings, or just errors / warnings / info — as Markdown ready to paste into a PR or ticket.
- **Findings markers on every diagram.** Open any layer view (System Design, Feature Areas, API List, Sequence, File, Function Flow) — entities with findings get a colored count marker. Click it to act on the finding without leaving the diagram.
- **`addComment` over the WS bridge** accepts a `source: 'ai'` field so comments authored from the AI popover are tagged correctly and persist alongside user comments with the right attribution.
- **Workspace counts richer.** The `workspaceInfo` broadcast now includes `fileGraphCount`, `flowGraphCount`, and `sequenceGraphCount` so the home page (and any client that listens to the WS bridge) can show diagram-coverage at a glance.

### New module for agent-driven PR review (additive)

A new `prSummaryPrompt` module defines a strict 5-block output schema for a PR-style review document — Header → Summary → Interpretation → Findings → Instructions — with:
- A required `mechanism` field on each finding (the *how* — what makes the review actionable, not just a linter dump).
- Instructions that reference findings by id with an observable acceptance condition.
- A merge-blocker checklist that's a strict subset of instructions.
- A deterministic validator enforcing five mapping rules (no orphan criticals, no invented instructions, severity-flows-up, recommendation matches severity).

It's wired internally — future MCP tools (or your own agent that calls the standalone) can import the prompt + validator without re-implementing the schema.

### Fixed / improved

- Standalone `addComment` handler — previously the home-popover "Comment" button posted a message that landed nowhere on the standalone side. Now it persists + broadcasts `commentAdded` / `commentsUpdated`.
- Findings popover is resizable; size persists across the session via sessionStorage.
- Section dividers + spacing on the home page have proper breathing room — the layout reads as discrete sections instead of a single wall of cards.

### Upgrade notes

- No schema changes. Your `.codeatlas-sa/state.db` from 2.0.1 keeps working.
- All 39 tools + 8 resources unchanged. Existing MCP integrations don't need any changes.

## 2.0.1

Quality-of-life pass on the AI Review tooling shipped in 2.0.0. The 39 tools are unchanged; the engine they run on is faster, smarter about repeat runs, and tags every finding with the code state it reviewed.

```bash
npx @codeatlas/mcp /path/to/repo --browser
# Same flag as before. Behaviour upgrades below.
```

### What's new

- **Findings carry a commit SHA.** Every finding now includes a `baselineRef` with the 7-character git short SHA of HEAD at review time. Workspaces without a git repo get a deterministic 8-char content hash instead. Lets your agent ask "is this finding still relevant for the current commit?".
- **Re-runs that wouldn't change anything are short-circuited.** Calling `requestFullReview` (over the browser WS) against the same review guidelines and the same code state as the last completed run skips the LLM entirely and re-emits the existing findings with a `aiReviewNoChange` event. Hit Clear or edit something — the next call runs for real.
- **`clearFindings` WS message** alongside the existing `clear_findings` MCP tool. Wipes findings plus the dedup signature so the next review starts clean.
- **`cancelFullReview` WS message** aborts the in-flight LLM fetch immediately instead of waiting for the model to finish responding (used to make Cancel feel like a 30–60s delay on local models).
- **`requestSpecificReview` WS message** takes a free-form prompt ("audit input validation in POST handlers") and runs a one-shot project-level pass tuned to that focus.

### Fixed

- **The diagram views (System Design, Feature Areas, API List, Sequence, File, Flow) load cleanly in the browser.** A pre-existing CJS leak in the bundle caused "require is not defined" on every layer view at runtime in 2.0.0.
- **Saving an Ollama / local LLM config updates the home-page badge immediately** instead of staying stuck on "OpenRouter" until reload.
- **A fresh browser tab now shows the same finding count as your first tab**, without needing to open a layer view first.
- **Background re-sync no longer wipes review guidelines + persisted findings** on extension reboot.

### Upgrade notes

- All 39 tools + 8 resources from 2.0.0 are unchanged. The new behaviour is additive — existing integrations keep working.
- `state.db` schema bumps from v3 to v4 to add the `ai_review_signature` table (single row, for the "nothing changed" check). Migration is automatic on next load.

## 2.0.0

AI code review, exposed as MCP tools. Your AI coding assistant — Claude Code, Cursor, Copilot, Codex CLI, Gemini CLI, or any MCP-compatible client — can now query and act on findings the same way you would in the browser.

```bash
npx @codeatlas/mcp /path/to/repo --browser
# Same `--browser` flag as before. New tools listed below.
```

### New: AI code review tools (14 new)

- **`list_ai_findings`** — every finding with severity, category, layer, and the source it quotes.
- **`get_ai_finding`** — full body of one finding by id.
- **`get_ai_finding_counts`** — counts grouped by diagram layer, entry point, or severity. Drop-in for showing badges.
- **`update_ai_finding_status`** — mark a finding resolved or ignored after fixing it.
- **`get_review_guidelines` / `set_review_guidelines`** — read and write the team's review rules (up to 8 KB of free text). Saved guidelines get used in every subsequent review.
- **`search_ai_findings`** — natural-language search over findings. "What's wrong with auth?" or "anything fishy in the article create flow?" returns ranked matches scoped to the right entry point or cluster.
- **`summarise_findings`** — extractive 3–7 bullet summary, deterministic, no LLM call. For small-context agents.
- **`list_findings_by_guideline`** — group findings by which guideline triggered them. Shows which guidelines are pulling weight.
- **`clear_findings`** — wipe findings within a scope before a fresh review run.
- **`get_review_summary`** — total findings, top errors, last guidelines hash — single low-token call for "how's the review looking?".
- **`review_and_fix_pack`** — one-shot context bundle for an agent that wants to fix a finding: the finding itself + the entry-point pack + impact analysis + any sibling user comments.
- **`score_findings`** — rank an existing set of findings against a natural-language query.
- **`propose_guideline_from_finding`** — given a finding the user agreed with, propose a one-line guideline that would catch it next time.
- **`review_diff_with_baseline`** — surface the scope of entry points that changed since baseline, ready for a targeted review.

### New: MCP resources (3 new)

- `codeatlas://workspace/ai-findings` — the full findings list as a JSON resource.
- `codeatlas://workspace/review-guidelines` — the current team rules.
- `codeatlas://workspace/review-summary` — counts, top errors, last review meta.

### New: push notifications

- `notifications/codeatlas/findings_changed` — emitted whenever findings are added, updated, or removed. Stdio clients that subscribe get updates without polling.

### New: AI review configuration

- Pick any provider — OpenRouter, OpenAI, Anthropic, Ollama (local), or any OpenAI-compatible endpoint. Configure with `OPENROUTER_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` env vars, or via the browser. Ollama and custom endpoints don't need a key.
- All review prompts include your team's guidelines (if set) as a scoped block.
- Each finding the model emits must quote 1–5 lines of source verbatim — anything that doesn't actually appear in your code gets filtered out before being persisted. Toggle this filter via `codeatlas.evidenceGateEnabled` (or the DEBUG button in the browser) when you want to see un-filtered output.

### Fixes

- **`git log`, `git branch`, and `git diff` queries** now work reliably when the MCP server is launched by another Node process (CI harnesses, agentic tools). Previously these silently returned empty lists with an EBADF inside.
- **Browser-mode home page** now shows real workspace stats (files / APIs / services / features) instead of em-dashes the moment a tab connects.
- **Diagram cards on the browser home page** now navigate correctly. Clicking System Design / Feature Areas / API List / Sequence / Flow Chart opens the matching diagram.
- **File-edit changes propagate to the browser** automatically — edit a file in your editor, and any open browser tab refreshes the diagram it was showing.
- **File watcher no longer reacts to its own state-database writes**, which used to fire an endless cascade loop.
- **Robust LLM response parsing**: handles prose-prefixed JSON ("Based on the data, here are findings: …"), bare JSON, and code-fenced JSON. Common pattern with smaller local models that surfaced as "0 findings emitted" in earlier versions.

### Upgrade notes

- All 25 tools from 1.x are unchanged. The 14 new tools are additive.
- `state.db` schema bumps from v2 to v3 to add the `ai_review_findings` and `review_guidelines` tables. Migration is automatic; existing workspaces gain the new tables on next load.
- Default storage directory for the standalone package remains `.codeatlas-sa/` (separate from the VS Code extension's `.codeatlas/`).

## 1.2.0

Diagrams in your browser, alongside the MCP server. No VS Code required.

```bash
npx @codeatlas/mcp /path/to/repo --browser
# Opens http://localhost:7742 in your default browser.
```

- **All six diagram layers** in the browser — system design, feature clusters, API list, sequences, file dependencies, function flow.
- **Live file-edit cascade** — saves propagate to the browser in real time.
- **Click any node to open the file** in your editor (`$EDITOR`, `code`, `cursor`, `subl`, `nvim`, `vim`).
- **Comments** — add, resolve, persist.
- **Light and dark themes.**
- **AI Review** with OpenRouter, OpenAI, Anthropic, Ollama (local), or a custom endpoint. Set the env var that matches your provider (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `LLM_API_KEY`) — Ollama and custom endpoints work without a key.
- **Natural-language search** ("find handlers that hit prisma.user") using the same provider set.
- **Replay working changes** — the diagrams step through your current edits one layer at a time, so you can see how a change propagates from a single function up to the system view.
- **Compare commits, branches, and pull requests** from the browser. PRs use the GitHub API — public repos work as-is; for private repos set `GITHUB_TOKEN` (or `GH_TOKEN`).
- **Multi-commit timeline walk** — pick a commit range and the diagrams auto-page through every step of every commit.
- **LLM settings editable from the browser.** Saved to your workspace config.

Default behavior (no `--browser`) is unchanged: stdio MCP only, no extra ports, no extra startup cost.

## 1.1.0

Initial release. 25 tools and 5 resources for any MCP-compatible LLM client.
