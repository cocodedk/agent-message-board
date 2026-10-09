#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.venv/bin:$PATH"
export RUFF_CACHE_DIR="$PWD/.ruff_cache"
export MYPY_CACHE_DIR="$PWD/.mypy_cache"
if command -v lintp >/dev/null 2>&1; then
  lintp --tools ruff,mypy models.py storage.py server.py help_content.py tests scripts
else
  .venv/bin/ruff check models.py storage.py server.py help_content.py tests scripts
  .venv/bin/mypy models.py storage.py server.py help_content.py tests scripts
fi
python - <<'PY'
import pytest

class CountTests:
    def pytest_collection_finish(self, session):
        assert len(session.items) == 69, f"Expected 69 tests, collected {len(session.items)}"

raise SystemExit(pytest.main(["-q"], plugins=[CountTests()]))
PY
node_tests=$(node --test --test-reporter=tap tests/test_webmcp.js) || {
  printf '%s\n' "$node_tests"
  exit 1
}
printf '%s\n' "$node_tests"
if ! printf '%s\n' "$node_tests" | grep -qx '# tests 16'; then
  echo 'Expected exactly 16 WebMCP tests' >&2
  exit 1
fi
