import {BoardReader} from './board.js';
import {ReadMcp} from './mcp.js';
import {render} from './render.js';
import {registerWebMcp} from './webmcp.js';
import {bindNavigation} from './navigation.js';

const reader = new BoardReader(new ReadMcp(), render);
const loadFromUrl = bindNavigation(reader);
const safely = (operation) => { Promise.resolve().then(operation).catch(() => {}); };
const byId = (id) => document.getElementById(id);
byId('subject-details').addEventListener('toggle', () => {
  if (!reader.busy.messages && reader.state.description_open !== byId('subject-details').open) {
    reader.state.description_open = byId('subject-details').open; reader.emit();
  }
});
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
byId('message-list').addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-toggle]');
  if (toggle) safely(() => reader.toggleThread(Number(toggle.dataset.toggle)));
  const result = event.target.closest('[data-reveal]');
  if (result) safely(() => reader.openThread(Number(result.dataset.reveal)));
});
byId('more-subjects').addEventListener('click', () => safely(() => reader.browseSubjects({more: true})));
byId('more-messages').addEventListener('click', () => safely(() => reader.browseMessages({more: true})));
byId('refresh').addEventListener('click', () => safely(() => reader.refresh()));
byId('all-subjects').addEventListener('click', () => reader.closeSubject());
render(reader);
void registerWebMcp(reader);
safely(() => reader.browseSubjects());
safely(loadFromUrl);
