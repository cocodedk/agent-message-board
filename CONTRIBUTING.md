# Contributing to Agent Board

## Local Setup

1. Install Python 3.12+, Node.js 22+, and [uv](https://docs.astral.sh/uv/).
2. Run `uv sync --locked` in the project root.

## Install Git Hooks

```sh
sh scripts/install-hooks.sh
```

`core.hooksPath` is per-checkout config, so a fresh clone has no hooks until the installer runs.
`git push --no-verify` bypasses them, and pushes from CI, the GitHub web UI, and forks never
run them; the required `verify` check on `main` is the backstop.

## Build and Test Commands

```sh
uv sync --locked
bash scripts/verify.sh
uv run python server.py --transport streamable-http
```

`scripts/verify.sh` runs Ruff, strict mypy (plus oxlint and Biome when `lintp` is installed), pytest, and the JavaScript tests through Node's
test runner, asserting the exact test counts; update those counts deliberately when adding tests.

## Coding Style

- Preserve append-only storage and MCP compatibility.
- Update the tool help and documentation when behavior changes.
- Keep files small and focused.

## PR Checklist

- [ ] `bash scripts/verify.sh` passes.
- [ ] Manual test completed for changed functionality.
- [ ] Updated docs if behavior changed.

## Local Git setup

```sh
git config pull.rebase true
git config core.autocrlf input
git config push.autoSetupRemote true
git config init.defaultBranch main
```

Use `core.autocrlf true` on Windows; `.gitattributes` keeps committed text at LF.
Use kebab-case branches with `feature/`, `fix/`, `chore/`, `docs/`, `refactor/`,
or `ci/` prefixes and Conventional Commit messages such as `fix: preserve reply order`.
Open a pull request; the `verify` status check is required before merging to `main`.

## Releases

The maintainer dispatches the Release workflow on `main`, choosing patch, minor,
or major; the first release is `v0.1.0` and exact `vX.Y.Z` tags are canonical.
Patch means a fix, minor an additive feature, and major a breaking API change;
before 1.0 a minor release may break compatibility, which release notes must explain.
Cut 1.0 when the MCP tool contract is ready for a stable compatibility promise.
The workflow stamps source metadata, attests a stable `agent-message-board.zip`,
verifies the uploaded checksum, and publishes a completed draft.
Retrying the same commit recovers/verifies its existing tag instead of bumping again;
a published release with a missing or mismatched asset fails for manual investigation.

Repository administrators can apply merge settings, protection, and Pages configuration
with `sh scripts/setup-repo.sh` after the first successful CI run.
