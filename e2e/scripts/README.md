# `e2e/scripts/` — verification driver registry

Per Issue #727: every verification driver script lives here, in the
repo, so a fresh clone has them on disk + a fresh session doesn't
re-derive them from `/tmp`.

Run any of them via the `npm run verify:*` aliases declared in the
root `package.json`.

| File | npm alias | Skill that consumes it | Purpose |
|---|---|---|---|
| `mcp-smoke.js` | `npm run verify:mcp-smoke` | `comprehensive-verify` (fallback when deep probe is missing), `mcp-live-verify` | Quick smoke: spawn `mcp-package/dist/mcp-server.js <repo>`, init via MCP `initialize` request, fetch `tools/list`, assert count > 0, exit clean. ~5 s. |
| `mcp-all-tools-probe.js` | `npm run verify:mcp-tools` | `comprehensive-verify` (Leg 3) | 40-tool deep probe: every registered tool is called with a representative argument set; the response shape is asserted (no `isError: true`, content array present). Catches "tool was registered but throws on call" regressions. |
| `mcp-standalone-live-verify.js` | `npm run verify:standalone` | `mcp-live-verify` | 28-invariant standalone live-verify: spawn `--browser`, wait for `CodeAtlas browser ready`, edit the canonical handler in the test workspace, probe all 6 DB layers, revert, assert clean. |
| `mcp-ai-review-verify.mcp.js` | `npm run verify:ai-review:mcp` | `verify-all` (Phase 4b) | Drives AI review against the standalone with `scope: 'cluster', clusterId: 'cluster:auth'`. 9 invariants: boot, cascade fired, ws connected, findings cleared, completed within budget, cursors stamped, pipeline ran, cycle-close clean. |
| `mcp-ai-review-verify.ext.js` | `npm run verify:ai-review:ext` | `verify-all` (Phase 4a) | Companion driver for the extension surface — connects to existing `localhost:7742`, reads `.codeatlas/state.db`. |
| `all37-leak-probe.sh` | `npm run verify:all37` | `live-verify` extension at `.claude/skills/live-verify/SKILL.md` | 37-repo per-layer cascade leak probe. For each cloned fixture: clean-init → edit → revert → diff per-layer counts. Asserts L1/L2a/L2b/L3/L4/L5 all settle back to baseline. |

## Conventions for new drivers

1. **No hardcoded paths.** Use `path.resolve(__dirname, '..', '..')` to
   reach the extension root. Scripts must run from any clone.
2. **Spawn the MCP/standalone via `mcp-package/dist/mcp-server.js`**, not
   via the extension build. The standalone is the canonical surface for
   the verifications and matches what users run.
3. **Exit code = pass/fail.** `process.exit(0)` for success;
   `process.exit(1)` for any invariant violation. Print a leading line
   with the invariant counts (`PASS 9/9` or `FAIL 2/9 (boot, cascade)`)
   so the consuming skill / CI workflow can grep one line.
4. **Stderr = diagnostics, stdout = the pass/fail report.** Each script
   captures the standalone's stderr to a local `*.stderr.log` file when
   it spawns one; the consuming skill greps that file for invariant
   evidence.
5. **Cleanup on signal.** Every driver registers a SIGINT / SIGTERM
   handler that kills the spawned child process before exiting so a
   ctrl-C doesn't leak processes.
