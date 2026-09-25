# Contributing to origami-cli

Thanks for helping. Bug reports, fixes, and small focused features are all welcome.

## Setup

```bash
git clone https://github.com/BrainGridAI/origami-cli.git
cd origami-cli
pnpm install
pnpm dev -- send campaigns list --help    # run from source
```

Node.js 18+ and pnpm 10 (`corepack enable` picks the pinned version).

## Before you open a pull request

```bash
pnpm typecheck
pnpm test
pnpm build
```

CI runs the same three on Node 18, 20 and 22. Tests never touch the network: they stub
`fetch` or run a local HTTP server, so they need no API key.

## How the code is laid out

| Path | What lives there |
| --- | --- |
| `src/v3/catalog.ts` | Generated. One entry per v3 operation. Never edit by hand. |
| `scripts/sync-v3-catalog.mjs` | Builds the catalog from Origami's published OpenAPI spec. |
| `src/v3/commands.ts` | Turns the catalog into `send`, `leads`, `jobs`, `account` commands. |
| `src/v3/values.ts`, `jobs.ts`, `render.ts` | Flag parsing, Job polling, output. |
| `src/api/client.ts` | HTTP client: auth, retries, idempotency, pagination. |
| `src/commands/` | The hand-written v2 agent surface (`run`, `agents`, `tables`, …). |

## When Origami changes its API

```bash
pnpm sync:v3            # regenerate src/v3/catalog.ts from the live spec
pnpm test               # catalog tests check coverage and flag collisions
```

A scheduled workflow does this weekly and opens a pull request when the spec moved.

A v3 behavior that the generic command builder can't express (like `jobs wait`) gets a small
hand-written command next to the generated ones; keep those rare.

## Style

- TypeScript strict mode, ESM, no new runtime dependencies without a good reason.
- Data goes to stdout, progress and hints to stderr, so pipes stay clean.
- Every behavior change comes with a test.

## Releasing (maintainers)

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Merge to `main`.
3. Publish a GitHub release tagged `vX.Y.Z`. The release workflow publishes to npm with
   provenance.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE)
and that you'll follow the [Code of Conduct](CODE_OF_CONDUCT.md).
