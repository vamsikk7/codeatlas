# CodeAtlas review guidelines (nominal instructions)

Apply these IN ADDITION to correctness/security review. Flag a guideline finding
only when the **changed** code actually exhibits the issue AND you can quote the
evidence from the source. Do not flag pre-existing code the diff didn't touch.

## Cloud architecture patterns
- **Resilience**: an outbound network / DB / queue / HTTP call added on a request
  path with no timeout, retry, or fallback — a slow dependency will hang the handler.
- **Idempotency**: a state-mutating entry point (POST/PUT/DELETE, job, queue consumer)
  made non-idempotent — retried delivery would double-apply (no idempotency key / dedup).
- **Statelessness**: per-request or per-user state stored in module/global scope —
  breaks horizontal scaling and leaks across requests.
- **Config over hardcoding**: endpoints, credentials, region/env values, or feature
  flags hardcoded in the changed code instead of read from config/env.

## Gang-of-Four / design patterns
- A growing `if/else`/`switch` on a type or enum in the diff that a **Strategy** or
  polymorphic dispatch would replace.
- Direct `new`/construction of a dependency inside a handler where the codebase already
  uses a **Factory** or dependency injection for that concern.
- Duplicated object-construction or event-notification logic that a **Builder** /
  **Observer** would centralize.
- Only raise when the branching/duplication is introduced or extended by THIS diff.

## DRY / simplicity
- The diff copies a block (same logic, ~5+ lines) that already exists elsewhere instead
  of reusing it; or adds a helper that duplicates an existing utility's behavior.
- **Over-engineering**: a new abstraction / indirection / config layer added for a
  single caller, where an inline implementation is clearer.

## Syntax / correctness hygiene
- **Unawaited async**: `forEach(async …)`, a fire-and-forget promise, or an un-awaited
  call on a path whose failure must not be silent (cleanup, delete, payment, notify).
- **Reference equality**: `===`/`!==` comparing objects/dates (e.g. dayjs, Date) that
  compares identity, not value — will not behave as intended.
- **Logic slips**: inverted conditions (`&&` vs `||`), off-by-one, unreachable
  `else`/`else if` branches, redundant optional chaining after a null check.
- **Case/normalization**: case-sensitive comparison/`indexOf`/blacklist on values that
  should be normalized (email, codes), allowing a trivial bypass.
- **Portability**: platform-specific shell/syntax (e.g. macOS `sed -i ''`) in scripts
  meant to run cross-platform / in CI.
