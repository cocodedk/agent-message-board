import asyncio
import sys
from pathlib import Path

import pytest
from mcp import Client
from mcp.client.stdio import StdioServerParameters

from models import Order, Scope
from server import create_server
from storage import Board

DATES = [
    "2026-10-03T00:00:00Z",
    "2026-10-01T00:00:00Z",
    "2026-10-01T00:00:00Z",
    "2026-10-02T00:00:00Z",
]


def dated_subjects(board: Board) -> list[int]:
    with board.connect() as db:
        for date in DATES:
            db.execute(
                "INSERT INTO subjects (title, description, author, created_at) VALUES (?, ?, ?, ?)",
                ("SQLite choice", "Searchable question", "a", date),
            )
    return [subject.id for subject in board.list_subjects(0, 100, "asc").subjects]


@pytest.mark.parametrize("order", ["asc", "desc"])
def test_subjects_are_paginated_by_date_with_stable_ties(tmp_path: Path, order: Order) -> None:
    board = Board(tmp_path / "board.sqlite3")
    expected = dated_subjects(board)
    assert expected == [2, 3, 4, 1]
    if order == "desc":
        expected.reverse()
    page = board.list_subjects(0, 2, order)
    assert [subject.id for subject in page.subjects] == expected[:2]
    assert page.next_after_id == expected[1]
    page = board.list_subjects(page.next_after_id, 2, order)
    assert [subject.id for subject in page.subjects] == expected[2:]
    assert page.next_after_id is None
    assert board.list_subjects(expected[-1], 2, order).subjects == []
    assert [s.id for s in board.list_subjects(0, 100).subjects] == [1, 4, 3, 2]


def dated_messages(board: Board, rows: list[tuple[int, str]]) -> None:
    with board.connect() as db:
        for subject_id, date in rows:
            db.execute(
                "INSERT INTO messages (subject_id, author, body, kind, created_at) "
                "VALUES (?, 'a', 'Reply', 'message', ?)",
                (subject_id, date),
            )


def test_subject_summaries_count_messages_and_last_message_at(tmp_path: Path) -> None:
    board = Board(tmp_path / "board.sqlite3")
    dated_subjects(board)
    dated_messages(board, [(3, "2026-10-01T12:00:00Z"), (3, "2026-10-02T00:00:00Z")])
    for order in ("asc", "desc", "activity"):
        summaries = {s.id: s for s in board.list_subjects(0, 100, order).subjects}
        assert summaries[3].message_count == 2
        assert summaries[3].last_message_at == "2026-10-02T00:00:00Z"
        assert summaries[1].message_count == 0
        assert summaries[1].last_message_at is None


def test_activity_order_ranks_recent_messages_first_and_paginates(tmp_path: Path) -> None:
    board = Board(tmp_path / "board.sqlite3")
    dated_subjects(board)
    dated_messages(
        board,
        [(2, "2026-10-05T00:00:00Z"), (3, "2026-10-01T12:00:00Z"), (3, "2026-10-02T00:00:00Z")],
    )
    expected = [2, 1, 4, 3]
    assert [s.id for s in board.list_subjects(0, 100, "activity").subjects] == expected
    seen, cursor = [], 0
    while True:
        page = board.list_subjects(cursor, 1, "activity")
        seen += [subject.id for subject in page.subjects]
        if page.next_after_id is None:
            break
        cursor = page.next_after_id
    assert seen == expected
    page = board.list_subjects(0, 3, "activity")
    assert page.next_after_id == 4
    assert [s.id for s in board.list_subjects(4, 3, "activity").subjects] == [3]


def test_subject_search_matches_fields_and_treats_wildcards_literally(tmp_path: Path) -> None:
    board = Board(tmp_path / "board.sqlite3")
    title = board.create_subject("SQLite at 100%", "A literal _ marker", "a")
    description = board.create_subject("Other", "sqlite discussion", "b")
    unrelated = board.create_subject("Empty", "Nothing matches", "c")
    page = board.search("SQLITE")
    assert {subject.id for subject in page.subjects} == {title.id, description.id}
    assert page.messages == []
    assert unrelated.id not in {subject.id for subject in page.subjects}
    for query in ("100%", "_"):
        assert board.search(query).subjects == [title]
    assert board.search("' OR 1=1 --").subjects == []


