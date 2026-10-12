import asyncio
from pathlib import Path

import httpx2
import pytest
from mcp import Client

from models import Order
from server import create_server
from storage import Board


def seed(board: Board) -> int:
    subject = board.create_subject("A shared question", "Compare the evidence", "a")
    with board.connect() as db:
        for day in (3, 1, 1, 2):
            db.execute(
                "INSERT INTO messages (subject_id, author, body, kind, created_at) "
                "VALUES (?, 'a', 'Evidence', 'message', ?)",
                (subject.id, f"2026-10-0{day}T00:00:00Z"),
            )
    return subject.id


def test_reader_serves_fixed_assets_and_read_only_discovery(tmp_path: Path) -> None:
    async def check() -> None:
        app = create_server(tmp_path / "board.sqlite3").streamable_http_app(json_response=True)
        async with app.router.lifespan_context(app):
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app), base_url="http://127.0.0.1:8000"
            ) as http:
                assert (await http.get("/")).headers["location"] == "/board/"
                response = await http.get("/board/")
                assert response.status_code == 200
                assert "Board reader" in response.text
                for asset in (
                    "styles.css",
                    "mcp.js",
                    "board.js",
                    "render.js",
                    "webmcp.js",
                    "main.js",
                ):
                    assert (await http.get(f"/board/{asset}")).status_code == 200
                assert "browse_messages" in (await http.get("/llms.txt")).text
                assert (await http.post("/board/")).status_code == 405
                for path in ("schema.sql", "../schema.sql", "%2e%2e%2fschema.sql"):
                    assert (await http.get(f"/board/{path}")).status_code == 404

    asyncio.run(check())


@pytest.mark.parametrize("order", ["asc", "desc"])
def test_message_dates_sort_globally_with_pagination(tmp_path: Path, order: Order) -> None:
    board = Board(tmp_path / "board.sqlite3")
    subject_id = seed(board)
    expected = [2, 3, 4, 1] if order == "asc" else [1, 4, 3, 2]
    page = board.read_messages(subject_id, 0, 2, None, False, None, order)
    assert [message.id for message in page.messages] == expected[:2]
    assert page.next_after_id == expected[1]
    page = board.read_messages(subject_id, page.next_after_id, 2, None, False, None, order)
    assert [message.id for message in page.messages] == expected[2:]
    assert page.next_after_id is None


@pytest.mark.parametrize("foreign", [False, True])
def test_message_date_cursor_rejects_missing_or_foreign_records(
    tmp_path: Path, foreign: bool
) -> None:
    board = Board(tmp_path / "board.sqlite3")
    subject_id = seed(board)
    cursor = 999
    if foreign:
        other = board.create_subject("Other", "Separate discussion", "b")
        cursor = board.post_message(other.id, "b", "Other evidence", None, "message").id
    with pytest.raises(ValueError, match="requested subject" if foreign else "does not exist"):
        board.read_messages(subject_id, cursor, 50, None, False, None, "desc")


def test_date_sort_keeps_direct_reply_and_kind_filters(tmp_path: Path) -> None:
    board = Board(tmp_path / "board.sqlite3")
    subject_id = seed(board)
    parent = board.post_message(subject_id, "a", "Parent", None, "proposal")
    first = board.post_message(subject_id, "b", "A conclusion", parent.id, "conclusion")
    board.post_message(subject_id, "b", "A challenge", parent.id, "challenge")
    last = board.post_message(subject_id, "c", "A newer conclusion", parent.id, "conclusion")
    page = board.read_messages(subject_id, 0, 1, parent.id, False, "conclusion", "desc")
    assert page.messages == [last]
    assert page.next_after_id == last.id
    assert board.read_messages(
        subject_id, last.id, 1, parent.id, False, "conclusion", "desc"
    ).messages == [first]


@pytest.mark.parametrize("order", ["sideways", True])
def test_invalid_message_sort_rejected_via_mcp(tmp_path: Path, order: str | bool) -> None:
    async def check() -> None:
        async with Client(create_server(tmp_path / "board.sqlite3")) as client:
            result = await client.call_tool("read_messages", {"subject_id": 1, "order": order})
            assert result.is_error

    asyncio.run(check())


def test_browser_rpc_handshake_and_reads_leave_discussion_unchanged(tmp_path: Path) -> None:
    async def check() -> None:
        board = Board(tmp_path / "board.sqlite3")
        subject_id = seed(board)
        before = board.read_messages(subject_id, 0, 100, None, False, None)
        app = create_server(board.path).streamable_http_app(json_response=True)
        headers = {"Accept": "application/json, text/event-stream"}
        async with app.router.lifespan_context(app):
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app), base_url="http://127.0.0.1:8000"
            ) as http:
                response = await http.post(
                    "/mcp",
                    headers=headers,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-11-25",
                            "capabilities": {},
                            "clientInfo": {"name": "agent-board-reader", "version": "1.0"},
                        },
                    },
                )
                assert response.status_code == 200
                headers["Mcp-Session-Id"] = response.headers["Mcp-Session-Id"]
                headers["MCP-Protocol-Version"] = response.json()["result"]["protocolVersion"]
                response = await http.post(
                    "/mcp",
                    headers=headers,
                    json={
                        "jsonrpc": "2.0",
                        "method": "notifications/initialized",
                        "params": {},
                    },
                )
                assert response.status_code == 202
                response = await http.post(
                    "/mcp",
                    headers=headers,
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/call",
                        "params": {
                            "name": "read_messages",
                            "arguments": {"subject_id": subject_id, "limit": 2, "order": "desc"},
                        },
                    },
                )
                assert response.status_code == 200
                result = response.json()["result"]
                assert not result.get("isError")
                assert [message["id"] for message in result["structuredContent"]["messages"]] == [
                    1,
                    4,
                ]
        assert board.read_messages(subject_id, 0, 100, None, False, None) == before

    asyncio.run(check())
