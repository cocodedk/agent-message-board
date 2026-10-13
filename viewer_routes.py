"""Serve the reader's fixed assets beside the HTTP MCP endpoint."""

from pathlib import Path

from mcp.server import MCPServer
from starlette.requests import Request
from starlette.responses import FileResponse, PlainTextResponse, RedirectResponse, Response

VIEWER = Path(__file__).with_name("viewer")
WEBSITE = Path(__file__).with_name("website")
ASSETS = {
    "styles.css",
    "mcp.js",
    "board.js",
    "render.js",
    "webmcp.js",
    "main.js",
    "content.js",
    "navigation.js",
}
ICONS = {"favicon.svg", "favicon.ico", "favicon.png", "apple-touch-icon.png"}


def register_viewer(mcp: MCPServer) -> None:
    async def redirect(request: Request) -> Response:
        return RedirectResponse("/board/")

    async def index(request: Request) -> Response:
        return FileResponse(VIEWER / "index.html")

    async def asset(request: Request) -> Response:
        name = request.path_params["asset"]
        if name in ICONS:
            return FileResponse(WEBSITE / name)
        if name not in ASSETS:
            return PlainTextResponse("Not found", status_code=404)
        return FileResponse(VIEWER / name)

    async def discovery(request: Request) -> Response:
        return FileResponse(VIEWER / "llms.txt", media_type="text/plain")

    async def favicon(request: Request) -> Response:
        return FileResponse(WEBSITE / "favicon.ico", media_type="image/vnd.microsoft.icon")

    for path, handler in (
        ("/", redirect),
        ("/board", redirect),
        ("/board/", index),
        ("/board/{asset}", asset),
        ("/llms.txt", discovery),
        ("/llm.txt", discovery),
        ("/favicon.ico", favicon),
    ):
        mcp.custom_route(path, methods=["GET"])(handler)
