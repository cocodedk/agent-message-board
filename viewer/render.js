import {preview} from './content.js';
import {markdown} from './markdown.js';

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const date = (value) => new Date(value).toLocaleString();
const byId = (id) => document.getElementById(id);
const count = (value, name) => `${value} ${value === 1 ? name : name === 'reply' ? 'replies' : `${name}s`} shown`;

function messageCard(message, full = false, loading = false, thread = null, primary = false) {
  const card = element('article', undefined, 'message');
  card.dataset.message = message.id;
  const heading = element('div', undefined, 'message-heading');
  heading.append(element('strong', message.receiver ? `${message.author} → ${message.receiver}` : message.author),
    element('span', message.kind, 'kind'),
    element('span', `#${message.id} · ${date(message.created_at)}`, 'meta'));
  card.append(heading);
  if (primary) {
    card.append(markdown(message.body));
  } else if (full) {
    card.id = 'context';
    const close = element('button', `Collapse message #${message.id}`, 'parent');
    close.type = 'button'; close.dataset.closeContext = '';
    card.append(close, markdown(message.body));
  } else {
    card.append(markdown(preview(message.body)));
    const read = element('button', `Read message #${message.id}`, 'parent');
    read.type = 'button'; read.dataset.readMessage = message.id;
    read.disabled = loading;
    card.append(read);
  }
  if (!primary) {
    const open = element('button', `Open thread #${message.id}`, 'parent');
    open.type = 'button'; open.dataset.thread = message.id; open.disabled = loading;
    card.append(open);
  }
  if (!primary && message.parent_id !== null && message.parent_id !== thread?.id) {
    const parent = element('button', `Read parent #${message.parent_id}`, 'parent');
    parent.type = 'button'; parent.dataset.parent = message.parent_id;
    parent.disabled = loading;
    card.append(parent);
  }
  return card;
}

export function render(reader) {
  const s = reader.state;
  const loading = Object.values(reader.busy).some(Boolean);
  const view = s.subject ? (s.thread ? 'thread' : 'subject') : 'subjects';
  const list = s.message_query ? 'search result' : (s.thread ? 'reply' : 'thread');
  byId('subjects-view').hidden = view !== 'subjects';
  byId('discussion-view').hidden = view === 'subjects';
  byId('all-subjects').hidden = view === 'subjects';
  byId('subject-overview').hidden = view !== 'thread';
  byId('parent-thread').hidden = !s.thread?.parent_id;
  byId('parent-thread').textContent = s.thread?.parent_id ? `Parent thread #${s.thread.parent_id}` : 'Parent thread';
  byId('status').textContent = loading ? 'Reading the board…'
    : view === 'subjects' ? count(s.subjects.length, 'subject') : count(s.messages.length, list);
  byId('refresh').disabled = loading;
  const error = Object.values(reader.errors).find(Boolean);
  byId('error').hidden = !error;
  byId('error').textContent = error ?? '';
  for (const scope of ['subject', 'message']) {
    const input = byId(`${scope}-query`);
    if (document.activeElement !== input) input.value = s[`${scope}_query`];
    byId(`${scope}-order`).value = s[`${scope}_order`];
  }
  const subjects = s.subjects.map((subject) => {
    const button = element('button', undefined, 'subject-button');
    button.type = 'button'; button.dataset.subject = subject.id;
    button.setAttribute('aria-pressed', String(s.subject?.id === subject.id));
    button.append(element('strong', subject.title),
      element('span', `${subject.author} · ${date(subject.created_at)}`, 'meta'));
    return button;
  });
  if (!subjects.length && !reader.busy.subjects) {
    subjects.push(element('p', s.subject_query ? 'No subjects match this search.' : 'No subjects yet.'));
  }
  byId('subject-list').replaceChildren(...subjects);
  byId('conversation-heading').textContent = s.thread ? `Thread #${s.thread.id}` : s.subject?.title ?? 'Subjects';
  byId('page-intro').hidden = view !== 'subjects';
  byId('subject-overview').textContent = s.subject?.title ?? 'Subject overview';
  const description = s.subject?.description ?? '';
  byId('subject-preview').replaceChildren(markdown(preview(description.length <= 160 ? description : description.split(/\n\s*\n/)[0])));
  byId('subject-preview').hidden = view !== 'subject';
  byId('subject-details').hidden = view !== 'subject' || description.length <= 160;
  byId('subject-details').open = s.description_open;
  if (byId('subject-details').dataset.subject !== String(s.subject?.id)) {
    byId('subject-details').dataset.subject = String(s.subject?.id);
    byId('subject-description').replaceChildren(...(s.subject ? [markdown(description)] : []));
  }
  byId('subject-meta').textContent = s.subject
    ? `#${s.subject.id} · ${s.subject.author} · ${date(s.subject.created_at)}` : '';
  byId('message-form').hidden = !s.subject;
  byId('messages-heading').textContent = s.message_query ? 'Search results in this subject' : s.thread ? 'Direct replies' : 'Threads';
  byId('thread-post').hidden = !s.thread;
  byId('thread-post').replaceChildren(...(s.thread ? [messageCard(s.thread, true, false, s.thread, true)] : []));
  const messages = s.messages.map((message) => {
    if (s.context?.id === message.id && s.context_anchor_id === message.id) return messageCard(s.context, true, reader.busy.messages, s.thread);
    const card = messageCard(message, false, reader.busy.messages, s.thread);
    if (s.context && s.context_anchor_id === message.id) card.append(messageCard(s.context, true, reader.busy.messages, s.thread));
    return card;
  });
  if (s.context && s.context_anchor_id === null) messages.unshift(messageCard(s.context, true, false, s.thread));
  if (s.subject && !messages.length && !reader.busy.messages) {
    messages.push(element('p', s.message_query ? 'No messages match this search.' : s.thread ? 'No direct replies yet.' : 'No threads yet.'));
  }
  byId('message-list').replaceChildren(...messages);
  for (const [scope, cursor] of [['subjects', s.next_subject_cursor], ['messages', s.next_message_cursor]]) {
    byId(`more-${scope}`).hidden = cursor === null;
    byId(`more-${scope}`).disabled = reader.busy[scope];
  }
}
