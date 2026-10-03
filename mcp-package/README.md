# @codeatlas/mcp

> **Live codebase architecture and AI code review for any MCP-compatible LLM client.**
> 57 tools + 8 resources expose routes, sequences, dependency graphs, diffs, impact analysis, architecture violations, full SQL access, and AI-driven review findings over your workspace — so the model gets structured answers instead of grepping through files.

Works with **Claude Code, Cursor, VS Code Copilot, Codex CLI, Gemini CLI, Antigravity, Continue** — anything that speaks the Model Context Protocol.

**New in v3** — **zero-config install**. `npm install --save-dev @codeatlas/mcp` inside your repo writes the MCP server entry into every detected client (Claude Desktop, Cursor, Claude Code, Codex, Gemini, VS Code Copilot Chat, Continue) AND starts a per-OS daemon (launchd / systemd / Task Scheduler) so the browser surface + the MCP index stay live as you edit. No manual JSON editing, no `npx` chaining, no daemon-mgmt — one command and it's running.

**Also in v2** — AI code review tools: run a review with `run_review`, list findings with `list_ai_findings`, ask "what's wrong with auth?" with `search_ai_findings`, then ask for a one-shot context bundle to fix the issue with `review_and_fix_pack`. Findings are grounded in source quotes the model has to copy verbatim — no invented issues.

---

## Why it matters: token economics

Measured against a mid-sized test project, every query returns **5×–200× fewer tokens** than the equivalent file-walking approach:

