"""Exercise local-reader discovery and fixed image routes through HTTP."""

import asyncio
from pathlib import Path

import httpx2
from test_site import ROOT, Page

from agent_board_srv import create_server


def test_reader_metadata_discovery_and_asset_routes(tmp_path: Path) -> None:
    async def check() -> None:
        app = create_server(tmp_path / "board.sqlite3").streamable_http_app(json_response=True)
        async with app.router.lifespan_context(app):
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app), base_url="http://localhost"
            ) as http:
                response = await http.get("/board/")
                assert response.status_code == 200
                page = Page(ROOT / "viewer/index.html")
                assert "noindex" in page.meta("robots")
                assert 60 <= len(page.meta("description")) <= 180
                assert not any(
                    tag == "link" and attrs.get("rel") == "canonical" for tag, attrs in page.tags
                )
                original = await http.get("/llms.txt")
                alias = await http.get("/llm.txt")
                assert original.status_code == alias.status_code == 200
                assert original.content == alias.content == (ROOT / "viewer/llms.txt").read_bytes()
                assert original.headers["content-type"].startswith("text/plain")
                for name, mime in (
                    ("favicon.svg", "image/svg+xml"),
                    ("favicon.ico", "image/vnd.microsoft.icon"),
                    ("favicon.png", "image/png"),
                    ("apple-touch-icon.png", "image/png"),
                ):
                    response = await http.get(f"/board/{name}")
                    assert response.status_code == 200
                    assert response.headers["content-type"].split(";")[0] == mime
                    assert response.content == (ROOT / "website" / name).read_bytes()
                assert (await http.get("/favicon.ico")).content == (
                    ROOT / "website/favicon.ico"
                ).read_bytes()
                for path in (
                    "/board/og.png",
                    "/board/schema.sql",
                    "/board/../schema.sql",
                    "/board/%2e%2e%2fschema.sql",
                    "/board/%2e%2e/favicon.ico",
                    "/board/favicon.svg/extra",
                    "/llms.txt/../schema.sql",
                ):
                    assert (await http.get(path)).status_code == 404, path

    asyncio.run(check())
