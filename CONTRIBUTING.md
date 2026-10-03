# Contributing to CodeAtlas

Thanks for considering it. This document covers the legal bit, what is most
useful to work on, and how to build and verify a change.

## License and the CLA

CodeAtlas is [Apache-2.0](LICENSE). Contributions are accepted under that
license, **plus** a Contributor License Agreement.

The CLA Assistant bot will prompt you on your first pull request; signing takes
one click and covers everything you contribute afterwards.

Please read [section 3 of the CLA](.github/CLA.md) before signing. It grants
the project the right to relicense contributions commercially, which is what
makes the reserved surface in [COMMERCIAL.md](COMMERCIAL.md) viable. You keep
the copyright to your work — it is a license, not an assignment — and anything
released under Apache-2.0 stays under Apache-2.0 permanently. If that clause is
not acceptable to you, that is a reasonable position; issues and discussions
need no CLA.

Contributing on company time, or under an employment contract that claims your
output? The [Corporate CLA](.github/CLA-CORPORATE.md) probably applies instead.

## What is most useful

Ranked by how likely a pull request is to merge quickly.

**1. Language and framework support.** The highest-leverage contribution, and
the one with the clearest contract. The graph core does not need to change: you
add detection patterns and fixtures. See *Adding a new framework* below.
[ROADMAP.md](ROADMAP.md) marks this area as community-contributable.

**2. Parser and detector bug fixes.** CodeAtlas parses real codebases and gets
things wrong on real codebases. A failing case with a minimal reproduction is
genuinely valuable even without a fix attached.

**3. The open hardening items.** Issues labelled `security` are known, scoped
tasks the maintainer has already specified — origin checks and a `state` nonce
on the local callback routes, and authentication for non-browser WebSocket
clients. They are well-bounded and make good first contributions.

These are published deliberately rather than fixed quietly before launch. None
is remotely exploitable; each is defence-in-depth, and fixing them in the open
with tests is a more honest record than an empty commit log.

**4. Performance on large repositories.** Profiles and benchmarks on repos
larger than the test corpus.

**Please open an issue first for:** new diagram layers, changes to the graph
data model, anything touching the diff cascade, and anything in
[COMMERCIAL.md](COMMERCIAL.md)'s reserved surface. These have design
constraints that are not obvious from the code, and nobody enjoys a rejected
pull request that took a weekend.

## Development setup

```bash
git clone https://github.com/vamsikk7/codeatlas.git
cd codeatlas
npm install
cd webview-ui && npm install && cd ..
```

Requires Node 18 or 20 (CI tests both).

Note that builds from source have **no telemetry keys compiled in** and
therefore send nothing — those are injected by CI for official releases only.

### Build and test

Extension host (TypeScript → CommonJS via esbuild):

```bash
npm run compile          # one-off bundle → dist/extension.js
npm run watch            # esbuild watch mode
npm run lint             # TypeScript type-check
npm test                 # vitest, Node environment
```

A single test file:

```bash
npx vitest run src/core/parser/__tests__/frameworkDetector.test.ts
```

Webview UI (React + Vite):

```bash
cd webview-ui
npm run build            # production build → webview-ui/dist/
npm run dev              # Vite dev server (standalone preview)
npm test                 # vitest + jsdom + react-testing-library
```

Full package:

```bash
npm run package          # compile extension + build webview
```

### The real-world corpus

Verification runs against real open-source repositories. They are **not**
vendored — `e2e/real-projects/fetch.sh` shallow-clones them on demand from the
public URLs in `repos.json`, into the gitignored `e2e/real-repos/`:

```bash
npm run fetch:real-projects      # clone the corpus (several GB, idempotent)
npm run verify:real              # regression baseline
npm run verify:real:invariants   # layer + integrity invariants
```

## Verification gate

Before opening a pull request:

```bash
npm run lint
npm test
npm run package
npm run test:e2e
```

**Paste the results into the pull request.** "Tests pass" without output is not
something a reviewer can check. `npm run test:e2e` needs a built VSIX and a
browser — if you cannot run it, say so and CI will cover it.

## Architecture

Two build targets communicating through typed `postMessage`:

| Target | Entry | Output | Build tool |
|---|---|---|---|
| Extension host | `src/extension.ts` | `dist/extension.js` | esbuild (CJS, Node 18) |
| Webview UI | `webview-ui/src/main.tsx` | `webview-ui/dist/` | Vite (ESM, React 18) |

