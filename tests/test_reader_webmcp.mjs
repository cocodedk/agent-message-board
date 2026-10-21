import assert from 'node:assert/strict';
import {test} from 'node:test';
import {registerWebMcp} from '../viewer/webmcp.js';
import {BoardReader} from '../viewer/board.js';
import {readFile} from 'node:fs/promises';

const names = ['describe', 'browse_subjects', 'open_subject', 'open_thread', 'browse_messages'];
async function fixture(documentObject) {
  const calls = [];
  const reader = new BoardReader({async call(name, args) {
    calls.push({name, args});
    if (name === 'get_subject') return {id: args.subject_id, title: 'Question', description: 'Criteria', author: 'a', created_at: '2026-10-01T00:00:00Z'};
    return {subjects: [], messages: [], next_after_id: null};
  }});
  const tools = [];
  await registerWebMcp(reader, documentObject ?? {modelContext: {registerTool: (tool) => {tools.push(tool);}}});
  return {reader, calls, tools};
}
test('the actual reader page has human controls for its five WebMCP abilities and no thread-view controls', async () => {
  const html = await readFile(new URL('../viewer/index.html', import.meta.url), 'utf8');
  for (const id of ['subject-form', 'message-form', 'subject-order', 'message-order', 'more-subjects', 'more-messages', 'message-list', 'subjects-view', 'status']) {
    assert.ok(html.includes(`id="${id}"`));
  }
  assert.ok(html.includes('<option value="activity">Recent activity</option>'));
  assert.ok(html.indexOf('id="status"') < html.indexOf('id="message-list"'));
  for (const id of ['subject-overview', 'parent-thread', 'thread-post']) assert.ok(!html.includes(`id="${id}"`));
  assert.ok(html.includes('src="./main.js"'));
});
test('registered tools declare closed input schemas and truthful state-change annotations', async () => {
  const {tools} = await fixture();
  assert.deepEqual(tools.map((tool) => tool.name), names);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, tool.name === 'describe');
    assert.equal(tool.annotations.untrustedContentHint, true);
    assert.equal(tool.annotations.consequentialHint, false);
  }
});
test('WebMCP actions use the reader state and return a closed success shape', async () => {
  const {reader, tools} = await fixture();
  const selected = await tools.find((tool) => tool.name === 'open_subject').execute({subject_id: 1});
  assert.equal(selected.ok, true);
  assert.deepEqual(Object.keys(selected).toSorted(), ['error', 'ok', 'state']);
  const described = await tools[0].execute({});
  assert.equal(described.state.subject.id, 1);
  assert.equal(described.state.subject.id, reader.state.subject.id);
  assert.equal(described.state.message_count, reader.state.messages.length);
  assert.ok(!Object.hasOwn(described.state, 'messages'));
  assert.ok(!Object.hasOwn(described.state.subject, 'description'));
});
test('malformed inputs and undeclared fields cannot trigger reads or mutate the page state', async () => {
  const {reader, tools, calls} = await fixture();
  const before = structuredClone(reader.snapshot());
  const overview = (await tools[0].execute({})).state;
  for (const tool of tools) {
    for (const input of [null, [], 'text', {unknown: true}, {subject_id: 'subject-list'}, {order: 'sideways'}, {query: 5}, {query: 'a'.repeat(201)}, {more: 'yes'}]) {
      const result = await tool.execute(input);
      assert.equal(result.ok, false);
      assert.deepEqual(Object.keys(result).toSorted(), ['error', 'ok', 'state']);
      assert.deepEqual(result.state, overview);
      assert.deepEqual(reader.snapshot(), before);
    }
  }
  assert.equal(calls.length, 0);
});
test('missing, refused, and throwing WebMCP registries leave the page usable', async () => {
  await fixture({});
  await fixture({get modelContext() {throw new Error('Unavailable');}});
  const registered = [];
  await fixture({modelContext: {registerTool(tool) {
    registered.push(tool.name);
    if (tool.name === 'describe') throw new Error('Refused');
  }}});
  assert.deepEqual(registered, names);
});
test('an aborted WebMCP action returns a closed failure and does not change selection', async () => {
  const {reader, tools, calls} = await fixture();
  const controller = new AbortController(); controller.abort();
  const result = await tools.find((tool) => tool.name === 'open_subject').execute({subject_id: 1}, {signal: controller.signal});
  assert.equal(result.ok, false);
  assert.equal(reader.state.subject, null);
  assert.equal(calls.length, 0);
});