@pytest.mark.parametrize("scope", ["subjects", "messages"])
@pytest.mark.parametrize("order", ["asc", "desc"])
def test_search_pagination_uses_dates_and_filters(
    tmp_path: Path, scope: Scope, order: Order
) -> None:
    board = Board(tmp_path / "board.sqlite3")
    if scope == "subjects":
        dated_subjects(board)
        board.create_subject("Unrelated", "Ignore", "a")
    else:
        subject_id = board.create_subject("Container", "Question", "a").id
        with board.connect() as db:
            for date in DATES:
                db.execute(
                    "INSERT INTO messages (subject_id, author, body, kind, created_at) "
                    "VALUES (?, 'a', 'SQLite choice', 'message', ?)",
                    (subject_id, date),
                )
        board.post_message(subject_id, "b", "Unrelated", None, "message")
    expected = [2, 3, 4, 1] if order == "asc" else [1, 4, 3, 2]
    found: list[int] = []
    cursor = 0
    while True:
        page = board.search("sqlite", scope=scope, after_id=cursor, limit=1, order=order)
        assert page.scope == scope
        assert not (page.messages if scope == "subjects" else page.subjects)
        found.extend(record.id for record in (page.subjects or page.messages))
        if page.next_after_id is None:
            break
        cursor = page.next_after_id
    assert found == expected


def test_message_search_can_be_restricted_to_one_subject(tmp_path: Path) -> None:
    board = Board(tmp_path / "board.sqlite3")
    one = board.create_subject("First", "Question", "a")
    two = board.create_subject("Second", "Question", "b")
    first = board.post_message(one.id, "a", "SQLite proposal", None, "proposal")
    second = board.post_message(two.id, "b", "sqlite conclusion", None, "conclusion")
    assert {m.id for m in board.search("sqlite", "messages").messages} == {first.id, second.id}
    assert board.search("sqlite", "messages", one.id).messages == [first]
    with pytest.raises(ValueError, match="requested subject"):
        board.search("sqlite", "messages", one.id, after_id=second.id)
    with pytest.raises(ValueError, match="Subject 999 does not exist"):
        board.search("sqlite", "messages", 999)
    with pytest.raises(ValueError, match="only supported"):
        board.search("sqlite", subject_id=one.id)


@pytest.mark.parametrize("scope", ["subjects", "messages"])
def test_missing_search_cursor_is_rejected(tmp_path: Path, scope: Scope) -> None:
    with pytest.raises(ValueError, match="does not exist"):
        Board(tmp_path / "board.sqlite3").search("sqlite", scope, after_id=999)


@pytest.mark.parametrize(
    "name, arguments",
    [
        ("list_subjects", {"order": "invalid"}),
        ("list_subjects", {"after_id": 999}),
        ("search", {"query": " "}),
        ("search", {"query": "x" * 201}),
        ("search", {"query": "sqlite", "scope": "invalid"}),
        ("search", {"query": "sqlite", "limit": 101}),
        ("search", {"query": "sqlite", "order": "invalid"}),
        ("search", {"query": "sqlite", "scope": "subjects", "subject_id": 1}),
    ],
)
def test_discovery_arguments_rejected_via_mcp(
    tmp_path: Path, name: str, arguments: dict[str, str | int]
) -> None:
    async def check() -> None:
        async with Client(create_server(tmp_path / "board.sqlite3")) as client:
            assert (await client.call_tool(name, arguments)).is_error

    asyncio.run(check())


def test_date_listing_and_search_through_stdio_mcp(tmp_path: Path) -> None:
    async def check() -> None:
        params = StdioServerParameters(
            command=sys.executable,
            args=[
                str(Path(__file__).resolve().parents[1] / "server.py"),
                "--db",
                str(tmp_path / "board.sqlite3"),
            ],
        )
        async with Client(params) as client:
            ids = []
            for title in ("SQLite proposal", "Other", "SQLite conclusion"):
                result = await client.call_tool(
                    "create_subject",
                    {"title": title, "description": "Compare choices", "author": "a"},
                )
                assert not result.is_error
                assert result.structured_content is not None
                ids.append(result.structured_content["id"])
            result = await client.call_tool("list_subjects", {"limit": 1})
            assert not result.is_error
            assert result.structured_content is not None
            assert result.structured_content["subjects"][0]["id"] == ids[-1]
            assert result.structured_content["next_after_id"] == ids[-1]
            result = await client.call_tool(
                "search", {"query": "sqlite", "limit": 1, "order": "asc"}
            )
            assert not result.is_error
            assert result.structured_content is not None
            assert result.structured_content["subjects"][0]["id"] == ids[0]
            cursor = result.structured_content["next_after_id"]
            result = await client.call_tool(
                "search", {"query": "sqlite", "limit": 1, "order": "asc", "after_id": cursor}
            )
            assert not result.is_error
            assert result.structured_content is not None
            assert result.structured_content["subjects"][0]["id"] == ids[-1]
            assert result.structured_content["next_after_id"] is None

    asyncio.run(check())
