# CodeAtlas roadmap

**Last updated:** 2026-10-03
**Current release:** extension 9.3.0 (build 158) · `@codeatlas/mcp` 5.3.0

This roadmap exists for two audiences: users deciding whether to depend on
CodeAtlas, and contributors deciding where to spend their time. Every item
carries a licensing tag so the second group never has to guess.

## How to read the tags

| Tag | Meaning |
|---|---|
| **`OSS`** | Ships in this repository under Apache-2.0. |
| **`COMMUNITY`** | `OSS`, and **contributions are actively wanted**. Clear contract, bounded scope, no hidden design constraints. Start here. |
| **`COMMERCIAL`** | Reserved. May be built as a commercially licensed service. See [COMMERCIAL.md](COMMERCIAL.md). |

A `COMMERCIAL` tag does not mean an existing feature is being taken away.
Nothing already released under Apache-2.0 can be withdrawn from it. The tag
marks work that has **not been built** and that, if built, may ship under a
different license.

Estimates are relative sizing, not commitments. This is maintained by one
person plus contributors.

---

## Part 1 — What ships today (9.3.0)

A VS Code / OpenVSX extension plus a localhost browser UI that builds a
six-layer semantic graph of a codebase, updates it live on save, and renders it
as interactive diagrams. Everything runs locally.

| Capability | Surface |
|---|---|
| **6-layer diagrams** | L1 system → L2a feature areas → L2b API list → L3 sequence → L4 file → L5 flow. Cross-file call resolution to 8 hops. |
| **30+ frameworks, 14 languages** | Express, Nest, Next, Nuxt, Remix, SvelteKit, tRPC, GraphQL, gRPC, Django, FastAPI, Flask, Spring, Ktor, Gin, Echo, Chi, Fiber, Laravel, Symfony, Rails, Sinatra, Actix, Axum, Rocket, ASP.NET, Vapor — across JS/TS, Python, Java, Kotlin, Go, Rust, C#, PHP, Ruby, Swift, Dart, C, C++. |
| **Mobile / frontend detection** | Android (Compose, Hilt, Room), iOS (SwiftUI, UIKit), React Native, Flutter, Expo Router, KMP source sets, SDK detection. |
| **Live diff propagation** | Edit → save → cascade through L5 → L4 → L3 → L2b → L2a → L1. Three-channel WCAG-safe encoding (color + symbol + border). |
| **Git diff mode** | Compare any two commits, branches, tags, or a PR across every layer. |
| **Timeline replay** | Commit-by-commit walk through the layers. |
| **AI Review** | LLM review of working changes or a git diff, scoped per route / job / task, findings tagged to the layer they belong to. BYO key. |
| **PR Watcher** | Watches GitHub pull requests, clones the branch, reviews it with full architectural context. |
| **Health dashboard** | Dead code, god files, cyclic dependencies, high coupling, orphan clusters. |
| **Impact analysis** | Blast radius: direct callers, transitive callers, review-required set. |
| **MCP server** | **58 tools** across impact analysis, entrypoints, snapshots, API testing, coverage, AI findings, and architecture queries. Embedded and standalone (`@codeatlas/mcp`). |
| **Agent comments** | Right-click a node → export to `comments.md` with full layer context. |
| **Browser mode** | Full UI at `localhost:7742`, bound to loopback only. |
| **Coverage overlay (read)** | LCOV + Istanbul JSON parsing. |
| **Quality gate** | Real-world repository corpus plus layered invariant assertions, run on every release. |

**Removed in the open-source release:** Ask AI (natural-language query). It
overlapped with the MCP tools, which do the same job better and with a clearer
data-flow story.

---

## Part 2 — Where the gap is

| Category | Established tools | What they leave open |
|---|---|---|
| Code search | Sourcegraph, GitHub Code Search, ripgrep | Text-first. No structural predicate like "every caller of anything in cluster X". |
| Architecture diagrams | Structurizr, C4, Mermaid, CodeSee | Hand-maintained, or limited to a few frameworks. They drift. |
| Static analysis | Sonar, CodeQL, Semgrep, Snyk Code | An issue list with no architectural context. |
| AI code review | CodeRabbit, Greptile, Bito, Cody | Per-file context. Misses architectural ripple. |
| AI coding assistants | Cursor, Windsurf, Copilot, Claude Code, Cline | Read a file at a time. No system model. |
| Service catalogs | Backstage, Cortex, OpsLevel | Manual entry, so permanently stale. |
| Observability | Sentry, Datadog, Honeycomb | Maps incidents to stack frames, not to features. |
| Documentation | Docusaurus, GitBook, Swimm | Hand-authored, drifts from code. |

