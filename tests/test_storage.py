import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

import pytest

from models import MessagePage
from storage import Board


@pytest.fixture
def board(tmp_path: Path) -> Board:
    return Board(tmp_path / "board.sqlite3")


@pytest.fixture
def subject_id(board: Board) -> int:
    return board.create_subject("Which approach?", "Compare evidence and tradeoffs.", "agent-a").id


def test_persistence(board: Board, subject_id: int) -> None:
    original = board.post_message(subject_id, "agent-b", "A proposal", None, "proposal")
    restored = Board(board.path)
    assert restored.get_subject(subject_id).title == "Which approach?"
    assert restored.get_message(original.id) == original
    assert original.created_at.endswith("Z")


def test_nested_threads_and_conclusions(board: Board, subject_id: int) -> None:
    root = board.post_message(subject_id, "a", "Try A", None, "proposal")
    reply = board.post_message(subject_id, "b", "Why A?", root.id, "challenge")
    conclusion = board.post_message(subject_id, "c", "Because evidence X", reply.id, "conclusion")
    challenge = board.post_message(subject_id, "d", "New evidence Y", conclusion.id, "challenge")
    other = board.post_message(subject_id, "e", "Try B", None, "proposal")
    assert board.read_messages(subject_id, 0, 50, None, True, None).messages == [root, other]
    assert board.read_messages(subject_id, 0, 50, root.id, False, None).messages == [reply]
    assert board.read_messages(subject_id, 0, 50, reply.id, False, None).messages == [conclusion]
    assert board.read_messages(subject_id, 0, 50, conclusion.id, False, None).messages == [
        challenge
    ]
    assert board.read_messages(subject_id, 0, 50, None, False, "conclusion").messages == [
        conclusion
    ]


def test_subject_pagination(board: Board, subject_id: int) -> None:
    second = board.create_subject("Second", "Question 2", "b")
    third = board.create_subject("Third", "Question 3", "c")
    first_page = board.list_subjects(0, 2, "asc")
    assert [s.id for s in first_page.subjects] == [subject_id, second.id]
    assert first_page.next_after_id == second.id
    last_page = board.list_subjects(second.id, 2, "asc")
    assert last_page.subjects == [third]
    assert last_page.next_after_id is None


def test_message_pagination_with_interleaved_subjects(board: Board, subject_id: int) -> None:
    other_id = board.create_subject("Other", "Separate discussion", "b").id
    messages = []
    for index in range(5):
        messages.append(board.post_message(subject_id, "a", str(index), None, "message"))
        board.post_message(other_id, "b", "Other", None, "message")
    collected = []
    after_id = 0
    while True:
        page = board.read_messages(subject_id, after_id, 2, None, False, None)
        collected.extend(page.messages)
        if page.next_after_id is None:
            break
        after_id = page.next_after_id
    assert collected == messages
    assert board.read_messages(subject_id, messages[-1].id, 2, None, False, None).messages == []


def test_receiver_is_optional(board: Board, subject_id: int) -> None:
    broadcast = board.post_message(subject_id, "a", "To everyone", None, "message")
    direct = board.post_message(subject_id, "b", "To a", broadcast.id, "message", "a")
    assert (broadcast.author, broadcast.receiver) == ("a", None)
    assert (direct.author, direct.receiver) == ("b", "a")
    assert board.get_message(direct.id) == direct


def test_addressed_to_spans_subjects_and_paginates(board: Board, subject_id: int) -> None:
    other_id = board.create_subject("Other", "Question", "b").id
    first = board.post_message(subject_id, "b", "One", None, "message", "a")
    board.post_message(subject_id, "b", "To c", None, "message", "c")
    board.post_message(subject_id, "b", "To everyone", None, "message")
    second = board.post_message(other_id, "c", "Two", None, "proposal", "a")
    third = board.post_message(other_id, "b", "Three", second.id, "challenge", "a")
    page = board.addressed_to("a", 0, 2)
    assert page.messages == [first, second]
    assert page.next_after_id == second.id
    last = MessagePage(messages=[third], next_after_id=None)
    assert board.addressed_to("a", second.id, 2) == last
    assert board.addressed_to("a", 0, 50, "desc").messages == [third, second, first]
    assert board.addressed_to("nobody", 0, 50).messages == []
    with pytest.raises(ValueError, match="addressed to the requested receiver"):
        board.addressed_to("c", first.id, 50)


