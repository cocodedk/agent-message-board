import {PAGE_SIZE, rootOf, sortedRoots} from './content.js';

const READ_LIMIT = 100;
const SUBJECT_ORDERS = ['activity', 'desc', 'asc'];

export class BoardReader {
  constructor(client, changed = () => {}) {
    this.client = client;
    this.changed = changed;
    this.state = {
      subject_query: '', subject_order: 'activity', subjects: [], next_subject_cursor: null,
      subject: null, conversation: [], open_threads: [], focus_id: null, reveal_id: null,
      message_query: '', message_order: 'desc', messages: [], page_start: 0, next_message_cursor: null,
      description_open: false,
    };
    this.busy = {subjects: false, messages: false, search: false};
    this.errors = {subjects: null, messages: null, search: null};
    this.jobs = {};
    this.versions = {subjects: 0, messages: 0, search: 0};
  }

  snapshot() { return {...this.state}; }
  emit() { this.changed(this); }
  cancel(scope) {
    this.jobs[scope]?.abort();
    this.versions[scope] += 1;
    this.busy[scope] = false;
    this.errors[scope] = null;
  }

  async perform(scope, fetcher, apply, signal) {
    this.cancel(scope);
    const version = this.versions[scope];
    const controller = new AbortController();
    this.jobs[scope] = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    this.busy[scope] = true;
    this.emit();
    try {
      const result = await fetcher(controller.signal);
      if (version !== this.versions[scope] || controller.signal.aborted) {
        throw new DOMException('This read was cancelled or replaced.', 'AbortError');
      }
      apply(result);
      return this.snapshot();
    } catch (error) {
      if (version === this.versions[scope]) this.errors[scope] = error.message;
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (version === this.versions[scope]) { this.busy[scope] = false; this.emit(); }
    }
  }

  browseSubjects({query = this.state.subject_query, order = this.state.subject_order,
    more = false} = {}, signal) {
    query = query.trim();
    const s = this.state;
    if (!SUBJECT_ORDERS.includes(order)) throw new Error('Sort subjects by activity, desc, or asc.');
    if (more && (query !== s.subject_query || order !== s.subject_order)) {
      throw new Error('Keep the same search and sort when loading more subjects.');
    }
    const after_id = more ? s.next_subject_cursor : 0;
    if (more && after_id === null) throw new Error('There are no more subjects; refresh or change the search.');
    s.subject_query = query; s.subject_order = order;
    if (!more) { s.subjects = []; s.next_subject_cursor = null; }
    const args = {after_id, limit: PAGE_SIZE, order};
    // Subject search has no activity order on the server, so it lists newest first.
    return this.perform('subjects', (requestSignal) => query
      ? this.client.call('search', {...args, order: order === 'activity' ? 'desc' : order, query, scope: 'subjects'}, requestSignal)
      : this.client.call('list_subjects', args, requestSignal), (page) => {
      s.subjects = page.subjects;
      s.next_subject_cursor = page.next_after_id;
    }, signal);
  }

  async readConversation(subject_id, signal) {
    const rows = [];
    let after_id = 0;
    do {
      signal?.throwIfAborted();
      const page = await this.client.call('read_messages', {subject_id, after_id, limit: READ_LIMIT, order: 'asc'}, signal);
      rows.push(...page.messages);
      after_id = page.next_after_id;
    } while (after_id !== null);
    return rows;
  }

  loadSubject(subject_id, signal, apply) {
    return this.perform('messages', (requestSignal) => Promise.all([
      this.client.call('get_subject', {subject_id}, requestSignal),
      this.readConversation(subject_id, requestSignal),
    ]), apply, signal);
  }

  openSubject(subject_id, signal, description_open = false) {
    this.cancel('search');
    const s = this.state;
    Object.assign(s, {subject: null, conversation: [], open_threads: [], focus_id: null, reveal_id: null,
      messages: [], message_query: '', page_start: 0, next_message_cursor: null, description_open: false});
    return this.loadSubject(subject_id, signal, ([subject, rows]) => {
      s.subject = subject; s.description_open = description_open; s.conversation = rows;
      this.showRoots(PAGE_SIZE);
    });
  }

