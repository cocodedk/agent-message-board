import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BoardReader} from '../viewer/board.js';
import {bindNavigation, subjectFromUrl, threadFromUrl} from '../viewer/navigation.js';

const subject = (id) => ({id, title: `Subject ${id}`, description: 'Question', author: 'a', created_at: '2026-10-01T00:00:00Z'});
const message = (id, parent_id, subject_id) => ({id, parent_id, subject_id, author: 'a', receiver: null, kind: 'message', body: 'Evidence', created_at: '2026-10-01T00:00:00Z'});
// Subject 1 holds root 2 with reply 3 and root 4; every other subject N holds one root, N * 10.
function fixture(url = 'http://localhost/board/') {
  const calls = [], writes = [], replaced = [], events = new Map();
  const browser = {location: {href: url}, scrollX: 0, scrollY: 0,
    scrollTo(x, y) {this.scrollX = x; this.scrollY = y;},
    history: {state: null, scrollRestoration: 'auto',
      replaceState(state, _title, href) {this.state = state; if (href) {replaced.push(href); browser.location.href = href;}},
      pushState(state, _title, href) {this.state = state; writes.push(href); browser.location.href = href;}},
    addEventListener(name, listener) {events.set(name, listener);}};
  const reader = new BoardReader({async call(name, args) {
    calls.push({name, args});
    if (name === 'list_subjects') return {subjects: [subject(1)], next_after_id: null};
    if (name === 'get_subject') return subject(args.subject_id);
    const rows = args.subject_id === 1 ? [message(2, null, 1), message(3, 2, 1), message(4, null, 1)]
      : [message(args.subject_id * 10, null, args.subject_id)];
    return {messages: rows, next_after_id: null};
  }});
  const load = bindNavigation(reader, browser);
  return {reader, browser, calls, writes, replaced, events, load};
}
const param = (browser, name) => new URL(browser.location.href).searchParams.get(name);
test('subject URLs accept only positive safe integer IDs, including encoded injection attempts', () => {
  assert.equal(subjectFromUrl('http://localhost/board/'), null);
  assert.equal(subjectFromUrl('http://localhost/board/?subject=12'), 12);
  for (const payload of ['0', '-1', '01', '', '1 OR 1=1', "1; DROP TABLE subjects;--", '1 UNION SELECT 1', '1e3', '9007199254740992']) {
    assert.throws(() => subjectFromUrl(`http://localhost/board/?subject=${encodeURIComponent(payload)}`), /positive integer/);
  }
});
test('thread URLs reject encoded injection, duplicate parameters and unsafe integer IDs', () => {
  assert.equal(threadFromUrl('http://localhost/board/?subject=1&thread=2'), 2);
  assert.equal(threadFromUrl('http://localhost/board/?subject=1'), null);
  for (const payload of ['0', '-2', '01', '1 OR 1=1', '1; DROP TABLE messages;--', '9007199254740992']) {
    assert.throws(() => threadFromUrl(`http://localhost/board/?subject=1&thread=${encodeURIComponent(payload)}`), /positive integer/);
  }
  assert.throws(() => threadFromUrl('http://localhost/board/?thread=1&thread=2'), /positive integer/);
  assert.throws(() => subjectFromUrl('http://localhost/board/?subject=1&subject=2'), /positive integer/);
});
test('a subject-plus-reply deep link opens the subject with that thread unfolded and revealed, without new history', async () => {
  const {reader, browser, writes, load} = fixture('http://localhost/board/?subject=1&thread=3');
  await reader.browseSubjects(); await load();
  assert.equal(reader.state.subject.id, 1); assert.deepEqual(reader.state.open_threads, [2]);
  assert.equal(reader.state.focus_id, 3); assert.equal(reader.state.reveal_id, 3);
  assert.equal(browser.location.href, 'http://localhost/board/?subject=1&thread=3');
  assert.equal(writes.length, 0);
});
test('unfolding and folding threads rewrite the current entry, so only subject changes add history', async () => {
  const {reader, browser, writes, replaced, load} = fixture('http://localhost/board/?subject=1'); await load();
  reader.toggleThread(4); assert.equal(param(browser, 'thread'), '4');
  reader.toggleThread(2); assert.equal(param(browser, 'thread'), '2');
  reader.toggleThread(2); assert.equal(param(browser, 'thread'), '4');
  reader.toggleThread(4); assert.equal(param(browser, 'thread'), null);
  assert.equal(writes.length, 0); assert.equal(replaced.length, 4);
  await reader.openSubject(5);
  assert.equal(writes.length, 1); assert.equal(param(browser, 'subject'), '5'); assert.equal(param(browser, 'thread'), null);
});
test('thread links require a subject, and a message outside the subject keeps the subject open with an error', async () => {
  const missing = fixture('http://localhost/board/?thread=1'); await missing.load();
  assert.equal(missing.calls.length, 0); assert.match(missing.reader.errors.messages, /include a subject/);
  const foreign = fixture('http://localhost/board/?subject=2&thread=3'); await foreign.load();
  assert.equal(foreign.reader.state.subject.id, 2); assert.deepEqual(foreign.reader.state.open_threads, []);
  assert.match(foreign.reader.errors.messages, /not in this subject/);
  assert.equal(foreign.writes.length, 0);
});
test('Back returns to the previous subject with its unfolded threads and saved scroll position', async () => {
  const {reader, browser, events, load} = fixture('http://localhost/board/?subject=1'); await load();
  reader.toggleThread(2);
  browser.scrollY = 640; events.get('scroll')();
  const entry = structuredClone(browser.history.state);
  await reader.openSubject(5); assert.equal(browser.scrollY, 0);
  browser.location.href = 'http://localhost/board/?subject=1&thread=2'; browser.history.state = entry; await load();
  assert.equal(reader.state.subject.id, 1); assert.deepEqual(reader.state.open_threads, [2]);
  assert.equal(browser.scrollY, 640); assert.equal(browser.history.scrollRestoration, 'manual');
});
test('a deep link without a saved position keeps the scroll that revealed the message', async () => {
  const {browser, load} = fixture('http://localhost/board/?subject=1&thread=3');
  browser.scrollTo = function (x, y) {this.scrollX = x; this.scrollY = y; this.scrolled = true;};
  await load();
  assert.equal(browser.scrolled, undefined);
});
test('loading a subject cannot overwrite a saved position with a temporarily clamped page', async () => {
  const {reader, browser, events, load} = fixture('http://localhost/board/?subject=1'); await load();
  const original = reader.client.call; let resolveSubject;
  browser.scrollY = 800; events.get('scroll')();
  reader.client.call = (name, args) => name === 'get_subject'
    ? new Promise((resolve) => {resolveSubject = resolve;}) : original(name, args);
  const pending = reader.openSubject(5);
  browser.scrollY = 0; events.get('scroll')();
  assert.equal(browser.history.state.agentboard_scroll.y, 800);
  resolveSubject(subject(5)); await pending;
  assert.equal(browser.scrollY, 0);
});
test('history restores subject details along with the saved scroll position', async () => {
  const {reader, browser, events, load} = fixture('http://localhost/board/?subject=1');
  const details = {open: false}; browser.document = {getElementById: () => details};
  await load(); details.open = true;
  browser.scrollY = 1600; events.get('scroll')();
  const entry = structuredClone(browser.history.state);
  await reader.openSubject(3); details.open = false;
  browser.location.href = 'http://localhost/board/?subject=1'; browser.history.state = entry; await load();
  assert.equal(reader.state.subject.id, 1); assert.equal(details.open, true); assert.equal(browser.scrollY, 1600);
});
test('a delayed scroll restoration cannot override a newer Back or Forward destination', async () => {
  const {browser, load} = fixture('http://localhost/board/?subject=1');
  const frames = []; browser.requestAnimationFrame = (callback) => {frames.push(callback);};
  browser.history.state = {agentboard_scroll: {x: 0, y: 700, key: 1}}; await load();
  browser.location.href = 'http://localhost/board/?subject=2';
  browser.history.state = {agentboard_scroll: {x: 0, y: 900, key: 2}}; await load();
  frames[0](); assert.equal(browser.scrollY, 0);
  frames[1](); assert.equal(browser.scrollY, 900);
});
test('returning home during URL loading clears the cancelled destination from the address bar', async () => {
  const {reader, browser, load} = fixture('http://localhost/board/?subject=1');
  const original = reader.client.call; let resolveSubject;
  reader.client.call = (name, args) => name === 'get_subject'
    ? new Promise((resolve) => {resolveSubject = resolve;}) : original(name, args);
  const pending = load(); reader.closeSubject();
  resolveSubject(subject(1)); await pending;
  assert.equal(reader.state.subject, null);
  assert.equal(new URL(browser.location.href).searchParams.get('subject'), null);
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
  assert.equal(reader.state.conversation.length, 0);
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