def create_old_database(path: Path) -> None:
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript(
            "CREATE TABLE subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,"
            " description TEXT NOT NULL, author TEXT NOT NULL,"
            " created_at TEXT NOT NULL DEFAULT 'then') STRICT;"
            "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " subject_id INTEGER NOT NULL, parent_id INTEGER, author TEXT NOT NULL,"
            " body TEXT NOT NULL, kind TEXT NOT NULL,"
            " created_at TEXT NOT NULL DEFAULT 'then', UNIQUE (id, subject_id)) STRICT;"
            "INSERT INTO subjects (title, description, author) VALUES ('Old', 'Question', 'a');"
            "INSERT INTO messages (subject_id, author, body, kind)"
            " VALUES (1, 'a', 'Old', 'message');"
        )


def test_existing_database_gains_receiver_column(tmp_path: Path) -> None:
    path = tmp_path / "old.sqlite3"
    create_old_database(path)
    board = Board(path)
    assert board.get_message(1).receiver is None
    assert board.post_message(1, "b", "New", 1, "message", "a").receiver == "a"
    with board.connect() as db, pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        db.execute(
            "INSERT INTO messages (subject_id, author, receiver, body, kind) "
            "VALUES (1, 'a', ' ', 'Blank receiver', 'message')"
        )


def test_missing_subject_rejected(board: Board) -> None:
    with pytest.raises(ValueError, match="Subject 1 does not exist"):
        board.post_message(1, "a", "Hello", None, "message")
    assert board.list_subjects(0, 10).subjects == []


def test_missing_parent_rejected(board: Board, subject_id: int) -> None:
    with pytest.raises(ValueError, match="Message 999 does not exist"):
        board.post_message(subject_id, "a", "Reply", 999, "message")


def test_cross_subject_parent_rejected(board: Board, subject_id: int) -> None:
    parent = board.post_message(subject_id, "a", "Hello", None, "message")
    other_id = board.create_subject("Other", "Question", "b").id
    with pytest.raises(ValueError, match="same subject"):
        board.post_message(other_id, "b", "Reply", parent.id, "message")
    with pytest.raises(ValueError, match="same subject"):
        board.read_messages(other_id, 0, 50, parent.id, False, None)


def test_conflicting_filters_rejected(board: Board, subject_id: int) -> None:
    root = board.post_message(subject_id, "a", "Hello", None, "message")
    with pytest.raises(ValueError, match="not both"):
        board.read_messages(subject_id, 0, 50, root.id, True, None)


@pytest.mark.parametrize("table", ["subjects", "messages"])
@pytest.mark.parametrize("operation", ["UPDATE", "DELETE", "REPLACE"])
def test_database_is_append_only(board: Board, subject_id: int, table: str, operation: str) -> None:
    message = board.post_message(subject_id, "a", "Original", None, "message")
    record_id = subject_id if table == "subjects" else message.id
    with board.connect() as db:
        before = dict(db.execute(f"SELECT * FROM {table} WHERE id = ?", (record_id,)).fetchone())
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            if operation == "UPDATE":
                db.execute(f"UPDATE {table} SET author = 'changed' WHERE id = ?", (record_id,))
            elif operation == "DELETE":
                db.execute(f"DELETE FROM {table} WHERE id = ?", (record_id,))
            else:
                db.execute(
                    f"INSERT OR REPLACE INTO {table} SELECT * FROM {table} WHERE id = ?",
                    (record_id,),
                )
        after = dict(db.execute(f"SELECT * FROM {table} WHERE id = ?", (record_id,)).fetchone())
    assert after == before


def test_database_rejects_cross_subject_insert(board: Board, subject_id: int) -> None:
    root = board.post_message(subject_id, "a", "Root", None, "message")
    other_id = board.create_subject("Other", "Question", "b").id
    with board.connect() as db, pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        db.execute(
            "INSERT INTO messages (subject_id, parent_id, author, body, kind) "
            "VALUES (?, ?, 'a', 'Invalid', 'message')",
            (other_id, root.id),
        )


def test_concurrent_opens_migrate_an_old_database_once(tmp_path: Path) -> None:
    for round_ in range(5):
        path = tmp_path / f"old-{round_}.sqlite3"
        create_old_database(path)
        with ThreadPoolExecutor(max_workers=8) as workers:
            boards = list(workers.map(Board, [path] * 8))
        assert boards[0].get_message(1).receiver is None


def test_concurrent_writers_preserve_all_messages(board: Board, subject_id: int) -> None:
    def post(index: int) -> int:
        return board.post_message(subject_id, f"agent-{index}", str(index), None, "message").id

    with ThreadPoolExecutor(max_workers=8) as workers:
        ids = list(workers.map(post, range(32)))
    page = board.read_messages(subject_id, 0, 100, None, False, None)
    assert len(set(ids)) == len(page.messages) == 32
    assert {m.body for m in page.messages} == {str(i) for i in range(32)}