All numbers below are **measured live** against the [Node Express RealWorld example app](https://github.com/gothinkster/node-express-realworld-example-app) — 33 TypeScript files, 27 HTTP routes, ~14,144 tokens of source (the "full file-walk" baseline).

| Query | Tool call | Tokens | Reduction |
|---|---|---:|---:|
| "What's in this codebase?" | `get_workspace_status` | **68** | ~208× |
| "Show me everything related to login" | `search_workspace({query:'login'})` | **272** | ~52× |
| "If I change `getCurrentUser`, what breaks?" | `get_impact_of_change` | **367** | ~38× |
| "Walk me through this codebase, 5 steps" | `get_tour({mode:'codebase', maxSteps:5})` | **731** | ~19× |
| "What does `POST /api/articles` do?" (with handler source) | `get_entrypoint_pack` | **1,181** | ~12× |
| "Show me the article module" | `get_feature_pack({clusterId:'cluster:article'})` | **1,690** | ~8× |
| "List every endpoint" (27 of them) | `list_entrypoints` | **2,759** | ~5× |
| "Find architectural violations" (9 issues in 6 rules) | `list_architecture_violations` | **817** | ~17× |
| Diff summary | `get_diff_summary` | **28** | >500× vs raw git output |

Ratios scale with codebase size — on a 100k-LOC monorepo the absolute savings are dramatic. The **5–200× claim is verified in production**.

A 2.7B-class model with a 16K context window can answer *"what handles this route?"* or *"what breaks if I change X?"* on a 1k-file codebase using **one MCP call instead of dozens of file reads.** The retrieval problem moves from the LLM to the framework.

---

## Quick start — one command

Install **inside your repo** (not globally — see below for why):

```bash
cd /path/to/your/repo
npm install --save-dev @codeatlas/mcp
```

That's it. The postinstall hook auto-wires every MCP client it finds on your machine and starts a per-workspace daemon. Within seconds:

- 🟢 **MCP server is live** — Claude Code / Cursor / Codex CLI / Gemini CLI / Copilot Chat / Continue / Claude Desktop all get a `codeatlas` server entry pointing at your repo.
- 🟢 **Browser surface is up** at **http://localhost:7742** — interactive system-design / sequence / file / flow diagrams of your code, updated live as you edit.
- 🟢 **Daemon keeps the index fresh** — a background process (per-OS: launchd / systemd / Task Scheduler) watches your files and rebuilds the relevant graphs on save. No stale answers when the LLM queries you.

Restart whichever MCP clients you use — they'll pick up the new server entry on next session.

### Why local-install only?

Each install is bound to ONE workspace. Global installs (`npm i -g`) are blocked because the configured MCP server, the daemon, and the browser URL all point at a specific path. Installing inside your repo makes that path implicit + auto-discoverable. Re-run `npm install` inside another repo to set up that one too — they coexist (different ports, different daemons).

### What "one command" buys you

| Step | Before (manual) | Now (auto) |
|---|---|---|
| Add MCP server entry | Edit 1–6 JSON files by hand per CLI | Postinstall writes them all, atomic + backed up |
| Find a free port | Pick one, hope it's unused | Auto-allocates 7742+, walks up |
| Start the server | `npx @codeatlas/mcp <path>` every time | Daemon starts immediately + on every login |
| Keep the index fresh | Re-run on every edit | File watcher inside the daemon |
| Verify it worked | Manual file inspection | `codeatlas-mcp doctor` |

## Supported MCP clients

| Client | Auto-wired? | Notes |
|---|:---:|---|
| **Claude Desktop** | ✅ | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\` (Windows) / `~/.config/Claude/` (Linux) |
| **Cursor** | ✅ | `~/.cursor/mcp.json` |
| **Claude Code CLI** | ✅ | `~/.claude/settings.json` |
| **VS Code Copilot Chat** | ✅ | User settings: `github.copilot.chat.mcpServers` |
| **Continue** | ✅ | `~/.continue/config.json` |
| **Gemini CLI** | ✅ | `~/.gemini/settings.json` |
| **Codex CLI** | ⚠️ best-effort | We write `~/.codex/config.json`. Some Codex versions use `~/.codex/config.toml` instead — if your session doesn't pick it up, manually add the equivalent TOML block (see "Manual setup" below). |
| **Antigravity** | ❌ not yet | Use `--client-config <path>` (see below) to point at its config file. |
| **Anything else** | ❌ not yet | Same — `--client-config <path>` works for any MCP-shaped JSON. |

## After install

```bash
# See what got configured, daemon status, telemetry state:
npx codeatlas-mcp doctor

# Re-run wiring (e.g. after upgrading or moving the repo):
npx codeatlas-mcp setup

# Remove the daemon for this workspace (configs left alone):
npx codeatlas-mcp teardown

# Review a pull request from CI and post the findings to GitHub
# (run on pull_request events — inline comments on changed lines plus
#  an updated-in-place summary; drop --post for a dry-run JSON print):
npx codeatlas-mcp review-pr . --base <base-sha> --head <head-sha> \
  --repo owner/name --pr 123 --post

# Help:
npx codeatlas-mcp --help
```

## Cross-platform support

| OS | Daemon mechanism | Auto-start on login |
|---|---|:---:|
| macOS | LaunchAgent (`~/Library/LaunchAgents/com.codeatlas.<id>.plist`) loaded via `launchctl bootstrap gui/<uid>` | ✅ |
| Linux | systemd user unit (`~/.config/systemd/user/<id>.service`) enabled via `systemctl --user enable --now` | ✅ (where systemd-user runs — most modern distros, not all WSL setups) |
| Windows | Scheduled Task (ONLOGON trigger) registered via `schtasks` | ✅ |

Daemon logs land in `~/.config/codeatlas/logs/<id>.log` (stdout) and `.err.log` (stderr).

## Manual setup (no auto-config)

If the postinstall hook was suppressed (`npm install --ignore-scripts`, `CI=1`, or `CODEATLAS_NO_POSTINSTALL=1`), or your MCP client lives in a non-standard location, configure manually:

### Generic `mcpServers` JSON (Cursor, Claude Code, Codex JSON variant, Gemini, Continue, Claude Desktop)
```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["@codeatlas/mcp", "/absolute/path/to/your/repo"]
    }
  }
}
```

### VS Code Copilot Chat — user `settings.json`
```jsonc
{
  "github.copilot.chat.mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["@codeatlas/mcp", "/absolute/path/to/your/repo"]
    }
  }
}
```

### Codex CLI (TOML variant) — `~/.codex/config.toml`
```toml
[mcp_servers.codeatlas]
command = "npx"
args = ["@codeatlas/mcp", "/absolute/path/to/your/repo"]
```

### Custom config path (any tool we don't detect natively)
```bash
npx codeatlas-mcp setup --client-config /path/to/your/tools/mcp-config.json
```
This writes the standard `mcpServers.codeatlas` block into the file you point at, atomically and backed up.

After registering, restart your client. The 57 tools + 8 resources appear alongside its built-ins.

---

## What it exposes

### Tools

Per-tool examples below. Each entry: **purpose** → JSON-RPC args → _when to call_. (Issue #726.)

#### Quick-start prompt template

When an agent is asked "what changes if I edit this file?" the
canonical three-tool chain is:

1. `get_diff_summary {}` — what's already changed since baseline?
2. `get_impact_of_change { filePath: "src/auth/login.ts" }` — which other files / clusters / entry points are affected?
3. `pre_edit_brief { filePath: "src/auth/login.ts", symbolName: "loginHandler" }` — load the surrounding context the agent needs to make the edit safely.

The "what does this codebase do?" chain is:

1. `get_workspace_status {}` — counts + initialisation state.
2. `get_feature_pack { clusterId: "cluster:auth" }` — top-level overview of one cluster (its routes, files, entry points).
3. `get_tour { mode: "codebase", maxSteps: 10 }` — guided walkthrough of the codebase's most load-bearing entry points.

---

#### Context packs — minimum-token retrieval

##### `list_entrypoints`
Inventory of every entry point — HTTP routes, screens, jobs, MQ consumers, CLI commands.
```json
{ "name": "list_entrypoints", "arguments": {} }
```
_When to call: at the start of any session before drilling into a specific area._

##### `list_entrypoints_paged`
Paginated variant for large workspaces.
```json
{ "name": "list_entrypoints_paged", "arguments": { "method": "GET", "limit": 20, "cursor": null } }
```
_When to call: workspaces with > 200 entry points; tokens are tight._

##### `get_entrypoint_pack`
Full handler context for one entry point — source, callers, callees, diff state.
```json
{ "name": "get_entrypoint_pack", "arguments": { "apiId": "POST:/api/articles::src/routes/article.ts::createArticle" } }
```
_When to call: about to answer a question about one specific route._

##### `get_feature_pack`
Cluster-level overview: routes + files + entry points + cohesion metric.
```json
{ "name": "get_feature_pack", "arguments": { "clusterId": "cluster:auth" } }
```
_When to call: "what does the auth cluster do?" or any cluster-scoped question._

##### `pre_edit_brief`
One-shot context briefing before editing — function source, entry points that reach it, sibling functions, imports, current diff state.
```json
{ "name": "pre_edit_brief", "arguments": { "filePath": "src/routes/article.ts", "symbolName": "createArticle" } }
```
_When to call: replaces 4–5 separate `get_function_source` + `get_function_dependencies` calls._

##### `get_function_source`
Full source of one function with surrounding ±5 lines.
```json
{ "name": "get_function_source", "arguments": { "filePath": "src/routes/article.ts", "symbolName": "createArticle" } }
```
_When to call: need to inspect the exact body but not the full pack._

##### `trace_call_path`
BFS the workspace call graph for the shortest path between two functions.
```json
{ "name": "trace_call_path", "arguments": { "fromFile": "src/routes/article.ts", "fromFn": "createArticle", "toFile": "src/db/prisma.ts", "toFn": "user.create", "maxDepth": 8 } }
```
_When to call: "how does GET /articles reach the database?" in one call instead of N drill-downs._

---

#### Diff & impact — what changed, what breaks

##### `get_diff_summary`
High-level diff between baseline and working snapshots.
```json
{ "name": "get_diff_summary", "arguments": {} }
```
_When to call: first call after the agent connects — knows what's in flight._

##### `get_api_surface_diff`
Contract-level diff: routes added, removed, or with changed auth/middleware.
```json
{ "name": "get_api_surface_diff", "arguments": {} }
```
_When to call: PR / release notes._

##### `get_impact_of_change`
Blast radius — which clusters + entry points are affected by editing one file.
```json
{ "name": "get_impact_of_change", "arguments": { "filePath": "src/middleware/auth.ts" } }
```
_When to call: about to edit a shared module; want to know what to retest._

##### `get_impact_analysis`
Reverse blast radius — given a function key, find every caller across the workspace.
```json
{ "name": "get_impact_analysis", "arguments": { "filePath": "src/middleware/auth.ts", "symbolName": "requireAuth", "maxDepth": 4 } }
```
_When to call: deeper than `get_impact_of_change`; you want depth-grouped output._

##### `get_function_dependencies`
Direct callers + callees of one function, no transitive reach.
```json
{ "name": "get_function_dependencies", "arguments": { "filePath": "src/db/prisma.ts", "symbolName": "user.create" } }
```
_When to call: one-step neighbour query when transitive reach would be too noisy._

---

#### Search & query

##### `search_workspace`
Weighted reverse index over names + bodies.
```json
{ "name": "search_workspace", "arguments": { "query": "rate limit", "limit": 10 } }
```
_When to call: "find me code about <topic>" — first call before targeted drill-down._

##### `query_snapshot`
Read-only SQL over the snapshot store. Joins routes, clusters, services, findings.
```json
{ "name": "query_snapshot", "arguments": { "sql": "SELECT method, route, file_path FROM apis WHERE method = 'POST' LIMIT 10", "limit": 10 } }
```
_When to call: precise structured query the other tools can't compose._

##### `describe_snapshot_schema`
Returns the sqlite table schema so `query_snapshot` can be written correctly.
```json
{ "name": "describe_snapshot_schema", "arguments": {} }
```
_When to call: paired with `query_snapshot` — read the schema once per session._

---

#### Health & rules

##### `get_health_report`
Dead code, god files, coupling, cycles, orphaned clusters.
```json
{ "name": "get_health_report", "arguments": {} }
```
_When to call: code-quality review of the workspace._

##### `list_architecture_violations`
Architecture-rule violations (e.g., layering violations, forbidden imports) configured in `.codeatlas/rules.json`.
```json
{ "name": "list_architecture_violations", "arguments": {} }
```
_When to call: code review against project-specific rules._

##### `get_coverage_overlay`
Per-file test coverage stitched into the call graph.
```json
{ "name": "get_coverage_overlay", "arguments": {} }
```
_When to call: workspace has loaded LCOV/Istanbul coverage and you want to bias the agent toward untested paths._

---

#### Workspace

##### `get_workspace_status`
Counts (files / APIs / clusters / services), initialisation state, LLM provider config.
```json
{ "name": "get_workspace_status", "arguments": {} }
```
_When to call: first call ever — confirms the workspace is initialised._

##### `find_similar_entities`
Structural similarity: name + co-occurrence.
```json
{ "name": "find_similar_entities", "arguments": { "filePath": "src/routes/article.ts", "symbolName": "createArticle", "limit": 5 } }
```
_When to call: "show me functions like this one"; structural-only (semantic search lands later via #709)._

##### `list_saved_views`
Saved diagram views (the user persists "look at cluster:auth" or similar).
```json
{ "name": "list_saved_views", "arguments": {} }
```
_When to call: resume work the user had pinned in a previous session._

##### `compare_workspaces`
Diff two workspace snapshots (e.g. two branches).
```json
{ "name": "compare_workspaces", "arguments": { "leftWorkspace": "/path/to/branch-a", "rightWorkspace": "/path/to/branch-b" } }
```
_When to call: comparing branches outside the standard baseline-vs-working flow._

##### `get_tour`
Guided onboarding tour (Issue #702): codebase walkthrough by fan-in DESC, or recent-changes walkthrough.
```json
{ "name": "get_tour", "arguments": { "mode": "codebase", "maxSteps": 30 } }
```
_When to call: "I'm new to this codebase — where should I start reading?"._

---

#### Interop

##### `export_openapi_spec`
Generate an OpenAPI 3.0 spec from the detected HTTP routes.
```json
{ "name": "export_openapi_spec", "arguments": {} }
```
_When to call: agent integrating with downstream API clients._

##### `export_function_calling_spec`
Generate a function-calling JSON schema (OpenAI / Anthropic format) from selected functions.
```json
{ "name": "export_function_calling_spec", "arguments": { "filterByCluster": "cluster:auth" } }
```
_When to call: building a function-calling agent that needs typed schemas for one cluster's APIs._

##### `summarise_payload`
Compress an oversized tool response into a token-budgeted summary.
```json
{ "name": "summarise_payload", "arguments": { "payload": "...", "maxTokens": 800 } }
```
_When to call: previous tool returned ≥ 4 KB and you need a tighter recap._

---

#### AI Code Review

##### `list_ai_findings`
Filter findings by severity / category / status / cluster.
```json
{ "name": "list_ai_findings", "arguments": { "severity": "error", "status": "open", "limit": 20 } }
```
_When to call: "show me the high-severity findings I haven't fixed yet."_

##### `get_ai_finding`
One specific finding by id.
```json
{ "name": "get_ai_finding", "arguments": { "findingId": "<finding-uuid>" } }
```
_When to call: drilling into a specific row returned from `list_ai_findings`._

##### `get_ai_finding_counts`
Per-cluster / per-severity counts.
```json
{ "name": "get_ai_finding_counts", "arguments": {} }
```
_When to call: dashboard view; want the chip counts without the full list._

##### `update_ai_finding_status`
Mark a finding resolved / ignored / open / stale.
```json
{ "name": "update_ai_finding_status", "arguments": { "findingId": "<uuid>", "status": "resolved" } }
```
_When to call: agent or user is closing the loop on a finding._

##### `get_review_guidelines`
The current user-supplied review guidelines text.
```json
{ "name": "get_review_guidelines", "arguments": {} }
```
_When to call: agent wants to apply the same rubric the user wrote._

##### `set_review_guidelines`
Replace the review guidelines.
```json
{ "name": "set_review_guidelines", "arguments": { "text": "Always require input validation on POST routes." } }
```
_When to call: user is configuring review intent through the agent._

##### `search_ai_findings`
Full-text search across finding titles + bodies.
```json
{ "name": "search_ai_findings", "arguments": { "query": "rate limit", "limit": 10 } }
```
_When to call: "any findings about <topic>?"_

##### `summarise_findings`
Aggregate the open findings into a short narrative.
```json
{ "name": "summarise_findings", "arguments": { "severity": ["error", "warning"] } }
```
_When to call: weekly review or release-notes preparation._

##### `list_findings_by_guideline`
Group findings by which guideline they cite.
```json
{ "name": "list_findings_by_guideline", "arguments": {} }
```
_When to call: "which guidelines are most violated?"_

##### `get_review_summary`
Counts + the last-run timestamp for the most recent review.
```json
{ "name": "get_review_summary", "arguments": {} }
```
_When to call: status check after a review just completed._

##### `clear_findings`
Wipe the findings store. Irreversible.
```json
{ "name": "clear_findings", "arguments": { "scope": "all" } }
```
_When to call: rare — the user confirmed they want a fresh review state._

##### `review_and_fix_pack`
For one finding, returns the surrounding source + the finding context so the agent can propose a fix.
```json
{ "name": "review_and_fix_pack", "arguments": { "findingId": "<uuid>" } }
```
_When to call: agent is about to write a fix; needs the full context block._

##### `score_findings`
Compute a heuristic priority score per finding.
```json
{ "name": "score_findings", "arguments": {} }
```
_When to call: "which should I fix first?"_

##### `propose_guideline_from_finding`
Generalise one finding into a workspace-wide rule the user can save as a guideline.
```json
{ "name": "propose_guideline_from_finding", "arguments": { "findingId": "<uuid>" } }
```
_When to call: pattern-detection moment — same kind of bug shows up repeatedly._

##### `review_diff_with_baseline`
Run AI review against the working-vs-baseline diff only.
```json
{ "name": "review_diff_with_baseline", "arguments": {} }
```
_When to call: PR-style review — focus on what changed, skip the rest._

### 8 resources

| URI | Contents |
|-----|----------|
| `codeatlas://workspace/microservices` | All detected services — name, technology, API count, inter-service connections |
| `codeatlas://workspace/apis` | All REST / GraphQL / gRPC / WS / SSE / job / CLI entry points — method, route, handler, file path |
| `codeatlas://workspace/features` | Feature clusters — label, file membership, cohesion, API count |
| `codeatlas://workspace/entrypoints` | Every entry point flattened across all categories |
| `codeatlas://workspace/diff-summary` | Baseline-vs-working summary across all 6 diagram layers |
| `codeatlas://workspace/ai-findings` | All AI-review findings — severity, layer bindings, source quotes |
| `codeatlas://workspace/review-guidelines` | Team review rules currently injected into every review prompt |
| `codeatlas://workspace/review-summary` | Counts by layer + severity, top findings, last review metadata |

