import asyncio
from pathlib import Path
from typing import Literal

import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from server import create_server


@pytest.mark.parametrize("mode", ["auto", "legacy"])
def test_http_discovery_and_posting(tmp_path: Path, mode: Literal["auto", "legacy"]) -> None:
    async def check() -> None:
        mcp = create_server(tmp_path / "board.sqlite3")
        app = mcp.streamable_http_app(json_response=True)
        async with app.router.lifespan_context(app):
            async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app)) as http:
                transport = streamable_http_client("http://127.0.0.1:8000/mcp", http_client=http)
                async with Client(transport, mode=mode) as client:
                    assert len((await client.list_tools()).tools) == 9
                    result = await client.call_tool(
                        "create_subject",
                        {
                            "title": "HTTP works?",
                            "description": "Verify both protocol eras",
                            "author": "a",
                        },
                    )
                    assert not result.is_error
                    assert result.structured_content is not None
                    subject_id = result.structured_content["id"]
                    result = await client.call_tool(
                        "post_message",
                        {
                            "subject_id": subject_id,
                            "author": "b",
                            "body": "Confirmed",
                            "kind": "conclusion",
                        },
                    )
                    assert not result.is_error
                    result = await client.call_tool("read_messages", {"subject_id": subject_id})
                    assert result.structured_content is not None
                    assert result.structured_content["messages"][0]["body"] == "Confirmed"
                    result = await client.call_tool(
                        "search",
                        {
                            "query": "CONFIRM",
                            "scope": "messages",
                            "subject_id": subject_id,
                            "limit": 1,
                        },
                    )
                    assert not result.is_error
                    assert result.structured_content is not None
                    assert result.structured_content["messages"][0]["body"] == "Confirmed"

    asyncio.run(check())