The pattern: each owns text search, an issue list, or a runtime stream. None
owns the **structural layer** — a live, accurate, multi-level model of how the
system is actually put together. That is the wedge, and it is why the MCP
server matters more than the diagrams: the graph is the asset, and diagrams are
one consumer of it.

---

## Part 3 — Planned work

### Phase 1 — Tighten the existing loop · `OSS`

Compounding value from features already most of the way there. No new
infrastructure.

- **1.1 Coverage overlay, complete** — the LCOV/Istanbul reader is wired; surface
  coverage as a fourth visual channel. Uncovered nodes hatched on every layer,
  hot paths heat-tinted. Turns the view into a testing-priority map.
- **1.2 Public API contract diff** — when a change alters a route signature
  (path, method, params, response shape), say so explicitly rather than marking
  the node "modified".
- **1.3 Export polish** — the exports are the product's most-shared artifact and
  deserve more care than they currently get.

### Phase 2 — Server-side surfaces · `COMMERCIAL`

Moving from an individual tool to a team product. Requires hosting, a GitHub
App, and CI minutes — the first work in this roadmap with a recurring cost
attached, which is why it sits on the commercial side.

- **2.1 Hosted PR review bot** — the same review pipeline as a GitHub App,
  posting inline comments with layer context ("changes a function with 47
  transitive callers across 3 clusters").
- **2.2 Shared team state** — findings, comments, and review status synced
  across a team rather than living in one workspace.

Note that the **local** PR Watcher is already `OSS` and shipping. Phase 2 is
the hosted, multi-user version.

### Phase 2.5 — API playground · `OSS`

CodeAtlas already detects every API with method, path, and handler, parses the
handler body, and traces the L3 call chain. That is most of what a test
generator needs.

- **2.5.1 Playground panel** — opens from any L2b route, lists detected APIs.
- **2.5.2 LLM test generation** — handler body plus call chain plus detected
  schema becomes a runnable request set. BYO key.
- **2.5.3 Chain execution** — multi-step flows with variable extraction.

Partially landed: `run_api_chain`, `generate_test_cases`, `generate_chain`, and
`import_api_collection` already exist as MCP tools. The remaining work is the
editor surface.

### Phase 2.6 — Architectural planning mode · `OSS`

The gap between "I have a feature idea" and "I am ready to write code" is where
most architectural debt is created. Human-driven: the user sketches, the LLM
assists, ADRs fall out as a side effect.

- Target-cluster suggestion for a described feature
- Pre-implementation impact preview
- ADR capture from the planning session

### Phase 2.7 — Per-framework architectural lints · `COMMUNITY`

The health dashboard does structural lints today. This extends it to rules that
are specific to a framework and need the graph to evaluate — "this Django view
performs a query inside a loop across a related manager", "this Express route
lacks the auth middleware every sibling route has".

**This is the single best area for contributors.** Each lint is independent,
testable in isolation, and needs framework knowledge rather than knowledge of
the graph core. If you know one framework deeply, you can write a lint for it
without reading the rest of the codebase.

### Phase 3 — Deeper AI-native integration · `OSS`

- **3.1 MCP expansion** — 58 tools today. Remaining gaps: intent-to-feature
  mapping, file-location proposal for new work, one-shot impact summary for a
  proposed diff.
- **3.2 Agent-facing graph diffs** — let an assistant ask "what did my last
  change do architecturally" and get a structured answer.
- **3.3 Review quality** — better prompts, better scoping, fewer false
  positives. Measured against the benchmark suite, not by intuition.

### Phase 3.5 — Browser-resident architectural agent · `OSS`

An agent inside the localhost UI, BYO LLM, differentiated by the one thing
Cursor and Cline do not have: a live, accurate, multi-layered semantic graph.
Every prompt auto-augmented with the architectural context currently on screen.

Explicitly **not** an attempt to out-build a full agent runtime. It puts the
graph in front of one. Sequenced in three sub-phases so real usage informs the
riskier parts.

### Phase 4 — Multi-repo and org scale · `COMMERCIAL`

The graph schema already supports cross-repo edges; storage and UI do not.

- **4.1 Multi-repo workspace** — N repositories, one unified L1 with cross-repo
  API edges matched via gRPC proto, OpenAPI spec, or REST URL. This is the
  org-chart view Backstage and Cortex ask humans to maintain by hand.
- **4.2 Contract testing** — once cross-repo edges are detected, verify them.
- **4.3 Organisation dashboards** — persistent, shared, access-controlled.

Single-repo analysis stays `OSS` permanently. The reserved part is the hosted,
cross-repo, multi-user service.

### Phase 4.5 — Failure and load simulation · `OSS`

Static simulation by graph traversal — no instrumentation, no running system.
The inverse of diff propagation: follow consumer edges instead of producer
edges.

- Right-click a service, database, or API node → "simulate failure" → every
  downstream entity that breaks is painted: services that start 5xx-ing,
  features that go unavailable, jobs that stall.
- Load-path highlighting for a chosen entrypoint.

Reuses the cascade engine that already powers diff propagation, which makes
this unusually cheap for the value.

### Phase 4.6 — Execution-driven simulation · `OSS`

Between static simulation and production runtime: **local execution** painted
onto the diagrams. Run a test, a test file, or the suite, and watch the path it
actually takes light up. Much higher fidelity than static heuristics, because
it is real code running.

This is what turns the diagrams from a map into something you can drive
against.

### Phase 5 — Live runtime correlation · `COMMERCIAL`

Runtime data painted on the structural graph — errors, p95 latency, throughput,
toggleable per layer.

The mapping is already direct: CodeAtlas indexes every node by
`(filePath, symbol)`, the same shape as Sentry's `culprit`, Datadog's span
name, and OTLP's `code.function`. No new data model needed.

Commercial because it means holding credentials for a customer's observability
stack and operating a correlation service — which is a hosted product, not a
local feature.

### Phase 6 — Compliance and governance · `COMMERCIAL`

Queries against the existing graph, packaged for security, platform, and
data-protection teams.

- **6.1 Data-flow rules** — declare "PII may only flow through `auth/*`" and
  flag violations.
- **6.2 License conformance** — dependencies are already detected; cross-check
  against an allowlist and surface violations on L1.
- **6.3 Audit export** — evidence artifacts for compliance review.

### Phase 7 — Reach · `COMMUNITY`

Broadens distribution without depending on the core roadmap. Parallel-runnable
and opportunistic.

- **7.1 JetBrains plugin** — the graph builder is editor-agnostic; only
  rendering is new. A large, well-bounded contribution for someone who knows
  the IntelliJ platform.
- **7.2 OSS project explorer** — pre-built graphs for popular repositories at
  `codeatlas.live/explore/<repo>`. Zero-install demo.
- **7.3 Chat bots** — `/codeatlas what calls handleAuth?` in Slack or Discord.
- **7.4 More languages** — Elixir, Scala, Haskell, Zig, Lua, and others. The
  clearest contribution contract in the project: add a tree-sitter grammar, a
  detector, fixtures, and a corpus entry.

---

## Part 4 — Sequencing

Phase 1 comes first because it is cheap and compounds. Phase 2.7 and Phase 7.4
run in parallel with everything else — they are additive and touch little
shared code, which is exactly why they are the contributor-facing work.

Phases 4.5 and 4.6 both depend on the cascade engine staying stable. They
should not run concurrently with structural changes to diff propagation.

Phase 5 depends on Phase 4 for the multi-repo data model.

The commercial phases are deliberately placed after the open phases that feed
them. The open core has to be excellent first; a hosted service on a weak local
engine has nothing to sell.

---

## Part 5 — Deliberately not doing

Saying no explicitly, because each of these gets suggested regularly:

- **A general-purpose code search engine.** Sourcegraph and ripgrep exist and
  are good. CodeAtlas adds structural predicates on top of search; it does not
  replace it.
- **A linter for single-file issues.** ESLint, RuboCop, and golangci-lint are
  better at this and always will be. CodeAtlas's lints must need the graph, or
  they do not belong here.
- **Our own LLM.** CodeAtlas is BYO-key and will stay that way. The graph is
  the asset; inference is a commodity.
- **A diagram editor.** The diagrams are generated and stay accurate because
  nobody hand-edits them. Manual editing would reintroduce exactly the drift
  that makes Structurizr and C4 painful.
- **IDE-agnostic LSP server.** Tempting, but the value is in the rendered
  layers, and LSP cannot express them.

---

## Contributing to this roadmap

Items tagged `COMMUNITY` are the ones to pick up — see
[CONTRIBUTING.md](CONTRIBUTING.md).

For anything tagged `OSS`, open an issue before starting: these have design
constraints that are not obvious from reading the code, and a conversation
first saves a rejected pull request later.

For anything tagged `COMMERCIAL`, open a
[discussion](https://github.com/vamsikk7/codeatlas/discussions). Interest in
these shapes what gets built and when, and in some cases is a good argument for
moving an item to `OSS`.