### Push notifications

Stdio clients that subscribe get `notifications/codeatlas/findings_changed` when findings are added, updated, or removed — no polling needed.

---

## Self-init: no VS Code required

The first time you point it at a workspace, the MCP server indexes the code and starts watching for changes. The AI gets working answers within seconds.

Both this server and the VS Code extension can run on the same repo at the same time — they keep their own state, so they don't conflict. Add `.codeatlas-sa/` to `.gitignore` (the index lives there).

---

## Browser diagrams (`--browser`)

Add `--browser` to view the architecture in a browser tab alongside the AI conversation:

```bash
npx @codeatlas/mcp /path/to/repo --browser
```

A tab opens at `http://localhost:7742` showing six linked diagram layers: system design, feature clusters, API list, sequences, file dependencies, and function flow. File edits propagate to the browser in real time. Click any node to open the file in your editor.

| Flag | Effect |
|------|--------|
| `--browser` | Start the diagram view alongside the AI server |
| `--port <N>` | Use a specific port (default 7742) |
| `--no-open` | Don't auto-open the browser; just print the URL |

Set `CODEATLAS_EDITOR=<cmd>` to pick the editor (defaults to `$EDITOR`, then `code`, `cursor`, `subl`, `nvim`, `vim`).

### Run a Code Review from the browser

