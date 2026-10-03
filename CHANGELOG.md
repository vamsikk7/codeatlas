# Changelog

All notable changes to the CodeAtlas extension are documented here.

## [9.3.0] - 2026-08-09

Sign in from the browser view, and a big correctness win: an edit now lights up every layer that depends on it — all the way up to the System Design map.

Ships with `@codeatlas/mcp@5.3.0`.

### What's new

- **Sign in to view your diagrams.** The browser view now asks for a quick sign-in to open diagrams and use the tools — sign in with your account, see who you're signed in as in the header, and sign out any time. Setting up your workspace still works signed-out (you can initialize and re-sync before signing in), and if your session expires CodeAtlas offers a one-click re-sign-in.
- **Help shape the project.** Once you're signed in, a quiet, opt-in prompt lets you register interest in seeing the CodeAtlas visual engine go open-source. One click — and if you're not interested, dismiss it and it won't come back.

### Fixed

- **An edit now marks every layer that depends on it.** Changing a function in a service or helper file — even one that has no route of its own — now correctly flags the affected feature, API list, and service on the System Design map as changed, not just the file and sequence views. Change tracking propagates all the way up.
- **Change highlights survive a reload.** Reopening a diagram after an edit keeps the correct "changed" markers instead of losing them.
- **No more repeated "session expired" prompts.** The re-sign-in prompt now appears once, when your session actually expires — instead of popping up on a loop.
- **No sign-in flicker on first load.** Opening the browser view no longer briefly flashes "Sign in" (and the sign-in prompt) before settling — the header now waits until it knows your status, so if you're already signed in you go straight to your account.
- **The header always reflects your real account.** The signed-in state now tracks your actual session everywhere, so you'll never see a "signed in" header while your diagrams are asking you to sign in — the two always agree.
- **Run the editor and the standalone MCP on the same project at once.** The single-writer lock is now scoped to each one's own data, so opening a repo in VS Code no longer blocks (or gets interrupted by) `@codeatlas/mcp` running on the same folder — they keep separate diagram data and stay out of each other's way.
- **Quieter, lighter Code Review card.** Fixed a case where the review panel could repeatedly re-request its status in the background; it now loads once and stays calm.
- **Code review lives in one place.** AI code review now runs only from the **Code Review** card on the home screen. The in-diagram review button, overlay, and per-node markers were removed, so diagrams stay clean — and clickable.
- **Diagrams open ready to explore.** System Design no longer opens in a "Baseline → Working" comparison view on first launch that you had to reset before you could click through the layers. First open is fully interactive; the comparison view is now opt-in via Compare Commits / Branch Diff / Replay.
- **No phantom "new screen" markers on full-stack projects.** Editing the backend no longer makes every front-end screen light up as newly added.

### Notes for existing users

- No database migration, no setting changes, no command changes — drop in and go.
- Viewing diagrams in the browser now needs a quick, free sign-in; initializing and re-syncing your workspace still work signed-out.
- Same 40+ supported frameworks (Express, Koa, Fastify, NestJS, Next.js, FastAPI, Django, Flask, Spring, Rails, Laravel, Go, Rust, and more).

## [9.2.0] - 2026-08-03

Sharper change tracking across your diagrams — edits now light up in the right places, and nothing lingers stale after a re-sync.

Ships with `@codeatlas/mcp@5.2.0`.

### Fixed

- **Edits to routes defined inline now show up everywhere.** When a route's logic lives right on the route definition (rather than in a separately named function), changing it now marks it changed on the sequence diagram and the function flow chart — not just the file view.
- **The incoming request arrow reflects a changed handler, even behind middleware.** On a sequence diagram, the arrow for an endpoint (a GET, POST, PUT… request) now shows as changed when its handler changed — including routes that pass through authentication or other middleware first.
- **No more false change markers on shared services.** Your database, token helpers, and third-party libraries are no longer flagged as changed on a sequence diagram just because a route that calls them was edited. Only what actually changed is highlighted.
- **The home screen refreshes right after a re-sync.** The stat cards and the "what to re-test" banner update immediately, instead of sitting blank or stale until you reload the page.

### Improved

- **Clearer feedback on sequence diagrams.** Clicking a participant or message that has no deeper view to open — an external dependency, or a call that couldn't be traced to a file — now tells you why, instead of doing nothing.

## [8.0.0]

### New — Cleaner, scoped Knowledge Map

- The Knowledge Map lays out each feature cluster with its own APIs stacked beside it — short edges, vertical growth — instead of the previous wide grid with long crossing lines.
- On multi-repo workspaces, the Knowledge Map now opens as one card per repository; click a card to see that repo's own map. (Previously every repo's content merged into a single huge graph.)

### Improved

- Every HTTP route now has a sequence diagram — including infrastructure-defined routes (Serverless Framework, SAM, CDK) whose handlers have no traced call chain; those show a clean request→handler view instead of bouncing to another layer.
- Tour steps read as guidance: step 1 explains why it leads the tour, and steps name the feature area they belong to.
- The standalone browser's workspace tour now matches the VS Code extension's repo-by-repo guided walkthrough on multi-repo workspaces.
- Drilling from a repo-scoped System Design into Features keeps the repo in the URL, so reload and copy-link stay on the slice you picked.
- Returning to System Design from the Tour (or via the home breadcrumb) on a large multi-repo workspace now shows the grouped overview instead of a wall of every service.
- Service counts refined again: a repository with a named service no longer also counts a generic placeholder.

## [7.4.0] - 2026-06-11

A reliability-and-overlays update. Large multi-repo workspaces get their live-update loop back, the numbers you see are now the same on every page, and a new Overlays panel lets you choose which signals paint on top of your diagrams.

Ships with `@codeatlas/mcp@3.4.0` — **54 tools** (up from 51).

### New — Overlays panel

A new **🎛 Overlays** button in the command bar opens a panel listing every signal that can paint on top of your diagrams — change markers, comments, test coverage, and TODO/FIXME density — each with its own on/off toggle. Toggles persist across reloads. Diagrams stay quiet by default (only change markers start enabled); flip on what you need, and an inline hint warns when enough overlays are active that the canvas may get busy. Coverage shows a friendly "drop an lcov.info here" hint instead of a dead toggle when no coverage file exists.

AI agents get the same data through two new MCP tools: `list_overlays` and `get_overlay` — UI toggles never gate what the model can read.

### New — "What should I re-test?" (regression scope)

After you make changes, a new banner on the home page composes your working diff, blast radius, coverage, and cross-repo consumers into a ranked re-test plan. Also available to AI agents as the `get_regression_scope` MCP tool.

### New — Cross-repo change notifications

In multi-repo workspaces, saving a file in one sub-repo now notifies open tabs that consume its APIs: the affected *consumes* arrows update live, active System Design views soft-refresh with a toast, and background tabs get a subtle "upstream changes" chip instead of stealing focus.

### Fixed — Live updates on large multi-repo workspaces

On workspaces with many sub-repositories (50+), file saves could silently stop updating the diagrams after a while. The live-update loop now stays connected no matter how many sub-repos the workspace holds — edits show up across all six layers within seconds again.

### Fixed — Service counts now agree everywhere

- The home page's SERVICES stat no longer collapses same-named services from different sub-repos into one — a 132-repo workspace that really exposes 209 services now says 209.
- The System Design header on those grouped workspace views now reads the true total too — "209 services · 10 groups" — instead of calling the 10 condensed groups "10 services". Both numbers come from the same count, so they can't drift apart.
- The standalone browser (`npx @codeatlas/mcp`) home page previously showed only the primary sub-repo's counts in multi-repo workspaces; it now aggregates files, APIs, and services across all sub-repos like the VS Code extension, and its System Design view shows the same grouped overview on very large workspaces.

### Fixed — Change badges for serverless-style handlers

Editing a handler written as `module.exports.create = (…) => {…}` (the common Serverless Framework / Lambda style, especially without semicolons) now marks the changed statement on the Function Flow chart with the usual `+` / `~` badge. Previously the chart redrew with your new code but showed no change marker at all.

### Fixed — Large multi-repo navigation

- The grouped System Design view on big workspaces (50+ sub-repos) no longer disappears after a file save — it previously got replaced by an unreadable one-node-per-repo wall until re-initialization.
- Clicking a service on a sub-repo-scoped System Design now opens **that** repo's features. Previously, when several sub-repos all exposed a default service, the click could land on a different repo's feature view.
- Clicking an AWS-service group node now explains what the group contains and points you to the Home picker, instead of dead-ending on an empty Features page.
- Clicking an API row whose handler has no sequence diagram yet (some infrastructure-defined routes) now falls back to the handler's flow chart or file diagram with a note — never an endless "Loading…" spinner. The same safety net covers Tour drill-downs and pasted deep links.
- On multi-repo workspaces, the workspace Tour's “Drill into repo tour” now opens the chosen sub-repo's own walkthrough (it previously did nothing on large workspaces).
- The Knowledge Map no longer shows a partially-built view if you open it in the first seconds while the workspace is still indexing.
- Fixed a background race where AI cluster naming could corrupt the change-tracking baseline, making unrelated feature clusters show phantom "+ added" badges after a small edit. If you've seen that, one **Re-sync Everything** clears it permanently.

### Fixed — Multi-repo polish

- **Business Domains** (`#/domain`) now renders on multi-repo workspaces instead of bouncing back to home.
- The MCP `list_entrypoints` tool now returns the merged entry-point set across all sub-repos by default (pass `repoId` to scope), matching its documented behaviour.
- Repeated saves of an Express file no longer accumulate phantom API records that flagged every cross-repo consumer as modified on each save.
- After a timeline replay finishes in a multi-repo workspace, it now also walks the cross-repo connections affected by the replayed changes, so dependent repos' updated edges are part of the story.

### Notes for existing users

- No settings changes, no command changes, and no on-disk migration — your existing `.codeatlas` state keeps working as-is.
- The improved change badges for serverless-style handlers apply fully after your next **Re-sync Everything** (or the next workspace initialization), which refreshes the stored comparison baseline.
- Three new MCP tools (`list_overlays`, `get_overlay`, `get_regression_scope`); all previously existing tools and resources are unchanged, so agents upgrade safely.
- Same supported frameworks across JS/TS, Python, Java/Kotlin, Go, Rust, Ruby, PHP, C#, Swift, Dart — plus the same mobile (Android / iOS / React Native / Flutter) and IaC (Serverless / SAM / CDK) coverage as 7.3.0.

## [7.3.0] - 2026-06-10

A multi-repo polish release. When you open a workspace with several sub-repositories, every layer now feels "single-repo clean" once you pick a sub-repo — System Design, Feature Areas, Knowledge Map, Sequence, Flow, API List, Search, and Path Finder all scope to the sub-repo you chose, and step back to the full workspace whenever you ask. Code Review gains per-sub-repo guidelines so each service can enforce its own rules. Detection coverage tightens around .NET Lambda handlers and AWS managed infrastructure.

Ships with `@codeatlas/mcp@3.3.0` — same 51 tools, with the standalone browser surface now matching the extension layer-for-layer in multi-repo workspaces.

### New — Pick a sub-repo, see its slice end-to-end

In multi-repo workspaces the home picker now opens a two-step flow on **API List**, **Sequence**, and **Flow Chart**: step 1 picks a sub-repo, step 2 picks an entry point within it. The picker shows the technology and a real HTTP-routes count next to every sub-repo (`aws-dotnet-rest-api-with-dynamodb · serverless · 3 APIs`), so you can choose without drilling in to count.

Once you're in, the URL hash carries the scope (`#/system-design/<sub-repo>`, `#/map/<sub-repo>`) so reload and copy-link both stay on the slice you picked. System Design and Knowledge Map both rebuild on demand for the picked sub-repo — you see just that service plus its infrastructure neighbours, not the whole workspace overview.

### New — Per-sub-repo Code Review guidelines

Open Code Review in a multi-repo workspace and the scope picker now lives **inside** the card. Pick a sub-repo and:

- Every review (Start review / Changed only / Full re-review / Specific review) targets that sub-repo.
- The **Review guidelines** card grows a per-sub-repo chip — guidelines you save while scoped to `aws-node-http-api-mongodb` apply only to that sub-repo. Switch scope to a sibling and the guidelines flip with it.
- Guidelines persist per sub-repo across sessions; workspace-wide guidelines stay available when no scope is picked.

A single sub-repo can encode service-specific rules ("flag any S3 write that doesn't go through the IAM-checked helper") without polluting the workspace-wide list.

### New — "Search only in this repo" toggle on Search + Path Finder

In multi-repo workspaces the **Search** modal and **Find Call Path** modal both render an *in-this-repo* checkbox that defaults **on** whenever the current URL carries a sub-repo scope. Search results, file/function candidates, and path-finder source/target lists all filter by sub-repo. Untick the checkbox to widen the search workspace-wide — useful for tracing a call that crosses service boundaries.

### New — Cross-repo HTTP edges flag stale consumers

When one sub-repo calls another's HTTP endpoint and that endpoint's response shape changes, the L1 *consumes* arrow + the L3 sequence's outbound message now light up as `~ modified` automatically. No re-clicking; the next render after the upstream change picks it up.

### New — Multi-repo init progress

On large multi-repo workspaces the home page shows `Init: 130/132 ready, 2 failed (click for details)` while sub-repos finish parsing. Clicking the count surfaces which sub-repos still need attention.

### Improved — .NET Lambda handlers detected correctly in serverless workspaces

In Serverless Framework workspaces a .NET function written as `DotNetServerless.Lambda::MyNamespace.Functions.CreateItem::Run` now resolves to the right `.cs` file. The HTTP route, cluster membership, and sequence diagrams all wire up; previously the namespace path was stripped and the handler appeared to have zero APIs attached.

### Improved — AWS managed infrastructure on .NET services

Services written in C# that use `Amazon.DynamoDBv2`, `Amazon.S3`, `Amazon.SQS`, or `Amazon.SimpleNotificationService` now surface the managed infrastructure on the System Design layer next to the service. Same one-glance view your Node, Python, Go, and Java services already had.

### Improved — Multi-repo Knowledge Map scoping

When you pick a sub-repo from the home picker, the Knowledge Map zooms to that sub-repo: its services, clusters, files, infra databases / queues / caches, plus any cross-repo *consumes* edges that touch it. The URL hash stays scoped so you can share a link directly to a sub-repo's map.

### Improved — Per-sub-repo Git Diff sessions

Compare Commits, PR Diff, Branch Diff, and Replay now keep one diff session **per sub-repo**. Open Compare Commits against `service-a` in one tab and `service-b` in another and they coexist; restoring the page restores the right session. Workspace-wide diff (no sub-repo picked) still works as before.

### Polish

- Background fixes to the API List picker so sub-repos sharing a cluster name (`cluster:model` is common across MongoDB examples) all show up correctly in step 2.
- Code-blocks in the home Code Review card now show the live sub-repo chip beside the per-repo guideline label.
- Knowledge Map for the picked sub-repo no longer briefly flashes the workspace overview before settling on the scoped view.

### Bundled MCP server

CodeAtlas ships with `@codeatlas/mcp@3.3.0`. Same 51 tools across every detected MCP client (Claude Code, Cursor, Codex, Gemini, VS Code Copilot Chat, Continue). The standalone browser surface now matches the VS Code extension layer-for-layer in multi-repo workspaces — pick a sub-repo and the per-sub-repo System Design, Knowledge Map, picker subtitles, and Code Review chip all behave identically whether you're using the VS Code panel or `npx @codeatlas/mcp <workspace> --browser`.

## [7.2.0] - 2026-06-07

A breadth release. CodeAtlas now sees more of your codebase: framework middleware shows up in your sequence diagrams across nine ecosystems, serverless / SAM / CDK routes are picked up alongside HTTP routes, and multi-repo + multi-binary workspaces feel noticeably steadier from first open. The MCP server gains two new tools and a quieter co-existence with the VS Code extension.

Ships with `@codeatlas/mcp@3.2.0` (51 tools, up from 49).

### New — Middleware shows up as participants in your sequence diagrams

Sequence diagrams used to jump straight from the route to the handler body, hiding everything that ran in between. Now your authentication, rate-limiting, logging, and other middleware appears as its own swimlane participant — so a `GET /api/user` route shows the auth middleware → controller → service flow end-to-end. Coverage:

- **JavaScript / TypeScript** — Express, Koa, Fastify, Hono, NestJS (`@UseGuards` / interceptors / pipes)
- **Python** — Django, Flask, FastAPI, Starlette
- **Java / Kotlin** — Spring (interceptors, filters, aspects, global exception handlers), Ktor
- **Go** — Gin, Echo, Chi
- **PHP / Ruby** — Laravel, Symfony, Rails (`before_action` / `around_action` / `after_action`)
- **Rust** — Actix, Axum

Cross-file mounts work too: a route registered in one router file and mounted at a prefix in another carries both the inner and the parent middleware in its sequence.

### New — Serverless / SAM / CDK routes appear alongside your HTTP routes

Routes defined in infrastructure-as-code now show up everywhere your HTTP routes already do — the API list, sequence diagrams, system-design layer, and MCP `list_entrypoints`.

- **AWS SAM** — `AWS::Serverless::Function` HTTP / API events, including `AWS::Serverless::Api` consolidation
- **AWS CDK** — REST API + HTTP API constructs across TypeScript, Python, and Java. Multi-file stacks resolve correctly — a route defined in one stack and consumed in another both attribute to the right service
- **Serverless Framework** — `functions.<name>.events.http` in `serverless.yml` (REST + HTTP API + ALB)

Each IaC-sourced route carries a small `«iac»` tag in its sequence so you can tell at a glance whether the route comes from application code or from infrastructure.

### New — gRPC + GraphQL routes carry their authentication

gRPC service methods now pick up auth interceptors as middleware participants. GraphQL resolvers (Apollo / Nexus / Pothos / NestJS `@UseGuards`) get the same treatment. The 🔒 lock icon in the API list now reflects auth requirements correctly for HTTP, gRPC, GraphQL, and tRPC alike.

### New — Saved views for the API list

Filter the API list — method tabs (POST / GET / DELETE), search term, finding-severity bucket, "show only modified" — and click 💾 Save view to keep it. Saved views appear in the toolbar; one click restores the exact filter combination, regardless of which cluster you're currently in. Views persist between sessions.

### New — Auto-detect of API collections (OpenAPI / Postman / Insomnia)

CodeAtlas now scans your workspace for `openapi.yaml`, `openapi.json`, `*.postman_collection.json`, and `*.insomnia.json` and surfaces them in the API Testing workbench automatically — no need to click Import. Click one to merge it into your active environment.

### New — OAuth2 callback receiver in API Testing

