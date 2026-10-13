import {preview} from './content.js';

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const date = (value) => new Date(value).toLocaleString();
const byId = (id) => document.getElementById(id);
const count = (value, name) => `${value} ${name}${value === 1 ? '' : 's'} shown`;

function messageCard(message, full = false, loading = false) {
  const card = element('article', undefined, 'message');
  card.dataset.message = message.id;
  const heading = element('div', undefined, 'message-heading');
  heading.append(element('strong', message.author), element('span', message.kind, 'kind'),
    element('span', `#${message.id} · ${date(message.created_at)}`, 'meta'));
  card.append(heading);
  if (full) {
    card.id = 'context';
    const close = element('button', `Collapse message #${message.id}`, 'parent');
    close.type = 'button'; close.dataset.closeContext = '';
    card.append(close, element('p', message.body, 'body'));
  } else {
    card.append(element('p', preview(message.body), 'body'));
    const read = element('button', `Read message #${message.id}`, 'parent');
    read.type = 'button'; read.dataset.readMessage = message.id;
    read.disabled = loading;
    card.append(read);
  }
  if (message.parent_id !== null) {
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
  byId('status').textContent = loading ? 'Reading the board…'
    : `${count(s.subjects.length, 'subject')}${s.subject ? ` · ${count(s.messages.length, 'message')}` : ''}`;
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
  byId('conversation-heading').textContent = s.subject?.title ?? 'Choose a subject';
  byId('subject-description').textContent = s.subject?.description ?? 'Open a subject to read its messages.';
  byId('subject-meta').textContent = s.subject
    ? `#${s.subject.id} · ${s.subject.author} · ${date(s.subject.created_at)}` : '';
  byId('message-form').hidden = !s.subject;
  const messages = s.messages.map((message) => {
    if (s.context?.id === message.id && s.context_anchor_id === message.id) return messageCard(s.context, true, reader.busy.messages);
    const card = messageCard(message, false, reader.busy.messages);
    if (s.context && s.context_anchor_id === message.id) card.append(messageCard(s.context, true, reader.busy.messages));
    return card;
  });
  if (s.context && s.context_anchor_id === null) messages.unshift(messageCard(s.context, true));
  if (s.subject && !messages.length && !reader.busy.messages) {
    messages.push(element('p', s.message_query ? 'No messages match this search.' : 'No messages yet.'));
  }
  byId('message-list').replaceChildren(...messages);
  for (const [scope, cursor] of [['subjects', s.next_subject_cursor], ['messages', s.next_message_cursor]]) {
    byId(`more-${scope}`).hidden = cursor === null;
    byId(`more-${scope}`).disabled = reader.busy[scope];
  }
}
