import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BoardReader} from '../viewer/board.js';
import {registerWebMcp} from '../viewer/webmcp.js';
import {replyCount, rootOf, threadRows} from '../viewer/content.js';

const subject = (id) => ({id, title: `Subject ${id}`, description: 'Question', author: 'a', created_at: '2026-10-01T00:00:00Z'});
const message = (id, parent_id = null, subject_id = 1) => ({id, parent_id, subject_id, author: 'a', receiver: null, kind: 'message',
  created_at: '2026-10-01T00:00:00Z', body: `Evidence ${id}: ${'long '.repeat(100)}END_${id}`});
// Subject 1: root 1 has a reply chain 2 → 3 and twenty direct replies 6..25; root 4 has none;
// roots 26..40 make two pages of root threads. Message 5 belongs to subject 2.
async function fixture() {
  const calls = [], tools = [];
  const messages = [message(1), message(2, 1), message(3, 2), message(4), message(5, null, 2),
    ...Array.from({length: 20}, (_, i) => message(i + 6, 1)), ...Array.from({length: 15}, (_, i) => message(i + 26))];
  const reader = new BoardReader({async call(name, args) {
    calls.push({name, args});
    if (name === 'get_subject') return subject(args.subject_id);
    if (name === 'list_subjects') return {subjects: [subject(1), subject(2)], next_after_id: null};
    let rows = messages.filter((row) => row.subject_id === args.subject_id);
    if (name === 'search') rows = rows.filter((row) => row.body.includes(args.query));
    rows.sort((a, b) => args.order === 'asc' ? a.id - b.id : b.id - a.id);
    if (args.after_id) rows = rows.filter((row) => args.order === 'asc' ? row.id > args.after_id : row.id < args.after_id);
    return {messages: rows.slice(0, args.limit), next_after_id: rows.length > args.limit ? rows[args.limit - 1].id : null};
  }});
  await registerWebMcp(reader, {modelContext: {registerTool: (tool) => {tools.push(tool);}}});
  const call = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args);
  return {reader, calls, call, messages};
}

