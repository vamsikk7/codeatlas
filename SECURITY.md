# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through
[GitHub Security Advisories](https://github.com/vamsikk7/codeatlas/security/advisories/new),
which is the preferred channel. If that is unavailable to you, email
`vamsi.iiita@gmail.com`.

Useful things to include, to whatever extent you have them: affected version
and build number (`CodeAtlas: Show Version`), the surface involved (extension
host, webview, MCP server, standalone daemon), reproduction steps or a proof of
concept, and the impact you believe it has.

### What to expect

| Stage | Target |
|---|---|
| Acknowledgement | 48 hours |
| Initial assessment and severity | 7 days |
| Fix or documented mitigation for critical issues | 30 days |
| Public advisory | after a fix ships, coordinated with you |

This project is maintained by one person. These are honest targets rather than
a contractual SLA; if a deadline is going to slip, you will be told rather than
left waiting.

You will be credited in the advisory unless you prefer otherwise. There is no
bug bounty.

## Supported versions

| Version | Supported |
|---|---|
| Latest minor release | ✅ |
| Previous minor release | Critical fixes only |
| Older | ❌ |

Fixes ship in a new release rather than as patches to old ones.

## Scope

**In scope** — anything in this repository:

- The VS Code / OpenVSX extension host
- The webview UI and the local HTTP + WebSocket server on `localhost:7742`
- The MCP server, both embedded and standalone (`@codeatlas/mcp`)
- The standalone daemon and CLI
- Build and release tooling in `scripts/` and `.github/workflows/`

**Out of scope** — report these to their owners:

- `codeatlas.live` and the dashboard (separate, closed-source)
- Clerk, Mixpanel, Sentry, OpenRouter, and other third-party services
- Vulnerabilities in dependencies with no CodeAtlas-specific exploit path
  (Dependabot already tracks these; a report is still welcome if you have a
  working exploit through CodeAtlas)

## Threat model

Knowing what the project does and does not defend against should save you time.

**Defended:**

- *Hostile workspace content.* CodeAtlas parses untrusted source code. Parsers
  must not execute it, and must not be driven into resource exhaustion by it.
- *Cross-origin access to the local server.* The HTTP and WebSocket server binds
  `127.0.0.1` only. Browser clients are checked against a localhost Origin
  allowlist with a matching port.
- *Path traversal.* Static asset serving resolves and enforces a
  path-separator boundary.
- *Credential exfiltration through a custom LLM endpoint.* API keys are attached
  only for allowlisted hosts unless the user explicitly opts in per endpoint.
- *Secrets at rest.* Secret-shaped tokens are redacted from stored file content.
  Credentials go to the OS keychain in-editor, or a `0600` file standalone.

**Not defended:**

- *A local process running as the same user.* Anything with your UID can read
  your keychain, your `0600` files, and connect to your loopback ports. This is
  outside what a local developer tool can defend.
- *A compromised VS Code extension host.* Other extensions share the process.
- *Your own LLM provider.* Code sent for AI review reaches whatever endpoint you
  configured. See [PRIVACY.md](PRIVACY.md).

## Known properties worth knowing about

Neither of these is a vulnerability, but both are things a reviewer will find
and should hear from us first.

**Marketplace builds are minified and reproducible from source.** Published
VSIX artifacts are produced by `npm run package`, which runs esbuild with
`minify: true` and nothing else. No obfuscation is applied. You can build the
same bundle locally from this repository and compare it against what ships —
the only intended difference is the telemetry keys CI injects (see below).

**Telemetry keys are not in this repository.** Builds from source have no
Mixpanel token and no Sentry DSN, and therefore send nothing. Official releases
have both injected by CI. What official builds collect, and how to turn it off,
is in [PRIVACY.md](PRIVACY.md).

## Hardening for sensitive environments

- Set `CODEATLAS_TELEMETRY=0` or `DO_NOT_TRACK=1`, or disable VS Code telemetry.
- Skip AI features, or point them at a local model (Ollama, or any
  OpenAI-compatible endpoint) so no source leaves the machine.
- Build from source to get a bundle with no telemetry keys compiled in, and
  to verify that it matches the published artifact.
- Do not sign in. Sign-in is optional; local diagram generation does not
  require it.