The home page has a **Code Review** card that fans the review out across every entry point. **Changed only** restricts it to entry points whose code differs from baseline. **Specific review** opens a textarea so you can tell the AI exactly what to focus on. **Cancel** stops the in-flight LLM call immediately; **Clear** wipes findings and resets state.

When findings exist, the **Findings popover** opens with a top-down summary: an "Interpretation" line that names the dominant pattern across all findings (auth gaps, validation risks, secret leakage, N+1 queries…), per-layer breakdowns that name the actual clusters / routes / files affected, and a "Top concerns (focus here first)" shortlist. Every finding row carries **Resolve / Ignore / Comment / Copy** buttons. A "Copy ▾" dropdown copies all findings — or just errors / warnings / info — as Markdown ready to paste into a PR or ticket.

Each finding is tagged to the layer and entity it belongs to (System Design, Feature Areas, API List, Sequence, File, or Function Flow) — click a finding in the popover to jump straight to that spot. State changes propagate to every open tab immediately.

Each finding is tagged with the commit SHA it was reviewed against (or a content-hash for non-git workspaces). Re-running with the same code + guidelines surfaces a **"Nothing changed since last review"** badge instead of burning another LLM call.

### Connect an LLM

Code Review and natural-language search use any OpenAI-compatible provider. Pick one:

