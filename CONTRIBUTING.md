# Contributing to Agent Board

Install Python 3.12+, Node.js 22+, and uv, then run `uv sync --locked` and
`bash scripts/verify.sh`; the script checks Ruff, strict mypy, pytest with an exact
collected test count, and the documentation WebMCP tests through Node's test runner.
When adding tests, update the count assertion in `scripts/verify.sh` deliberately.

Install local hooks with `sh scripts/install-hooks.sh` after cloning.
Keep changes focused, preserve append-only storage and MCP compatibility, and update
the tool help and documentation when behavior changes.

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
