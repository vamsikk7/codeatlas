# Privacy

What CodeAtlas sends, when, and how to stop it.

The short version: **your source code is never sent anywhere by CodeAtlas
itself.** All parsing, graph building, and diagram rendering happen on your
machine. The two ways code can leave are (1) AI features you configure with
your own LLM provider, and (2) the PR watcher, which talks to GitHub. Both are
off until you turn them on.

Last updated: 2026-10-03, for extension 9.3.0.

## Verify this yourself

This is why the project is open source. Telemetry lives in
`src/analytics/mixpanelService.ts`, `src/mcp/analytics/mcpAnalytics.ts`, and
`src/errors/sentryNode.ts`. Network calls to LLM providers are in
`src/core/llm/`. Nothing described here is hidden in a build step you cannot
read.

## Builds from source send nothing

The Mixpanel token and Sentry DSN are **not in this repository**. They are
injected by CI for official releases only. A build you produce from source has
no keys compiled in and makes no telemetry request — not a disabled one, no
request at all.

Everything in the next section applies to **official builds** from the VS Code
Marketplace, OpenVSX, and npm.

## Usage analytics (official builds)

Sent to Mixpanel (US region) when telemetry is enabled.

**On every event:**

| Field | Value |
|---|---|
| `distinct_id` | Your user ID if signed in, otherwise the device ID |
| `$device_id` | `vscode.env.machineId` — the anonymous ID VS Code assigns |
| `$insert_id`, `time` | Deduplication and timestamp |
| `vscode_version`, `platform`, `arch` | e.g. `1.95.0`, `darwin`, `arm64` |
| `extension_version` | e.g. `9.3.0` |
| editor context | Which editor variant is running (VS Code, Cursor, Windsurf) |

**Only if you are signed in:**

| Field | Value |
|---|---|
| `$user_id` | Your CodeAtlas user ID |
| `email` | Your account email |
| `first_name`, `last_name` | If present on your account |

Signing in is optional. Not signing in keeps analytics tied to an anonymous
device ID with no email attached.

**Per-event properties** are feature-usage facts: which diagram layer was
opened, whether a command succeeded, counts, durations, and flags such as
`has_profile: true` or `source: 'deep_link'`.

### What is not sent

No source code. No file contents. No file or directory paths as deliberate
fields. No repository names, remote URLs, or branch names. No API keys. No
diagram contents.

### One honest caveat

Some failure events include an error message truncated to 200 characters —
for example `cascade_error` and `ws_bridge_start_failed` carry
`String(err.message).slice(0, 200)`. Operating-system errors sometimes embed a
path (`ENOENT: no such file or directory, open '/Users/you/project/src/x.ts'`).
So a path fragment can reach telemetry **incidentally, inside an error string**,
even though no code path sends paths on purpose.

This is a real exception to "no paths are sent" and it is written down rather
than glossed over. If that matters in your environment, disable telemetry.

## Crash reporting (official builds)

Sent to Sentry: exception type, message, stack trace, and the same platform and
version fields. Stack traces reference CodeAtlas's own files, not yours. Events
are tagged by context (extension host / MCP standalone / webview) and carry an
anonymous machine-derived ID so repeated crashes from one install can be
grouped.

Note that marketplace builds are obfuscated, so the stack traces Sentry
receives are themselves mangled.

## AI features — your provider, your data

When you use AI Review, code **is** sent — to the endpoint *you* configured,
using *your* API key. CodeAtlas is not an intermediary: it does not proxy,
log, or retain these requests, and the project operates no inference service.

What is sent is bounded by the review scope you choose: the changed functions,
their immediate structural context, and relevant blast-radius metadata. Not
your whole repository.

Your data is then governed by your provider's policy — OpenRouter, OpenAI,
Anthropic, or your own server. For zero egress, point CodeAtlas at a local
model (Ollama, or any OpenAI-compatible endpoint); the request then never
leaves your machine.

Your API key is stored in the OS keychain through VS Code's `SecretStorage`, or
in `~/.codeatlas/secrets.json` with `0600` permissions when running standalone.
It is attached only to allowlisted provider hosts unless you explicitly opt in
for a custom endpoint — a deliberate guard against a hostile endpoint
harvesting it.

## GitHub access (PR watcher)

Reads pull request metadata and clones PR branches through the GitHub API,
using `GITHUB_TOKEN`/`GH_TOKEN` from the environment or your VS Code GitHub
session. Scoped to repositories your token already reaches. No data is sent to
CodeAtlas servers.

## Sign-in

Optional, and handled by Clerk. CodeAtlas receives a user ID, email, and name
and stores the session locally. Local diagram generation works fully signed
out; the browser UI at `localhost:7742` asks for sign-in.

## Local storage

Graph state lives in `.codeatlas/` inside your workspace and never leaves your
machine. Secret-shaped tokens in file content are redacted before being written
to that store. Add `.codeatlas/` to `.gitignore` so it is not committed.

## Turning it off

Any one of these stops usage analytics and crash reporting:

```bash
export CODEATLAS_TELEMETRY=0     # or: off, false, no
export DO_NOT_TRACK=1            # honoured as the industry-standard signal
```

Or in VS Code settings: `"telemetry.telemetryLevel": "off"` — which CodeAtlas
respects as a full opt-out.

Or build from source, which produces a bundle with no telemetry keys at all.

All three surfaces — extension usage analytics, MCP server analytics, and
crash reporting — answer to the same predicate (`src/lib/telemetryOptOut.ts`),
so any one of these settings silences all of them. That was not true before
this release: the extension host previously honoured only the VS Code setting
while the other two honoured the environment variables, which meant a user who
set `DO_NOT_TRACK=1` was still sending usage events. Fixed as audit finding S9,
with regression tests in `src/analytics/__tests__/mixpanelService.test.ts`.

## Questions

Open an issue at https://github.com/vamsikk7/codeatlas/issues, or email
`vamsi.iiita@gmail.com` for anything you would rather not raise publicly.
