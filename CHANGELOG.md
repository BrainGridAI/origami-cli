# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-09-25

First public release, published as `@braingrid/origami-cli`.

### Added

- Every Origami v3 operation as a command (`send`, `leads`, `jobs`, `account`): 120
  operations generated from the published OpenAPI spec by `pnpm sync:v3`.
- `--wait` on Job-returning operations and `origami jobs wait <id>`, polling on the Job's
  `next_poll_at`.
- Automatic `Idempotency-Key` on every v3 POST, reused across retries.
- Validation of enum values and required fields before any request is sent.
- `--all` pagination, `--data` request bodies (inline, `@file`, or stdin), CSV passthrough.

### Changed

- `origami account` and `origami credits` use v3.
- v2 `campaigns`, `sequences` and `projects` now point to their v3 equivalents.

## [0.1.0] - 2026-07-21

- Initial CLI for the Origami v2 API: agents and runs, tables and rows, enrichments,
  documents, campaigns, sequences, scheduled agents, projects, webhooks tooling.

[0.2.0]: https://github.com/BrainGridAI/origami-cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/BrainGridAI/origami-cli/commits/5d43dda
