import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BoardReader} from '../viewer/board.js';
import {registerWebMcp} from '../viewer/webmcp.js';
import {preview, messagePreview} from '../viewer/content.js';

const description = 'Question criteria. '.repeat(1000);
const body = 'Detailed evidence. '.repeat(1000);
const subject = (id) => ({id, title: `Subject ${id}`, description, author: 'a', created_at: '2026-10-01T00:00:00Z'});
const message = (id, parent_id = null) => ({id, subject_id: 1, parent_id, author: 'b', receiver: null, kind: 'message', body, created_at: '2026-10-01T00:00:00Z'});
// Thirty root threads; root 1 holds forty replies, alternating direct replies and replies to the previous one.
const conversation = [...Array.from({length: 30}, (_, i) => message(i + 1)),
  ...Array.from({length: 40}, (_, i) => message(i + 31, i % 2 ? i + 30 : 1))];
async function fixture() {
  const calls = [], tools = new Map();
  const reader = new BoardReader({async call(name, args) {
    calls.push({name, args});
    if (name === 'get_subject') return subject(args.subject_id);
    const key = name === 'list_subjects' || args.scope === 'subjects' ? 'subjects' : 'messages';
    let records = key === 'subjects'
      ? Array.from({length: 30}, (_, i) => (name === 'list_subjects' ? {...subject(i + 1), message_count: i, last_message_at: i ? '2026-10-02T00:00:00Z' : null} : subject(i + 1)))
      : conversation;
    if (args.order === 'desc') records = records.toReversed();
    if (args.after_id) records = records.slice(records.findIndex((r) => r.id === args.after_id) + 1);
    const page = records.slice(0, args.limit);
    return {[key]: page, next_after_id: records.length > page.length ? page.at(-1).id : null};
  }});
  await registerWebMcp(reader, {modelContext: {registerTool(tool) {tools.set(tool.name, tool);}}});
  const call = (name, input = {}) => tools.get(name).execute(input);
  return {reader, calls, call};
}