The Auth tab now ships a built-in OAuth2 callback receiver at `http://localhost:7742/oauth-callback`. Wire it into your provider's redirect URI, click **Authorize**, log in in the browser tab — the receiver captures the code, exchanges it for a token, and drops the access token into your environment under `oauthAccessToken`. SSE and WebSocket tabs also gained connect-state badges, message counters, and autoscroll.

### New — Scope picker on multi-repo and multi-binary workspaces

When your workspace has more than one repository, or more than one binary entry point (a Go `cmd/` directory with several mains, a Rust workspace with multiple crates), a scope picker now appears in every layer toolbar — Microservices, Features, API List, Knowledge Map, Domain, Sequence. Pick one and the UI scopes to it. The picker remembers your last choice per route.

### New — Mobile Xamarin / .NET MAUI detection

CodeAtlas now reads Xamarin.Forms and .NET MAUI projects: `ContentPage` views, navigation via `Shell.Current.GoToAsync` / `NavigationPage.PushAsync`, network calls via `HttpClient` / `Refit`, dependency-injection bindings via `MauiAppBuilder.Services` / `Splat`, and background tasks via `BackgroundFetch` / `WorkManager`. Same five-layer treatment as Android and iOS.

### Improved — Multi-repo + serverless steadier on first open

Multi-repo detection now recognises serverless monorepo shapes (one service folder per `serverless.yml`, several CDK stacks under a single root) and multi-binary monorepos (Go workspaces with multiple `cmd/<name>/main.go`, Rust workspaces with multiple `[[bin]]` targets). Each service / binary gets its own indexed slice; the dashboard groups clusters + APIs by repo. Large initial indexes parallelise across all detected services.

### Improved — Cleaner clusters and a tidier system-design layer

- **Cluster call counts and cohesion** now reflect actual file-graph relationships, so the cohesion percentage you see matches what the underlying clustering algorithm scored — even when files have cross-cluster dependencies.
- **No duplicate clusters** — if a child cluster contains only files already promoted into a parent, it's collapsed away. No more `Authentication (10 files)` + `Authentication (3 files)` siblings.
- **Infrastructure grouping** — when your workspace touches multiple databases / caches / queues / external APIs, those resources now group under tidy Data / Infrastructure layers instead of rendering as 6 sibling nodes.

### Reliability — Background error tracking

Uncaught exceptions in the extension host, the MCP standalone server, or the in-browser webview are now reported as anonymized stack traces so we can spot and fix real failures without you having to file a ticket. Code snippets never leave your machine. Disable entirely by setting `CODEATLAS_TELEMETRY=0` or `DO_NOT_TRACK=1` in your shell environment — both telemetry and error reporting honor either flag.

### Reliability — Self-correcting LLM calls

When CodeAtlas asks an LLM for structured output (request body inference, AI Review findings, natural-language search, test-case generation) and the response doesn't quite match the expected shape, CodeAtlas now sends one quick corrective re-prompt that quotes the validation error back to the model. Recovers a meaningful share of "almost-valid JSON" responses from smaller / cheaper local models that previously got dropped.

### Bug fixes

- **No more flash of stale content** on rapid route switches. When you jumped between layers quickly, the diagram occasionally showed the previous view for a beat before re-rendering — fixed.
- **Multi-repo scope picker** now appears on the Feature / API list / Flow Chart cards from the home page (it used to skip them); Cancel inside the picker clears the memo so the next click reopens it.
- **Fastify prefix routes** — routes registered via `fastify.register(plugin, { prefix: '/api/v1' })` previously rendered without their prefix; the prefixed path is now what shows up everywhere.
- **Java CDK** — CDK stacks written in Java now extract routes alongside the existing TypeScript and Python CDK support.

### MCP server (3.2.0)

- **Two new tools**: `trace_call_path` (shortest call path between two functions) and `generate_chain` (AI-proposed multi-step request chain). Bringing the total to 51 tools across Claude Code / Cursor / Codex / Gemini / Continue / VS Code Copilot Chat / Antigravity.
- **Browser surface moved to port 7842** so the MCP server and the VS Code extension (which uses 7742) can run side-by-side without a port collision. Override with `--port <N>` if 7842 is taken. Stdio clients are unaffected — they don't touch this port.

### Privacy

Telemetry and the new error reporting both respect the same two opt-outs that have always worked: set `CODEATLAS_TELEMETRY=0` or `DO_NOT_TRACK=1` in your shell environment to disable everything from the very first event. User identifiers are an anonymized SHA-256 hash; no source code, file contents, or paths leave your machine.

## [7.1.1] - 2026-06-04

A polish + bug-fix release. No breaking changes. Two new small controls land on the home page (Test Connection + Modules domain-phrase subtitle), six pre-existing UX rough edges from live verification are smoothed out, and the AI Review cost-estimate flow is hardened against silent hangs.

Ships with `@codeatlas/mcp@3.1.1`.

### New — "Test Connection" button on the LLM Config card

Click **Test Connection** on the home-page LLM Config card to verify the configured LLM endpoint is actually reachable BEFORE clicking Start review (and tripping the 15-second cost-estimate timeout). Provider-aware probes, all free / read-only:

- **OpenAI** → `GET /v1/models` with `Authorization: Bearer <key>`
- **OpenRouter** → `GET /api/v1/models`
- **Anthropic** → `POST /v1/messages` with empty body (400 = auth passed, key + endpoint reachable)
- **Ollama** → `GET <endpoint>/api/tags` (rewrites a `/v1/chat/completions` URL into `/api/tags` so the probe is cheap)
- **Custom** → `HEAD <endpoint>`

10-second `AbortController`-bounded timeout. Network failures translate into actionable messages: `ENOTFOUND` → "Couldn't resolve the LLM host (DNS)", `ECONNREFUSED` → "Connection refused — is the server running?", abort → "Timed out after 10s". The button has its own state machine (idle → testing → ok / error / timeout) with a Cancel from t=0 and a Retry on every terminal state, so a user with a flaky network can keep poking until it works.

### New — Modules layer shows the verb-phrase domain as a subtitle

The Modules layer (Louvain-derived clusters keyed by folder name — `auth`, `random`, `src`) now surfaces the matching verb-phrase domain from the Domains layer as a secondary subtitle on each cluster card. Example: the `auth` cluster now reads `🧭 Authenticate users` below the file count. Bridges the "where the code lives" ↔ "what it does" gap without forcing the user to flip layers. Powered by a new `inferDomainPhraseForCluster` helper that picks the dominant domain by file-overlap, tie-broken by domain confidence.

### Improved — Code Review cost-estimate timeout + Cancel + Retry

The pre-flight cost-estimate spinner used to hang silently when the LLM endpoint was slow or unreachable — no progress signal, no Cancel button, no recovery short of reloading the SPA tab. Now:

- Cancel button visible **from t=0** so users can always back out without reloading.
- After 15 seconds without a response, the panel flips to `⚠ Cost estimate timed out after 15s. Check your LLM endpoint (<provider> (<model>) at <url>).` with both Retry and Cancel.
- The endpoint label names the active LLM target (OpenAI / OpenRouter / Anthropic / Ollama / Custom) + model + URL so the user knows exactly which target is unreachable.
- Retry restores the loading state for the next attempt — useful when the endpoint is flaky.

### Improved — "RESPONSE FAILED · fetch failed" surfaces an actionable hint

When the user clicks **▶ Send** in the API Testing workbench and the target server isn't reachable, the response panel now renders a `💡 Is your API server running?` hint above the raw error. Detected patterns:

- localhost target → "Is your API server running? CodeAtlas tried to reach `<url>` but the connection was refused. Start the local server and click Send again."
- Private LAN host (10.x / 192.168.x / 172.16–31.x) → "Couldn't reach the private host. Check that you're on the right VPN / network."
- DNS resolution failure → "Couldn't resolve `<host>`. Check the URL in the request preview."
- Generic public host → "Couldn't reach `<host>`. The server may be down or blocked by a firewall."

The raw error stays visible underneath for power users.

### Improved — Toolbar carries visible short labels (no more emoji wall)

Every top toolbar button now shows a short text label next to the emoji icon — `🏗System`, `🧩Features`, `⚡APIs`, `💊Health`, `⎇Compare`, `🌿Branch`, `⤵PR`, `🎯Impact`, `⏯Replay`, `📄Export`, `✨Ask AI`, `💬Comments`, `🔍Search`, `🔄Sync`, `☾Dark`. Long-form tooltips still carry the full description (`System Design (L1)`, `Ask AI (Cmd+Shift+Q)`, etc.) so the discoverability win doesn't cost the power-user a11y signal.

### Improved — L2b API rows are keyboard accessible

Every `.ca-api-row` in the L2b API list now exposes `role="button"`, `tabIndex=0`, a route-bearing `aria-label` (`Open sequence diagram for GET /api/user`), and Enter/Space keyboard activation. Screen-reader users can navigate the API list without a mouse.

### Bug fixes

- **`/violations` title** said "Health Report" because the outside-route render flow inherited the previous view's `document.title`. New `outsideRouteTitle` helper + a dedicated effect now pin `CodeAtlas — Architecture Violations` (and `Tour` / `API Testing` for the other outside routes).
- **`#/domains` plural typo** silently hung the SPA on "Connecting…" because `parseHash` returned null for the plural form. Now aliased to the canonical singular `#/domain` route — the typo recovers + the URL normalizes.
- **Tour step body** leaked synthetic `anonymous@GET:/` handler IDs in the blurb + path footer for inline arrow-callback routes. Both the server-side tour-builder blurb AND the client-side TourView footer now suppress the `anonymous@` prefix. Step 1 now reads `Read /.` instead of `Read /. Handler: \`anonymous@GET:/\`.`.

### Tests

- Extension-host: 4423 (up from 4405 — new coverage on llmConnectionProbe (18 cases), tourBuilder anonymous-handler suppression (3 cases), inferDomainPhraseForCluster (6 cases), featureGraphBuilder domain-phrase meta (3 cases))
- Webview UI: 525 (up from 485 — new coverage on LlmConnectionTestButton (8 cases), EstimatingCostPanel (7 cases), interpretFetchError (13 cases), outsideRouteTitle (4 cases), parseHash plural alias (2 cases), ApiListPanel a11y (4 cases), CommandBar visible labels (4 cases), AiReviewControlCard endpointLabel (3 cases), TourView anonymous-symbol suppression (2 cases))

### Migration notes

No action required. All changes are additive or fix silent regressions. The new Test Connection button appears automatically on the home page once your settings include `llmProvider`.

## [7.1.0] - 2026-06-04

A minor release focused on **first-class multi-repo monorepo support** (ADR-034) plus a round of UX hardening surfaced by live verification against framework-spanning workspaces. The 8 existing diagram layers and the API Testing + Knowledge Map surfaces from 7.0.0 now work transparently across a workspace of N independent repos — same single-repo flow, same hotkeys, same drill paths.

Ships with `@codeatlas/mcp@3.1.0`.

### New — Multi-repo monorepo support (ADR-034)

Open a folder containing N sibling repos (each with its own `.git`) and CodeAtlas indexes every repo into its own per-repo `state.db`, aggregates the results into a workspace-level `monorepo.db`, and renders a unified view across all of them — without flattening into a single fake "workspace service" or dropping per-repo identities.

- **Per-repo `state.db` + workspace `monorepo.db`.** Each repo gets its own SQLite store under `<repo>/.codeatlas/state.db`. The workspace root holds a `monorepo.db` with the cross-repo registry, shared external SDK union, schema union, and HTTP-edge propagation. Backwards compatible — single-repo workspaces behave exactly like 7.0.0 (LRU never evicts at size 1).
- **Aggregator registry tracks every repo.** Per-repo summaries (APIs, SDKs, schemas, HTTP client paths) flow into the aggregator on init + on every save, so cross-repo dependencies surface in L1 the moment the second repo finishes parsing.
- **Worker-thread parallelism (Tier-2).** Per-repo orchestrators run in a 8-worker pool; an 8-repo workspace inits in ~1.5s end-to-end on a laptop. The dispatcher chooses between in-process (Tier-1, ≤3 repos) and worker-pool (Tier-2, ≥4 repos) based on repo count.
- **Skeletal L1 lands in <1s.** Even before any per-repo parse finishes, a skeletal L1 graph paints one card per detected repo so you see the topology immediately. Full L1 (with inter-service edges, infra grouping, worker nodes) replaces the skeleton via the standard `notifyRefresh` mechanism.
- **Per-repo Knowledge Map + Tour + AI Review + API Testing.** Every higher-level surface that worked on a single repo now drills cleanly into a per-repo scope. Knowledge Map shows each repo as its own domain cluster; Tour offers both a workspace meta-tour (one step per repo) and per-repo tours (`#/tour/<repoId>`); AI Review can scope findings to a single repo or run workspace-wide; API Testing groups endpoints by repo.
- **Cross-repo diff propagation + workspace re-sync.** Editing a file in repo A triggers a cascade in just that repo (no full-workspace re-parse), AND surfaces the cross-repo impact in repo B's diff badges if a shared external SDK or HTTP edge is affected. The workspace re-sync command rotates all per-repo baselines atomically — if any repo fails, the aggregator stays at the prior baseline so pending diffs aren't lost.
- **Failure isolation.** A parser crash in one repo no longer aborts the fan-out — the failing repo shows a "Failed" badge in L1 with the underlying error, and the other repos finish indexing normally.
- **Repo-tab cards in L1.** Each multi-repo L1 service node carries the repo's friendly name (`api`, `web`, `services/auth`) instead of the internal hex hash. Click any card to drill into its per-repo `feature:workspace` clusters.

### New — Architecture Violations panel (Issue #749)

A dedicated `#/violations` view that runs the configured rule set (`no_cyclic_dependencies`, `auth_required_on_writes`, etc.) and surfaces every violation with file + line context. Each rule produces a severity badge (🔴 error, 🟡 warning) so triage is fast. Open from the home page or any layer's toolbar.

### Improved — UX hardening from live verification

Sixteen+ UX issues surfaced and fixed during live dogfooding sessions over the 7.1.0 cycle:

- **Multi-repo home stats now aggregate correctly.** Previously the workspace-level snapshot was empty in multi-repo mode and the home page showed `—` placeholders. Counts now sum across per-repo stores AND dedupe services by id (was reporting `64 SERVICES` for 8 repos × 8 cross-repo stubs; now correctly reports `8 SERVICES`).
- **L1 click in multi-repo lands on the right Feature Clusters.** The card click now routes through the per-repo store's `feature:service:<repoName>` graph instead of falling through to an empty aggregator graph.
- **Repo chips show friendly names.** Multi-repo L1 cards no longer expose the raw 16-char repoId hash — they show `api` / `web` / `services/auth` with the full id available in the tooltip.
- **System Design breadcrumb deduped.** Multi-repo L1 used to read `System Design: System Design` because the defaulting fallback inserted the layer name into itself; now reads `System Design` when no meaningful repo name is available.
- **Cold deep-links to `#/tour` and `#/api-testing` no longer hang.** The SPA's initial-mount hash handler now recognises both non-graph surfaces and dispatches the right `requestTour` / `requestRoute` message.
- **Domain card drill, Ask AI wiring, Knowledge Map columnar layout, stat-card persona gating, Tour verb-ordering** + ~10 other UX-numbered fixes — see git history `UX-1`…`UX-21` for the full list.
- **Architecture Violations title fix.** `#/violations` now shows `CodeAtlas — Architecture Violations` in the title bar instead of inheriting whatever the previous view was.
- **`#/domains` plural typo is forgiven.** Typing the plural form (the natural English) used to silently hang the SPA on "Connecting…"; now aliased to the canonical singular `#/domain` route.
- **L2b API rows now keyboard-accessible.** Every `.ca-api-row` gets `role="button"`, `tabIndex=0`, a route-bearing `aria-label`, and Enter/Space keyboard activation. Screen-reader users can now navigate the API list without a mouse.
- **Tour body no longer leaks synthetic `anonymous@GET:/` handler ids.** The parser invents these for inline arrow-callback routes; Tour step blurbs and path footers now suppress them.

### Improved — community detection + page refresh

- **Community detection (cluster naming) is more deterministic** at small repo sizes — same input produces the same clusters across runs.
- **Page refresh** no longer drops the navigation stack or the active diff context.

### Improved — MCP surface alignment with multi-repo

The MCP server reads from the same per-repo + aggregator stores the extension uses, so the 25-tool surface returns workspace-aware results out of the box. `list_services`, `get_microservices`, `get_features`, `get_apis`, `get_call_path` etc. all surface per-repo provenance in their results so an AI agent can reason about which repo a finding lives in. See `@codeatlas/mcp@3.1.0` for the matching client-side notes.

### Tests + CI

- Extension-host tests: 4405 (up from 4380 in 7.0.0; new coverage on workspace orchestrator, aggregator store, cross-repo diff propagation, multi-repo cascade T3 scenarios, monorepo cleanup helpers, accessibility regressions)
- Webview UI tests: 485 (up from 466; new coverage on multi-repo chip labels, parseHash plural alias, outside-route title pinning, ApiListPanel a11y attributes, TourView anonymous-handler suppression)
- Real-world verification suite (`npm run verify:real`) expanded to assert per-layer leak rates across the 37 cloned framework repos

### Migration notes

No action required. Single-repo workspaces are unchanged. Existing `.codeatlas/state.json` files (pre-ADR-034) are silently migrated to the new SQLite store on first open.

## [7.0.0] - 2026-05-30

A major feature release. Two new top-level surfaces land alongside the existing six diagram layers: a full **API Testing workbench** that lets you browse, send, chain, script, import, and AI-generate HTTP/SSE/WebSocket/OAuth2 requests directly from the side panel, and a **Knowledge Map** that distills the workspace into a navigable mental model of features, files, and tour stops. The MCP surface grows from 40 to 50 tools to expose the same capabilities to AI agents.

Ships with `@codeatlas/mcp@3.0.0`.

### New — API Testing workbench

A first-class request workbench, fed automatically by the same indexer that powers the diagrams. Open the API Testing view in the side panel and every HTTP route the extension already knows about appears as a runnable request — no copy-paste from cURL, no Postman roundtrip.

