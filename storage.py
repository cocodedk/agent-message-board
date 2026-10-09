"""Small SQLite store with short transactions and cursor-based reads."""

import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path

from models import Kind, Message, MessagePage, Order, Scope, SearchPage, Subject, SubjectPage


class Board:
    def __init__(self, path: Path) -> None:
        self.path = path.expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript(Path(__file__).with_name("schema.sql").read_text())

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        with closing(sqlite3.connect(self.path, timeout=10)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            with db:
                yield db

    @staticmethod
    def require_subject(db: sqlite3.Connection, subject_id: int) -> Subject:
        row = db.execute("SELECT * FROM subjects WHERE id = ?", (subject_id,)).fetchone()
        if row is None:
            raise ValueError(f"Subject {subject_id} does not exist")
        return Subject.model_validate(dict(row))

    @staticmethod
    def require_message(db: sqlite3.Connection, message_id: int) -> Message:
        row = db.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        if row is None:
            raise ValueError(f"Message {message_id} does not exist")
        return Message.model_validate(dict(row))

    def create_subject(self, title: str, description: str, author: str) -> Subject:
        with self.connect() as db:
            row = db.execute(
                "INSERT INTO subjects (title, description, author) VALUES (?, ?, ?) RETURNING *",
                (title, description, author),
            ).fetchone()
            assert row is not None
            return Subject.model_validate(dict(row))

    @staticmethod
    def date_rows(
        db: sqlite3.Connection,
        table: Scope,
        cursor: Subject | Message | None,
        limit: int,
        order: Order,
        where: str = "1",
        params: tuple[int | str, ...] = (),
    ) -> list[sqlite3.Row]:
        direction = "ASC" if order == "asc" else "DESC"
        comparison = ">" if order == "asc" else "<"
        if cursor is not None:
            where += f" AND (created_at, id) {comparison} (?, ?)"
            params += (cursor.created_at, cursor.id)
        return db.execute(
            f"SELECT * FROM {table} WHERE {where} "
            f"ORDER BY created_at {direction}, id {direction} LIMIT ?",
            (*params, limit + 1),
        ).fetchall()

    def list_subjects(self, after_id: int, limit: int, order: Order = "desc") -> SubjectPage:
        with self.connect() as db:
            cursor = self.require_subject(db, after_id) if after_id else None
            rows = self.date_rows(db, "subjects", cursor, limit, order)
        subjects = [Subject.model_validate(dict(row)) for row in rows[:limit]]
        return SubjectPage(
            subjects=subjects,
            next_after_id=subjects[-1].id if len(rows) > limit else None,
        )

    def search(
        self,
        query: str,
        scope: Scope = "subjects",
        subject_id: int | None = None,
        after_id: int = 0,
        limit: int = 50,
        order: Order = "desc",
    ) -> SearchPage:
        with self.connect() as db:
            cursor: Subject | Message | None = None
            params: tuple[int | str, ...] = (query,)
            if scope == "subjects":
                if subject_id is not None:
                    raise ValueError("subject_id is only supported when scope is messages")
                table: Scope = "subjects"
                where = "(instr(lower(title), lower(?)) > 0 OR "
                where += "instr(lower(description), lower(?)) > 0)"
                params += (query,)
                if after_id:
                    cursor = self.require_subject(db, after_id)
            else:
                table = "messages"
                where = "instr(lower(body), lower(?)) > 0"
                if subject_id is not None:
                    self.require_subject(db, subject_id)
                    where += " AND subject_id = ?"
                    params += (subject_id,)
                if after_id:
                    cursor = self.require_message(db, after_id)
                    if subject_id is not None and cursor.subject_id != subject_id:
                        raise ValueError("Search cursor must belong to the requested subject")
            rows = self.date_rows(db, table, cursor, limit, order, where, params)
        return SearchPage(
            scope=scope,
            subjects=[Subject.model_validate(dict(row)) for row in rows[:limit]]
            if scope == "subjects"
            else [],
            messages=[Message.model_validate(dict(row)) for row in rows[:limit]]
            if scope == "messages"
            else [],
            next_after_id=rows[limit - 1]["id"] if len(rows) > limit else None,
        )

    def get_subject(self, subject_id: int) -> Subject:
        with self.connect() as db:
            return self.require_subject(db, subject_id)

    def get_message(self, message_id: int) -> Message:
        with self.connect() as db:
            return self.require_message(db, message_id)

    def post_message(
        self, subject_id: int, author: str, body: str, parent_id: int | None, kind: Kind
    ) -> Message:
        with self.connect() as db:
            self.require_subject(db, subject_id)
            if parent_id is not None:
                parent = self.require_message(db, parent_id)
                if parent.subject_id != subject_id:
                    raise ValueError("Parent message must belong to the same subject")
            row = db.execute(
                "INSERT INTO messages (subject_id, parent_id, author, body, kind) "
                "VALUES (?, ?, ?, ?, ?) RETURNING *",
                (subject_id, parent_id, author, body, kind),
            ).fetchone()
            assert row is not None
            return Message.model_validate(dict(row))

    def read_messages(
        self,
        subject_id: int,
        after_id: int,
        limit: int,
        parent_id: int | None,
        roots_only: bool,
        kind: Kind | None,
    ) -> MessagePage:
        if roots_only and parent_id is not None:
            raise ValueError("Use either roots_only or parent_id, not both")
        where = "subject_id = ? AND id > ?"
        params: list[int | str] = [subject_id, after_id]
        with self.connect() as db:
            self.require_subject(db, subject_id)
            if parent_id is not None:
                parent = self.require_message(db, parent_id)
                if parent.subject_id != subject_id:
                    raise ValueError("Parent message must belong to the same subject")
                where += " AND parent_id = ?"
                params.append(parent_id)
            elif roots_only:
                where += " AND parent_id IS NULL"
            if kind is not None:
                where += " AND kind = ?"
                params.append(kind)
            rows = db.execute(
                f"SELECT * FROM messages WHERE {where} ORDER BY id LIMIT ?", [*params, limit + 1]
            ).fetchall()
        messages = [Message.model_validate(dict(row)) for row in rows[:limit]]
        return MessagePage(
            messages=messages,
            next_after_id=messages[-1].id if len(rows) > limit else None,
        )
