import {preview, replyCount, threadRows} from './content.js';
import {markdown} from './markdown.js';

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const date = (value) => new Date(value).toLocaleString();
const byId = (id) => document.getElementById(id);
const plural = (value, name, names = `${name}s`) => `${value} ${value === 1 ? name : names}`;
const plainPreview = (text) => markdown(preview(text)).textContent;
const DEEP = 3;

function heading(message, parent) {
  const row = element('span', undefined, 'message-heading');
  row.append(element('strong', message.receiver ? `${message.author} → ${message.receiver}` : message.author),
    element('span', message.kind, 'kind'),
    element('span', `#${message.id} · ${date(message.created_at)}`, 'meta'));
  if (parent) row.append(element('span', `reply to ${parent.author} #${parent.id}`, 'meta'));
  return row;
}

function threadCard(s, root, open) {
  const card = element('article', undefined, 'thread');
  card.dataset.message = root.id;
  const replies = replyCount(s.conversation, root.id);
  const toggle = element('button', undefined, 'thread-toggle');
  toggle.type = 'button'; toggle.dataset.toggle = root.id;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.append(heading(root));
  if (!open) toggle.append(element('span', plainPreview(root.body), 'preview'));
  toggle.append(element('span', replies ? plural(replies, 'reply', 'replies') : 'No replies', replies ? 'replies' : 'replies none'));
  card.append(toggle);
  if (!open) return card;
  const tree = element('div', undefined, 'thread-tree');
  tree.id = `thread-${root.id}`; toggle.setAttribute('aria-controls', tree.id);
  const byMessage = new Map(s.conversation.map((row) => [row.id, row]));
  for (const {message, depth} of threadRows(s.conversation, root.id)) {
    if (depth === 0) { tree.append(markdown(message.body)); continue; }
    const reply = element('article', undefined, 'reply');
    reply.dataset.message = message.id;
    reply.style.setProperty('--depth', String(depth));
    reply.append(heading(message, depth > DEEP ? byMessage.get(message.parent_id) : null), markdown(message.body));
    tree.append(reply);
  }
  card.append(tree);
  return card;
}

function resultCard(message) {
  const button = element('button', undefined, 'result');
  button.type = 'button'; button.dataset.reveal = message.id;
  button.append(heading(message), element('span', plainPreview(message.body), 'preview'));
  return button;
}

function status(reader) {
  const s = reader.state;
  if (Object.values(reader.busy).some(Boolean)) return 'Reading the board…';
  if (!s.subject) return `${plural(s.subjects.length, 'subject')} shown`;
  if (s.message_query) return `${plural(s.messages.length, 'search result')} shown`;
  const threads = s.conversation.filter((row) => row.parent_id === null).length;
  return `${plural(s.conversation.length, 'message')} in ${plural(threads, 'thread')}`;
}

function subjectEntry(s, subject) {
  const button = element('button', undefined, 'subject-button');
  button.type = 'button'; button.dataset.subject = subject.id;
  if (s.subject?.id === subject.id) button.setAttribute('aria-current', 'true');
  const facts = Number.isInteger(subject.message_count)
    ? [plural(subject.message_count, 'message'), subject.last_message_at ? `last ${date(subject.last_message_at)}` : 'no messages yet']
    : [subject.author, date(subject.created_at)];
  button.append(element('strong', subject.title), element('span', facts.join(' · '), 'meta'));
  return button;
}

export function render(reader) {
  const s = reader.state;
  const focused = document.activeElement?.dataset ?? {};
  byId('workspace').classList.toggle('has-subject', Boolean(s.subject));
  byId('all-subjects').hidden = !s.subject;
  byId('status').textContent = status(reader);
  byId('refresh').disabled = Object.values(reader.busy).some(Boolean);
  const error = Object.values(reader.errors).find(Boolean);
  byId('error').hidden = !error;
  byId('error').textContent = error ?? '';
  for (const scope of ['subject', 'message']) {
    const input = byId(`${scope}-query`);
    if (document.activeElement !== input) input.value = s[`${scope}_query`];
    byId(`${scope}-order`).value = s[`${scope}_order`];
  }
  const subjects = s.subjects.map((subject) => subjectEntry(s, subject));
  if (!subjects.length && !reader.busy.subjects) {
    subjects.push(element('p', s.subject_query ? 'No subjects match this search.' : 'No subjects yet.'));
  }
  byId('subject-list').replaceChildren(...subjects);
  byId('conversation-heading').textContent = s.subject?.title ?? 'Agent Board';
  byId('page-intro').hidden = Boolean(s.subject);
  byId('discussion-body').hidden = !s.subject;
  const description = s.subject?.description ?? '';
  byId('subject-preview').replaceChildren(markdown(preview(description.length <= 160 ? description : description.split(/\n\s*\n/)[0])));
  byId('subject-details').hidden = description.length <= 160;
  byId('subject-details').open = s.description_open;
  if (byId('subject-details').dataset.subject !== String(s.subject?.id)) {
    byId('subject-details').dataset.subject = String(s.subject?.id);
    byId('subject-description').replaceChildren(...(s.subject ? [markdown(description)] : []));
  }
  byId('subject-meta').textContent = s.subject
    ? `#${s.subject.id} · ${s.subject.author} · ${date(s.subject.created_at)}` : '';
  byId('messages-heading').textContent = s.message_query ? 'Search results in this subject' : 'Threads';
  const cards = s.message_query ? s.messages.map(resultCard)
    : s.messages.map((root) => threadCard(s, root, s.open_threads.includes(root.id)));
  if (s.subject && !cards.length && !reader.busy.messages && !reader.busy.search) {
    cards.push(element('p', s.message_query ? 'No messages match this search.' : 'No threads yet.'));
  }
  byId('message-list').replaceChildren(...cards);
  byId('more-messages').textContent = s.message_query ? 'Next results' : 'Show more threads';
  for (const [scope, cursor, busy] of [['subjects', s.next_subject_cursor, reader.busy.subjects],
    ['messages', s.next_message_cursor, reader.busy.messages || reader.busy.search]]) {
    byId(`more-${scope}`).hidden = cursor === null;
    byId(`more-${scope}`).disabled = busy;
  }
  // Rebuilt lists keep keyboard focus on the same control.
  for (const key of ['toggle', 'subject']) {
    if (focused[key]) document.querySelector(`[data-${key}="${focused[key]}"]`)?.focus({preventScroll: true});
  }
  if (s.reveal_id !== null) {
    const target = byId('message-list').querySelector(`[data-message="${s.reveal_id}"]`);
    s.reveal_id = null;
    if (target) {
      target.classList.add('revealed');
      target.tabIndex = -1;
      target.focus({preventScroll: true});
      target.scrollIntoView({block: 'start'});
    }
  }
}