| Provider | Env var | `provider` setting |
|----------|---------|--------------------|
| OpenRouter (default) | `OPENROUTER_API_KEY` | `openrouter` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| Ollama (local — no key) | — | `ollama` |
| Custom endpoint | `LLM_API_KEY` (optional) | `custom` |

Change provider + model from the browser (LLM settings panel) or write to `<workspace>/.codeatlas-sa/config.json`:
```json
{
  "codeatlas.llmProvider": "anthropic",
  "codeatlas.llmModel": "claude-3-5-sonnet-latest"
}
```

### Compare commits, branches, and pull requests

From the diagram view in your browser:

- **Compare Commits** — pick base + head from a list of recent commits.
- **Compare Branch** — pick a branch; the diff shows what that branch added relative to your current `HEAD`.
- **Compare PR** — pick a pull request from the connected GitHub repo. Public repos work without a token (60 requests/hour limit). For private repos or higher rate limits, set `GITHUB_TOKEN` (or `GH_TOKEN`) with at least `repo` scope.

### Pairing with your AI assistant

The AI doesn't open the browser — you do. Register the server with `--browser` and the AI can cite URLs you click to jump straight to a specific diagram.

**Claude Code:**
```bash
claude mcp add codeatlas -- npx -y @codeatlas/mcp $(pwd) --browser
```