  // Root threads are paged in the browser: each page adds ten more cards below the shown ones.
  showRoots(count, start = 0) {
    const s = this.state;
    const roots = sortedRoots(s.conversation, s.message_order);
    s.messages = roots.slice(0, Math.max(PAGE_SIZE, count));
    s.page_start = Math.min(start, s.messages.length);
    s.next_message_cursor = roots.length > s.messages.length ? s.messages.at(-1).id : null;
  }

  ready() {
    if (!this.state.subject) throw new Error('Open a subject first.');
    if (this.busy.messages) throw new Error('Wait until the subject finishes loading.');
  }

  browseMessages({query = this.state.message_query, order = this.state.message_order,
    more = false} = {}, signal) {
    const s = this.state;
    this.ready();
    query = query.trim();
    if (more && (query !== s.message_query || order !== s.message_order)) {
      throw new Error('Keep the same search and sort when loading more messages.');
    }
    if (more && s.next_message_cursor === null) throw new Error('There are no more messages; refresh or change the search.');
    if (!query) {
      this.cancel('search');
      const start = more ? s.messages.length : 0;
      s.message_query = ''; s.message_order = order;
      this.showRoots(start + PAGE_SIZE, start);
      this.emit();
      return Promise.resolve(this.snapshot());
    }
    const after_id = more ? s.next_message_cursor : 0;
    s.message_query = query; s.message_order = order;
    if (!more) { s.messages = []; s.next_message_cursor = null; s.page_start = 0; }
    return this.perform('search', (requestSignal) => this.client.call('search',
      {subject_id: s.subject.id, after_id, limit: PAGE_SIZE, order, query, scope: 'messages'}, requestSignal), (page) => {
      s.messages = page.messages; s.page_start = 0;
      s.next_message_cursor = page.next_after_id;
    }, signal);
  }

  unfold(message_id, reveal) {
    const s = this.state;
    this.ready();
    const root = rootOf(s.conversation, message_id);
    if (!root) throw new Error(`Message #${message_id} is not in this subject.`);
    this.cancel('search');
    const index = sortedRoots(s.conversation, s.message_order).findIndex((row) => row.id === root.id);
    const shown = s.message_query ? 0 : s.messages.length;
    s.message_query = '';
    this.showRoots(Math.max(shown, (Math.floor(index / PAGE_SIZE) + 1) * PAGE_SIZE));
    if (!s.open_threads.includes(root.id)) s.open_threads = [...s.open_threads, root.id];
    s.focus_id = message_id;
    s.reveal_id = reveal ? message_id : null;
    this.emit();
    return this.snapshot();
  }

  // Unfold the whole thread that contains a message (a root or any reply) and scroll to that message.
  openThread(message_id) { return this.unfold(message_id, true); }

  toggleThread(root_id) {
    const s = this.state;
    if (!s.open_threads.includes(root_id)) return this.unfold(root_id, false);
    this.ready();
    s.open_threads = s.open_threads.filter((id) => id !== root_id);
    if (s.focus_id !== null && rootOf(s.conversation, s.focus_id)?.id === root_id) s.focus_id = s.open_threads.at(-1) ?? null;
    s.reveal_id = null;
    this.emit();
    return this.snapshot();
  }

  closeSubject() {
    this.cancel('messages'); this.cancel('search');
    Object.assign(this.state, {subject: null, conversation: [], open_threads: [], focus_id: null, reveal_id: null,
      messages: [], message_query: '', page_start: 0, next_message_cursor: null, description_open: false});
    this.emit();
  }

  reloadSubject() {
    const s = this.state, query = s.message_query, shown = query ? PAGE_SIZE : s.messages.length;
    return this.loadSubject(s.subject.id, undefined, ([subject, rows]) => {
      s.subject = subject; s.conversation = rows;
      if (!query) this.showRoots(shown);
    }).then(() => (query ? this.browseMessages({query}) : this.snapshot()));
  }

  async refresh() {
    await Promise.allSettled([this.browseSubjects(), ...(this.state.subject ? [this.reloadSubject()] : [])]);
  }
}
