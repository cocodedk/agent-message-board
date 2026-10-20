import asyncio
import sys
from pathlib import Path
from typing import Any, cast

import pytest
from mcp import Client
from mcp.client.stdio import StdioServerParameters

from server import create_server

TOOLS = {
    "create_subject",
    "list_subjects",
    "get_subject",
    "get_message",
    "post_message",
    "read_messages",
    "search",
    "addressed_to_me",
    "help",
}


async def call(client: Client, name: str, **arguments: Any) -> dict[str, Any]:
    result = await client.call_tool(name, arguments)
    assert not result.is_error, result.content
    assert result.structured_content is not None
    return cast(dict[str, Any], result.structured_content)


def test_tool_discovery_and_closed_output_schemas(tmp_path: Path) -> None:
    async def check() -> None:
        async with Client(
            create_server(tmp_path / "board.sqlite3"), raise_exceptions=True
        ) as client:
            result = await client.list_tools()
            assert {tool.name for tool in result.tools} == TOOLS
            for tool in result.tools:
                assert tool.description
                assert tool.output_schema is not None
                assert tool.output_schema["additionalProperties"] is False
                assert tool.annotations is not None
                assert tool.annotations.destructive_hint is False
                assert tool.annotations.read_only_hint == (
                    tool.name not in {"create_subject", "post_message"}
                )

    asyncio.run(check())


def test_agents_discuss_and_challenge_a_conclusion(tmp_path: Path) -> None:
    async def check() -> None:
        mcp = create_server(tmp_path / "board.sqlite3")
        async with Client(mcp) as agent_a, Client(mcp) as agent_b:
            subject = await call(
                agent_a,
                "create_subject",
                title="Storage?",
                description="Compare durability",
                author="a",
            )
            assert (await call(agent_b, "get_subject", subject_id=subject["id"])) == subject
            root = await call(
                agent_a,
                "post_message",
                subject_id=subject["id"],
                author="a",
                body="SQLite",
                kind="proposal",
            )
            reply = await call(
                agent_b,
                "post_message",
                subject_id=subject["id"],
                parent_id=root["id"],
                author="b",
                receiver="a",
                body="Concurrent writes?",
                kind="challenge",
            )
            assert (root["author"], root["receiver"]) == ("a", None)
            assert (reply["author"], reply["receiver"]) == ("b", "a")
            conclusion = await call(
                agent_a,
                "post_message",
                subject_id=subject["id"],
                parent_id=reply["id"],
                author="a",
                body="SQLite for modest traffic; concern remains",
                kind="conclusion",
            )
            challenge = await call(
                agent_b,
                "post_message",
                subject_id=subject["id"],
                parent_id=conclusion["id"],
                author="b",
                body="Revisit after load testing",
                kind="challenge",
            )
            assert (await call(agent_b, "list_subjects"))["subjects"] == [subject]
            assert (await call(agent_b, "get_message", message_id=root["id"])) == root
            page = await call(agent_b, "read_messages", subject_id=subject["id"], limit=2)
            assert page["messages"] == [root, reply]
            next_page = await call(
                agent_b,
                "read_messages",
                subject_id=subject["id"],
                after_id=page["next_after_id"],
                limit=2,
            )
            assert next_page["messages"] == [conclusion, challenge]
            assert next_page["next_after_id"] is None
            conclusions = await call(
                agent_b, "read_messages", subject_id=subject["id"], kind="conclusion"
            )
            assert conclusions["messages"] == [conclusion]
            inbox = await call(agent_a, "addressed_to_me", receiver="a")
            assert inbox == {"messages": [reply], "next_after_id": None}

    asyncio.run(check())


@pytest.mark.parametrize(
    "arguments",
    [
        {"title": " ", "description": "Question", "author": "a"},
        {"title": "Valid", "description": " ", "author": "a"},
        {"title": "Valid", "description": "Question", "author": " "},
        {"title": "x" * 201, "description": "Question", "author": "a"},
    ],
)
def test_invalid_subjects_leave_no_records(tmp_path: Path, arguments: dict[str, str]) -> None:
    async def check() -> None:
        async with Client(create_server(tmp_path / "board.sqlite3")) as client:
            result = await client.call_tool("create_subject", arguments)
            assert result.is_error
            assert (await call(client, "list_subjects"))["subjects"] == []

    asyncio.run(check())


@pytest.mark.parametrize(
    "arguments",
    [
        {"author": " "},
        {"author": "x" * 101},
        {"receiver": " "},
        {"receiver": "x" * 101},
    ],
)
def test_invalid_sender_or_receiver_leaves_no_message(
    tmp_path: Path, arguments: dict[str, str]
) -> None:
    async def check() -> None:
        async with Client(create_server(tmp_path / "board.sqlite3")) as client:
            subject = await call(
                client, "create_subject", title="Valid", description="Question", author="a"
            )
            valid = {"subject_id": subject["id"], "author": "a", "body": "Hi"}
            result = await client.call_tool("post_message", valid | arguments)
            assert result.is_error
            page = await call(client, "read_messages", subject_id=subject["id"])
            assert page["messages"] == []

    asyncio.run(check())


@pytest.mark.parametrize(
    "arguments",
    [
        {"limit": 0},
        {"limit": 101},
        {"after_id": -1},
        {"after_id": True},
    ],
)
def test_invalid_pagination_rejected(tmp_path: Path, arguments: dict[str, int]) -> None:
    async def check() -> None:
        async with Client(create_server(tmp_path / "board.sqlite3")) as client:
            assert (await client.call_tool("list_subjects", arguments)).is_error

    asyncio.run(check())


def test_missing_record_returns_useful_tool_error(tmp_path: Path) -> None:
    async def check() -> None:
        async with Client(create_server(tmp_path / "board.sqlite3")) as client:
            result = await client.call_tool("get_message", {"message_id": 1})
            assert result.is_error
            assert "does not exist" in str(result.content)

    asyncio.run(check())


def test_stdio_launch_and_persistence_across_clients(tmp_path: Path) -> None:
    async def check() -> None:
        params = StdioServerParameters(
            command=sys.executable,
            args=[
                str(Path(__file__).resolve().parents[1] / "server.py"),
                "--db",
                str(tmp_path / "board.sqlite3"),
            ],
            cwd=str(tmp_path),
        )
        async with Client(params, mode="legacy") as first:
            assert {tool.name for tool in (await first.list_tools()).tools} == TOOLS
            subject = await call(
                first,
                "create_subject",
                title="Persistent?",
                description="Survive a restart",
                author="a",
            )
            original = await call(
                first, "post_message", subject_id=subject["id"], author="a", body="Keep this"
            )
        async with Client(params) as second:
            assert (await call(second, "get_message", message_id=original["id"])) == original

    asyncio.run(check())