**Cursor / VS Code / Codex / Gemini** — add `--browser` to the args:
```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "@codeatlas/mcp", "/absolute/path/to/repo", "--browser"]
    }
  }
}
```

The AI can link directly to any layer:

| URL | View |
|------|------|
| `http://localhost:7742/` | System design |
| `http://localhost:7742/#/features/service:main` | Feature clusters |
| `http://localhost:7742/#/apis/cluster:auth` | APIs in a cluster |
| `http://localhost:7742/#/sequence/<file>:<handler>` | Sequence for a route |
| `http://localhost:7742/#/file/<path>` | File diagram |
| `http://localhost:7742/#/flow/<path>/<fn>` | Function flow |

### If port 7742 is already in use

The server tries 7742 first and walks up (7743, 7744, …) up to four times if those are busy. The actual port appears in the startup log:

```
CodeAtlas browser ready: http://localhost:7743
```

To pick a specific port, pass `--port`:

```bash
npx @codeatlas/mcp /path/to/repo --browser --port 8080
```

### Restarting the server

The standalone is a single process. To restart:

- **Launched in a terminal:** press `Ctrl+C`, then re-run the command.
- **Launched by an AI client** (Claude Code, Cursor, etc.): use the client's "reload MCP servers" action, or quit and reopen the client.

