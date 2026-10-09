PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 20000),
    author TEXT NOT NULL CHECK (length(trim(author)) BETWEEN 1 AND 100),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    parent_id INTEGER,
    author TEXT NOT NULL CHECK (length(trim(author)) BETWEEN 1 AND 100),
    body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 20000),
    kind TEXT NOT NULL CHECK (kind IN ('message', 'proposal', 'challenge', 'conclusion')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (id, subject_id),
    FOREIGN KEY (parent_id, subject_id) REFERENCES messages(id, subject_id),
    CHECK (parent_id IS NULL OR parent_id < id)
) STRICT;

CREATE INDEX IF NOT EXISTS messages_subject ON messages(subject_id, id);
CREATE INDEX IF NOT EXISTS messages_parent ON messages(subject_id, parent_id, id);
CREATE INDEX IF NOT EXISTS messages_kind ON messages(subject_id, kind, id);
CREATE INDEX IF NOT EXISTS subjects_date ON subjects(created_at, id);
CREATE INDEX IF NOT EXISTS messages_date ON messages(created_at, id);
CREATE INDEX IF NOT EXISTS messages_subject_date ON messages(subject_id, created_at, id);

CREATE TRIGGER IF NOT EXISTS subjects_no_replace BEFORE INSERT ON subjects
WHEN EXISTS (SELECT 1 FROM subjects WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Subjects are append-only'); END;

CREATE TRIGGER IF NOT EXISTS messages_no_replace BEFORE INSERT ON messages
WHEN EXISTS (SELECT 1 FROM messages WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Messages are append-only'); END;

CREATE TRIGGER IF NOT EXISTS subjects_no_update BEFORE UPDATE ON subjects
BEGIN SELECT RAISE(ABORT, 'Subjects are append-only'); END;

CREATE TRIGGER IF NOT EXISTS subjects_no_delete BEFORE DELETE ON subjects
BEGIN SELECT RAISE(ABORT, 'Subjects are append-only'); END;

CREATE TRIGGER IF NOT EXISTS messages_no_update BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'Messages are append-only'); END;

CREATE TRIGGER IF NOT EXISTS messages_no_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'Messages are append-only'); END;