test('describe and errors stay small even when the reader holds a long conversation', async () => {
  const {reader, call} = await fixture();
  await call('browse_subjects');
  await call('open_subject', {subject_id: 1});
  await call('open_thread', {message_id: 50});
  const before = structuredClone(reader.state);
  for (const answer of [await call('describe'), await call('browse_subjects', {unknown: true})]) {
    assert.ok(JSON.stringify(answer).length < 1500);
    assert.equal(answer.state.subject.id, 1);
    assert.equal(answer.state.subject_count, 10);
    assert.equal(answer.state.conversation_count, 70);
    assert.equal(answer.state.thread_count, 30);
    assert.deepEqual(answer.state.open_threads, [1]);
    assert.equal(answer.state.focus_id, 50);
    assert.ok(!Object.hasOwn(answer.state.subject, 'description'));
    for (const key of ['subjects', 'messages', 'thread']) assert.ok(!Object.hasOwn(answer.state, key));
  }
  assert.deepEqual(reader.state, before);
});
test('subject browsing returns one page of metadata with counts and last activity, without question bodies', async () => {
  const {call} = await fixture();
  const answer = await call('browse_subjects', {order: 'activity'});
  assert.equal(answer.ok, true);
  assert.equal(answer.state.subjects.length, 10);
  assert.deepEqual(Object.keys(answer.state.subjects[0]).toSorted(), ['author', 'created_at', 'id', 'last_message_at', 'message_count', 'title']);
  assert.deepEqual([answer.state.subjects[0].message_count, answer.state.subjects[0].last_message_at], [0, null]);
  assert.ok(JSON.stringify(answer).length < 4000);
  const searched = await call('browse_subjects', {query: 'Subject'});
  assert.ok(searched.state.subjects.every((r) => r.message_count === null && r.last_message_at === null));
});
test('opening a subject returns its question and ten root previews with reply counts, not the conversation', async () => {
  const {call} = await fixture();
  await call('browse_subjects');
  const answer = await call('open_subject', {subject_id: 1});
  assert.equal(answer.state.subject.description, description);
  assert.ok(!Object.hasOwn(answer.state, 'subjects'));
  assert.equal(answer.state.messages.length, 10);
  assert.ok(answer.state.messages.every((r) => r.truncated && Array.from(r.body).length === 161 && r.parent_id === null));
  const asc = await call('browse_messages', {order: 'asc'});
  assert.deepEqual([asc.state.messages[0].id, asc.state.messages[0].reply_count, asc.state.messages[1].reply_count], [1, 40, 0]);
  assert.ok(JSON.stringify(answer).length < description.length + 6000);
});
test('unfolding a thread returns at most twenty previews with depths and says how many were left out', async () => {
  const {reader, call} = await fixture();
  await call('open_subject', {subject_id: 1});
  const answer = await call('open_thread', {message_id: 34});
  assert.equal(answer.ok, true);
  assert.deepEqual([answer.state.thread.root_id, answer.state.thread.message_id, answer.state.thread.reply_count, answer.state.thread.omitted], [1, 34, 40, 21]);
  assert.equal(answer.state.thread.messages.length, 20);
  assert.deepEqual(answer.state.thread.messages.slice(0, 3).map((r) => [r.id, r.depth]), [[1, 0], [31, 1], [32, 2]]);
  assert.ok(answer.state.thread.messages.every((r) => r.truncated && Array.from(r.body).length === 161));
  assert.ok(JSON.stringify(answer).length < 9000);
  assert.deepEqual(reader.state.open_threads, [1]);
});
test('root and search pages stay bounded at ten and later pages return only their new rows', async () => {
  const {reader, calls, call} = await fixture();
  const first = await call('browse_subjects', {order: 'asc'});
  const second = await call('browse_subjects', {more: true});
  assert.equal(second.state.subjects.length, 10);
  assert.ok(second.state.subjects.every((r) => !first.state.subjects.some((old) => old.id === r.id)));
  await call('open_subject', {subject_id: 1});
  const roots = await call('browse_messages', {order: 'asc'});
  const next = await call('browse_messages', {more: true});
  assert.equal(next.state.messages.length, 10);
  assert.ok(next.state.messages.every((r) => !roots.state.messages.some((old) => old.id === r.id)));
  assert.equal(reader.state.messages.length, 20);
  const found = await call('browse_messages', {query: 'evidence'});
  assert.equal(found.state.message_view, 'search');
  assert.equal(found.state.messages.length, 10);
  assert.ok(calls.filter((r) => r.name !== 'read_messages' && 'limit' in r.args).every((r) => r.args.limit === 10));
});
test('previews preserve Unicode and signal exactly when full text was omitted', () => {
  assert.equal(preview(''), '');
  assert.equal(preview('🙂'.repeat(160)), '🙂'.repeat(160));
  assert.equal(preview('🙂'.repeat(200)), `${'🙂'.repeat(160)}…`);
  assert.equal(messagePreview({...message(1), body: 'Short evidence'}).truncated, false);
  assert.equal(messagePreview({...message(1), receiver: 'a'}).receiver, 'a');
  const long = messagePreview({...message(1), body: '🙂'.repeat(200)});
  assert.equal(long.truncated, true);
  assert.equal(Array.from(long.body).length, 161);
  assert.ok(!/\p{Surrogate}/u.test(long.body));
});
test('requesting another page after the end returns a small error without replaying records', async () => {
  const {calls, call} = await fixture();
  await call('browse_subjects');
  await call('browse_subjects', {more: true});
  await call('browse_subjects', {more: true});
  const before = calls.length;
  const answer = await call('browse_subjects', {more: true});
  assert.equal(answer.ok, false);
  assert.equal(calls.length, before);
  assert.ok(!Object.hasOwn(answer.state, 'subjects'));
  assert.ok(JSON.stringify(answer).length < 1500);
});
test('message tools wait for the subject to finish loading instead of reading half a conversation', async () => {
  const {reader, call} = await fixture();
  await call('open_subject', {subject_id: 1});
  const original = reader.client.call; let resolvePage;
  reader.client.call = (name, args) => name === 'read_messages'
    ? new Promise((resolve) => {resolvePage = resolve;}) : original(name, args);
  const pending = reader.reloadSubject();
  await new Promise(setImmediate);
  for (const [name, input] of [['open_thread', {message_id: 1}], ['browse_messages', {more: true}]]) {
    const answer = await call(name, input);
    assert.equal(answer.ok, false); assert.match(answer.error, /finishes loading/);
  }
  resolvePage({messages: [message(1)], next_after_id: null}); await pending;
  assert.equal(reader.state.conversation.length, 1);
});