After restart the browser reconnects automatically — just refresh the tab.

---

## Workspace languages & frameworks

Only the host machine needs **Node.js ≥18**. The indexed workspace can be in any of these:

**14 languages:** JavaScript, TypeScript, Python, Java, Kotlin, Go, Rust, C, C++, C#, PHP, Ruby, Swift, Dart

| Category | Frameworks |
|----------|-----------|
| **Node.js** | Express, Koa, Fastify, NestJS, Hono |
| **Meta-frameworks** | Next.js (App + Pages), Nuxt, Remix, SvelteKit |
| **API protocols** | tRPC, GraphQL, gRPC |
| **Python** | Django, FastAPI, Flask, Starlette, DRF |
| **Java/Kotlin** | Spring Boot, Micronaut, JAX-RS, Ktor |
| **Go** | Gin, Echo, Chi, Fiber |
| **PHP** | Laravel, Symfony |
| **Ruby** | Rails, Sinatra |
| **Rust** | Actix, Axum, Rocket |
| **C#** | ASP.NET Core, Minimal API |
| **Swift** | Vapor |
| **Mobile** | Android (Jetpack Compose, Hilt, Room), iOS (SwiftUI, UIKit, Combine), React Native, Flutter/Dart, Expo Router |

Plus **non-API entry points**: background jobs, message-queue consumers, CLI commands, ORM lifecycle hooks, DB migrations/seeds, socket events, GraphQL subscriptions, health endpoints, mobile push handlers, deep links, widgets, content providers, and lifecycle hooks.

**Infrastructure auto-detected:** PostgreSQL, MySQL, MongoDB, Redis, RabbitMQ, Kafka, Celery, Sidekiq, Entity Framework, Eloquent, Room, CoreData, Realm, Firebase, Prisma, Sequelize, and more.

---

## Any-workspace wrapper (optional)

If you want one config that works in any project, drop a tiny shim onto your `$PATH`:

```bash
#!/usr/bin/env bash
# /usr/local/bin/codeatlas-mcp
exec npx -y @codeatlas/mcp "$PWD"
```

Then your client configs become `command: codeatlas-mcp` with no args — workspace is wherever you launched the client.

---

## Running alongside the VS Code extension

