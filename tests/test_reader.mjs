import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ReadMcp} from '../viewer/mcp.js';
import {BoardReader} from '../viewer/board.js';

const subject = (id = 1) => ({id, title: `Subject ${id}`, description: 'Evidence', author: 'a', created_at: '2026-10-01T00:00:00Z'});
const message = (id = 1, subject_id = 1) => ({id, subject_id, parent_id: null, author: 'b', receiver: null, body: 'Evidence', kind: 'message', created_at: '2026-10-01T00:00:00Z'});
function rpcFetcher(log, respond = () => ({subjects: [], next_after_id: null})) {
  return async (_url, options) => {
    const request = JSON.parse(options.body);
    log.push({request, headers: options.headers, signal: options.signal});
    if (request.method === 'notifications/initialized') return new Response(null, {status: 202});
    const result = request.method === 'initialize'
      ? {protocolVersion: '2025-11-25'} : respond(request.params);
    return new Response(JSON.stringify({jsonrpc: '2.0', id: request.id, result: request.method === 'initialize'
      ? result : {structuredContent: result}}), {headers: {'Mcp-Session-Id': 'session-one'}});
  };
}
function mockBoard() {
  const calls = [];
  const client = {async call(name, args) {
    calls.push({name, args});
    if (name === 'get_subject') return subject(args.subject_id);
    if (name === 'get_message') return message(args.message_id);
    if (name === 'list_subjects') {
      return {subjects: [{...subject(args.after_id ? 2 : 1), message_count: 3, last_message_at: '2026-10-02T00:00:00Z'}], next_after_id: args.after_id ? null : 1};
    }
    if (name === 'search' && args.scope === 'subjects') return {subjects: [subject(args.after_id ? 2 : 1)], next_after_id: args.after_id ? null : 1};
    return {messages: [message()], next_after_id: null};
  }};
  return {reader: new BoardReader(client), calls};
}

test('HTTP MCP initialization is shared, and reads use negotiated session headers', async () => {
  const log = [], client = new ReadMcp('/mcp', rpcFetcher(log));
  await Promise.all([client.call('list_subjects', {}), client.call('search', {query: 'SQLite'})]);
  assert.deepEqual(log.map((r) => r.request.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
  for (const entry of log.slice(1)) {
    assert.equal(entry.headers['Mcp-Session-Id'], 'session-one');
    assert.equal(entry.headers['MCP-Protocol-Version'], '2025-11-25');
  }
});
test('all write and unknown tools are refused before any network request', async () => {
  const log = [], client = new ReadMcp('/mcp', rpcFetcher(log));
  for (const name of ['create_subject', 'post_message', 'delete_message', 'unknown']) {
    await assert.rejects(client.call(name, {}), /only read tools/);
  }
  assert.equal(log.length, 0);
});
test('tool errors become useful reader errors', async () => {
  const log = [], base = rpcFetcher(log);
  const client = new ReadMcp('/mcp', async (url, options) => {
    const r = JSON.parse(options.body);
    if (r.method !== 'tools/call') return base(url, options);
    return new Response(JSON.stringify({jsonrpc: '2.0', id: r.id,
      result: {isError: true, content: [{type: 'text', text: 'Subject missing'}]}}));
  });
  await assert.rejects(client.call('get_subject', {subject_id: 1}), /Subject missing/);
});
test('expired HTTP sessions reset so a later Refresh can reconnect', async () => {
  const log = [], base = rpcFetcher(log); let expired = true;
  const client = new ReadMcp('/mcp', (url, options) => {
    if (JSON.parse(options.body).method === 'tools/call' && expired) {
      expired = false; return Promise.resolve(new Response(null, {status: 404}));
    }
    return base(url, options);
  });
  await assert.rejects(client.call('list_subjects', {}), /Refresh/);
  await client.call('list_subjects', {});
  assert.equal(log.filter((r) => r.request.method === 'initialize').length, 2);
});
test('subject searches and subsequent pages keep the requested date order and cursor', async () => {
  const {reader, calls} = mockBoard();
  await reader.browseSubjects({query: ' SQLite ', order: 'asc'});
  await reader.browseSubjects({more: true});
  assert.deepEqual(calls.map((r) => r.args), [
    {query: 'SQLite', scope: 'subjects', order: 'asc', limit: 10, after_id: 0},
    {query: 'SQLite', scope: 'subjects', order: 'asc', limit: 10, after_id: 1},
  ]);
  assert.equal(reader.state.subjects.length, 1);
  assert.equal(reader.state.next_subject_cursor, null);
});
test('message searches stay within the selected subject and ask MCP for date sorting', async () => {
  const {reader, calls} = mockBoard();
  await reader.openSubject(3);
  await reader.browseMessages({query: ' evidence ', order: 'asc'});
  assert.deepEqual(calls.at(-1), {name: 'search', args: {subject_id: 3, query: 'evidence', scope: 'messages', order: 'asc', limit: 10, after_id: 0}});
});
test('subjects list by recent activity by default and keep the server counts', async () => {
  const {reader, calls} = mockBoard();
  await reader.browseSubjects();
  assert.deepEqual(calls[0], {name: 'list_subjects', args: {after_id: 0, limit: 10, order: 'activity'}});
  assert.equal(reader.state.subjects[0].message_count, 3);
  assert.equal(reader.state.subjects[0].last_message_at, '2026-10-02T00:00:00Z');
  await reader.browseSubjects({order: 'asc'});
  assert.equal(calls.at(-1).args.order, 'asc');
  assert.throws(() => reader.browseSubjects({order: 'sideways'}), /Sort subjects/);
});
test('subject search under recent activity asks the server for newest first, which search supports', async () => {
  const {reader, calls} = mockBoard();
  await reader.browseSubjects({query: 'SQLite'});
  assert.deepEqual(calls[0].args, {query: 'SQLite', scope: 'subjects', order: 'desc', limit: 10, after_id: 0});
  assert.equal(reader.state.subject_order, 'activity');
  assert.ok(!Object.hasOwn(reader.state.subjects[0], 'message_count'));
});
test('changing filters while loading another page is rejected instead of mixing result sets', async () => {
  const {reader} = mockBoard();
  await reader.browseSubjects({query: 'first'});
  assert.throws(() => reader.browseSubjects({query: 'different', more: true}), /same search/);
  assert.equal(reader.state.subject_query, 'first');
});
test('a late old search cannot overwrite a newer result', async () => {
  let resolveOld;
  const reader = new BoardReader({call: (_name, args) => args.query === 'old'
    ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.resolve({subjects: [subject(2)], next_after_id: null})});
  const old = reader.browseSubjects({query: 'old'}).catch((error) => error);
  await reader.browseSubjects({query: 'new'});
  resolveOld({subjects: [subject(1)], next_after_id: null});
  assert.equal((await old).name, 'AbortError');
  assert.equal(reader.state.subjects[0].id, 2);
  assert.equal(reader.errors.subjects, null);
});
test('message browsing requires a selected subject', () => {
  const {reader, calls} = mockBoard();
  assert.throws(() => reader.browseMessages(), /Open a subject first/);
  assert.equal(calls.length, 0);
});
test('cancelled MCP calls never send a tools/call request', async () => {
  const log = [], client = new ReadMcp('/mcp', rpcFetcher(log));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.call('list_subjects', {}, controller.signal), {name: 'AbortError'});
  assert.equal(log.filter((r) => r.request.method === 'tools/call').length, 0);
});
