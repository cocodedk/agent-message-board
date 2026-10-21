export const PAGE_SIZE = 10;
export const PREVIEW_LENGTH = 160;
export const TREE_LIMIT = 20;

export function preview(text) {
  const characters = Array.from(text);
  return characters.length > PREVIEW_LENGTH
    ? `${characters.slice(0, PREVIEW_LENGTH).join('')}…` : text;
}

// One index per loaded conversation array: message lookup and children in posting order.
const indexes = new WeakMap();
function conversationIndex(rows) {
  let index = indexes.get(rows);
  if (!index) {
    const byId = new Map(rows.map((row) => [row.id, row])), children = new Map();
    for (const row of rows) {
      if (row.parent_id === null) continue;
      if (!children.has(row.parent_id)) children.set(row.parent_id, []);
      children.get(row.parent_id).push(row);
    }
    index = {byId, children};
    indexes.set(rows, index);
  }
  return index;
}

const newest = (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id;
export function sortedRoots(rows, order) {
  const roots = rows.filter((row) => row.parent_id === null).toSorted(newest);
  return order === 'asc' ? roots.toReversed() : roots;
}

// The message and all its descendants, depth first, with depth 0 for the message itself.
export function threadRows(rows, id) {
  const {byId, children} = conversationIndex(rows);
  const start = byId.get(id);
  if (!start) return [];
  const result = [], stack = [[start, 0]];
  while (stack.length) {
    const [message, depth] = stack.pop();
    result.push({message, depth});
    const replies = children.get(message.id) ?? [];
    for (let i = replies.length - 1; i >= 0; i -= 1) stack.push([replies[i], depth + 1]);
  }
  return result;
}

export const replyCount = (rows, id) => Math.max(0, threadRows(rows, id).length - 1);

export function rootOf(rows, id) {
  const {byId} = conversationIndex(rows);
  let message = byId.get(id);
  while (message && message.parent_id !== null && byId.has(message.parent_id)) message = byId.get(message.parent_id);
  return message ?? null;
}

export const subjectSummary = ({id, title, author, created_at, message_count, last_message_at}) => ({
  id, title, author, created_at, message_count: message_count ?? null, last_message_at: last_message_at ?? null});
export function messagePreview({id, subject_id, parent_id, author, receiver, kind, created_at, body}) {
  const abbreviated = preview(body);
  return {id, subject_id, parent_id, author, receiver, kind, created_at, body: abbreviated, truncated: abbreviated !== body};
}
export const listPreview = (state, message) => ({...messagePreview(message), reply_count: replyCount(state.conversation, message.id)});

export function overview(state) {
  return {
    view: state.subject ? 'subject' : 'subjects',
    subject_query: state.subject_query, subject_order: state.subject_order,
    subject_count: state.subjects.length, next_subject_cursor: state.next_subject_cursor,
    subject: state.subject ? subjectSummary(state.subject) : null,
    description_open: state.description_open ?? false,
    conversation_count: state.conversation.length,
    thread_count: state.conversation.filter((row) => row.parent_id === null).length,
    message_view: state.message_query ? 'search' : 'threads',
    message_query: state.message_query, message_order: state.message_order,
    message_count: state.messages.length, next_message_cursor: state.next_message_cursor,
    open_threads: [...state.open_threads], focus_id: state.focus_id,
  };
}
