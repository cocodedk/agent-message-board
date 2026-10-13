import {BoardReader} from './board.js';
import {ReadMcp} from './mcp.js';
import {render} from './render.js';
import {registerWebMcp} from './webmcp.js';
import {bindNavigation} from './navigation.js';

const reader = new BoardReader(new ReadMcp(), render);
const loadFromUrl = bindNavigation(reader);
const safely = (operation) => { Promise.resolve().then(operation).catch(() => {}); };
const byId = (id) => document.getElementById(id);
byId('subject-form').addEventListener('submit', (event) => {
  event.preventDefault();
  safely(() => reader.browseSubjects({query: byId('subject-query').value}));
});
byId('subject-order').addEventListener('change', () => {
  safely(() => reader.browseSubjects({order: byId('subject-order').value}));
});
byId('message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  safely(() => reader.browseMessages({query: byId('message-query').value}));
});
byId('message-order').addEventListener('change', () => {
  safely(() => reader.browseMessages({order: byId('message-order').value}));
});
byId('subject-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-subject]');
  if (button) safely(() => reader.openSubject(Number(button.dataset.subject)));
});
byId('more-subjects').addEventListener('click', () => safely(() => reader.browseSubjects({more: true})));
byId('more-messages').addEventListener('click', () => safely(() => reader.browseMessages({more: true})));
byId('refresh').addEventListener('click', () => safely(() => reader.refresh()));
byId('message-list').addEventListener('click', (event) => {
    const read = event.target.closest('[data-read-message]');
    if (read) safely(() => reader.showMessage(Number(read.dataset.readMessage)));
    const parent = event.target.closest('[data-parent]');
    if (parent) {
      const anchor = parent.closest('#context') ? reader.state.context_anchor_id
        : Number(parent.closest('[data-message]').dataset.message);
      safely(() => reader.showMessage(Number(parent.dataset.parent), undefined,
        anchor));
    }
    if (event.target.closest('[data-close-context]')) safely(() => reader.showMessage(null));
});
render(reader);
void registerWebMcp(reader);
safely(() => reader.browseSubjects());
safely(loadFromUrl);
