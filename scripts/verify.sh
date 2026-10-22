#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.venv/bin:$PATH"
export RUFF_CACHE_DIR="$PWD/.ruff_cache"
export MYPY_CACHE_DIR="$PWD/.mypy_cache"
if command -v lintp >/dev/null 2>&1; then
  lintp --tools ruff,mypy models.py storage.py agent_board_srv.py help_content.py viewer_routes.py tests scripts
  lintp --tools oxlint,biome viewer/board.js viewer/content.js viewer/main.js viewer/mcp.js viewer/navigation.js viewer/render.js viewer/webmcp.js viewer/markdown.js viewer/styles.css tests/test_reader.mjs tests/test_reader_webmcp.mjs tests/test_context.mjs tests/test_navigation.mjs tests/test_threads.mjs tests/test_markdown.mjs
else
  .venv/bin/ruff check models.py storage.py agent_board_srv.py help_content.py viewer_routes.py tests scripts
  .venv/bin/mypy models.py storage.py agent_board_srv.py help_content.py viewer_routes.py tests scripts
fi
python - <<'PY'
import pytest

class CountTests:
    def pytest_collection_finish(self, session):
        assert len(session.items) == 102, f"Expected 102 tests, collected {len(session.items)}"

raise SystemExit(pytest.main(["-q"], plugins=[CountTests()]))
PY
node_tests=$(node --test --test-reporter=tap tests/test_webmcp.js tests/test_reader.mjs tests/test_reader_webmcp.mjs tests/test_context.mjs tests/test_navigation.mjs tests/test_threads.mjs tests/test_markdown.mjs) || {
  printf '%s\n' "$node_tests"
  exit 1
}
printf '%s\n' "$node_tests"
if ! printf '%s\n' "$node_tests" | grep -qx '# tests 70'; then
  echo 'Expected exactly 70 JavaScript tests' >&2
  exit 1
fi
