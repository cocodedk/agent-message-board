"""Exercise SQL payloads through actual MCP HTTP transports, never production data."""

import asyncio
from pathlib import Path
from typing import Any, Literal, cast

import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from agent_board_srv import create_server
from storage import Board


async def call(client: Client, name: str, **arguments: Any) -> dict[str, Any]:
    result = await client.call_tool(name, arguments)
    assert not result.is_error
    assert result.structured_content is not None
    return cast(dict[str, Any], result.structured_content)


def snapshot(board: Board) -> tuple[list[tuple[Any, ...]], list[tuple[Any, ...]]]:
    with board.connect() as db:
        return (
            [tuple(row) for row in db.execute("SELECT * FROM subjects ORDER BY id")],
            [tuple(row) for row in db.execute("SELECT * FROM messages ORDER BY id")],
        )


@pytest.mark.parametrize("mode", ["auto", "legacy"])
def test_sql_payloads_are_bound_data_or_rejected_before_sql(
    tmp_path: Path, mode: Literal["auto", "legacy"]
) -> None:
    async def check() -> None:
        board = Board(tmp_path / "injection.sqlite3")
        baseline = board.create_subject("Baseline", "Keep this question", "a")
        board.post_message(baseline.id, "a", "Keep this evidence", None, "message")
        before = snapshot(board)
        app = create_server(board.path).streamable_http_app(json_response=True)
        async with app.router.lifespan_context(app):
            async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app)) as http:
                transport = streamable_http_client("http://127.0.0.1:8000/mcp", http_client=http)
                async with Client(transport, mode=mode) as client:
                    attacks: list[tuple[str, dict[str, Any]]] = [
                        ("get_subject", {"subject_id": "1 OR 1=1"}),
                        ("get_message", {"message_id": "1; DROP TABLE messages;--"}),
                        ("list_subjects", {"after_id": "1 UNION SELECT 1"}),
                        ("list_subjects", {"limit": "1; DELETE FROM subjects"}),
                        ("list_subjects", {"order": "desc; DROP TABLE subjects;--"}),
                        ("search", {"query": "x", "scope": "subjects; DELETE FROM messages"}),
                        ("search", {"query": "x", "subject_id": "1 OR TRUE"}),
                        ("read_messages", {"subject_id": 1, "parent_id": "1 OR TRUE"}),
                        ("read_messages", {"subject_id": 1, "kind": "message' OR TRUE--"}),
                        (
                            "post_message",
                            {
                                "subject_id": 1,
                                "parent_id": "1; DELETE FROM messages",
                                "author": "a",
                                "body": "Must not be appended",
                            },
                        ),
                    ]
                    for name, args in attacks:
                        assert (await client.call_tool(name, args)).is_error, name
                        assert snapshot(board) == before, name
                    for payload in (
                        "' OR 1=1 --",
                        "'; DROP TABLE subjects;--",
                        "x'); UPDATE messages SET body='changed';--",
                        "%'; DELETE FROM messages;--",
                    ):
                        subject = await call(
                            client,
                            "create_subject",
                            title=payload,
                            description=payload,
                            author=payload,
                        )
                        assert (
                            await call(client, "get_subject", subject_id=subject["id"])
                        ) == subject
                        assert (
                            subject["title"]
                            == subject["description"]
                            == subject["author"]
                            == payload
                        )
                        message = await call(
                            client,
                            "post_message",
                            subject_id=subject["id"],
                            author=payload,
                            body=payload,
                        )
                        assert (
                            await call(client, "get_message", message_id=message["id"])
                        ) == message
                        assert message["body"] == message["author"] == payload
                        found = await call(client, "search", query=payload, scope="subjects")
                        assert [item["id"] for item in found["subjects"]] == [subject["id"]]
                        found = await call(
                            client,
                            "search",
                            query=payload,
                            scope="messages",
                            subject_id=subject["id"],
                        )
                        assert [item["id"] for item in found["messages"]] == [message["id"]]
                    subjects, messages = snapshot(board)
                    assert len(subjects) == len(messages) == 5
                    assert subjects[0] == before[0][0] and messages[0] == before[1][0]

    asyncio.run(check())
