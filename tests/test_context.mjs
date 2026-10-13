import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BoardReader} from '../viewer/board.js';
import {registerWebMcp} from '../viewer/webmcp.js';
import {preview, messagePreview} from '../viewer/content.js';

const description = 'Question criteria. '.repeat(1000);
const body = 'Detailed evidence. '.repeat(1000);
const subject = (id) => ({id, title: `Subject ${id}`, description, author: 'a', created_at: '2026-10-01T00:00:00Z'});
const message = (id) => ({id, subject_id: 1, parent_id: null, author: 'b', kind: 'message', body, created_at: '2026-10-01T00:00:00Z'});
async function fixture() {
  const calls = [], tools = new Map();
  const reader = new BoardReader({async call(name, args) {
    calls.push({name, args});
    if (name === 'get_subject') return subject(args.subject_id);
    if (name === 'get_message') return message(args.message_id);
    const key = name === 'list_subjects' || args.scope === 'subjects' ? 'subjects' : 'messages';
    let records = Array.from({length: 30}, (_, i) => (key === 'subjects' ? subject : message)(i + 1));
    if (args.order === 'desc') records.reverse();
    if (args.after_id) records = records.slice(records.findIndex((r) => r.id === args.after_id) + 1);
    const page = records.slice(0, args.limit);
    return {[key]: page, next_after_id: records.length > page.length ? page.at(-1).id : null};
  }});
  await registerWebMcp(reader, {modelContext: {registerTool(tool) {tools.set(tool.name, tool);}}});
  const call = (name, input = {}) => tools.get(name).execute(input);
  return {reader, calls, call};
}

