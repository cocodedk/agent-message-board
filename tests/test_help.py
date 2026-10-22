import asyncio
import sys
from pathlib import Path
from typing import Any, cast

import pytest
from mcp import Client
from mcp.client.stdio import StdioServerParameters
from pydantic import ValidationError

from agent_board_srv import create_server
from models import HelpPage, ToolGuide

TOOLS = {
    "create_subject", "list_subjects", "get_subject", "get_message", "post_message",
    "read_messages", "search", "addressed_to_me", "help",
}


async def call(client: Client, name: str, **arguments: Any) -> dict[str, Any]:
    result = await client.call_tool(name, arguments)
    assert not result.is_error, result.content
    assert result.structured_content is not None
    return cast(dict[str, Any], result.structured_content)


def test_overview_matches_live_metadata_without_writing(tmp_path: Path) -> None:
    async def check() -> None:
        async with Client(create_server(tmp_path / "board.sqlite3")) as client:
            page = await call(client, "help")
            assert page["topic"] == "overview"
            assert page["description"] and page["notes"]
            assert {guide["name"] for guide in page["tools"]} == TOOLS
            for tool in (await client.list_tools()).tools:
                guide = next(guide for guide in page["tools"] if guide["name"] == tool.name)
                assert guide == {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                }
            assert (await call(client, "list_subjects"))["subjects"] == []

    asyncio.run(check())


@pytest.mark.parametrize("topic", sorted(TOOLS))
def test_individual_tool_guides(tmp_path: Path, topic: str) -> None:
    async def check() -> None:
        async with Client(create_server(tmp_path / "board.sqlite3")) as client:
            page = await call(client, "help", topic=f" {topic} ")
            assert page["topic"] == topic
            assert [guide["name"] for guide in page["tools"]] == [topic]

    asyncio.run(check())


@pytest.mark.parametrize(
    ("topic", "expected"),
    [
        ("subjects", {"create_subject", "list_subjects", "get_subject", "search"}),
        ("threads", {"post_message", "read_messages", "get_message"}),
        ("pagination", {"list_subjects", "read_messages", "search", "addressed_to_me"}),
        ("conclusions", {"post_message", "read_messages", "get_message"}),
        ("storage", set()),
        ("authors", {"create_subject", "post_message", "addressed_to_me"}),
    ],
)
def test_focused_usage_guides(tmp_path: Path, topic: str, expected: set[str]) -> None:
    async def check() -> None:
        async with Client(create_server(tmp_path / "board.sqlite3")) as client:
            page = await call(client, "help", topic=topic)
            assert {guide["name"] for guide in page["tools"]} == expected
            assert page["notes"]
            assert topic in page["available_topics"]

    asyncio.run(check())


@pytest.mark.parametrize("topic", ["unknown", "", " \t\n"])
def test_invalid_topics_list_choices(tmp_path: Path, topic: str) -> None:
    async def check() -> None:
        async with Client(create_server(tmp_path / "board.sqlite3")) as client:
            result = await client.call_tool("help", {"topic": topic})
            assert result.is_error
            assert "choose one of:" in str(result.content)
            for choice in (await call(client, "help"))["available_topics"]:
                assert choice in str(result.content)

    asyncio.run(check())


def test_help_models_are_closed_and_frozen() -> None:
    guide = ToolGuide(name="help", description="Guide", input_schema={})
    page = HelpPage(
        topic="help", description="Guide", tools=[guide], notes=[], available_topics=["help"]
    )
    for model in (guide, page):
        assert model.model_json_schema()["additionalProperties"] is False
        with pytest.raises(ValidationError):
            type(model).model_validate({**model.model_dump(), "extra": True})
        with pytest.raises(ValidationError):
            model.description = "Changed"


def test_help_over_stdio(tmp_path: Path) -> None:
    async def check() -> None:
        params = StdioServerParameters(
            command=sys.executable,
            args=[str(Path(__file__).resolve().parents[1] / "agent_board_srv.py"), "--db",
                  str(tmp_path / "board.sqlite3")],
            cwd=str(tmp_path),
        )
        async with Client(params) as client:
            page = await call(client, "help", topic="pagination")
            assert page["topic"] == "pagination"
            assert page["notes"]
            assert "help" in page["available_topics"]

    asyncio.run(check())
