export const PAGE_SIZE = 10;
export const PREVIEW_LENGTH = 160;

export function preview(text) {
  const characters = Array.from(text);
  return characters.length > PREVIEW_LENGTH
    ? `${characters.slice(0, PREVIEW_LENGTH).join('')}…` : text;
}

export const subjectSummary = ({id, title, author, created_at}) => ({id, title, author, created_at});
export function messagePreview({id, subject_id, parent_id, author, kind, created_at, body}) {
  const abbreviated = preview(body);
  return {id, subject_id, parent_id, author, kind, created_at, body: abbreviated, truncated: abbreviated !== body};
}

export function overview(state) {
  return {
    subject_query: state.subject_query, subject_order: state.subject_order,
    subject: state.subject ? subjectSummary(state.subject) : null,
    subject_count: state.subjects.length, next_subject_cursor: state.next_subject_cursor,
    message_query: state.message_query, message_order: state.message_order,
    message_count: state.messages.length, next_message_cursor: state.next_message_cursor,
    context_anchor_id: state.context_anchor_id ?? null,
    context: state.context ? {id: state.context.id, parent_id: state.context.parent_id} : null,
  };
}
