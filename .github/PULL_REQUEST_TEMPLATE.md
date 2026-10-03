## What this changes

<!-- One or two sentences. Link the issue if there is one: Fixes #123 -->

## Why

<!-- The problem being solved. Skip if the issue already covers it. -->

## How it was verified

CodeAtlas has a four-command gate. Paste the results — "tests pass" without
output is not enough to review against.

```
npm run lint      →
npm test          →
npm run package   →
npm run test:e2e  →
```

<!--
Only `npm run test:e2e` may reasonably be skipped: it needs a built VSIX and a
browser. If you skipped it, say so here and CI will cover it.
-->

- [ ] New tests cover the change, or there is a reason none are needed
- [ ] Verified against a real project, not only fixtures

### If this touches a parser or detector

- [ ] Added a fixture under `e2e/real-projects/`
- [ ] Named the language and framework version it was tested against

## Checklist

- [ ] I have signed the [CLA](https://github.com/vamsikk7/codeatlas/blob/main/.github/CLA.md)
      (the bot will prompt on first PR)
- [ ] No secrets, tokens, personal paths, or private repository names in the diff
- [ ] Docs updated if behaviour changed
- [ ] Follows the existing style of the files touched

## Anything reviewers should know

<!-- Trade-offs, parts you are unsure about, things you deliberately left out.
     Flagging uncertainty here makes review faster, not weaker. -->
