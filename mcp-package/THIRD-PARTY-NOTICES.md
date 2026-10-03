# Third-party notices

CodeAtlas redistributes the components listed below. Each remains under its own
license, held by its own copyright holders. Nothing in this file alters those
licenses; it satisfies the attribution they require.

Last reviewed: 2026-10-03, against extension 9.3.0.

## Runtime dependencies

Bundled into the published VSIX and the `@codeatlas/mcp` npm package.

| Component | Version | License |
|---|---|---|
| `@babel/parser` | 7.29.0 | MIT |
| `@babel/traverse` | 7.29.0 | MIT |
| `@babel/types` | 7.29.0 | MIT |
| `@modelcontextprotocol/sdk` | 1.27.1 | MIT |
| `@sentry/node` | 10.56.0 | MIT |
| `@types/ws` | 8.18.1 | MIT |
| `chokidar` | 5.0.0 | MIT |
| `js-yaml` | 4.1.1 | MIT |
| `minimatch` | 10.2.2 | BlueOak-1.0.0 |
| `sql.js` | 1.14.1 | MIT |
| `tree-sitter-wasms` | 0.1.13 | Unlicense (see below) |
| `web-tree-sitter` | 0.22.6 | MIT |
| `ws` | 8.20.0 | MIT |
| `zod` | 4.4.3 | MIT |

All are permissive and compatible with Apache-2.0 redistribution. No copyleft
licenses are present in the runtime tree. BlueOak-1.0.0 is an OSI-approved
permissive license requiring notice preservation, which this file provides.

Full license texts are available in each package's directory under
`node_modules/` after `npm install`, and at each project's repository.

## Tree-sitter grammar binaries

`grammars/` contains 14 precompiled WebAssembly parsers:

```
tree-sitter-c.wasm        tree-sitter-cpp.wasm       tree-sitter-c_sharp.wasm
tree-sitter-dart.wasm     tree-sitter-go.wasm        tree-sitter-java.wasm
tree-sitter-javascript.wasm  tree-sitter-kotlin.wasm tree-sitter-php.wasm
tree-sitter-python.wasm   tree-sitter-ruby.wasm      tree-sitter-rust.wasm
tree-sitter-swift.wasm    tree-sitter-typescript.wasm
```

These are copied from the [`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms)
npm package by `scripts/copy-grammars.js` during `postinstall`.

### An open attribution item — stated plainly

`tree-sitter-wasms` releases **its own packaging** under the Unlicense (public
domain dedication). That dedication covers the build tooling. It does **not**
relicense the upstream grammars the binaries were compiled from — each
`tree-sitter-<language>` grammar is a separate project with its own copyright
holders and its own license (predominantly MIT, with some under Apache-2.0).

The `tree-sitter-wasms` package ships no per-grammar license files and no
upstream attribution, so that information does not flow through to this
repository automatically.

**Status: this attribution is incomplete.** Resolving it requires identifying
the exact upstream source and license of each of the 14 grammars and listing
them individually here. That work is tracked as a launch follow-up. It is
recorded here rather than omitted, because quietly shipping an incomplete
third-party notice is worse than an acknowledged gap — and because anyone doing
license diligence on this repository deserves to know where the edges are.

If you maintain one of these grammars and your attribution is missing or wrong,
please open an issue; it will be corrected promptly.

## Development dependencies

Build and test tooling (TypeScript, esbuild, Vite, React, Vitest, Playwright,
ESLint and their transitive dependencies) is not redistributed in any published
artifact and is therefore not listed here. The complete set with resolved
licenses is in `package-lock.json`, `webview-ui/package-lock.json`, and
`mcp-package/package.json`.

## Reporting an error

Attribution mistakes are corrected without argument. Open an issue at
https://github.com/vamsikk7/codeatlas/issues, or use the private channel in
[SECURITY.md](SECURITY.md) if you would rather not do so publicly.