- **Read-only browser.** Every detected route from every framework (HTTP, gRPC, WS, SSE, GraphQL subscription, mobile deep link, etc.) is listed with its method, path, file, and inferred schema. The schema inferrer reads JSDoc, TypeScript types, Zod, Joi, Yup, and class-validator decorators, so the request body editor pre-populates with the shape the handler actually expects.
- **Send-and-see.** Send any request inline. Response status, headers, latency, and body show up in the same panel; multiple responses are kept side-by-side for diffing.
- **Chain runner.** Build ordered multi-step flows (login → fetch token → call protected route → assert response) with JSONPath extractors that carry env vars between steps. Per-step assertions cover status codes, body contains/not-contains, header presence. Run the full chain or stop on first failure.
- **Sandboxed scripts.** Pre-request and post-response scripts run in a Node `vm` sandbox with a `pm.*` API surface (`pm.environment.set`, `pm.response.json()`, `pm.expect(...)`) — close enough to Postman that existing scripts port over. No filesystem, network, or process access from inside the sandbox.
- **AI generators.** Three evidence-gated generators on top of the LLM config you already use for Code Review: `Generate Request Body` proposes a body grounded in the handler source, `Generate Chain` proposes a sequence that exercises a coherent flow ("login then create article"), and `Generate Test Cases` produces a structured suite of positive + negative cases. Every generated field has to quote a source line as evidence — fields the model can't ground are dropped before display.
- **Importers.** Drag in an OpenAPI 3.x / Swagger 2.0 spec, a Postman v2.1 collection, or an Insomnia v4 export and the workbench merges it with the auto-derived list. The importer auto-detects the format from top-level fields.
- **OAuth2 helpers.** Built-in `client_credentials`, `authorization_code` (with PKCE), and `refresh` flows. The extension only assembles the URL and exchanges the code — it never stores secrets in plain text.
- **WebSocket + SSE.** Connect to a `ws://` / `wss://` endpoint, send scripted frames, capture inbound messages, close cleanly. Or open an SSE stream and read events until eof / cap. Both honour bearer tokens, header substitution, and env var substitution.

### New — Knowledge Map + Domain Map + Tour

A higher-level mental model surface over the indexer's output.

- **Knowledge Map view** clusters routes, screens, jobs, and consumers into domains (Auth, Articles, Payments, …) and surfaces the load-bearing entry points + supporting files in each domain. Click any node to drop into the corresponding sequence/file/flow diagram. Designed to answer "what does this codebase do?" in 30 seconds, not 30 minutes.
- **Domain verification** flags routes that don't belong to their parent domain (e.g. an auth route surfacing in `articles`) so the clustering stays honest as the codebase grows.
- **Tour mode.** Two ordered walkthroughs over the workspace: `codebase` ranks entry points by call-graph fan-in DESC so a new contributor starts at the most load-bearing routes; `recent` orders by diff status (modified → added → unchanged) for a "what just changed" tour. Each step carries a one-line "why this matters" blurb and a drill-down link to the corresponding L3 sequence.

### New — schema inference across six validator ecosystems

The L2b API list and the API Testing workbench now show inferred request/response shapes pulled from:

- **JSDoc** `@param` / `@returns` blocks
- **TypeScript** parameter types, return types, generics
- **Zod** schemas (`z.object`, `z.string`, refinements, transformers)
- **Joi** schemas (`Joi.object`, validator classes)
- **Yup** schemas
- **class-validator + class-transformer** decorators

Schemas inferred from one ecosystem in a handler are merged with schemas inferred from another (e.g. a Zod body + a class-validator query) so the workbench shows the full surface, not just the first match.

### New — 14 MCP tools (40 → 50)

The MCP server gains every capability of the workbench plus three exploration tools:

- `run_api_chain` — execute a list of HTTP requests with JSONPath extraction + per-step assertions
- `stream_sse` — open an SSE connection, read events, return them
- `connect_websocket` — open a WS connection, send scripted frames, capture inbound
- `oauth2_token` — exchange OAuth2 credentials (3 grant types)
- `oauth2_authorize_url` — assemble the authorize URL with optional PKCE
- `import_api_collection` — import OpenAPI / Postman / Insomnia
- `generate_request_body`, `generate_chain`, `generate_test_cases` — evidence-gated LLM generators
- `get_tour` — return the codebase / recent-changes walkthrough
- `pre_edit_brief` — one-shot context bundle before editing a file/function
- `trace_call_path` — BFS the call graph for the shortest path between two functions
- `list_entrypoints_paged` — paginated list_entrypoints for very large workspaces
- `list_architecture_violations` — run built-in + custom rules over the workspace

### What's better

- **Verification protocol is now self-driving.** A new `comprehensive-verify` skill runs five legs in one command — lint + unit + real-project fixture sweep + cascade replay + Playwright + MCP all-tools probe — and reports a single pass/fail table. The skill replaces the manual five-step ritual.
- **Six framework classifiers refreshed.** Vue, Svelte, SwiftUI, Jetpack Compose, Flutter, and Android XML detection paths landed clarifying rewrites; route counts now match hand-verified expectations across the 29-repo fixture set.
- **More accurate mobile screen detection.** Android XML layouts, Compose screens, SwiftUI views, and Flutter widgets are merged into one screen list per app — no more duplicate entries when a screen has both an XML layout and a Compose host.

### Notes for existing users

- **No database migration.** Your existing `.codeatlas/state.db` keeps working. New columns (inferred-schema metadata, knowledge-map clusters) are populated lazily on the next cascade rebuild.
- **No breaking command changes.** Every command from 6.x still works. Three new commands are registered: `CodeAtlas: Open API Testing`, `CodeAtlas: Open Knowledge Map`, `CodeAtlas: Start Tour`.
- **No setting changes required.** The API Testing surface uses the existing `codeatlas.llm*` configuration for AI generators — same key, same model selection, same opt-out. If you've never enabled the LLM features, the AI generator buttons stay hidden.
- **MCP tool count is now 50.** Existing tool names + schemas are unchanged. Only additions.
- Same 30+ supported frameworks across JS/TS, Python, Java, Kotlin, Go, Rust, Ruby, PHP, Swift, C#, Dart.

## [6.2.1] - 2026-05-28

A small follow-up release. Two infrastructure-level fixes that affect long sessions and observability. No new commands, no setting changes, no MCP tool changes.

Ships with `@codeatlas/mcp@2.2.1`.

### What's better

- **Anonymous usage telemetry now reaches our dashboard reliably.** Previous builds defaulted to a no-op sentinel when the telemetry token wasn't explicitly set at build time — a quirk of how the bundler injects build-time secrets. The fix wires a real default so anonymous adoption + usage data flows correctly. Same opt-out semantics as before (set `CODEATLAS_TELEMETRY=0` or `DO_NOT_TRACK=1` to disable); same anonymous device-id keying; same scrubbed content (no source code, file paths, or user identifiers ever leave your machine).
- **The browser surface now tells you which version is serving it.** When `npx @codeatlas/mcp` serves the diagram browser instead of VS Code, the page footer + home-screen header now display the MCP package version (e.g. `CodeAtlas MCP v2.2.1.1`) instead of the extension version. Useful when you have both surfaces installed and want to confirm which one's actually rendering.

### Notes for existing users

- No database migration. Your existing `.codeatlas/state.db` keeps working.
- No setting changes. No command changes. No MCP tool changes — every existing automation continues to work.
- Same 30+ supported frameworks across JS/TS, Python, Java, Kotlin, Go, Rust, Ruby, PHP, Swift, C#, Dart.

## [6.2.0] - 2026-05-28

A reliability release. The diagrams now stay accurate during long editing sessions on large codebases, and reverting an edit cleanly clears change markers across more language ecosystems. No new commands, no new settings — drop in and go.

Ships with `@codeatlas/mcp@2.2.0`.

### What's better