test('describe and errors stay small even when the reader holds long discussion records', async () => {
  const {reader, call} = await fixture();
  reader.state.subjects = Array.from({length: 30}, (_, i) => subject(i + 1));
  reader.state.messages = Array.from({length: 30}, (_, i) => message(i + 1));
  reader.state.subject = subject(1); reader.state.context = message(1);
  const before = structuredClone(reader.state);
  for (const answer of [await call('describe'), await call('browse_subjects', {unknown: true})]) {
    assert.ok(JSON.stringify(answer).length < 1500);
    assert.equal(answer.state.subject.id, 1);
    assert.equal(answer.state.subject_count, 30);
    assert.equal(answer.state.message_count, 30);
    assert.equal(answer.state.context.id, 1);
    assert.ok(!Object.hasOwn(answer.state.subject, 'description'));
    assert.ok(!Object.hasOwn(answer.state.context, 'body'));
    assert.ok(!Object.hasOwn(answer.state, 'subjects'));
    assert.ok(!Object.hasOwn(answer.state, 'messages'));
  }
  assert.deepEqual(reader.state, before);
});
test('subject browsing returns one page of metadata without question bodies or message history', async () => {
  const {reader, call} = await fixture();
  reader.state.messages = [message(1)]; reader.state.context = message(1);
  const answer = await call('browse_subjects', {order: 'asc'});
  assert.equal(answer.ok, true);
  assert.equal(answer.state.subjects.length, 10);
  assert.ok(answer.state.subjects.every((r) => !Object.hasOwn(r, 'description')));
  assert.ok(!Object.hasOwn(answer.state, 'messages'));
  assert.equal(answer.state.context, null);
  assert.ok(JSON.stringify(answer).length < 4000);
});
test('opening a subject returns its question and message previews without all other subjects', async () => {
  const {call} = await fixture();
  await call('browse_subjects');
  const answer = await call('open_subject', {subject_id: 1});
  assert.equal(answer.state.subject.description, description);
  assert.ok(!Object.hasOwn(answer.state, 'subjects'));
  assert.equal(answer.state.messages.length, 10);
  assert.ok(answer.state.messages.every((r) => r.truncated && Array.from(r.body).length <= 161));
  assert.ok(JSON.stringify(answer).length < description.length + 6000);
});
test('only an explicit message read returns the complete requested body', async () => {
  const {call} = await fixture();
  await call('open_subject', {subject_id: 1});
  const full = await call('show_message', {message_id: 2});
  assert.equal(full.state.context.id, 2);
  assert.equal(full.state.context.body, body);
  assert.ok(!Object.hasOwn(full.state, 'messages'));
  assert.ok(!Object.hasOwn(full.state.subject, 'description'));
  assert.ok(JSON.stringify(full).length < body.length + 1500);
  const described = await call('describe');
  assert.ok(!Object.hasOwn(described.state.context, 'body'));
  assert.ok(JSON.stringify(described).length < 1500);
});
test('subsequent pages replace previous rows and remain bounded for subjects and messages', async () => {
  const {reader, calls, call} = await fixture();
  const first = await call('browse_subjects', {order: 'asc'});
  const second = await call('browse_subjects', {more: true});
  assert.equal(second.state.subjects.length, 10);
  assert.ok(second.state.subjects.every((r) => !first.state.subjects.some((old) => old.id === r.id)));
  assert.equal(reader.state.subjects.length, 10);
  await call('open_subject', {subject_id: 1});
  const messages = await call('browse_messages', {order: 'asc'});
  const next = await call('browse_messages', {more: true});
  assert.equal(next.state.messages.length, 10);
  assert.ok(next.state.messages.every((r) => !messages.state.messages.some((old) => old.id === r.id)));
  assert.equal(reader.state.messages.length, 10);
  assert.ok(calls.filter((r) => 'limit' in r.args).every((r) => r.args.limit === 10));
});
test('previews preserve Unicode and signal exactly when full text was omitted', () => {
  assert.equal(preview(''), '');
  assert.equal(preview('🙂'.repeat(160)), '🙂'.repeat(160));
  assert.equal(preview('🙂'.repeat(200)), `${'🙂'.repeat(160)}…`);
  assert.equal(messagePreview({...message(1), body: 'Short evidence'}).truncated, false);
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
test('message expansion targets its own row or an explicitly selected current-page row', async () => {
  const {reader, calls, call} = await fixture();
  await call('open_subject', {subject_id: 1});
  reader.state.messages = [{...message(2), parent_id: 1}, message(1)];
  const own = await call('show_message', {message_id: 1});
  assert.equal(own.state.context_anchor_id, 1);
  const parent = await call('show_message', {message_id: 1, after_message_id: 2});
  assert.equal(parent.state.context_anchor_id, 2);
  assert.equal(parent.state.context.body, body);
  const before = calls.length;
  const invalid = await call('show_message', {message_id: 1, after_message_id: 999});
  assert.equal(invalid.ok, false);
  assert.equal(calls.length, before);
  assert.ok(JSON.stringify(invalid).length < 1500);
});
test('moving to another message page cancels a pending expansion and clears full text', async () => {
  const {reader, call} = await fixture();
  await call('open_subject', {subject_id: 1});
  let resolveMessage;
  const original = reader.client.call;
  reader.client.call = (name, args) => name === 'get_message'
    ? new Promise((resolve) => {resolveMessage = resolve;}) : original(name, args);
  const pending = reader.showMessage(1).catch((error) => error);
  await reader.browseMessages({order: 'asc'});
  resolveMessage(message(1));
  assert.equal((await pending).name, 'AbortError');
  assert.equal(reader.state.context, null);
  assert.equal(reader.state.context_anchor_id, null);
});
test('a full read cannot start on rows that are about to be replaced by paging', async () => {
  const {reader, calls, call} = await fixture();
  await call('open_subject', {subject_id: 1});
  let resolvePage;
  const original = reader.client.call;
  reader.client.call = (name, args) => name === 'read_messages'
    ? new Promise((resolve) => {resolvePage = resolve;}) : original(name, args);
  const pending = reader.browseMessages({more: true});
  const before = calls.length;
  const expanded = await call('show_message', {message_id: 30});
  assert.equal(expanded.ok, false);
  assert.equal(calls.length, before);
  resolvePage({messages: [message(20)], next_after_id: null});
  await pending;
  assert.equal(reader.state.context, null);
  assert.equal(reader.state.context_anchor_id, null);
});
