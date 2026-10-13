import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BoardReader} from '../viewer/board.js';
import {bindNavigation, subjectFromUrl} from '../viewer/navigation.js';

const subject = (id) => ({id, title: `Subject ${id}`, description: 'Question', author: 'a', created_at: '2026-10-01T00:00:00Z'});
function fixture(url = 'http://localhost/board/') {
  const calls = [], writes = [], events = new Map();
  const browser = {location: {href: url}, history: {pushState(_state, _title, href) {
    writes.push(href); browser.location.href = href;
  }}, addEventListener(name, listener) {events.set(name, listener);}};
  const reader = new BoardReader({async call(name, args) {
    calls.push({name, args});
    return name === 'get_subject' ? subject(args.subject_id) : {messages: [], next_after_id: null};
  }});
  const load = bindNavigation(reader, browser);
  return {reader, browser, calls, writes, events, load};
}
test('subject URLs accept only positive safe integer IDs, including encoded injection attempts', () => {
  assert.equal(subjectFromUrl('http://localhost/board/'), null);
  assert.equal(subjectFromUrl('http://localhost/board/?subject=12'), 12);
  for (const payload of ['0', '-1', '01', '', '1 OR 1=1', "1; DROP TABLE subjects;--", '1 UNION SELECT 1', '1e3', '9007199254740992']) {
    assert.throws(() => subjectFromUrl(`http://localhost/board/?subject=${encodeURIComponent(payload)}`), /positive integer/);
  }
});
test('deep links restore selection and successful subject changes update the same-origin URL once', async () => {
  const {reader, browser, writes, load} = fixture('http://localhost/board/?ref=docs&subject=3#messages');
  await load();
  assert.equal(reader.state.subject.id, 3);
  assert.equal(writes.length, 0);
  await reader.openSubject(5);
  assert.equal(new URL(browser.location.href).searchParams.get('subject'), '5');
  assert.equal(new URL(browser.location.href).searchParams.get('ref'), 'docs');
  assert.equal(new URL(browser.location.href).hash, '#messages');
  assert.equal(new URL(browser.location.href).origin, 'http://localhost');
  await reader.openSubject(5);
  assert.equal(writes.length, 1);
});
test('Back and Forward events restore selections or clear them without creating history entries', async () => {
  const {reader, browser, writes, events, load} = fixture('http://localhost/board/?subject=2');
  await load(); await reader.openSubject(4);
  for (const id of [2, 4, null]) {
    browser.location.href = `http://localhost/board/${id === null ? '' : `?subject=${id}`}`;
    events.get('popstate')();
    await new Promise(setImmediate);
    assert.equal(reader.state.subject?.id ?? null, id);
    assert.equal(writes.length, 1);
  }
  assert.equal(reader.state.messages.length, 0);
});
test('malformed URL IDs show an error without forwarding their text to MCP', async () => {
  const {reader, calls, load} = fixture("http://localhost/board/?subject=1%20OR%201%3D1");
  await load();
  assert.equal(calls.length, 0);
  assert.equal(reader.state.subject, null);
  assert.match(reader.errors.messages, /positive integer/);
});
test('navigating back while a subject is loading prevents its late result from changing the URL', async () => {
  const {reader, browser, writes, load} = fixture('http://localhost/board/?subject=1');
  await load();
  let resolveSubject;
  const original = reader.client.call;
  reader.client.call = (name, args) => name === 'get_subject' && args.subject_id === 5
    ? new Promise((resolve) => {resolveSubject = resolve;}) : original(name, args);
  const pending = reader.openSubject(5).catch((error) => error);
  browser.location.href = 'http://localhost/board/'; await load();
  resolveSubject(subject(5));
  assert.equal((await pending).name, 'AbortError');
  assert.equal(reader.state.subject, null);
  assert.equal(browser.location.href, 'http://localhost/board/');
  assert.equal(writes.length, 0);
});