- **Edits to large files reliably show up in the diagrams after long editing sessions.** A subtle resource leak in the underlying parser was causing rebuilds to silently stop reflecting your changes once you had touched ~30+ files in a single session. Multi-hour sessions on large workspaces (the kind where you'd notice diagrams "freezing" mid-day) now hold steady.
- **Cleaner change-marker cleanup after reverting an edit.** When you edit and then revert (Cmd-Z, branch swap, etc.), the orange "modified" badges on a few framework shapes no longer linger. Specifically: Go test functions, Rust attribute-decorated functions, Go Echo route clusters, and Django+Celery infrastructure nodes all return to a clean state immediately after the file content matches baseline again.
- **More accurate System Design diagrams for projects that call third-party services.** A workspace service whose name happened to share a substring with a third-party hostname (e.g. a workspace `api` service and `api.stripe.com`) no longer suppresses the external connection. Stripe, Auth0, Sentry, and similar SDK endpoints surface reliably at L1.
- **Flutter and other mobile apps in a monorepo are isolated as their own services.** A repo with `apps/mobile/pubspec.yaml` alongside a backend service now shows the mobile app as a distinct service node in the System Design diagram.
- **Frontend and mobile services render as a flat screen list at L2a.** Open a Next.js, Nuxt, Remix, SvelteKit, Expo Router, React SPA, React Native, SwiftUI, UIKit, Jetpack Compose, classic Android, or Flutter service and you see a clean route-grouped list of every screen the app exposes — not a Louvain cluster diagram meant for backend services. Click any screen to drop straight into its content panel.
- **Classic Android XML layouts contribute to the visual inventory.** Activities and Fragments that drive their UI from `res/layout/*.xml` now surface Buttons, EditTexts, TextViews, ImageViews, RecyclerViews, ConstraintLayouts, and ProgressBars in the L2b Visual section — matching the Compose / SwiftUI / Flutter readouts, including Material Components widgets like MaterialButton and TextInputEditText.

### Notes for existing users

- No database migration. Your existing `.codeatlas/state.db` keeps working.
- No setting changes. No command changes. No MCP tool changes — every existing automation continues to work.
- Same 30+ supported frameworks (Express, NestJS, Fastify, Hono, Next.js, Nuxt, Remix, SvelteKit, tRPC, Socket.IO, Bull/BullMQ, kafkajs, amqplib, Django, FastAPI, Flask, Starlette, DRF, Celery, Click, Typer, Alembic, SQLAlchemy, Spring Boot, Micronaut, JAX-RS, Ktor, Gin, Echo, Chi, Fiber, Actix, Axum, Rocket, Laravel, Symfony, Rails, Sinatra, Sidekiq, ASP.NET Core, Vapor, GraphQL, gRPC, Jetpack Compose, SwiftUI, UIKit, React Native, Flutter, and more).

## [6.1.2] - 2026-05-27

A bug-fix release focused on frontend and mobile codebase support. Same diagrams, same Code Review, same 39 MCP tools — but Next.js, React Native, SwiftUI, Jetpack Compose, Flutter, and classic Android repos now render with clearer screen lists, cleaner system design diagrams, and richer per-screen visual inventories.

Ships with `@codeatlas/mcp@2.1.2`.

### What's fixed

- **Flutter and mobile apps in a monorepo show as their own services.** If your repo has `apps/mobile/pubspec.yaml` alongside `apps/api/package.json`, the mobile app now appears as its own service in the system design diagram instead of being folded into a generic `main` workspace.
- **Cleaner system design diagram for projects that call external services.** Previously a workspace service named `api` or `web` could accidentally hide legitimate external connections like `api.stripe.com` or `web.archive.org`. External services are now matched by exact hostname, so the third-party connections you depend on show up reliably at L1.
- **Frontend and mobile services render as a real screen list at L2a.** Open a Next.js, Nuxt, Remix, SvelteKit, Expo Router, React SPA, React Native, SwiftUI, UIKit, Jetpack Compose, classic Android, or Flutter service and you now see a clean route-grouped list of every screen the app exposes — Login, Home, /admin/users, etc. — instead of a Louvain cluster blob meant for backend services. Click any screen to drop straight into its content panel.
- **Classic Android XML layouts now contribute to the visual inventory.** Activities and Fragments that drive their UI from `res/layout/*.xml` files now surface Buttons, EditTexts, TextViews, ImageViews, RecyclerViews, ConstraintLayouts, and ProgressBars in the L2b Visual section — same shape as the Compose / SwiftUI / Flutter readouts, including widgets from Material Components like `MaterialButton` and `TextInputEditText`.

### Notes for existing users

- No database migration. Your existing `.codeatlas/state.db` keeps working — the new screen-list layout is computed live from the snapshot you already have.
- No setting changes. No command changes. No MCP tool changes — every existing automation continues to work.
- Same 30+ supported frameworks (Express, NestJS, Fastify, Hono, Next.js, Nuxt, Remix, SvelteKit, tRPC, Socket.IO, Bull/BullMQ, kafkajs, amqplib, Django, FastAPI, Flask, Starlette, DRF, Celery, Click, Typer, Alembic, SQLAlchemy, Spring Boot, Micronaut, JAX-RS, Ktor, Gin, Echo, Chi, Fiber, Actix, Axum, Rocket, Laravel, Symfony, Rails, Sinatra, Sidekiq, ASP.NET Core, Vapor, GraphQL, gRPC, Jetpack Compose, SwiftUI, UIKit, React Native, Flutter, and more).

## [6.1.1] - 2026-05-27

A stability release. No new commands, no new behaviour — drop in and go. Same diagrams, same Code Review, same 39 MCP tools.

Ships with `@codeatlas/mcp@2.1.1`.

### What's better

- **Steadier framework detection across mixed-stack projects.** The way the extension recognises routes, jobs, queues, migrations, and lifecycle hooks has been tidied so projects that mix several frameworks in one repo (e.g. a Next.js front end alongside a Spring backend, or a NestJS service that uses Bull + Kafka + GraphQL) are handled more predictably. Verified to produce byte-identical results against the project's 29-repo framework test set, so existing diagrams won't shift.
- **More resilient handling of generated files and test fixtures.** Edge cases like GraphQL schema strings in test files, JS template-literal snippets in docs, and gRPC stub comments are recognised more reliably without bleeding into your real route counts.

### Notes for existing users

- No database migration. Your existing `.codeatlas/state.db` keeps working.
- No setting changes. No command changes. No MCP tool changes — every existing automation continues to work.
- Same 30+ supported frameworks (Express, NestJS, Fastify, Hono, Next.js, Nuxt, Remix, SvelteKit, tRPC, Socket.IO, Bull/BullMQ, kafkajs, amqplib, Django, FastAPI, Flask, Starlette, DRF, Celery, Click, Typer, Alembic, SQLAlchemy, Spring Boot, Micronaut, JAX-RS, Ktor, Gin, Echo, Chi, Fiber, Actix, Axum, Rocket, Laravel, Symfony, Rails, Sinatra, Sidekiq, ASP.NET Core, Vapor, GraphQL, gRPC, and more).

## [6.1.0] - 2026-05-24

A big upgrade to Code Review and the home page. The new review engine only re-reviews what actually changed since the last run, so an incremental review on a repo with hundreds of routes typically takes a fraction of the time and cost of a full pass.

Ships with `@codeatlas/mcp@2.1.0`.

### Code Review — incremental by default

- **Re-reviewing now only touches what changed.** Click "Start review" after editing a handler and only that handler is sent to the LLM. Every other route reuses its existing finding. Progress strip shows the savings live: `Reviewing 1 / 27 (26 reused from last run)`.
- **"↻ Full re-review"** button next to Start gives you the old all-routes pass on demand — for prompt-template tweaks, model swaps, or when you suspect a prior run was off.
- **Confirm cost before paying for it.** Clicking Start opens a small confirm modal with the estimated cost, the model, the entry-point count, and a warning if the estimate would exceed your budget cap (`codeatlas.aiReview.maxBudgetUSD`). Free runs (Ollama / local) auto-skip the modal.
- **Mid-review budget guard.** If a paid review crosses your cap mid-run, it stops cleanly and keeps every finding already saved. No surprise bills.

### Better findings readout

- **Blast radius section in the summary.** The Findings popover now shows "issue type → where it lands": for every theme detected (auth gaps, N+1 queries, validation gaps, etc.) you see which feature clusters and routes carry that pattern, plus sample routes. Answers "where do I focus first?" at a glance.
- **Actual feature names instead of "workspace-wide".** When findings span a single cluster the summary names it (`the article cluster`, `the auth cluster`) rather than hiding it behind a generic label.
- **History on every finding.** Click 📜 History on any finding that's been resolved or ignored — see who took the action, when, and any comment they added.

### Less time staring at "is this stuck?"

- **Tab reloads no longer break the review UI.** Reload the page during a long review and the Start / Changed / Full re-review / Specific buttons stay disabled — only Cancel renders — until the in-flight run actually finishes. The page now asks the server for current review status on load.
- **Review Guidelines locks during a review.** The Edit button on the guidelines card and the evidence-gate toggle are both disabled while a review is running. Prevents the orchestrator from reviewing against a guidelines hash that changed mid-flight.

### Clearer error messages

- **Distinct messages for each failure type.** Network drop, bad API key, rate-limit, model-not-found, server error, malformed response, and "every finding rejected by the evidence gate" each render their own banner with a remediation hint. A "View raw response" link shows the captured LLM body for debugging.

### Home page — Tools reordered

- **Re-initialize** and **Re-sync** now lead the Tools section — the "fix it" controls users reach for when state looks wrong should be the first thing they see. Health Report, Impact Analysis, Export Docs, etc. follow.

### Documentation + export

- **Code Review user guide.** New `docs/code-review-guide.md` walks through writing good guidelines, what the evidence gate does, the severity rubric, and how to drive a review from an external MCP agent (Claude Code, Cursor, etc.). Linked from the README.
- **Download findings as Markdown.** New 📥 button next to Copy on the Findings popover saves `codeatlas-findings-{timestamp}.md` — paste straight into a PR description or a ticket.

### Notes for existing users

- No DB migration on your part. Your existing `.codeatlas/state.db` from 6.0.3 keeps working; the new review cursor table is created automatically on first launch.
- Two new settings:
  - `codeatlas.aiReview.maxBudgetUSD` (default `1.0`; set to `0` to disable the cost cap entirely).
  - `codeatlas.aiReview.smallModelFallback` (default empty; set to a stronger model id to auto-retry single entries when a small local model produces zero findings).
- All 39 MCP tools unchanged — agents using the existing tool set keep working with no migration.

## [6.0.3] - 2026-05-23

A polish release covering long-standing UX gaps. No new commands, no migrations — drop in and go.

Ships with `@codeatlas/mcp@2.0.3`.

### Export your diagrams

The "Export" button in the toolbar is now a menu with three options:

- **PNG** — 2× retina-quality raster, ready to paste into Slack, a PR, or a deck.
- **SVG** — vector file you can drop into Figma, Confluence, or print at any size without blur.
- **Markdown + Mermaid** — generates `architecture.md` with every diagram as Mermaid code (same as the existing command, now one click away).

### Easier navigation

- **Back button always works.** Open a diagram via Cmd+Click (new browser tab) or paste a deep link and the back arrow now takes you Home instead of being hidden. No more dead ends on shared URLs.
- **Service name in the breadcrumb** for monorepos. If you have ≥2 services, the breadcrumb shows which one you're inside (e.g. `backend › Auth › POST /login`). Click the service name to jump to L1 System Design.
- **Click a 💬 comment badge** on any diagram node — opens the Comments panel so you can read and act on the thread without leaving the diagram.

### Smaller wins

- **Library-style repos** (no HTTP routes, no mobile screens) now show a helpful empty state at the API List level — points you to File and Function Flow diagrams instead of just saying "no APIs".
- **Help text in the API List** when no APIs are detected explains that you can still use the lower diagram layers — no more dead-end screens.

### Under the hood

- JSDoc with `@param` / `@returns` added to the top exported functions in the framework detector, sequence builder, community detector, tree-sitter extractor, and impact analyzer. IDE hover help is now informative.
- CSP comments in the webview clarify that `style-src 'unsafe-inline'` is a deliberate accepted risk for React Flow runtime styles — `script-src` is nonce-only with `strict-dynamic` and remains the dangerous one to lock down.
- 60+ legacy issues swept from `ISSUES.md` and tagged with concrete code-citation receipts. The open backlog is now exactly the items deferred for the next mobile / monorepo platform-coverage push.

### Notes for existing users

- No DB migration. Your `.codeatlas/state.db` from 6.0.2 keeps working.
- No new settings. The export menu replaces the old "copy SVG to clipboard" button — same access point, more useful.

## [6.0.2] - 2026-05-22

A big polish pass on Code Review (the feature you launch from the home page). Everything new sits on the same surface — no new commands to learn.

Ships with `@codeatlas/mcp@2.0.2`.

### New on the home page

- **Side-by-side layout.** Diagrams, Git & Diff, and Tools sit on the left; Code Review, your review guidelines, and AI configuration sit on the right. Everything visible at a glance — no more scrolling past the dashboard to find AI controls.
- **Stats row shows what you've actually got.** Four counts of what's in your code (Files / APIs / Services / Features) plus three counts of what CodeAtlas has built about it (File diagrams / Function diagrams / Sequence diagrams).
- **"Get support" button** in the header opens a pre-filled email to the maintainer with your version + workspace counts already in the body. One click instead of writing the boilerplate yourself.

### Code Review (was "AI Review") — much smarter readout

- **Top-down summary at the top of the Findings popover.** Reads like a real review: an "Interpretation" line that names the dominant pattern across your findings (auth gaps, validation risks, secret leakage, silent error swallowing, N+1 queries…), then per-layer sections that name the actual clusters, routes, files, and functions affected, finishing with a "Top concerns (focus here first)" shortlist. Capped at ~500 words.
- **Per-finding actions in the popover.** Resolve, Ignore, add a Comment (linked to the finding), or Copy the finding as Markdown — no more clicking into each layer to act on a finding.
- **Group copy** — copy all findings, or just errors / warnings / info — as Markdown ready to paste into a PR, Slack, or a ticket.
- **Resizable popover.** Drag the corner to expand; size persists in the same session.

### Findings now show up inside every diagram

Open System Design, Feature Areas, API List, Sequence, File, or Function Flow — entities that have findings get a colored marker with the count. Click the marker to open the same finding popover (with Resolve / Ignore / Comment / Copy) right where the problem lives. Status changes propagate to every open view immediately.

### Subtler improvements

- Section dividers on the home page have proper breathing room — the page reads as discrete sections instead of one wall of cards.
- The version chip in the header switched to a small monospace pill (reads as metadata, not branding).
- Resolved/Ignored findings disappear from the popover immediately; counts on every diagram update in real time.
- Saved popover size + the AI Review section reflect the actual workspace counts in the stats row.

### For your AI assistant

A new internal module (`prSummaryPrompt`) defines a strict 5-block schema for PR-style review summaries — Header → Summary → Interpretation → Findings → Instructions. Findings carry a "mechanism" field (the *how* — what makes a review a review and not a linter dump). Instructions reference findings by id with an observable acceptance condition. A built-in validator enforces five mapping rules so the agent can't ship "merge fine" while leaving a critical finding unaddressed. Future MCP tools will plug into this schema. Today it's ready to wire when you build agentic PR review on top of CodeAtlas.

### Notes for existing users

- No DB migration. Your `.codeatlas/state.db` from 6.0.1 keeps working.
- No new settings to configure. The "AI Review" → "Code Review" label is cosmetic only — the underlying review engine is unchanged.

## [6.0.1] - 2026-05-21

A polish pass on the AI Review you got in 6.0.0. Faster to use, harder to mess up, and clearer about what it just did.

Ships with `@codeatlas/mcp@2.0.1`.

### New on the home page

- **Start, cancel, and stop a review without leaving the home screen.** Big buttons for **Start review** (all entry points), **Changed only** (just what's different from baseline), **Specific review** (pop a textarea, tell the AI exactly what to focus on — "audit input validation in POST routes"), and **Cancel** while a review is running. Cancel actually stops the in-flight LLM call instead of waiting for it to finish.
- **Live progress strip.** While a review runs, you see which entry point is being reviewed and the running count: `Reviewing GET:/api/users · 4 / 27`.
- **Findings popover.** Counts at the top of the AI Review card with severity dots. Click to drop down a list of every open finding, filtered by severity tabs and a free-text search. Click any row to jump straight to the diagram that owns it, with the review panel already open and scoped.
- **Clear button.** When you want a fresh slate, the button on the card wipes all findings (with a confirm prompt). The next review runs from scratch.

### Won't re-review what didn't change

If you run **Start review** with the same review guidelines and the same code state as last time, CodeAtlas notices and shows **"Nothing changed since last review — N findings already loaded"** instead of burning an LLM round-trip. Edit a file, change your guidelines, or hit Clear — any of those make the next review run for real.

### Every finding is tagged to a commit

Each finding now carries the git commit SHA (or, if your workspace isn't a git repo, an 8-character hash of the file contents at review time). The popover shows it as a small `git:abc1234` chip next to each finding so you can tell which review run produced it.

### Findings stay loaded across browser tabs

Open a second browser tab on the same project — it now shows the same finding count and popover as your first tab, immediately. Previously a fresh tab showed `Findings 0` until you clicked into a layer.

### Fixed

- **Diagrams open cleanly in the browser webview** ("System Design" no longer dies with "Something went wrong / require is not defined"). Affected every layer view (System Design, Feature Areas, API List, Sequence, File, Flow) when opened from the home page.
- **Saving your LLM provider (Ollama / OpenAI / Anthropic / OpenRouter / custom) now updates the home-page badge immediately.** It used to keep showing "OpenRouter" until you reloaded the page even after you switched to a local model.
- **AI Review controls work the same way in the VS Code extension's browser webview** as in the standalone — Start / Cancel / Specific / Clear and the findings popover are now wired on both sides.
- **The DEBUG evidence-gate toggle no longer fails silently in the VS Code extension.** Adding `codeatlas.evidenceGateEnabled` to the configuration contributes makes the toggle actually persist.
- **The background re-sync that runs on extension startup no longer wipes your AI Review findings and guidelines.** Your team rules and prior findings survive every VS Code reload.

### Notes for existing users

- Your existing `.codeatlas/state.db` migrates from v3 to v4 automatically on first open — adds one small table for the "nothing changed" check. No action needed.
- The new home-page Findings counts are live: open + close the AI Review section, run a review, hit Clear — every tab sees it in real time.

## [6.0.0] - 2026-05-20

CodeAtlas now reviews your code. The same six-layer view you already use (System Design → Features → APIs → Sequences → Files → Function Flow) becomes the structure for an AI review: every route, job, or background task gets its own review, and the findings show up exactly where they belong on each diagram.

Ships with `@codeatlas/mcp@2.0.0`, which gives the same review to any AI coding tool you use (Claude Code, Cursor, Copilot, Codex CLI, and others).

### New: AI code review

- **Reviews every entry point.** Every HTTP route, scheduled job, message-queue handler, CLI command and more gets reviewed individually. Findings are tagged to the right layer — auth issues show up on the API list, N+1 queries on the sequence diagram, dead code on the file view.
- **Catches cross-cutting issues too.** A second pass looks at shared files no single route owns — auth setup, error handlers, the main entry file, config — and flags hardcoded secrets, leaky error messages, or missing security headers.
- **No more made-up findings.** Each issue must quote the actual source code that caused it. Anything the model invented gets filtered out before you see it. There's a DEBUG toggle on the home page if you want to compare what gets filtered vs. what the model originally said.
- **Smarter severity.** When the AI flags something obviously bad — like a hardcoded `JWT_SECRET || "superSecret"`, an `eval()` call, or an N+1 query pattern — the finding gets bumped to error severity automatically, regardless of how the model rated it.
- **Stops false alarms.** "Auth required on writes" no longer appears on GET routes. "Webhook signature missing" no longer appears on routes that aren't webhooks. The system checks if a guideline actually applies before flagging it.
- **Your own review guidelines.** A new section on the home page lets you write your team's review rules — "flag missing auth on POST routes", "prefer Result types over thrown exceptions", whatever you want. The AI reads them on every review.
- **Search findings in plain English.** Type "what's wrong with auth?" or "anything fishy in the article create flow?" and it returns the matching findings, ranked by relevance.
- **See findings on every layer.** Each diagram header shows a count of open findings, color-coded by severity. Click it to open the review panel scoped to that view. Click any colored dot on a node, message, or function to read the full finding with Resolve / Ignore / Open-in-panel options.
- **Comments and AI findings share one panel** with tabs for All / User / AI so you can keep them separate.
- **Works with any AI provider.** OpenRouter, OpenAI, Anthropic, or run it locally with Ollama. Local models don't need an API key.

### MCP server gets the same review surface

The MCP server bundled with the extension now has 39 tools (up from 25). The new ones let AI coding tools query, score, and act on review findings the same way you do in the panel. Full list in the [`@codeatlas/mcp@2.0.0` CHANGELOG](./mcp-package/CHANGELOG.md).

### Fixes

- **Python (FastAPI) and Go (gin) route handlers** now correctly show as modified on the sequence diagram when you edit them. Previously the file view marked them modified but the sequence didn't pick up the change.
- **Home page now shows real counts** for files, APIs, services, and features as soon as you open it, instead of em-dashes.
- **Diagram cards on the home page now work in the standalone**. Clicking System Design / Feature Areas / API List / Sequence / Flow Chart now opens the corresponding diagram.
- **File-edit updates now reach the browser tab automatically.** Edit a file, and any open browser tab refreshes the diagram it's currently showing.
- **The file watcher no longer reacts to its own state-database writes**, which used to trigger an endless update loop.
- **The connection badge in the browser** correctly says "Connected to CodeAtlas server" when running standalone (instead of saying VS Code).
- **Git-diff features (Compare Commits, Branch Diff, PR Diff)** now work reliably when the MCP server is launched from a non-terminal context.

### Notes for existing users

- Your existing `.codeatlas/state.db` upgrades automatically on first open. No action needed.
- Setting `codeatlas.evidenceGateEnabled` controls the source-quote filter; defaults to on. Use the home-page DEBUG toggle to flip it without editing settings.

## [5.1.0] - 2026-05-19

Diff stability sweep. After editing and then reverting a file, every diagram now goes back to a clean state. Verified across 29 backend frameworks (Go, Java, Kotlin, Python, Ruby, Rust, JS/TS, C#, PHP, Swift).

### Fixed

- **Cross-file routes in Go and Kotlin no longer split into two entries after an edit.** Editing a Gin/Echo/Chi/Fiber/Ktor handler used to leave the route showing twice in the API list (one with the group prefix, one without) until you re-initialized. Routes now stay correct through any edit cycle.
- **Rust imports written with brace syntax (`use axum::{body::Bytes, ...}`) no longer flash as "added" after every save.** Was caused by the import key parser mis-splitting on `::` when the imported name itself contained `::`.
- **The L1 System Design diagram no longer flags an external host like `localhost` as "added" forever.** New repos used to seed baseline with a stale "added" annotation on every external service they call.
- **L4 File diagram section subtitles ("3 unchanged", "~1 modified · 2 unchanged") now match between baseline and working snapshots.** Sections used to lose their subtitle text on the initial build, then differ from the post-revert rebuild.
- **L1 service ordering and L2b API-list entry-point ordering are now stable across rebuilds.** Background array order shifts no longer trigger a false "modified" mark on the diagram.
- **Go method names with the same identifier on different receiver types no longer collide in flow graphs.** A `User.Save` and `Article.Save` in the same package now get separate flow diagrams instead of overwriting each other.
- **L1 infrastructure edges (service → database/queue) no longer disappear after a cascade rebuild** in projects where a service file contains a connection string. The secret-redaction step was greedily eating multi-line content.

### Improved

- Repo-wide cascade cleanliness now holds across the full backend test matrix. Editing any function in any of the 29 framework repos, then reverting, returns the SQLite snapshot to byte-identical baseline.
- File graph diff subtitles always reflect the post-rebuild state instead of carrying stale "~1 modified" text after a revert.

## [5.0.3] - 2026-05-16

### Fixed

- **Direct links to a specific diagram now work.** Pasting a URL like `localhost:7742/#/features/service:main` or `#/apis/cluster:auth` lands on the right diagram instead of staying on the previous view. Browser back and forward also work between layers.

## [5.0.2] - 2026-05-16

Follow-up fixes to the monorepo and Rust support from 5.0.1.

### Fixed

- **Deeply nested Rust workspaces now show every sub-crate as its own service.** Repos like Rocket's `contrib/db_pools/lib/` (three levels deep) are picked up, and sub-crates that share a leaf name (`codegen`, `lib`) no longer overwrite each other. On rust-rocket this took cluster-to-service matching to 100%.
- **Rust `match` and Kotlin `when` blocks no longer show a phantom "modified" highlight after revert.** The diff was looking for a `switch` keyword in source — which never appears in Rust or Kotlin — so the same block flipped on every rebuild.

## [5.0.1] - 2026-05-16

Bug fixes for more accurate diagrams and a smoother browser experience.

### Fixed

- **Spring projects no longer show a fake "Room" database in the L1 System Design view.** The infra detector was mistaking JPA `@Entity` classes for Android's Room ORM.
- **Switching VS Code to a different workspace now refreshes the browser view automatically.** The browser at `localhost:7742` used to keep the previous project's diagrams until you hit `Cmd+Shift+R`.
- **L1 System Design lays out unconnected services as a clean grid instead of a tall vertical strip.** Affects Rust workspaces, Kotlin Ktor, and any monorepo with many independent services.

### Improved

- **Better service detection in nested monorepos.** Rust workspaces grouped under `https-tls/`, `cors/`, `websockets/`, `contrib/` etc. now register each sub-crate as its own service.
- **More reliable diff highlighting on the L5 flow graph** for class methods (Java/Kotlin), method receivers (Go), and attribute-decorated functions (Rust).

## [5.0.0] - 2026-05-15

The headline feature in this major release: **CodeAtlas now exposes its indexed workspace knowledge as a Model Context Protocol (MCP) server.** LLM coding agents — Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code Copilot Chat, Antigravity, Continue, or any other MCP-compatible client — can now query routes, sequences, dependencies, diffs, impact analysis, architecture violations, and run ad-hoc SQL over the snapshot, without reading the source files themselves. Typical query is **5×–60× smaller than the equivalent file-walking approach** (measured against the test project — full numbers below).

### Added — MCP server with 25 tools

A standalone Node binary at `dist/mcp-server.js` ships with the extension and speaks MCP over stdio. Point any MCP client at it to give the model live structural answers about your workspace.

**Context-pack tools** (LLM-ready briefings, designed to fit in 2-5KB JSON):
- `list_entrypoints` — every entry point (HTTP routes + JOB / MQ_CONSUMER / CLI_COMMAND / SCREEN / NAV_ROUTE / DB_MIGRATION / DB_SEED / SOCKET_EVENT / SUBSCRIPTION / HEALTH / MIDDLEWARE / etc.) with cluster, service, auth, middleware metadata
- `list_entrypoints_paged` — cursor-based pagination + token budget for huge repos
- `get_entrypoint_pack` — handler source + downstream calls + sequence messages + flow nodes + siblings + diff state in one call
- `get_feature_pack` — feature-cluster overview: entry points, subsystems consumed, member files, diff state
- `pre_edit_brief` — one-shot context before editing: source + impact + siblings + imports + diff
- `get_function_source` — single-function source slice (signature + body) with line range
- `trace_call_path` — shortest call path between two functions, with edge confidence + kind

**Diff & impact tools**:
- `get_diff_summary` — added / removed / modified entry points + clusters since baseline
- `get_api_surface_diff` — contract-level changes (routes added/removed + auth/middleware changes)
- `get_impact_of_change` — every entry point reachable from a changed file/function
- `get_impact_analysis` — call-graph blast radius for arbitrary file changes
- `get_function_dependencies` — bidirectional caller/callee traversal

**Search & query tools**:
- `search_workspace` — weighted reverse index across features / routes / functions / classes / files / services; camelCase + snake_case auto-split; accepts string or array queries with optional `requireAll` AND semantics
- `query_snapshot` — read-only SQL with strict guardrails (SELECT-only, table allowlist, multi-statement blocked, row cap, CTE-aware)
- `describe_snapshot_schema` — DB schema introspection so LLMs can author valid SELECTs

**Health & rules**:
- `get_health_report` — dead functions, god files, high-coupling files, cyclic dependencies, orphan clusters
- `list_architecture_violations` — 6 built-in rules (auth-on-writes, services-per-cluster, no-god-files, no-cycles, no-dead-functions, webhook-signature-verification) plus user rules via `.codeatlas/rules.json`
- `get_coverage_overlay` — per-file + aggregate test coverage when LCOV / Istanbul data is present

**Workspace introspection**:
- `get_workspace_status` — bootstrap state (`ready` / `initializing` / `not_a_codebase` / `read_only` / `error`)
- `find_similar_entities` — structurally similar routes/clusters (same method, path shape, middleware overlap)
- `list_saved_views` — user-defined named queries from `.codeatlas/saved-queries.json`
- `compare_workspaces` — open another workspace's state.db and diff API surfaces

**Interop**:
- `export_openapi_spec` — emit the tool surface as OpenAPI 3.1 paths for non-MCP HTTP consumers
- `export_function_calling_spec` — emit as OpenAI / Anthropic native function-calling format
- `summarise_payload` — deterministic extractive summariser (no LLM) that compresses a heavy pack into a 3-7 bullet brief

Plus five MCP resources: `codeatlas://workspace/microservices`, `…/apis`, `…/features`, `…/entrypoints`, `…/diff-summary`.

### Added — Self-init: no VS Code required

When an MCP client launches the binary against a workspace that has no `.codeatlas/state.db`, the server now bootstraps the snapshot itself: classifies the workspace as a codebase (counts files matching the 11 supported language extensions), runs the same `SyncOrchestrator.initialize()` pipeline VS Code uses, and starts a file watcher to keep state current as code changes. Doc-only or empty directories return `status: 'not_a_codebase'` from every tool with a clear diagnostic reason — no empty arrays, no confusion.

### Added — Workspace write coordination

A `.codeatlas/.mcp-owner` lock file coordinates writes between the VS Code extension and standalone MCP processes so `state.db` never sees concurrent writers. Atomic acquire with PID + label; stale-lock detection via `process.kill(pid, 0)`; release-on-exit hooks for `SIGINT` / `SIGTERM` / `exit`.

### Added — MCP-preferred preempt protocol

When an MCP process starts on a workspace that VS Code already owns, MCP writes `.codeatlas/.mcp-preempt`. The extension watches for this file and yields — releases its lock, disables auto-update for the rest of the session, and shows a recovery toast. MCP polls (up to 5s) for the release, then acquires write ownership. Agentic workflows take priority over the IDE without races. Symmetric: when the extension activates and an MCP process already owns the lock, the extension starts read-only — no fight.

### Token economics — measured against the test project

| Query | File-walk equivalent | MCP context pack | Reduction |
|---|---:|---:|---:|
| List every entry point | 14,088 tokens (read every src file) | 1,794 tokens | **7.9×** |
| One route's full context (`GET /api/articles/:slug`) | 5,647 tokens (4 involved files) | 703 tokens | **8.0×** |
| Diff summary (clean tree) | several KB (parse git diff) | 28 tokens | **>200×** |
| Impact-of-change (`getCurrentUser`) | 20-30 files of grepping | 254 tokens | **~50×** |
| Feature cluster overview (article) | 2,373 tokens (5 cluster files) | 1,198 tokens | **2.0×** |

Real codebases (~3MB source / 1k files): projected ~60× smaller for `list_entrypoints` than naive file walking. Single-route packs stay ~8× smaller regardless of repo size because they're scoped to the route's call chain.

### Fixed

- **Issue 351** — `home.spec.ts` AI Configuration form spec is no longer flaky on cold runs. Scoped locators to the form container, asserted `.toBeEditable()` before each interaction, used `.click()` to establish focus before `.fill()`, verified typed value with `.toHaveValue()`. 5/5 cold-run streak with 0 retries.

### Upgrading

After installing 5.0.0:
1. **Standard VS Code use** — no action required. The extension grabs the workspace write-lock on activate; behaviour is unchanged.
2. **To use CodeAtlas with an LLM agent** — see the README's *Use CodeAtlas with Claude Code / Cursor / VS Code Copilot / Codex / Gemini* section. The `dist/mcp-server.js` binary is bundled inside the installed extension at `~/.vscode/extensions/codeatlaslive.codeatlas-live-5.0.0/dist/mcp-server.js` (or the platform equivalent).
3. **If both VS Code and an MCP agent run on the same workspace** — the MCP agent gets write priority. VS Code goes read-only with a recovery toast; close+reopen the workspace once the MCP process exits to reclaim writes.

## [4.2.0] - 2026-05-13

A reliability + clarity release focused on the Express controller pattern that powers most JavaScript / TypeScript backends: inline arrow handlers, per-route middleware, mounted sub-routers, and for-loop route registration. Every layer (L1–L5) now produces accurate, openable output for these shapes, and three new visual markers in the API list surface authentication, error handling, and loop-registered route cardinality at a glance.

### Added

- **🔒 / 🔓 auth markers on every route in the API list.** Routes declared with `auth.required` / `auth.optional` middleware — or with a `@auth required|optional` JSDoc tag on the route comment — now show a lock icon next to the path. The tooltip lists the full middleware chain so you can see exactly which guards run. Hover any route to confirm "is this gated?" without opening the source. Applies to Express patterns of the form `router.METHOD(path, middleware1, middleware2, …, handler)`.
- **⚠ marker on Express error-handling middleware.** A 4-arg `app.use((err, req, res, next) => …)` is now classified as MIDDLEWARE with `meta.error=true` and renders with a warning glyph in the "Request Hooks" section of the API list. Previously these handlers were entirely invisible to the model.
- **×N marker on for-loop-registered routes.** When a route is registered inside a constant-bound `for (let i = 1; i <= N; i++) router.get(\`/path/${i}\`, …)` loop, the API list shows ONE parameterized row (`/path/:i`) with a `×N` indicator. The tooltip describes the loop bounds (`Loop-registered: 25 routes (index 1→25)`). Clicking the row opens the shared arrow body — no more wading through 25 identical rows.
- **Composite `Router().use(child).use(child)` chains.** When a parent router is built by chaining `.use(childRouter)` calls over imported sub-routers and then mounted under a prefix (`Router().use('/api', api)`), every sub-router's routes are now correctly prefixed with `/api`. Standard Express route-composition pattern; previously the chain was opaque to the model.

### Improved

- **Inline arrow route handlers are now first-class entities at L4 and L5.** `router.get('/users', async (req, res) => { … })` and similar inline-arrow handlers were previously invisible to the file-diagram (L4) and function-flow (L5) layers — the function existed only inside the routing call. They now appear as `anonymous@METHOD:/route` function nodes on the file diagram, with their own flow graph, and their body edits cascade correctly through every layer of the diff. The most common Express handler shape is finally a first-class citizen.
- **Sequence diagrams for `:param` routes show only that route.** Editing or viewing a sequence diagram for `GET /articles/:slug` used to show edges from every other route in the same controller (POST /users, /profiles, etc.) — the per-handler filter fell back to the file-wide universe when synthetic handler names didn't match. Each sequence diagram now scopes correctly to its single handler and call chain.
- **L3 over-marking is gone.** Editing one service function (e.g. `getCurrentUser`) used to flag every sequence in the calling controller as modified. The cascade now correctly identifies which sequences actually reach the changed function and leaves the rest unchanged. The L2b API list and L3 sequence diagram agree on which routes are affected.
- **`main.ts` edits no longer light up unrelated feature clusters.** Editing the root `app.get('/', …)` handler used to flag Random Number Generation, Exception Handling, and Express API clusters — three different clusters for one edit. With the detection set stabilised (loop unrolling collapsed, error middleware classified, anonymous handlers tracked), cluster membership is now stable across edits and only the cluster actually containing `main.ts` is flagged.
- **Stale `modified` annotations after a revert are gone.** Editing a file and then reverting it back to baseline now returns every layer to grey on the next rebuild. Previous releases could leave synthetic graphs (`:router` from for-loop registrations, sequence diagrams for handlers that no longer exist after detection improvements) stuck in modified state until a manual re-sync.
- **`seed.ts` and other db-seeding scripts cascade correctly.** Edits to the seed script's body now reflect on the L5 flow graph, and unrelated cross-file edits (e.g. controller changes) no longer falsely flag the seed's sequence diagram. The BFS-based call-chain detection is now strictly bounded by reachable function calls.

### Fixed

- **`router.METHOD(path, mw, handler)` middleware arguments captured correctly.** The detector previously took only the LAST argument as the handler and dropped every middleware sitting between path and handler. The full middleware chain is now captured on `meta.middlewares` for every Express route, and used to derive the `auth.required` / `auth.optional` flag surfaced by the new lock marker.
- **For-loop route registration no longer leaks as a phantom `router` handler.** `for (let i = 1; i <= 25; i++) router.get(\`/random/${i}\`, …)` previously emitted a single bogus `ApiRecord` with handler name `router` (the chain receiver) and route literal `/random/${index}` — neither openable. The new path emits ONE parameterized `/random/:index` record with the arrow body's source span as the anchor, so click-through opens the actual handler.
- **JSDoc `@auth` tags resolve correctly when middleware is absent.** Routes annotated with `@auth required` / `@auth optional` / `@auth none` in the route's leading JSDoc block now drive the auth marker even when no inline middleware is present. Babel attaches doc comments to the parent statement, so the resolver walks up the path to find them.

### Auth markers extended to non-Express frameworks

The 🔒 / 🔓 auth marker now surfaces on routes across five additional framework idioms beyond the original Express convention:

- **Hono mount-level middleware propagation.** `app.use('/auth/*', basicAuth(...))` followed by `app.get('/auth/page', handler)` correctly marks the route auth.required — the path-glob from the mount call is matched against every subsequent route in the file. Globs like `/auth/*` compile to a regex matcher that catches `/auth`, `/auth/page`, `/auth/users/42`, etc. Recognised Hono factories: `basicAuth`, `bearerAuth`, `jwt` / `jwtAuth`.
- **Fastify options-object middleware.** Routes declared as `fastify.get('/path', { preHandler: auth, schema: {...} }, handler)` now have `preHandler` (plus `onRequest`, `preValidation`, `preParsing`, `preSerialization`, `onResponse`, `onError`, `onSend`) extracted as middleware. Both single Identifier values and array forms (`onRequest: [auth, requireAdmin]`) are supported.
- **Spring Security annotations.** Java / Kotlin files using `@PreAuthorize`, `@PostAuthorize`, `@Secured`, `@RolesAllowed`, `@PreFilter`, or `@PostFilter` on a route method now flag it auth.required. Class-level annotations apply to every route method in the class body. `@PermitAll` is recognised as the explicit public marker (auth.optional). Method-level annotations apply only to the immediately following route so adjacent unannotated routes aren't accidentally flagged.
- **FastAPI `Depends(get_current_user)`-style dependencies.** Python routes annotated with `@router.get("/users", dependencies=[Depends(get_current_active_superuser)])` — or whose handler signature contains `current_user: User = Depends(get_current_user)` — are now flagged auth.required. Recognised dependency names: `get_current_user`, `get_current_active_user`, `get_current_active_superuser`, `current_user`, `verify_token`, `authenticate`, `is_authenticated`, `oauth2_scheme`, `JWTBearer`, `require_auth`, `require_login`. Non-auth dependencies like `Depends(get_db)` are not flagged.
- **Koa-style global auth middleware.** `app.use(authMiddleware)` at the top of a Koa file (no path arg) now propagates to every route in the file. Limited to a small allowlist of auth-named middleware (`auth`, `authRequired`, `authMiddleware`, `requireAuth`, `passport.authenticate`, `koaJwt`, etc.) so unrelated middleware like `cors()`, `bodyParser()`, `logger()` doesn't incorrectly flag routes.
- **Passport / express-jwt factory recognition.** `router.get('/path', passport.authenticate('jwt'), handler)` and `app.use(expressJwt({...}))` both flag downstream routes auth.required.

### Upgrading

No action needed — the new build's startup reconciliation rebuilds the API index from scratch, so stale rows from pre-4.2.0 detection (25 unrolled `/random/N` rows, missing-auth markers, phantom `router` handlers) clear automatically on the next launch. If your diagrams are stuck on stale state from an even earlier release, run **CodeAtlas: Re-sync Everything** once to refresh the baseline.

## [4.1.2] - 2026-05-13

Two user-visible improvements to the localhost browser experience: home page now appears as soon as the workspace finishes loading instead of stalling on a "Loading…" spinner, and Kafka / message-queue projects correctly highlight the single affected service on the System Design diagram after an edit.

### Improved

- **Home page in the browser opens in well under a second.** When you click *Open in Browser* (or hard-refresh `localhost:7742`), the home page now renders as soon as your workspace info reaches the browser — typically a few hundred milliseconds. Previously a hardcoded eight-second loading timeout gated the home behind a spinner even when the underlying data was already available, making the experience feel sluggish on every launch. The eight-second timeout is still in place as a safety net for slow or disconnected extensions, but is no longer the primary path.

### Fixed

- **Editing a Kafka / message-queue listener now highlights the right cluster and service.** When you edit a `@KafkaListener` / `@RabbitListener` / `@JmsListener` handler in a Spring Kafka or similar message-consumer project, the System Design diagram (L1) and Feature Areas diagram (L2a) now correctly flag exactly one service and one cluster as modified. Earlier releases over-counted the change because the Worker bundle node (added in 4.0.1 to visualise jobs and consumers) was being counted as a separate service. The diff now distinguishes application services from their Worker siblings and infrastructure nodes (databases, brokers, caches), so the "what changed" answer is precise.

### Upgrading

No action needed. The home-page fix takes effect on the next launch. If your Spring Kafka workspace was previously showing two services modified after a listener edit, run **CodeAtlas: Re-sync Everything** once after upgrading to refresh the baseline.

## [4.1.1] - 2026-05-13

Hotfix on top of 4.1.0 — eliminates a startup race that could leave clicks on API list routes silently inert until you re-synced the workspace.

### Fixed

- **Clicking a route in the API list reliably opens its sequence diagram, even on the first workspace load after VS Code starts.** A race between two startup paths could leave the in-memory API index out of sync with the routes shown in the API list. The L2b panel would render correctly (you'd see the route), but clicking it did nothing — and there was no error message. The fix coalesces the racing startup paths into a single execution and re-syncs the live-diff session with the freshly-built workspace state once initialization finishes. Clicks now work immediately after startup, with no re-sync needed.
- **Working-changes diff view stays in sync with the live workspace.** When you launch a project that already has uncommitted edits, the diff overlay (baseline → working) used to snapshot an empty API list and keep it frozen for the rest of the session. The overlay now refreshes once startup finishes so every diff-aware view (AI Review, Replay Working Changes, sequence/file panels) sees the correct routes.
- **No more transient "API not found" toasts on click.** Combined with a defensive fallback that reads from the cluster snapshot when the API index is briefly out of sync, you should never see this warning during normal use. If you do, please file an issue — it indicates a deeper state divergence worth investigating.

### Upgrading

No action needed. If your diagrams are showing stale routes from an earlier 4.1.0 install, run **CodeAtlas: Re-sync Everything** once to clear them.

## [4.1.0] - 2026-05-12

A reliability-focused release. The diff cascade across all six diagram layers — system design, feature areas, API list, sequence, file, and flow chart — is now consistent across JavaScript, TypeScript, Java, Python, Go, and Kotlin codebases. In-diagram navigation, comment anchoring, and timeline replay also got significantly steadier.

### Improved

- **Diff colours now flow correctly through every layer for every language.** Editing a function body in a Java, Python, or Go file now lights up the function on the flow chart (L5), marks the right cluster on Feature Areas (L2a), and flags the right service on System Design (L1) — matching the JavaScript / TypeScript behaviour that has always worked. Non-JS projects no longer stop the cascade halfway up.
- **File diagram section labels show what changed.** The L4 file view now appends a count to its Functions / Imports section headers — `Functions (1 changed + 4)` instead of just `Functions (5)` — so you can see how much of the file moved without expanding the section.
- **API list opens the right sequence diagram every time.** Clicking a route in the L2b API list now reliably opens its sequence diagram, even on workspaces with heavy working changes or after a background re-sync. A second lookup path uses the feature cluster snapshot when the in-memory API index is briefly out of sync, so clicks no longer silently fail with "API not found".
- **Workspace activation no longer races itself.** Opening a workspace previously had two startup paths racing — the first finished and populated the diagrams, the second cleared them. Some users had to hit `CodeAtlas: Re-sync Everything` to get back to a usable state. Activation now runs once, cleanly, with no manual recovery needed.
- **Comments stay attached to the right thing after edits.** Comments anchored to a function used to occasionally migrate to the file root, a section header, or an unrelated node when the file was edited or resynced. The re-anchor strategy is stricter now — it requires a real position match before falling back to symbol-based matching — so comments stay where you put them.
- **Comments behave correctly across multiple diagram layers.** Previously, when two different diagrams happened to use the same internal node ID, a comment anchored to one could silently move to the other on resync. Each diagram is now scoped independently.

### Added

- **Timeline replay now handles uncommitted changes.** `Replay Working Changes` walks through your live edits the same way `Replay Commits` walks through git history — step by step, layer by layer. Useful for reviewing your own diff before committing.
- **Replay button on every diff badge.** The diff overlay at the top of every diagram page now has a Replay button — click it to walk through the changes inside the current diff session (Compare Commits, Branch Diff, PR Diff, or Replay Working Changes).
- **Wider framework coverage.** Additional route shapes recognised in Go Chi / Fiber, Kotlin Ktor, Java Spring (including @KafkaListener), Python FastAPI, and several Express patterns that were previously skipped. Real-world projects show meaningfully more routes after this update.

### Fixed

- **Express projects with sub-routers now diff correctly.** When a route lives in a controller file mounted by a parent router (the common Express pattern), editing the handler used to either miss the diff or over-mark adjacent routes. The cascade now correctly attributes the change to the single edited route.
- **Sequence diagram diff annotations match the real edit.** When you edit one handler, only that handler's sequence arrow turns modified — the surrounding participants and their unchanged messages stay grey. Sibling sequences in the same controller file no longer get caught in the over-marking.
- **System Design correctly returns to grey after a revert.** Undoing your changes returns the L1 service tile to clean state alongside every other layer. Previously the orange "modified" highlight could linger on L1 even after the file was back to baseline content.
- **Real-projects test coverage prevents regressions across 34 framework samples.** A continuous-verification pass runs the entire pipeline against a curated set of real-world repos (Express, Django, FastAPI, Spring Boot, Spring Kafka, Go Gin, and more) and checks that file counts, route counts, cluster counts, and diff annotations match expectations on every release.
- **Browser view no longer shows duplicate notifications** for the same warning.

### Upgrading

If your diagrams are showing stale diff state from a previous release — for example, services or files still flagged as "modified" even after reverting your changes — run **CodeAtlas: Re-sync Everything** once after upgrading. Future edits will cascade cleanly.

## [4.0.1] - 2026-05-10

A major upgrade to what CodeAtlas surfaces in your diagrams. Until now the focus was HTTP routes; this release treats every other kind of architectural entry point as a first-class citizen.

### Added
- **Extension version + build number displayed in the UI.** The browser home page shows `CodeAtlas v<version>.<build>` as a badge next to the title, and every page (home + all diagram views) carries the same string in a bottom-right footer. The 4th identifier (`.<build>`) auto-increments with every `npm run package` so iterative test builds are distinguishable at a glance. The VSIX filename produced by the package step also incorporates the build number: `codeatlas-live-<version>.<build>.vsix`. The build number lives in `package.json` next to `version` so it's also visible without rebuilding the UI.
- **More than just HTTP routes.** Background jobs, message-queue consumers, CLI commands, database migrations and seeds, controller filters, ORM lifecycle hooks, GraphQL subscriptions, WebSocket / Socket.IO events, health endpoints, mobile push notifications, background tasks, app lifecycle hooks, deep links, and home-screen widgets all show up alongside your routes — each one with its own sequence, file, and function-flow diagrams.
- **API list grouped into clean sections.** The list now organises entries into "Real-Time", "Background Jobs", "CLI Commands", "Data Lifecycle", "Request Hooks", "Observability", and "Mobile Lifecycle". Sections appear only when there's something in them, so HTTP-only projects look the same as before.
- **System Design diagram now shows Workers.** Services that run background jobs or queue consumers get a Worker node with a count summary, plus an arrow to the broker (Kafka, RabbitMQ, Redis, JMS) so the asynchronous side of your architecture is visible at a glance.
- **Webhook routes get a ⚡ marker.** Routes that verify Stripe, GitHub, Slack, Twilio, or generic signature handlers are flagged in the API list — scan a long list and instantly tell webhook receivers apart from regular endpoints.

### Fixed
- **Diff colours now reach every new entry type.** Add a job, remove a worker, change a topic, rename a migration — the diff colour flows up through every layer of the diagram the same way an HTTP route change has always done.
- **Diff no longer gets stuck after a `git commit`.** Previously, committing changes inside the workspace didn't refresh the baseline — so even on a clean git tree, the diagrams could keep showing files / services as "modified" forever. CodeAtlas now also watches the git reflog, so any commit, pull, merge, reset, or checkout automatically refreshes the baseline. If your diagrams are currently stuck on stale diff state from before this update, run **CodeAtlas: Re-sync Everything** once to clear them.
- **Diff highlighting works for files containing API keys, connection strings, or other secrets.** Previously, any function inside a file that contained a secret-shaped token (Postgres URIs, Stripe keys, AWS credentials, JWTs, etc.) would silently lose its diff annotations on save — the function flow chart, sequence diagram, and cluster colour all stayed "unchanged" no matter what you edited. The fix makes diff computation independent of how content gets stored, so edits to handlers next to any secret are now correctly highlighted across all diagram layers.
- **Reset (exit compare-commits) now correctly returns L1 + every layer to live state.** Previously, clicking the Reset button to leave diff mode left the L1 system-design view stuck showing the stale modified state — the header would correctly say "No changes" but the service tile still rendered with the orange MODIFIED badge. The browser caches the in-flight diff graph; Reset now triggers a fresh cascade on the live working snapshot BEFORE broadcasting the updated graphs to the panel, so the L1 (and every other open view) refreshes to live state without a manual reload.
- **File diagram (L4) now visibly marks functions as modified.** Even after the symbols cascade was fixed (#381), the section header + function tiles on the L4 file view stayed grey because the JS/TS code path didn't carry the section's `meta.items` array that the recompute logic relied on. The recompute now walks the section's `contains` edges to find its children, refreshes per-child diff status, and updates the section's `(N changed + M)` count label so the L4 view matches reality.
- **API list now shows only the actually-affected routes after a service-layer edit.** When you edit a function in a service file (e.g. `auth.service.ts`) that isn't a direct member of its route's cluster, the L2b API list could mark multiple routes as modified — the api-list was rebuilt against an over-marked sequence diff before the cascade reset it. Api lists are now rebuilt AFTER the sequence cascade settles, so only the route(s) whose sequence graph actually shows real changes are flagged.
- **Diff state correctly resets when you undo your changes.** Previously, after editing a function and then reverting your edit, the system-design (L1) service tile could stay orange "modified" even though every downstream diagram (Feature Areas, API list, File diagram, Function flow) correctly returned to grey. Root cause: the cascade was mutating an in-memory copy of the graph, but the memory-bounded graph cache evicted that copy before the change persisted to disk, so the next read came back from disk with the old "modified" state. The cascade now writes the mutated graph back through the proxy explicitly, so undoing your changes correctly returns every layer to grey.
- **Feature Areas (L2a) workspace view now reflects diff state correctly.** The L2a top-level Feature Areas view stayed grey even when the same edit correctly lit up L1, L2b, L3, L4, L5. The cluster nodes WERE getting the modified annotation during the rebuild cascade, but a few seconds later the LLM cluster-naming service would resolve and rebuild the feature graph with un-annotated clusters — silently overwriting the cascade output. The LLM rebuild now re-applies the cascade so cluster annotations survive the rename.
- **File diagram diff is now redaction-aware.** Following up #377: even after the redactor was fixed to produce valid JS, functions containing `password:` (or any of the redacted key patterns) still got marked as modified on the L4 file diagram — because the file-diff layer was comparing redacted-baseline bodies against un-redacted working bodies. Now the file diagram uses the authoritative un-redacted body text captured at scan time, so unchanged functions correctly stay grey and the L3/L2b cascade downstream sees only the genuinely-edited functions.
- **Secret redactor no longer breaks the diff cascade.** The old redactor sometimes rewrote `password: hashedPassword` inside JS/TS object literals as `password= [REDACTED]` — invalid JS that Babel couldn't parse. When the baseline content stored on disk contained that broken form, every consumer that read it (the entity diff for the L4 file view, the sequence diff for L3 routes that pass through the affected file) silently produced wrong output. Symptoms: L4 file view staying grey even when you'd edited a function inside it; L3 sequence diagrams for unrelated routes lighting up as if they'd changed; L2b reporting more modified APIs than the actual edit; L1 surfacing the wrong function name as "changed". The redactor now keeps the original `:` or `=` separator and wraps the redacted value in quotes — output is always valid syntax. After upgrading to this version, run `CodeAtlas: Re-initialize Visuals` once to capture a fresh, clean baseline; subsequent edits will cascade correctly across all six diagram layers.
- **Sequence diagram arrows no longer over-mark when only one function changed.** When you edited a function body inside a participant module, every arrow attached to that participant — including arrows OUT of it to unrelated modules — used to render dotted-orange. Now only the arrow INTO the changed participant gets the modified style; outgoing arrows stay solid grey unless they themselves changed. The call into the changed module is the real signal; outgoing calls are routing detail, not changes.
- **File diagram now shows function-body edits.** The L4 file view used to keep every function tile grey even when you'd edited the body of one — the function flow chart correctly turned orange, but the parent file view stayed flat. Editing a function's body now correctly colours the function tile on the file diagram, matching what the flow chart shows.
- **Sequence diagrams no longer over-mark return arrows from edited handlers.** When you edit a function body, the call-into arrow correctly turns orange — but the return arrow back to the caller used to also go orange even when the returned value expression was unchanged. Return arrows are visual cues paired with their forward call; they're now left alone unless the call-into arrow is itself flagged.
- **Feature Areas diagram no longer flags unrelated clusters as modified.** Editing a single function inside one file used to light up two or three feature clusters as "modified" on the L2a Feature Areas view, even though only one of them had any real change. This was caused by clustering jitter: re-running community detection between snapshots sometimes reassigns an otherwise-unchanged file to a different cluster, and the old diff logic treated every membership shift as a real edit. Cluster diff is now driven purely by file content changes (and real additions / deletions in the codebase). Files moving between clusters with identical content are correctly ignored — so the cluster colour reflects actual code edits, not Louvain noise.

## [3.3.3] - 2026-05-10

### Fixed
- **Databases, caches, and queues stay visible on the System Design diagram** — projects that detect their database from code (Prisma, Mongoose, TypeORM, Sequelize, Drizzle, Redis client, Spring Data JPA, Django ORM, ActiveRecord, and more) without a `docker-compose.yml` saw the database / cache / queue nodes disappear from the L1 view after the first file save in a session. The infrastructure layer now persists correctly across navigation, file saves, cascade rebuilds, and Compare Commits sessions
- **Source content for the System Design pipeline survives every save** — the lazy-storage path silently dropped persisted file contents on the second save of a session, which made several detectors (services, technology, consumed URLs, infrastructure-relevance change detection) silently fall back to empty input. They now read from the on-disk store reliably no matter how many saves have happened

### Changed
- **Sign-in is gone from the UI entirely** — the Account section in the editor sidebar, the `CodeAtlas: Sign In` / `CodeAtlas: Sign Out` command-palette entries, and the welcome panel's Sign-In step are all removed. CodeAtlas auth no longer appears anywhere in the UI — every feature works without signing in

### Added
- **More entry points reminding you the browser view is ready** — the "Open in Browser" notification now surfaces at the moments where it's most useful: when a workspace finishes loading, after `Initialize Visuals`, when you switch to a different folder, when you return to the editor after being away for a couple of hours, on your first save in a session, when you open the welcome panel, and after a Compare Commits diff finishes. A periodic 6-hour reminder pings you while a workspace is open. All triggers share a single 24-hour cooldown — you'll never see more than one popup per day no matter how many sources fire — and any reminder is suppressed automatically when a browser tab is already viewing your diagrams
- **Status-bar marker when System Design changes** — a small dot appears on the CodeAtlas status-bar item when new services or infrastructure are detected since you last viewed the System Design diagram. Open the diagram (status bar, sidebar, or browser tab) to clear the marker

## [3.3.2] - 2026-05-09

### Changed
- **No more sign-in required to use CodeAtlas** — diagrams, the API explorer, the browser view at `localhost:7742`, comments, sequence/flow/feature panels, and every keyboard shortcut work out of the box without an account. Sign-in is now entirely optional and only used to bind your profile to anonymous telemetry. The Getting Started sidebar's "Sign In" entry, the daily sign-in popup, and the home page's Account section have all been removed
- **Cleaner home view** — the "Account" section (Sign In / Sign Out cards) is no longer shown. The home page now opens straight into Diagrams, Git & Diff, and Tools — matching the no-auth-needed flow
- **New "Open in Browser" nudge** — once per 24 hours, when a workspace finishes loading (either fresh-init or auto-load from cache), CodeAtlas surfaces a notification with the live diagram count and a one-click "Open in Browser" button that takes you to `localhost:7742`. The post-init notification also gained an "Open in Browser" button alongside the existing "Open System Design"

### Performance
- **Huge workspaces stay responsive** — projects with tens of thousands of diagrams or thousands of APIs no longer stall the editor on activation. Memory usage drops sharply at steady state, and opening a Flutter- or monorepo-scale codebase feels fluid
- **File saves are noticeably lighter on disk** — a single file edit only re-writes what actually changed, instead of rewriting the entire workspace state. Most visible on large repos where saves used to trigger tens of megabytes of disk activity
- **Browser tab loads big workspaces faster** — sending diagrams to the `localhost:7742` browser view streams them on demand rather than buffering everything first. Initial render and "broadcast everything" operations finish in a fraction of the previous time on 5000+ diagram workspaces

### Added
- **Far more complete API detection across Go and Kotlin frameworks** — Gin, Fiber, Echo, Chi, and Ktor codebases that split routes across files (a router-receiving function in one file invoked from another with a prefixed group) now correctly compose the prefix and surface every route. On real-world samples, route counts went up substantially: ktor-samples 99 → 168, fiber recipes 253 → 426, gin-realworld 20 → 57, chi 44 → 61, echo cookbook 44 → 49
- **Many more SwiftUI patterns recognized** — generics, `where` clauses, the `NavigationLink { … } label: { … }` closure form, and access modifiers like `private(set)` are all picked up. iOS mobile items detected on the SwiftUI sample app went from 152 to 254
- **Ktor typed routes, WebSocket, and SSE handlers** — `get<Routes.User>`, `webSocket("/ws")`, `sse("/events")`, and path-less verb blocks like `route("/api") { get { … } }` now appear in the API list
- **Larger files included by default** — the per-file size limit raised from 1 MB to 5 MB. New `codeatlas.maxFileSize` setting lets you raise it further for large generated artifacts (Prisma schemas, GraphQL codegen output) or lower it on slow machines
- **Configurable sequence-traversal depth** — `codeatlas.sequenceTraversalDepth` (default 8) controls how deep sequence diagrams expand across imports. Raise for deep delegation chains, lower to keep panels compact
- **Optional in-memory storage mode** — new `codeatlas.storage.inMemoryOnly` setting. When enabled, CodeAtlas keeps state only in memory and never writes anything to disk. Useful for ephemeral workspaces or secret-sensitive projects
- **Browser tab signals when the extension is offline** — if the local extension restarts or crashes, the `localhost:7742` tab now shows a clear "extension disconnected" banner instead of silently freezing on a stale diagram

### Fixed
- **`Re-sync Everything` and `Initialize Visuals` truly clear all state** — running either now wipes the local cache atomically. No more stale data surviving a reset, no more "delete `.codeatlas/` manually" workarounds
- **Subdomain routes no longer collapse into one** — three sub-apps each registering `GET "/"` in the same file now show as three distinct routes in the API list, instead of deduplicating to a single entry
- **Merge commits no longer create false add/delete pairs in commit diffs** — content already merged from a parent branch is correctly shown as unchanged instead of appearing twice as added-and-deleted
- **Deleted feature clusters surface in commit diffs** — when an entire cluster is removed between two commits, its API list now appears as deleted (with all the gone routes listed), instead of silently vanishing
- **Re-export chains across multiple barrel files now resolve** — imports that hop through several `index.ts` re-exports (`./services` → `./services/todo` → `./services/todo/TodoService.ts`) follow the chain correctly to the implementation
- **Long Chinese / Japanese / Korean labels truncate correctly** — flow node labels with CJK or fullwidth characters now truncate based on visible width, keeping panel layouts clean
- **Concurrent saves from two VS Code windows on the same workspace are serialized** — running two windows side-by-side no longer risks one window's save losing the other's changes
- **Docker Compose files with anchors and aliases parse correctly** — services defined via `<<: *defaults` or `&anchor` references are now picked up in the microservice diagram
- **Windows users no longer hit transient save failures** — atomic writes retry and fall back to a copy-based approach when Windows briefly holds the destination file open
- **AI assistants no longer see your environment-variable names** — the consumed-URLs list exposed via the MCP integration redacts placeholders like `env:DATABASE_URL` to `env:[REDACTED]`
- **Dart 3.x syntax fully covered** — extension types, `mixin Foo on Bar`, base mixins, enhanced enums with methods, and complex generic return types are all extracted correctly

## [3.3.0] - 2026-05-06

### Performance
- **TypeScript saves are noticeably faster** --- the same file used to be parsed up to five times per save (file diagram, sequence diagram, API detector, function flow, framework detector). It is now parsed once and reused across the whole rebuild pass. Save-to-render latency drops by roughly 70% on medium TS projects, and large monorepos feel fluid even on slower machines
- **Browser mode handles large diagram pushes smoothly** --- the local WebSocket bridge that powers `localhost:7742` now compresses its messages, so opening a 500+ file repo in the browser tab finishes in a fraction of the time it did before. Multi-tab broadcasts no longer stall the editor
- **Cluster diagrams rebuild only what changed** --- editing a single file used to refresh every L2b API list panel in the workspace. Now only the cluster that owns that file rebuilds, which is dramatically faster on workspaces with a dozen or more feature areas
- **Newer NL Query results never wait for older ones** --- typing a follow-up question in "Ask AI" or AI Review immediately cancels the previous LLM request instead of queuing behind it. You see the latest answer first

### Added
- **Cleaner upgrades after extension updates** --- saved diagram state now carries a schema version. After an extension upgrade that changes the storage format, CodeAtlas detects the mismatch and rebuilds cleanly on next launch instead of throwing on stale state. No more "delete `.codeatlas/` and reload" workarounds
- **Privacy disclosure in README** --- a new "Privacy & Telemetry" section lists exactly which anonymous events are collected, which fields are scrubbed, and how to opt out. No code snippets, file paths, source content, or personally identifying data ever leaves your machine

### Fixed
- **Auth callback can no longer be replayed by a stale link** --- the sign-in flow now embeds a one-time CSRF token that expires after 10 minutes, so an old browser tab or an emailed callback link cannot quietly sign you in or out. The token is also bound to the editor that started the flow, so a callback opened in the wrong window is rejected cleanly
- **Background analytics never crash the editor** --- network failures, timeouts, and other transient errors during anonymous event delivery are now logged and dropped instead of bubbling up. CodeAtlas keeps working even if the telemetry endpoint is unreachable
- **More reliable rebuild when files churn quickly** --- saving a flurry of files in rapid succession (mass formatter run, branch switch, codegen) used to occasionally race the cascade and leave one or two diagrams stale. Rebuilds are now serialized through a queue, so every save lands in order and every layer ends up consistent

## [3.2.7] - 2026-05-03

### Added
- **AI Review available the moment you have working changes** --- the AI Review button now surfaces in the toolbar automatically whenever your working tree differs from the analyzed baseline, no Replay click required. Click it on any layer (L1 → L5) to run an LLM-powered review of just the diff
- **Diff colors propagate across every layer without manual refresh** --- edit a function, save, and the modified status flows up automatically: L5 flow shows the changed statements, L3 sequence highlights the changed message, L2b API list marks the affected route, L2a feature cluster turns orange, L1 system node reflects the change. Navigate freely through breadcrumbs, back button, or direct search and every layer stays in sync

### Fixed
- **Message label text now colors correctly in sequence diagrams** --- modified message arrows AND their text labels now both render in orange (or green/red for added/deleted). Previously a CSS rule was silently overriding the per-edge label color, leaving labels black even when the arrow line was correctly diff-colored
- **Sequence diagram messages no longer falsely bold for unchanged functions** --- only messages targeting an actually-changed function get highlighted. Previously, when one function in a file changed, every message originating from that file's participant was incorrectly marked modified
- **Sequence diagram participants now spaced cleanly** --- panels with 5+ participants no longer overlap or crowd. Adjacent participant boxes always have at least 30px breathing room between them, even at maximum density
- **L4 file diagram refreshes on navigation instead of showing stale cache** --- navigating back to a file diagram after editing now shows the latest inline diff annotations (modified function bodies highlighted) without needing a manual refresh
- **L2b API list refreshes on back navigation** --- clicking back to an API list panel after drilling into L3/L5 now shows the latest API diff state. Same behavior for L2a feature clusters
- **Working changes detected on window reload** --- if you edited files while the extension was inactive (window reload, hot reload, etc.), CodeAtlas now picks up those changes on next load and shows them as live diffs immediately, no save-trigger needed
- **Back button navigation no longer shows "diagram not found"** --- back-button navigation across all six layers (L1 → L5) now correctly resolves the target panel and refreshes its diff state
- **Initialize wipes the cache directory** --- running "CodeAtlas: Initialize Workspace Visuals" now removes the entire `.codeatlas/` directory before rebuilding. No stale or corrupted state survives a re-initialize

## [3.2.6] - 2026-05-03

### Fixed
- **Persisted file content no longer corrupted by secret-redaction** --- code like `const password = input.password?.trim()` and validation messages like `password: ["can't be blank"]` are no longer mangled into `password = [REDACTED]` when state is saved. The redaction now matches only credential-shaped values (base64/hex tokens) preceded by secret-named keys, never code expressions
- **TypeScript files with type-cast syntax parse reliably for inline diffs** --- `.ts` files with `<Type>expr` cast syntax (common in Apollo and other TS codebases) now produce inline function-level diff annotations instead of being silently skipped
- **Resilient handling of corrupted baseline content** --- if the persisted baseline content fails to parse (from previous redaction bugs or other corruption), the file diagram still builds correctly and the rebuild continues for the rest of the workspace instead of bailing entirely
- **Auto-refresh corrupted baseline from git HEAD** --- when CodeAtlas detects a working file has drifted from its persisted baseline, it now refreshes the baseline content from `git HEAD` before computing the diff. This recovers cleanly from any baseline corruption left by older versions

## [3.2.5] - 2026-05-02

### Added
- **Rust Actix `web::resource` routes flow-chart in full** --- inline closures registered as `web::resource("/x").to(|req| ...)` and `web::resource("/").route(web::get().to(|| async {...}))` now produce their L5 flow diagrams. Common in Actix examples and real-world Actix backends; previously these routes showed only as bare API entries with no internal control flow
- **Rust Rocket inline `#[get("/")] fn name()` patterns recognized** --- routes declared in macro-expanded blocks like `spawn! { #[get("/")] fn index() { } }` now correctly resolve to their handler function instead of showing as anonymous
- **Go Chi `r.Handle` and `r.HandleFunc` route detection** --- Chi's `r.HandleFunc("/pprof/cmdline", pprof.Cmdline)` style now appears in the API list with the correct named handler (previously was missing entirely)
- **Go named handlers recovered in long files** --- `app.Get("/path", myHandler)` style routes in Fiber/Echo/Gin files where `func main()` opens far above the route declaration now correctly capture `myHandler` as the handler name instead of falling back to anonymous

### Fixed
- **Kotlin `return@get`, `break@post`, `this@delete` labels no longer mistaken for JAX-RS annotations** --- Ktor route handlers using Kotlin's labeled-return syntax (`val x = call.parameters["id"] ?: return@get`) no longer emit phantom `GET /` entries. This alone removed dozens of false-positive routes from real Ktor apps
- **HTTP client calls no longer mistaken for server routes** --- `client.get("/captured-headers")`, `jwkProvider.get("uuid")`, `HttpClient.get($repo/$artifact)` and similar method calls in Kotlin/Ktor client files no longer pollute the API list with phantom server endpoints
- **JSON map accessors in Kotlin/Android no longer registered as Ktor routes** --- `volumeInfoJson.get("title")` style calls in Android apps (e.g. `MainActivity.kt`) no longer create phantom `GET /title`, `GET /subtitle` etc. entries
- **Kotlin string-template route paths flow-chart correctly** --- routes declared with interpolation like `get("{$pathParameterName...}")` now resolve to their handler body instead of showing an empty flow chart
- **Sequence diagrams now have matching flow charts across the board** --- the long-standing gap where some sequence diagrams had no clickable flow chart at all (most visible in Rust Actix, Rust Axum, Kotlin Ktor, Ruby Sinatra, Go Fiber) is now resolved at 99%+ coverage. The few remaining cases are inherently structural (e.g. `expvar.Handler()` in Go, where the handler is a value returned by a constructor with no extractable closure body)

## [3.2.4] - 2026-05-02

### Added
- **Sequence diagrams now produced for inline route handlers across 8 frameworks** --- Go (Fiber, Chi, Echo, Gin), Rust (Axum, Actix, Rocket), Kotlin Ktor, Ruby Sinatra, PHP Laravel, Java/Kotlin Spring, C# ASP.NET Core, and Python (FastAPI, Flask, Django) all now flow-chart their route bodies even when the handler is an inline closure or block. Previously these only showed up as bare API entries with no L3/L5 detail
- **NestJS controller methods get full flow charts** --- methods like `findAll`, `getFeed`, `create` etc. on a `@Controller`-decorated class now produce one flow chart per method (previously only the `constructor` was flow-charted)
- **tRPC procedure bodies are flow-charted** --- the arrow inside `publicProcedure.query(({input}) => …)` and `.mutation(...)` now produces a full L5 flow diagram for each procedure
- **Named function expressions used as middleware are flow-charted** --- patterns like `app.all("*", function getReplayResponse(req, res, next) { … })` (Remix `server.ts` style) now show their internal control flow

### Fixed
- **API list no longer includes test fixtures** --- Apollo's `__tests__/` GraphQL schemas, JUnit `@Rule` factories (`createComposeRule`, `setUp`), RSpec helpers, Go `*_test.go` mocks, Rust `#[cfg(test)] mod tests { … }` blocks, and Python `test_*.py` / `*_test.py` files no longer leak into the visible API list. The list reflects only your real route surface
- **Storage and cache calls no longer mistaken for HTTP routes** --- Cloudflare Durable Object `storage.put('value', value)`, Knex/SQL `connection.query(...)`, and similar method calls with key-name string args (no leading `/`) are no longer detected as endpoints
- **Doc comments and Python docstrings ignored** --- example `#[get("/")]` lines inside `///` Rust doc comments, `* @Get` JSDoc lines, and `url(r'^$', views.home)` examples inside Python `"""…"""` docstrings no longer create phantom routes
- **Class-level `[Route("/blog")]` and `#[Route('/blog')]` annotations no longer create empty endpoints** --- in C# ASP.NET and PHP Symfony, the controller-prefix attribute now correctly registers as a path prefix for child methods rather than as a standalone route
- **Express `router.route('/x').get(h).post(h)` chained routes detected in full** --- common in Node real-world templates and bigger backends; previously the chained methods were silently dropped
- **Sibling tRPC procedures get distinct names** --- a router that defines `{ healthcheck: …query(...), listUsers: …query(...), createUser: …mutation(...) }` shows each as its own procedure (was previously collapsing all to whichever name appeared first)
- **Java/Kotlin/C#/PHP class-method handlers map to their flow charts** --- `OwnerController.processCreationForm` style class-method names now resolve to the right L5 flow without users having to drill in via the file diagram first
- **Python `@router.get("/users") def read_items(...)` decorated handlers flow-chart correctly** --- previously the wrapper consumed the function and the handler was silently skipped from L5
- **Rust nested handler functions flow-chart** --- `async fn handler(...)` declared inside a helper builder function (e.g. `fn admin_routes()` in Axum examples) now produces a flow graph
- **Cross-file Django CBV and Rust module references resolved in L3/L5 navigation** --- clicking a sequence in `urls.py` for `ArticlesFeedAPIView` now finds the flow chart in `views.py`; same for Rust `auth_handler::login` in `main.rs` finding the body in `auth_handler.rs`
- **"Replay Working Changes" knows when there's nothing to replay** --- if your working tree matches baseline (file content equality, not graph annotations), the home-page card now shows "No working changes to replay. Edit some files first." instead of running an empty diff

## [3.2.3] - 2026-05-01

### Added
- **Express chained routes detected in full** --- Express files that group routes with `router.route('/users').get(handler).post(handler).delete(handler)` now show every method, not just the ones written as `router.get(...)`. Common in Node real-world templates and bigger backends
- **Sibling tRPC procedures named correctly** --- a router that defines several queries side-by-side (`{ healthcheck: publicProcedure.query(...), listUsers: publicProcedure.query(...), createUser: publicProcedure.mutation(...) }`) now shows each procedure with its own name in the API list. Previously all siblings collapsed to whichever name appeared first

### Fixed
- **"Replay Working Changes" knows when there's nothing to replay** --- if your working tree matches the last analyzed snapshot, the home-page card now shows a clear "No working changes to replay. Edit some files first." toast instead of running an empty diff. Edit-then-revert sequences no longer leave a phantom diff queued
- **Cleaner sequence diagrams** --- L3 sequence views no longer carry orphan participants for imports the handler never actually calls. Ruby, Rust, Go, Kotlin, PHP, Swift, and Dart sequence diagrams in particular now show only the services and modules the route really talks to
- **No more empty sequence diagrams** --- files where every import was framework noise used to leave an empty sequence entry in the navigation tree. Those are now suppressed
- **GraphQL test fixtures no longer pollute the API list** --- Apollo Server projects (and any project with `gql\`type Query { ... }\`` blocks inside `__tests__/` directories) no longer show phantom API entries from test fixtures. Test files are skipped by the GraphQL detector
- **Code samples inside template-literal strings no longer create fake routes** --- documentation/example projects that embed Express or Go snippets as strings inside Svelte stores or other template literals no longer trigger phantom route detection
- **No false-positive `QUERY /procedure` entries from SQL helpers** --- migration and database-init scripts that call `connection.query("CREATE DATABASE ...")` no longer get listed as tRPC procedures

## [3.2.2] - 2026-05-01

### Added
- **Sign in or sign up with just an email code** --- whether you started in the editor or in the browser, you now go to the same single page that handles both new accounts and returning users. No more "couldn't find your account" if you've never signed in before
- **Browser sign-in returns to the browser** --- when you sign in from the browser tab (`localhost:7742`), you land back on your diagram view automatically. Previously the redirect bounced you into the editor, leaving you to manually re-open the browser

### Fixed
- **L2b API list scrolls cleanly and every section collapses** --- the API list view in busy clusters (e.g. "Article Management" with a dozen routes plus subsystems) now reserves space for its scrollbar and lets you collapse the Changes group, every per-file group, and the Subsystems block. Long lists no longer feel stuck
- **Routes no longer double-counted on the same line** --- Express, Koa and Fastify routes written with inline arrow handlers (e.g. `router.get('/tags', async (req, res) => {...})`) used to show twice in the API list because two detectors disagreed on what to call the anonymous handler. Each route now appears exactly once
- **Replay no longer shows phantom "added" and "deleted" clusters** --- the Working Changes replay on the L1 system view and the L2a feature areas view used to flash whole clusters as added or deleted whenever the AI naming pass renamed them in the background. The diff is now keyed on the cluster's stable identity, so cosmetic renames don't masquerade as architectural changes
- **Silent error parity in browser mode locked in** --- a regression guard now checks that every editor-side error message in the handler layer is mirrored to a browser toast. New silent failures cannot ship in a future release without breaking the test

## [3.2.1] - 2026-04-28

### Added
- **API & Screen List populated at workspace open** --- the L2b panel now appears immediately when you open a project (previously empty until you clicked into a feature). Sub-cluster panels populate the same way, so navigating down the tree never lands you on a blank screen
- **NestJS, Symfony, Spring, ASP.NET controllers fully indexed** --- every method on a class controller now registers as its own route handler. You see all routes (not just the first one per controller) in file diagrams, sequence diagrams, and the API list
- **More anonymous handlers picked up** --- TSX files with JSX inside the handler body (`app.get("/", (c) => c.html(<html>...</html>))`), one-line arrow callbacks (`(c) => c.text("hi")`), and routes prefixed with middleware (`app.get("/api", auth, validate, (c) => {...})`) all flow-chart now
- **Mobile vs server-side counts separated** --- React Native, Flutter, Android Compose, and SwiftUI projects now distinguish screens/navigation from backend endpoints. The headline "API count" reflects real routes; mobile UI items are tracked separately
- **C# 10+ file-scoped namespaces** --- methods inside `namespace Foo;` (semicolon form, no braces) flow-chart correctly. Previously these files produced no flow graphs
- **Hono multi-app composition** --- `app.route("/api", subApp)` now correctly surfaces the sub-app's routes in the parent app's API list

### Fixed
- **Rust import labels no longer blank** --- file diagrams for Actix, Axum, and Rocket projects no longer show empty rectangles for imports. The `use foo::{Bar, Baz}` brace-group form is now parsed correctly
- **NestJS / TypeORM / class-validator files parse** --- the legacy decorator syntax these libraries use is now supported. Files that previously got skipped (about two-thirds of a typical NestJS app) now produce diagrams
- **TypeScript type-cast syntax in .ts files** --- the angle-bracket cast `<Type>expr` (still common in older codebases like Apollo Server) now parses in `.ts` files even when the same project has `.tsx` JSX files
- **Kotlin imports show in file diagrams** --- Compose Android projects and any Kotlin codebase now show `import androidx.compose.runtime.*` etc. as proper import nodes
- **Browser-mode click feedback** --- clicks that previously failed silently in the browser (cluster not found, function not found, file outside workspace, build errors) now surface a toast notification, so you always see what happened
- **Replay Working Changes is reliable** --- the home-page card no longer occasionally drops the click while the WebSocket is settling
- **AI Review panel buttons match across diff views** --- panel renders consistently whether you triggered it from PR diff, branch diff, or working-changes replay
- **Sub-cluster panels carry members** --- clicking down into a sub-cluster shows its files/APIs (previously empty)
- **Database services unified across detection methods** --- `psql` in a Dockerfile and `PostgreSQL` from a connection string now collapse into one infrastructure node (similarly for Mongo, MySQL, Redis, RabbitMQ, Kafka)
- **Anonymous handlers visible at startup** --- across Express, Fastify, Hono, Apollo, Go Fiber and others, route callbacks are flow-charted during initial workspace scan instead of waiting for you to click

## [3.1.5] - 2026-04-27

### Added
- **Anonymous route handlers across languages** --- flow charts for inline route callbacks now work in Go (`r.GET("/path", func(c *gin.Context) {...})`), Kotlin (Ktor `get("/path") { ... }`), Rust (Axum `.route("/path", get(|| async {...}))`), Ruby (Sinatra), and PHP (Laravel) --- previously only JavaScript/TypeScript was supported

### Fixed
- **Anonymous handler flow charts more reliable** --- Express/Koa/Fastify route callbacks with middleware arguments (e.g., `router.get('/users', auth, validate, async (req, res) => {...})`) are now correctly extracted; the body parser no longer mis-counts parentheses inside the function body, so handlers no longer get truncated mid-function
- **TypeScript anonymous handlers** --- `.ts` files with inline route callbacks now open their flow charts (previously the TypeScript path routed through the multi-language analyzer, which couldn't locate anonymous functions and showed "Function not found")
- **"Function not found" warning surfaced in browser mode** --- when a flow chart cannot be resolved, the warning now also appears in the browser UI instead of only the VS Code editor

## [3.1.4] - 2026-04-27

### Added
- **Flow charts for anonymous route handlers** --- clicking a sequence diagram message for Express/Koa/Fastify arrow function handlers (e.g., `router.get('/articles', async (req, res) => {...})`) now opens its control flow diagram. Previously showed "Function not found" for anonymous callbacks
- **Anonymous handlers in function list** --- route handler callbacks like `anonymous@GET:/articles` now appear in the sidebar function explorer alongside named functions, so you can browse and click into any route's control flow directly

### Fixed
- **Sequence message click opens flow chart** --- clicking any message arrow in a sequence diagram now reliably opens the target function's flow chart, including for anonymous Express route handlers

## [3.1.3] - 2026-04-27

### Security
- **Recursive prototype pollution defense** --- `state.json` parsing now recursively strips `__proto__`, `constructor`, and `prototype` keys at all nesting depths, preventing supply-chain attacks via crafted workspace state files
- **Git file path injection prevention** --- file paths passed to `git show` are validated against shell metacharacters (`$`, backticks, semicolons) before execution, blocking command injection via crafted filenames
- **WebSocket connection cap** --- browser mode server now rejects connections beyond 20 clients, preventing denial-of-service via connection flooding
- **Symlink path traversal fix** --- `safeResolve()` now uses `fs.realpathSync()` to follow symlinks before checking workspace boundaries, preventing symlink escape attacks
- **CORS port validation** --- WebSocket origin check now validates that the connecting origin's port matches the server port, blocking cross-origin connections from other localhost services
- **Secret redaction expanded** --- `CERT`, `CERTIFICATE`, Bearer tokens, and `http://user:pass@` URL patterns are now redacted from `state.json` alongside existing password/key patterns

### Added
- **Switch statements in flow charts** --- `switch/case` blocks now render as proper decision trees with labeled branches per case, instead of a single opaque node
- **Stable key collision prevention** --- diff matching uses content-aware hashing for string literals instead of normalizing all strings to the same token, preventing false "unchanged" results between genuinely different nodes
- **API Explorer icons for 20+ method types** --- SIGNAL, AOP_ASPECT, MIDDLEWARE, SERVLET_FILTER, DI_DEPENDENCY, SERVER_ACTION, EVENT_LISTENER, and mobile types (SCREEN, NAV_ROUTE, NETWORK) now have distinct icons in the sidebar
- **Transitive impact analysis** --- blast radius "review-required" now traces up to 3 hops through import chains, catching files that transitively depend on changed code
- **External HTTP call detection** --- sequence diagrams now detect `axios.get()`, `http.post()`, `got()`, `superagent.get()`, and `ky` calls as external service participants, not just bare `fetch()`
- **Class hierarchy in file diagrams** --- class nodes now show both `extends` and `implements` in their subtitle (previously only `extends` was shown)
- **Protocol versioning** --- message protocol between extension and webview now includes a `PROTOCOL_VERSION` constant for detecting version mismatches during updates
- **Impact panel state persistence** --- the minimized/expanded state of the blast radius panel is persisted to localStorage, so it doesn't reopen uninvited on every new analysis

### Fixed
- **Auth gate race condition** --- browser mode now defaults to "blocked" until authentication status is confirmed, preventing a brief flash of authenticated content before the auth check completes
- **Sequence entry point regex tightened** --- `isApiHandlerName()` no longer matches utility functions like `postMessage`, `createStore`, or `fetchTheme`; requires explicit handler/controller suffixes or exact HTTP method names
- **Dangling edges in diff graphs** --- deleted edges that reference non-existent nodes are now pruned, preventing layout crashes and phantom connections in the diff view
- **Edge diff priority corrected** --- connections to newly-added nodes now show as "added" (green) instead of "modified" (orange)
- **Edge dedup preserves type** --- edges with the same endpoints but different types (`calls` vs `uses`) are no longer collapsed into one
- **Section labels in diff mode** --- file diagram sections now show "3 changed + 12" instead of the misleading total "15" when most entities are unchanged
- **Monorepo single-package detection** --- projects with exactly one package.json in a subdirectory are now correctly detected as monorepo services instead of falling through to Docker or fallback detection
- **Comment ID uniqueness** --- concurrent comment creation uses random suffixes to prevent ID collisions in browser mode with multiple simultaneous users
- **Sequence participant ordering stable** --- participants are now sorted by kind (client → modules → external) then alphabetically, preventing layout jumps when import order changes
- **Branch name validation relaxed** --- git branch names with colons, `@`, `+`, and `=` characters (e.g., `release:v1.0-rc1`) are now accepted
- **Sub-cluster depth enforced** --- recursive sub-clustering is now hard-capped at depth 1, preventing potential stack overflow on deeply nested projects
- **NL query stale results invalidated** --- file changes now increment the query request ID, discarding any in-flight search results that were computed against outdated code
- **FastAPI router prefix edge cases** --- `APIRouter()` without a prefix argument no longer causes downstream routes to be mislabeled
- **Event listener cleanup** --- the `classBlockItemClick` listener on DiagramView now properly removes itself on component unmount via `useEffect` cleanup
- **Non-HTTP methods excluded from API count** --- System Design service nodes now show only HTTP API counts, excluding SIGNAL, AOP, MIDDLEWARE, and DI entries from `exposedApiCount`
- **Feature explorer diff operator** --- cluster diff status now uses `!== undefined` instead of `??`, correctly respecting explicitly set `unchanged` status
- **Cyclic dependencies sorted** --- Health Dashboard now shows longest dependency cycles first (most critical)
- **Windows path extraction** --- changed items sidebar correctly handles Windows drive-letter colons in `flow:C:\path:function` graph IDs
- **WS message size limit** --- browser bridge rejects messages larger than 10MB to prevent out-of-memory crashes
- **forceUpdate anti-pattern removed** --- theme changes now trigger re-renders through React state naturally, removing the `useState(0)` increment hack
- **Mermaid export escaping** --- apostrophes, backticks, and ID collisions (e.g., `node-1` vs `node_1`) are now handled correctly in exported Mermaid diagrams

## [3.1.2] - 2026-04-27

### Added
- **Next.js Server Actions** --- functions marked with `'use server'` are now detected as `SERVER_ACTION` endpoints, visible in the API explorer and searchable across all layers
- **Next.js data fetching** --- `getServerSideProps`, `getStaticProps`, and `getStaticPaths` are detected as data-fetching entry points and traced in sequence diagrams showing their full call chains
- **Next.js middleware** --- `middleware.ts` at the project root is detected as a `MIDDLEWARE` endpoint with `/*` route coverage
- **FastAPI router prefixes** --- `APIRouter(prefix="/api/v1/todos")` now correctly prepends the prefix to all routes registered on that router (e.g., `@router.get("/")` becomes `/api/v1/todos`)
- **Spring Security annotations** --- `@Secured`, `@PreAuthorize`, and `@RolesAllowed` on controller methods are now detected alongside route mappings
- **Spring AOP detection** --- `@Aspect` classes and `@Around`/`@Before`/`@After`/`@AfterReturning`/`@AfterThrowing` advice methods with pointcut expressions are detected as cross-cutting concerns
- **Spring WebFlux router functions** --- `.route(GET("/path"), handler)` and builder-chain `.GET("/path")` patterns are detected for reactive Spring Boot apps
- **Spring Servlet Filters & Interceptors** --- classes implementing `Filter` or `HandlerInterceptor` are detected as middleware-like components
- **Django middleware detection** --- middleware classes with `process_request`, `process_response`, or `__call__` methods are detected as `MIDDLEWARE` endpoints
- **Django signals** --- `@receiver(post_save, sender=Model)` signal handlers are detected as `SIGNAL` event endpoints, showing the signal type and sender model
- **Django DRF @action improvements** --- `@action(detail=True)` without explicit `methods` now defaults to GET and properly extracts the URL path
- **FastAPI dependency injection** --- `Depends(get_db)` calls are detected as `DI_DEPENDENCY` entries, making dependency chains visible in the API explorer
- **Node.js EventEmitter** --- `.on('eventName', handler)` listeners and `.emit('eventName')` emissions are detected when EventEmitter is imported, making event-driven architectures visible in diagrams
- **Architecture Decision Records** --- 7 ADRs added in `docs/ADR-*.md` documenting the rationale behind all bug fixes and design choices for future maintainability

### Fixed
- **Timeline Replay cleanup** --- stopping a replay now properly removes all diff overlay annotations (~MODIFIED badges, orange borders) by pushing clean working graphs back to the browser; previously the diff styling persisted after stop
- **AI Review loading feedback** --- clicking the AI Review button now immediately shows a spinner with "Preparing review..." and includes a 3-minute timeout fallback, instead of appearing to do nothing

## [3.1.1] - 2026-04-24

### Fixed
- **Browser navigation overhaul** --- breadcrumbs now show a clean hierarchical path (e.g., System Design › Features › APIs › GET /articles) instead of accumulating stale navigation history; browser tab title updates correctly on back/forward navigation; navigating to `localhost:7742` always lands on the home page
- **API list click navigates to Sequence Diagram** --- clicking an API route in the API list now opens its L3 Sequence Diagram (full call chain visualization) instead of skipping to the L4 File Diagram
- **Clustering accuracy for Express apps** --- controllers are now placed in their correct domain clusters (article.controller.ts in "Article Management", auth.controller.ts in "User Authentication") instead of all being merged into a single cluster due to shared middleware imports
- **Health report accuracy** --- dead function false positives reduced from 17 to 1 (imported service functions like `getArticles`, `login` are no longer flagged); orphaned cluster false positives reduced from 2 to 1 (clusters with APIs are never flagged as orphaned)
- **All API routes now visible** --- removed the 260px height cap on API list sections that clipped most routes; all 15+ routes per controller are now fully visible without scrolling within sections
- **API count consistency** --- System Design now shows the correct count (24 APIs) matching the home page and search picker
- **LLM cluster names validated** --- broken AI-generated names like "The domain name for this module wo..." are rejected and replaced with clean algorithmic labels; sentence-like and code-like LLM output is filtered out
- **Git & Diff cards work in browser** --- Compare Commits, Branch Diff, and all 7 Git & Diff home page cards now function correctly in browser mode; the auto-resync dialog no longer blocks silently in browser sessions
- **Timeline Replay cleans up properly** --- diff overlay (~MODIFIED badges, orange borders) is now removed when replay stops, instead of persisting with stale annotations
- **AI Review loading feedback** --- clicking the AI Review button now immediately shows a loading spinner with "Preparing review..." text and a 3-minute timeout fallback, instead of appearing to do nothing
- **Impact Analysis navigates first** --- selecting a file for impact analysis now opens its file diagram before showing the blast radius overlay, so results are actually visible instead of being hidden behind the home page
- **API filter updates tab counts** --- typing a search filter now updates all method tab counts (ALL, GET, POST, etc.) to reflect filtered results instead of showing stale totals
- **Feature area edge labels cleaned up** --- removed the misleading "70%" confidence percentage from inter-cluster edge labels; edges now show just the call count (e.g., "2 calls")
- **Homepage grammar** --- stats card now shows "1 Service" (singular) instead of "1 Services"
- **Homepage card descriptions clarified** --- Sequence and Flow Chart cards now say "Pick an API/function" to set the right expectation before opening a picker

## [3.1.0] - 2026-04-24

### Added
- **AI Review** --- click the new **Review** button on any diff badge to get instant, LLM-powered code review feedback directly on your diagrams
  - Severity-coded review bubbles appear on changed nodes across all 6 layers --- red for likely bugs and security issues, amber for potential problems, blue for suggestions
  - Click any bubble to expand the full explanation with a concrete fix suggestion
  - **Layer-aware analysis** --- the AI focuses on architecture concerns at L1 System Design, API design issues at L3 Sequence, code quality at L4 File, and logic bugs at L5 Flow
  - **Resolve / Ignore / Reopen** --- mark findings as resolved (addressed), ignore (dismiss), or reopen; resolved items hide from the default view but can be shown with the "Show resolved" checkbox
  - **Summary panel** --- right-side panel groups all findings by severity with layer filter tabs (All, L1–L5), click any finding to jump to its diagram
  - Works with all diff flows: Compare Commits, PR Diff, Branch Diff, and Working Changes
  - Cached per diff pair --- toggle review on and off instantly after the first generation
  - Works in browser mode at `localhost:7742`
- **Smart retry on LLM failures** --- transient errors (rate limits, timeouts, server errors) are automatically retried up to 2 times with exponential backoff before giving up
- **Partial failure handling** --- if some layers fail to review, you still see results from successful layers with a clear warning showing which layers were missed
- **Timeout-specific guidance** --- when a review times out, the notification suggests trying a faster model or smaller diff instead of a generic error

### Fixed
- Sequence diagram message lines now correctly change color when a participant is modified --- previously edges stayed gray even when the target service had changes

## [3.0.0] - 2026-04-22

### Added
- **Timeline Replay with manual navigation** --- step forward and backward through every change across all 6 diagram layers using ‹ Prev and › Next buttons, or let auto-play walk through them at your own speed
  - Replay now covers **all layers**: L5 Flow, L4 File, L3 Sequence, L2a Feature Areas, **L2b API List**, and **L1 System Design** (previously stopped at L2a)
  - Auto-pauses on the last step instead of closing --- browse freely with Prev/Next, then resume auto-play from any position
  - Step counter shows "Step 3/15" so you always know where you are in the walkthrough
  - Single-commit replay --- select just one commit and it automatically diffs against its parent, no need to pick a range
- **Replay any diff** --- after any Compare Commits, PR Diff, or Branch Diff, click the new **▶ Replay** button on the diff badge to get a guided layer-by-layer walkthrough of the changes instantly (zero wait, no rebuild)
- **Replay Working Changes** --- one-click replay of all uncommitted changes vs your baseline, walking through every modified function, file, API, and service
- **Replay PR / Replay Branch** --- new home page actions that combine the picker + replay into a single step: pick a PR or branch and immediately get a guided walkthrough instead of a static diff view
- **Focused file replay** --- click the ▶ button on any changed file in the Changed Elements sidebar to replay just that file's impact chain through the layers
- **Keyboard shortcuts during replay** --- ← / → for prev/next step, Space for play/pause, Escape to stop (active only during replay so they don't interfere with normal editing)

### Changed
- Replay engine rebuilt from loop-based to timer-based architecture for instant prev/next response and cross-commit navigation with automatic diff context switching

## [2.7.1] - 2026-04-19

### Added
- **Comment badges on all diagram nodes** — 💬 badge with count appears inline on nodes across L1 System Design, L2a Feature Areas, L3 Sequence, L4 File, and L5 Flow when comments are added
- **Comments panel in browser** — click the 💬 button in the toolbar to see all comments grouped by layer with click-to-navigate and inline resolve
- **Comment count bubbles up to parent layers** — service and cluster nodes show aggregated comment counts from all child functions
- **"View comments" in context menu** — right-click a commented node to open the comments panel
- **Timeline Replay on home page** — ⏯ button added to the Git & Diff section on the browser home page
- **Auth gate for browser mode** — signed-out users are redirected to the home page with a "Sign in to view diagrams" prompt; diagrams, tools, and git commands are disabled until sign-in
- **Browser sign-in redirect** — clicking Sign In on the browser redirects to the auth page with editor URI scheme for seamless callback

### Fixed
- **Loading stuck on invalid routes** — navigating to a non-existent sequence diagram (e.g., `anonymous@GET:/articles`) now falls back to System Design instead of showing an infinite spinner
- **Route fallback timer** — if no diagram arrives within 5 seconds of a hash navigation, the browser shows the home page instead of stuck loading
- **Browser re-sync works** — Re-sync from the browser now triggers a real workspace rebuild with progress notifications instead of a silent no-op
- **Coverage loading feedback** — browser shows a clear message that coverage loading requires the editor
- **Source navigation feedback** — "Opened file.ts at line 42 in editor. Switch to your editor to view."
- **VSIX package cleaned up** — removed `docs/` (1MB of GIFs) and `test-results/` from the published extension package

## [2.7.0] - 2026-04-19

### Added
- **Commit Timeline Replay** — select a range of commits and watch a cinematic replay of your codebase evolving, with diff colors flowing through all 6 diagram layers
  - Auto-navigates from function flow (L5) through file dependencies (L4), API sequences (L3), feature clusters (L2), to system design (L1) for each commit
  - Playback controls: pause, resume, skip commit, stop, and adjustable speed slider (0.5s–5s per step)
  - Commit progress dots show which commit is playing and which are done
  - Full WCAG-safe 3-channel diff colors on every node and edge (green/added, orange/modified, red/deleted)
- **Branch selector in commit picker** — switch between local and remote branches to replay commits from any branch
- **Merge-base auto-detection** — the commit where your branch diverged from main/master is automatically marked with a "merge-base" badge and pre-selected as the replay start point
- **Live Impact Replay** — when enabled, diagrams auto-navigate through changed functions and their blast radius as files are saved (opt-in via `CodeAtlas: Toggle Live Replay`)
  - Shows function-level changes, then affected API sequences, then impacted feature clusters
  - Replay indicator overlay with stop button
- **Change timeline bar** — horizontal scrubber at the bottom of the browser UI showing all file changes as dots, with play/pause and click-to-navigate
- **Comments to comments.md** — right-click any node in any diagram to add a comment, exported to `comments.md` with full layer context (service, cluster, API, file, function) for LLM agents to read
- **"Add Comment" context menu** — available on all diagram nodes across all layers
- **11 Claude Code skills** — project-specific `/verify`, `/impact`, `/review-diff`, `/add-issue`, `/explain-layer`, `/security-check`, `/changelog-entry`, `/test-for`, `/fix-issue`, `/tdd`, `/publish-check`

### Fixed
- Clicking sequence diagram message arrows now opens the correct function flow chart for lambda/arrow functions
- `CLAUDE.md` now mandates lint + tests + build + test updates after every change

## [2.6.0] - 2026-04-19

### Added
- **AI Query Engine** — ask questions about your codebase in plain English and see matching entities highlighted in blue across all 6 diagram layers
  - Type queries like "Show me the authentication flow" or "How does payment connect to the database?"
  - Blue highlights persist as you navigate between layers — services, clusters, APIs, files, classes, and functions all light up
  - Hover any highlighted node to see WHY it matched (e.g., "API handler: POST /auth/login", "In cluster: Authentication")
  - Sequence diagram message arrows between highlighted participants also turn blue
  - File/flow diagram edges between highlighted nodes turn blue
  - Sub-cluster pills in Feature Areas show which sub-clusters contain matched files
  - Config files and type definitions without functions are highlighted via file-level matching
  - API list items show blue left-border and background highlight
- **Ask AI toolbar button** — sparkle icon in the command bar focuses the query input; keyboard shortcut `Cmd+Shift+Q`
- **Zero-result guidance** — when no matches are found, suggested example queries help users get started
- **Query progress indicators** — shows "Analyzing codebase..." after 3s and "Still working..." after 10s for long-running queries
- **Query result caching** — identical queries within 5 minutes return cached results instantly, no LLM call needed; cache invalidated on file changes
- **Concurrent query safety** — rapid-fire queries discard stale results; only the latest query's highlights are displayed
- **Browser API key input** — set your LLM API key directly from the browser UI when not configured (no VS Code command palette needed)
- **Class-aware LLM context** — classes with inheritance info are included in the LLM summary for queries like "Show me the controllers"
- **Enriched cluster context** — LLM summary now includes top API routes and file names per cluster for better match quality
- **Prioritized truncation** — large codebases send the most-called functions and symbol-richest files to the LLM first

### Fixed
- Monorepo rootPath matching no longer produces false positives (`services/auth` no longer matches `services/auth-shared`)
- Light theme NL query highlight contrast increased (background opacity 0.10 to 0.18) for better visibility

## [2.5.3] - 2026-04-18

### Added
- **Click-to-line navigation** — clicking a line in flow charts opens the exact line in your editor (VS Code, Cursor, Windsurf, or any compatible editor)
- **Line hover tooltips** — hovering over truncated lines in consolidated flow chart blocks shows the full statement text
- **Smart browser tab reuse** — reloading the editor no longer opens duplicate browser tabs; existing tabs auto-reconnect automatically
- **Consolidated flow charts** — consecutive statements are merged into compact block nodes, reducing visual noise by 40-60%
- **Inline diff within blocks** — modified, added, and deleted lines show per-line color indicators inside consolidated blocks
- **PR picker with live PR list** — browse and search open pull requests directly in the browser with title, author, branch, and time since last update
- **Diff progress indicators** — loading spinner with real-time status messages while diffs are being built
- **PR context in diff badge** — the nav bar diff badge now shows the PR number with full title in the tooltip
- **End-to-end browser test suite** — 58 Playwright tests validating all diagram layers, navigation, modals, and theme switching
- **Smarter feature clustering** — test files, config files, and infrastructure are automatically excluded from feature detection

### Fixed
- **Flow chart line offsets** — line navigation now works correctly across all code paths
- **Editor focus on click** — clicking a node from the browser brings the editor to the foreground
- **PR Diff works in browser** — clicking PR Diff from the browser now opens the in-browser PR picker
- **Sequence diagram diff propagation** — message arrows highlight when the called function was modified
- **Infrastructure nodes cleaned up** — database and cache nodes no longer show misleading tech badges
- **API count pluralization** — "1 API" instead of "1 APIs" across all diagram headers
- **Health Report works in browser** — clicking Health Report now correctly renders the dashboard
- **Explorer toggle repositioned** — moved to the command bar toolbar, preventing overlap issues
- **Test directories excluded** — test and config directories are no longer detected as services or features
- **All browser commands routed correctly** — all commands from browser mode use browser-native UI

## [2.2.0] - 2026-04-16

### Added
- **Standalone Browser Mode** — open CodeAtlas at `localhost:7742` in any browser, fully independent of editor panels
  - Auto-reconnecting WebSocket bridge with message buffering
  - Hash-based URL routing with browser history integration
  - Home page dashboard with workspace stats and command cards
  - Explorer sidebar with services, features, APIs, files, and functions
  - Command toolbar for quick access to all diagram layers
- **Browser-native pickers** — commit selection, PR input, and search use in-browser modals instead of editor dialogs
- **Unified test command** — `npm test` runs both extension and webview test suites

### Fixed
- Page refresh in browser now restores the current diagram
- Connection status indicator works correctly on mount
- Home page stats persist across navigation

## [2.1.0] - 2026-04-10

### Added
- **PR Diff integration** — compare any GitHub pull request across all diagram layers with automatic authentication and commit fetching
- **API grouping** — endpoints grouped by file in API List and Feature Areas

### Fixed
- PR diff error handling and auth retry flow

## [2.0.0] - 2026-04-09

### Added
- **6-layer architecture visualization** — System Design, Feature Areas, API List, Sequence, File, Flow + Health Dashboard
- **30+ framework detection** — Express, Next.js, Django, FastAPI, Spring Boot, Laravel, Remix, SvelteKit, tRPC, GraphQL, gRPC, Go, Rust, C#, Swift, and more
- **Mobile/UI detection** — Android, iOS, React Native, Expo Router, Flutter/Dart screens, navigation, network calls, and dependency injection
- **Git commit diff** — compare any two commits with colorblind-safe 3-channel diff indicators
- **Impact analysis** — blast radius calculation showing direct, transitive, and review-required impacts
- **Health dashboard** — dead code, god files, coupling cycles, orphaned clusters
- **Code coverage overlay** — LCOV and Istanbul JSON coverage parsing
- **MCP server** — AI assistant integration with architecture tools
- **Markdown export** — architecture documentation with Mermaid diagrams
- **LLM semantic naming** — AI-powered cluster and service naming (opt-in with data filtering)
- **Light mode** support with theme persistence

### Security
- Input validation on all shell commands
- Workspace boundary enforcement on all file operations
- Strict Content Security Policy with nonce-based script loading
- Sensitive values filtered from persisted state
- Schema validation on all JSON inputs
- File size limits with async batch processing

## [1.5.1] - 2026-03-26

### Added
- Open VSX marketplace support
- Editor-agnostic sign-in flow

## [1.0.0] - 2026-03-20

### Added
- Initial release with sequence, file, and flow diagrams
- Authentication integration
- Live diff detection
- Explorer sidebar tree views
