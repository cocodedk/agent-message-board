import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BoardReader} from '../viewer/board.js';
import {registerWebMcp} from '../viewer/webmcp.js';

const subject = (id) => ({id, title: `Subject ${id}`, description: 'Question', author: 'a', created_at: '2026-10-01T00:00:00Z'});
const message = (id, parent_id = null, subject_id = 1) => ({id, parent_id, subject_id, author: 'a', receiver: null, kind: 'message',
  created_at: '2026-10-01T00:00:00Z', body: `Evidence ${id}: ${'long '.repeat(100)}END_${id}`});
async function fixture() {
  const calls = [], tools = [];
  const messages = [message(1), message(2, 1), message(3, 2), message(4), message(5, null, 2),
    ...Array.from({length: 20}, (_, i) => message(i + 6, 1))];
  const reader = new BoardReader({async call(name, args) {
    calls.push({name, args});
    if (name === 'get_subject') return subject(args.subject_id);
    if (name === 'get_message') return messages.find((row) => row.id === args.message_id);
    if (name === 'list_subjects') return {subjects: [subject(1), subject(2)], next_after_id: null};
    let rows = messages.filter((row) => row.subject_id === args.subject_id);
    if (args.roots_only) rows = rows.filter((row) => row.parent_id === null);
    if (args.parent_id !== undefined) rows = rows.filter((row) => row.parent_id === args.parent_id);
    if (name === 'search') rows = rows.filter((row) => row.body.includes(args.query));
    rows.sort((a, b) => args.order === 'asc' ? a.id - b.id : b.id - a.id);
    if (args.after_id) rows = rows.filter((row) => args.order === 'asc' ? row.id > args.after_id : row.id < args.after_id);
    return {messages: rows.slice(0, args.limit), next_after_id: rows.length > args.limit ? rows[args.limit - 1].id : null};
  }});
  await registerWebMcp(reader, {modelContext: {registerTool: (tool) => {tools.push(tool);}}});
  const call = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args);
  return {reader, calls, call, messages};
}
test('subject overview contains only root threads and excludes descendants', async () => {
  const {reader, calls, call} = await fixture();
  const result = await call('open_subject', {subject_id: 1});
  assert.equal(result.ok, true);
  assert.deepEqual(reader.state.messages.map((row) => row.id), [4, 1]);
  assert.equal(calls.at(-1).args.roots_only, true);
  assert.equal(result.state.view, 'subject');
  assert.equal(result.state.thread, null);
  assert.ok(result.state.messages.every((row) => row.truncated && Array.from(row.body).length === 161));
});
test('opening a thread returns one full post and direct replies, excluding grandchildren and other roots', async () => {
  const {reader, calls, call} = await fixture();
  await reader.openSubject(1);
  const result = await call('open_thread', {message_id: 1});
  assert.equal(result.ok, true);
  assert.equal(result.state.view, 'thread');
  assert.ok(result.state.thread.body.endsWith('END_1'));
  assert.equal(result.state.messages.length, 10);
  assert.ok(result.state.messages.every((row) => row.parent_id === 1 && row.truncated));
  assert.deepEqual(calls.at(-1).args, {subject_id: 1, parent_id: 1, limit: 10, order: 'desc'});
});
test('any reply can become a sub-thread with only its own direct replies', async () => {
  const {reader, call} = await fixture(); await reader.openSubject(1);
  const result = await call('open_thread', {message_id: 2});
  assert.deepEqual(result.state.messages.map((row) => row.id), [3]);
  assert.equal(result.state.thread.parent_id, 1);
});
test('reply pagination replaces rows while preserving parent, date order, cursor and ten-row bound', async () => {
  const {reader, calls} = await fixture(); await reader.openSubject(1); await reader.openThread(1);
  const before = reader.state.messages.map((row) => row.id), cursor = reader.state.next_message_cursor;
  await reader.browseMessages({more: true});
  assert.deepEqual(calls.at(-1).args, {subject_id: 1, parent_id: 1, order: 'desc', after_id: cursor, limit: 10});
  assert.equal(reader.state.messages.length, 10);
  assert.ok(reader.state.messages.every((row) => !before.includes(row.id)));
});
test('overview and errors never replay the selected thread body or reply page', async () => {
  const {reader, call} = await fixture(); await reader.openSubject(1); await reader.openThread(1);
  for (const result of [await call('describe'), await call('open_thread', {message_id: '1 OR 1=1'})]) {
    assert.ok(!Object.hasOwn(result.state.thread, 'body'));
    assert.ok(!Object.hasOwn(result.state, 'messages'));
    assert.ok(JSON.stringify(result).length < 1500);
  }
});
test('foreign subject threads cannot be applied or returned, even when the client returns their record', async () => {
  const {reader, call} = await fixture(); await reader.openSubject(1);
  const result = await call('open_thread', {message_id: 5});
  assert.equal(result.ok, false); assert.match(result.error, /another subject/);
  assert.equal(reader.state.thread, null); assert.deepEqual(reader.state.messages, []);
  assert.ok(!JSON.stringify(result).includes('END_5'));
});
test('switching threads discards late older reads instead of overwriting the current view', async () => {
  const {reader} = await fixture(); await reader.openSubject(1);
  const original = reader.client.call; let resolveOld;
  reader.client.call = (name, args) => name === 'get_message' && args.message_id === 1
    ? new Promise((resolve) => {resolveOld = resolve;}) : original(name, args);
  const old = reader.openThread(1).catch((error) => error);
  await reader.openThread(2); resolveOld(message(1));
  assert.equal((await old).name, 'AbortError'); assert.equal(reader.state.thread.id, 2);
  assert.deepEqual(reader.state.messages.map((row) => row.id), [3]);
});
test('search covers the selected subject and clearing it restores root threads', async () => {
  const {reader, calls} = await fixture(); await reader.openSubject(1); await reader.openThread(1);
  await reader.browseMessages({query: 'END_3'});
  assert.equal(calls.at(-1).name, 'search'); assert.equal(calls.at(-1).args.subject_id, 1);
  assert.equal(reader.state.thread, null); assert.deepEqual(reader.state.messages.map((row) => row.id), [3]);
  await reader.browseMessages({query: ''});
  assert.deepEqual(reader.state.messages.map((row) => row.id), [4, 1]);
});
test('refresh stays in the current thread and browsing subjects returns home', async () => {
  const {reader, calls} = await fixture(); await reader.openSubject(1); await reader.openThread(2);
  await reader.refresh(); assert.equal(reader.state.thread.id, 2); assert.equal(calls.at(-1).args.parent_id, 2);
  await reader.browseSubjects();
  assert.equal(reader.state.subject, null); assert.equal(reader.state.thread, null);
  assert.deepEqual(reader.state.messages, []);
});
test('returning home during a subject load cancels the read before its late result can reopen the subject', async () => {
  const {reader} = await fixture(); const original = reader.client.call; let resolveSubject;
  reader.client.call = (name, args) => name === 'get_subject'
    ? new Promise((resolve) => {resolveSubject = resolve;}) : original(name, args);
  const pending = reader.openSubject(1).catch((error) => error);
  assert.equal(reader.state.subject, null); await reader.browseSubjects(); resolveSubject(subject(1));
  assert.equal((await pending).name, 'AbortError');
  assert.equal(reader.state.subject, null); assert.equal(reader.state.thread, null);
  assert.deepEqual(reader.state.messages, []);
});