test('opening a subject reads its whole conversation in ascending pages of one hundred', async () => {
  const {reader, calls} = await fixture();
  const original = reader.client.call;
  reader.client.call = (name, args) => name === 'read_messages' && args.after_id === 0
    ? Promise.resolve({messages: [message(1), message(2, 1)], next_after_id: 2}) : original(name, args);
  await reader.openSubject(1);
  assert.deepEqual(calls.filter((row) => row.name === 'read_messages').map((row) => row.args),
    [{subject_id: 1, after_id: 2, limit: 100, order: 'asc'}]);
  assert.equal(reader.state.conversation.length, 39);
  assert.equal(new Set(reader.state.conversation.map((row) => row.id)).size, 39);
});
test('root cards come ten at a time, newest first, with total reply counts for each thread', async () => {
  const {reader} = await fixture(); await reader.openSubject(1);
  assert.deepEqual(reader.state.messages.map((row) => row.id), [40, 39, 38, 37, 36, 35, 34, 33, 32, 31]);
  assert.ok(reader.state.messages.every((row) => row.parent_id === null));
  assert.equal(replyCount(reader.state.conversation, 1), 22);
  assert.equal(replyCount(reader.state.conversation, 4), 0);
  await reader.browseMessages({more: true});
  assert.equal(reader.state.messages.length, 17);
  assert.equal(reader.state.page_start, 10);
  assert.equal(reader.state.next_message_cursor, null);
  await reader.browseMessages({order: 'asc'});
  assert.deepEqual(reader.state.messages.slice(0, 3).map((row) => row.id), [1, 4, 26]);
});
test('a thread tree holds the root and every descendant in reading order with depths', async () => {
  const {reader} = await fixture(); await reader.openSubject(1);
  const rows = threadRows(reader.state.conversation, 1);
  assert.equal(rows.length, 23);
  assert.deepEqual(rows.slice(0, 4).map(({message: m, depth}) => [m.id, depth]), [[1, 0], [2, 1], [3, 2], [6, 1]]);
  assert.equal(rootOf(reader.state.conversation, 3).id, 1);
  assert.equal(rootOf(reader.state.conversation, 5), null);
});
test('unfolding a reply opens its whole thread, shows the page that holds the root, and folding closes it', async () => {
  const {reader, calls} = await fixture(); await reader.openSubject(1);
  const before = calls.length;
  reader.openThread(3);
  assert.equal(calls.length, before);
  assert.deepEqual(reader.state.open_threads, [1]);
  assert.equal(reader.state.focus_id, 3); assert.equal(reader.state.reveal_id, 3);
  assert.equal(reader.state.messages.length, 17);
  assert.ok(reader.state.messages.some((row) => row.id === 1));
  reader.toggleThread(4);
  assert.deepEqual(reader.state.open_threads, [1, 4]); assert.equal(reader.state.reveal_id, null);
  reader.toggleThread(4); assert.equal(reader.state.focus_id, 1);
  reader.toggleThread(1);
  assert.deepEqual(reader.state.open_threads, []); assert.equal(reader.state.focus_id, null);
});
test('messages from another subject or unknown IDs cannot be unfolded', async () => {
  const {reader, call} = await fixture(); await reader.openSubject(1);
  const result = await call('open_thread', {message_id: 5});
  assert.equal(result.ok, false); assert.match(result.error, /not in this subject/);
  assert.deepEqual(reader.state.open_threads, []);
  assert.ok(!JSON.stringify(result).includes('END_5'));
  assert.throws(() => reader.openThread(999), /not in this subject/);
});
test('choosing a search result clears the search and unfolds the thread at that message', async () => {
  const {reader, calls} = await fixture(); await reader.openSubject(1);
  await reader.browseMessages({query: 'Evidence 3:'});
  assert.deepEqual(calls.at(-1), {name: 'search', args: {subject_id: 1, query: 'Evidence 3:', scope: 'messages', order: 'desc', limit: 10, after_id: 0}});
  assert.deepEqual(reader.state.messages.map((row) => row.id), [3]);
  reader.openThread(3);
  assert.equal(reader.state.message_query, '');
  assert.deepEqual(reader.state.open_threads, [1]);
  assert.ok(reader.state.messages.some((row) => row.id === 1));
});
test('refresh rereads the subject list and conversation while keeping unfolded threads and shown roots', async () => {
  const {reader, calls} = await fixture(); await reader.openSubject(1);
  await reader.browseMessages({more: true}); reader.openThread(2);
  calls.length = 0;
  await reader.refresh();
  assert.deepEqual(calls.map((row) => row.name).toSorted(), ['get_subject', 'list_subjects', 'read_messages']);
  assert.deepEqual(reader.state.open_threads, [1]); assert.equal(reader.state.messages.length, 17);
  assert.equal(reader.state.subject.id, 1);
});
test('browsing subjects keeps the open discussion, and closing the subject returns to the list', async () => {
  const {reader} = await fixture(); await reader.openSubject(1); reader.openThread(1);
  await reader.browseSubjects({query: ''});
  assert.equal(reader.state.subject.id, 1); assert.deepEqual(reader.state.open_threads, [1]);
  reader.closeSubject();
  assert.equal(reader.state.subject, null); assert.deepEqual(reader.state.conversation, []);
  assert.deepEqual(reader.state.open_threads, []); assert.equal(reader.state.subjects.length, 2);
});
test('closing the subject during its load cancels the read before its late result can reopen it', async () => {
  const {reader} = await fixture(); const original = reader.client.call; let resolveSubject;
  reader.client.call = (name, args) => name === 'get_subject'
    ? new Promise((resolve) => {resolveSubject = resolve;}) : original(name, args);
  const pending = reader.openSubject(1).catch((error) => error);
  assert.throws(() => reader.openThread(1), /Open a subject first/);
  reader.closeSubject(); resolveSubject(subject(1));
  assert.equal((await pending).name, 'AbortError');
  assert.equal(reader.state.subject, null); assert.deepEqual(reader.state.messages, []);
});
test('switching subjects discards a late search from the previous subject', async () => {
  const {reader} = await fixture(); await reader.openSubject(1);
  const original = reader.client.call; let resolveSearch;
  reader.client.call = (name, args) => name === 'search'
    ? new Promise((resolve) => {resolveSearch = resolve;}) : original(name, args);
  const old = reader.browseMessages({query: 'END'}).catch((error) => error);
  await reader.openSubject(2); resolveSearch({messages: [message(3)], next_after_id: null});
  assert.equal((await old).name, 'AbortError');
  assert.equal(reader.state.message_query, ''); assert.deepEqual(reader.state.messages.map((row) => row.id), [5]);
});
