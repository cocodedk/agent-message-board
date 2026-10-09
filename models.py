"""The board's input constraints and closed response shapes."""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Id = Annotated[int, Field(gt=0, le=2**63 - 1, strict=True)]
Cursor = Annotated[int, Field(ge=0, le=2**63 - 1, strict=True)]
Limit = Annotated[int, Field(ge=1, le=100, strict=True)]
Author = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Body = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20000)]
Kind = Literal["message", "proposal", "challenge", "conclusion"]
Order = Literal["asc", "desc"]
Scope = Literal["subjects", "messages"]
Query = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ToolGuide(Record):
    name: str
    description: str
    input_schema: dict[str, Any]


class HelpPage(Record):
    topic: str
    description: str
    tools: list[ToolGuide]
    notes: list[str]
    available_topics: list[str]


class Subject(Record):
    id: Id
    title: Title
    description: Body
    author: Author
    created_at: str


class Message(Record):
    id: Id
    subject_id: Id
    parent_id: Id | None
    author: Author
    body: Body
    kind: Kind
    created_at: str


class SubjectPage(Record):
    subjects: list[Subject]
    next_after_id: Id | None


class MessagePage(Record):
    messages: list[Message]
    next_after_id: Id | None


class SearchPage(Record):
    scope: Scope
    subjects: list[Subject]
    messages: list[Message]
    next_after_id: Id | None
