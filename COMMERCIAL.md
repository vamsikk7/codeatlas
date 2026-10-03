# Commercial licensing and the reserved surface

CodeAtlas is licensed under the [Apache License 2.0](LICENSE). That covers
everything in this repository: the extension host, the webview UI, the MCP
server, the standalone daemon, and the CLI.

This document exists to be straight with you about two things: what you can do
with the code today, and what the project reserves for itself tomorrow.

## What Apache-2.0 gives you, today

Everything in this repository. You may use CodeAtlas commercially, inside a
company, in a product you sell, modified or unmodified, without asking anyone
and without paying anyone. You may fork it. You may ship it inside a closed
product. There is no "free for personal use" clause, no seat limit, and no
feature that unlocks on payment.

The obligations are the ordinary Apache-2.0 ones: keep the license and
copyright notices, retain the `NOTICE` file, and state what you changed. The
patent grant and its termination clause apply as written in the license.

One carve-out, and it is not a copyright one: the **CodeAtlas name and logo**
are trademarks and are not licensed to you. See [TRADEMARK.md](TRADEMARK.md).
Build what you like with the code; just do not call it CodeAtlas.

## What is reserved

None of the following exists in this repository today. Each is a surface the
project intends to build and may offer commercially:

- **Hosted multi-repository indexing** — a service that builds and serves the
  six-layer graph across an organisation's repositories.
- **Organisation dashboards** — shared, persistent architecture views across
  teams, with history and access control.
- **SSO and SCIM** — enterprise identity integration and user provisioning.
- **CI runner** — a hosted service that builds graphs and posts architectural
  review on pull requests.
- **Team sync** — shared comments, findings, and review state across users.

If and when these are built, they may be released under a commercial license
rather than Apache-2.0.

## Why this document can make that claim

Because of the [Contributor License Agreement](.github/CLA.md).

Apache-2.0 is a one-way grant: it licenses *you* to use the project's code. It
says nothing about the project's right to use *your* code under different terms.
Without a CLA, every merged contribution would be inbound-licensed under
Apache-2.0 only, and the project could not later include that contribution in a
commercially licensed product without each contributor's permission.

The CLA closes that gap. It asks you to grant the project the right to license
your contribution under other terms, including commercial ones. You keep the
copyright to your work — this is a license grant, not an assignment.

This is the same arrangement used by many projects with a commercial sponsor. It
is worth understanding before you contribute, which is why it is written out
here rather than buried.

## What this document does not do

It does not restrict the Apache-2.0 grant on anything in this repository. Code
that is here, under that license, stays under that license — for you and for
every fork, permanently. Nothing in this file can retroactively close code that
has already been released openly, and nothing here is intended to suggest
otherwise.

If a feature currently in this repository ever moves behind a commercial
license, the open version does not disappear: the last Apache-2.0 release
remains available and forkable.

## Questions

Open a [discussion](https://github.com/vamsikk7/codeatlas/discussions) or email
`vamsi.iiita@gmail.com` for licensing questions that should not be public.