When both the [CodeAtlas VS Code extension](https://marketplace.visualstudio.com/items?itemName=codeatlaslive.codeatlas-live) or [VSCodium](https://open-vsx.org/extension/codeatlaslive/codeatlas-live) and an MCP server target the same workspace, **MCP wins write ownership**. The extension watches for `.codeatlas/.mcp-preempt`, yields its lock when an MCP process requests it, disables auto-update for the session, and surfaces a recovery toast. Close + reopen the workspace once the MCP process exits to reclaim writes. No silent races on `state.db`.

---

## Troubleshooting

### "My MCP client doesn't see CodeAtlas after install"

1. **Run `npx codeatlas-mcp doctor`.** It prints every detected client + whether the `codeatlas` entry is present in each config file + the daemon status. If a client is listed but "NOT present", postinstall didn't reach that config — re-run `npx codeatlas-mcp setup`.
2. **Restart the client.** MCP servers are loaded at session start, not hot-reloaded. Quit the client app fully (right-click → Quit on macOS) and reopen.
3. **Check the daemon.** `doctor` shows `Daemon status: running | stopped | not-installed`. If stopped, the daemon's logs are at `~/.config/codeatlas/logs/<id>.err.log`.

### "No telemetry events showing up in my dashboard"

This is intentional opt-out — telemetry IS enabled by default unless you set `CODEATLAS_TELEMETRY=0` or `DO_NOT_TRACK=1`. To verify events are firing:
```bash
CODEATLAS_TELEMETRY_DEBUG=1 npx codeatlas-mcp <workspace>
# Every send attempt + Mixpanel HTTP response logs to stderr.
```

### "Postinstall didn't run / daemon didn't start"

Common causes + fixes:
- `npm install --ignore-scripts` was used → postinstall was suppressed. Run `npx codeatlas-mcp setup` manually after install.
- `CI=1` env var set → postinstall is auto-suppressed in CI to avoid surprise daemons. Run setup manually if you actually want it.
- `CODEATLAS_NO_POSTINSTALL=1` → suppression env we honor. Unset it + re-install.
- Global install attempt (`npm i -g`) → blocked by design. Re-install locally inside your repo.

### "I want to remove CodeAtlas from this repo"

```bash
npx codeatlas-mcp teardown   # stops + uninstalls the daemon
npm uninstall @codeatlas/mcp # removes the binary
```
The MCP client configs aren't touched by teardown — open each client's config file and remove the `codeatlas` entry manually (look under `mcpServers`).

### "Port 7742 is already taken by another tool"

The installer auto-walks 7742 → 7842 looking for a free port; the chosen port is reported in the postinstall banner and persisted in `~/.config/codeatlas/setup-marker.json`. If you want a specific port, run `codeatlas-mcp <workspace> --browser --port <N>` directly.

### "I want to keep using my own MCP client config — don't auto-write"

Two options:
- `CODEATLAS_NO_POSTINSTALL=1 npm install --save-dev @codeatlas/mcp` — install the binary without the auto-config.
- After install, `npx codeatlas-mcp teardown` removes the daemon; then delete the `codeatlas` entry from each client's config manually. The binary stays on disk for manual invocation.

---

## Privacy & security

- **Your code stays local.** All indexing and queries run on your machine; no source is uploaded.
- **Anonymous usage telemetry, opt-out.** The binary reports adoption + usage events (server boot, version installed / upgraded, per-tool-call name + duration, errors, session length) to Mixpanel (US region) so we can see which tools are useful and where they slow down. Events are keyed by a SHA-256 of `hostname` + `username` + Node version — no source code, no file paths, no commit metadata, no usernames. **Disable with `CODEATLAS_TELEMETRY=0`** (also honours the industry-standard `DO_NOT_TRACK=1`). For diagnostics, set `CODEATLAS_TELEMETRY_DEBUG=1` to see every event posted on stderr. The event catalogue is documented in `src/mcp/analytics/mcpAnalytics.ts` in the source repo.
- **Sensitive data scrubbed.** Passwords, tokens, and connection strings are redacted before being written to `.codeatlas/state.db`.
- **Path-traversal-safe.** Every file lookup is validated against the workspace boundary.
- **Read-only SQL.** `query_snapshot` enforces SELECT-only access — no mutations, no shell-out.

---

## Links

- **Issues / feature requests:** https://github.com/vamsikk7/codeatlas-live-issues/issues
- **Website:** https://codeatlas.live
- **Marketplace:** https://openvsx.org/extension/codeatlaslive/codeatlas-live
- **Docs:** https://www.codeatlas.live/docs/mcp/tools
---

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