The extension host **never** imports from `webview-ui/` and vice versa. All
communication goes through `src/views/webview/messageProtocol.ts`. If you find
yourself wanting to cross that line, the answer is a new message type.

```
src/
  extension.ts              — activation, command registration, message routing
  core/
    parser/                 — Babel (JS/TS) + tree-sitter (multi-language) AST parsing
    graph/                  — diagram builders: sequence, file, flow, feature, microservice
    analysis/               — clustering, service detection, health, impact, coverage
    sync/                   — file watcher → debounced rebuild orchestrator
    storage/                — state persistence with secret redaction + pruning
    navigation/             — source navigation + path validation
    lsp/                    — LSP fallback resolver for complex types
    llm/                    — LLM clients for AI review and semantic naming
    review/                 — PR watcher and clone runner
    export/                 — Markdown + Mermaid exporter
    git/                    — git reader, commit differ, snapshot builder
  views/                    — sidebar tree providers + webview panel manager
  mcp/                      — MCP server (AI assistant integration)
  standalone/               — standalone daemon + CLI
  server/                   — local HTTP + WebSocket bridge
  handlers/                 — message handlers
webview-ui/src/
  App.tsx                   — navigation, message handling, error boundary
  components/               — diagram views, node components, panels
  layout.ts                 — Dagre layout with LRU cache
  diffColors.ts             — shared diff colors, symbols, border styles
  index.css                 — CSS custom properties (dark + light themes)
```

### Design decisions worth knowing before you change things

| Decision | Rationale |
|---|---|
| Babel for JS/TS, tree-sitter for everything else | Babel gives a precise AST for sequence-graph BFS; tree-sitter is universal |
| Louvain clustering | Higher modularity than label propagation; LP kept as fallback |
| 3-channel diff (color + symbol + border) | WCAG 1.4.1 — do not reduce it to color alone |
| File content stored in the state DB | Needed for incremental diff without re-reading disk |
| Dagre layout with a 5-entry LRU cache | Avoids recomputation on an unchanged graph |
| CSP with a crypto nonce, no `unsafe-inline` | Prevents XSS in the webview |
| Secrets redacted before persistence | Connection URIs and keys stripped from stored content |
| Git hashes hex-validated before shell interpolation | Prevents command injection |

The last two are security invariants. If a change appears to require relaxing
one, open an issue instead of working around it.

## Adding a new framework

1. Add patterns to `src/core/parser/frameworkDetector.ts` — see
   `META_FRAMEWORK_PATTERNS` for file-path-based routing.
2. If the framework implies database, cache, or queue connections, add infra
   patterns to `src/core/analysis/serviceDetector.ts`.
3. Write tests in `src/core/parser/__tests__/` — `metaFrameworkDetection.test.ts`
   is a good template.
4. Add a real repository to `e2e/real-projects/repos.json` and record its
   expectations. Detection that works on a fixture but not on a real project is
   the failure mode this corpus exists to catch.
5. Run the verification gate.

## Adding a new diagram layer

Open an issue first — these have cross-cutting design constraints.

1. Create the builder in `src/core/graph/` (`featureGraphBuilder.ts` as template)
2. Add the graph ID convention to `graphTypes.ts` `DiagramType`
3. Add the ViewMode to `src/views/webview/messageProtocol.ts`
4. Create the React component in `webview-ui/src/components/`
5. Add mode routing in `webview-ui/src/components/DiagramView.tsx`
6. Wire into the extension host message handler and commands

## Pull requests

Small and focused merges faster than large and comprehensive. Keep unrelated
refactoring out — if you spot something that needs fixing, a separate pull
request gets both merged sooner.

Commit messages: imperative mood, explain *why* in the body when it is not
obvious. No secrets, personal paths, or private repository names in the diff or
the message — the repository is public and history is permanent.

## Reporting bugs and vulnerabilities

Bugs: [open an issue](https://github.com/vamsikk7/codeatlas/issues) using the
template.

Security vulnerabilities: **do not open a public issue.** See
[SECURITY.md](SECURITY.md) for private reporting.

## Attribution in generated output

CodeAtlas stamps `Powered by CodeAtlas` into exports, the diagram canvas, and
MCP responses. Please leave it in place.

Being straight about it: Apache-2.0 permits you to remove it — only the
`NOTICE` file is binding. It is a request, not a lock. The name and logo are a
separate matter and are covered by [TRADEMARK.md](TRADEMARK.md).

## Conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Short version: make it easy for other
people to keep contributing.
