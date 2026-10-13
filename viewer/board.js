import {PAGE_SIZE} from './content.js';

export class BoardReader {
  constructor(client, changed = () => {}) {
    this.client = client;
    this.changed = changed;
    this.state = {
      subject_query: '', subject_order: 'desc', subjects: [], subject: null,
      next_subject_cursor: null, message_query: '', message_order: 'desc',
      messages: [], next_message_cursor: null, context: null, context_anchor_id: null,
    };
    this.busy = {subjects: false, messages: false, context: false};
    this.errors = {subjects: null, messages: null, context: null};
    this.jobs = {};
    this.versions = {subjects: 0, messages: 0, context: 0};
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
    if (more && (query !== s.subject_query || order !== s.subject_order)) {
      throw new Error('Keep the same search and sort when loading more subjects.');
    }
    const after_id = more ? s.next_subject_cursor : 0;
    if (more && after_id === null) throw new Error('There are no more subjects; refresh or change the search.');
    s.subject_query = query; s.subject_order = order;
    if (!more) { s.subjects = []; s.next_subject_cursor = null; }
    const args = {after_id, limit: PAGE_SIZE, order};
    return this.perform('subjects', (requestSignal) => query
      ? this.client.call('search', {...args, query, scope: 'subjects'}, requestSignal)
      : this.client.call('list_subjects', args, requestSignal), (page) => {
      s.subjects = page.subjects;
      s.next_subject_cursor = page.next_after_id;
    }, signal);
  }

  openSubject(subject_id, signal) {
    this.cancel('context');
    const s = this.state;
    s.subject = null; s.messages = []; s.context = null; s.context_anchor_id = null;
    s.message_query = ''; s.next_message_cursor = null;
    return this.perform('messages', (requestSignal) => Promise.all([
      this.client.call('get_subject', {subject_id}, requestSignal),
      this.client.call('read_messages', {subject_id, limit: PAGE_SIZE, order: s.message_order}, requestSignal),
    ]), ([subject, page]) => {
      s.subject = subject; s.messages = page.messages; s.next_message_cursor = page.next_after_id;
    }, signal);
  }

  browseMessages({query = this.state.message_query, order = this.state.message_order,
    more = false} = {}, signal) {
    const s = this.state;
    if (!s.subject) throw new Error('Open a subject first.');
    query = query.trim();
    if (more && (query !== s.message_query || order !== s.message_order)) {
      throw new Error('Keep the same search and sort when loading more messages.');
    }
    const after_id = more ? s.next_message_cursor : 0;
    if (more && after_id === null) throw new Error('There are no more messages; refresh or change the search.');
    this.cancel('context'); s.context = null; s.context_anchor_id = null;
    s.message_query = query; s.message_order = order;
    if (!more) { s.messages = []; s.next_message_cursor = null; }
    const args = {subject_id: s.subject.id, after_id, limit: PAGE_SIZE, order};
    return this.perform('messages', (requestSignal) => query
      ? this.client.call('search', {...args, query, scope: 'messages'}, requestSignal)
      : this.client.call('read_messages', args, requestSignal), (page) => {
      s.messages = page.messages;
      s.next_message_cursor = page.next_after_id;
    }, signal);
  }

  showMessage(message_id = null, signal, after_message_id) {
    if (message_id === null) {
      this.cancel('context'); this.state.context = null; this.state.context_anchor_id = null; this.emit();
      return Promise.resolve(this.snapshot());
    }
    if (!this.state.subject) throw new Error('Open a subject first.');
    if (this.busy.messages) throw new Error('Wait until the message page finishes loading.');
    const rows = this.state.messages;
    const anchor = after_message_id === undefined ? (rows.some((row) => row.id === message_id)
      ? message_id : rows.find((row) => row.parent_id === message_id)?.id ?? null) : after_message_id;
    if (anchor !== null && !rows.some((row) => row.id === anchor)) throw new Error('Choose a message on the current page for inline placement.');
    const subject_id = this.state.subject.id;
    return this.perform('context', (requestSignal) => this.client.call('get_message', {message_id}, requestSignal),
      (message) => {
        if (message.subject_id !== subject_id) throw new Error('This message is in another subject.');
        this.state.context = message;
        this.state.context_anchor_id = anchor;
      }, signal);
  }

  closeSubject() {
    this.cancel('messages'); this.cancel('context');
    Object.assign(this.state, {subject: null, messages: [], message_query: '',
      next_message_cursor: null, context: null, context_anchor_id: null});
    this.emit();
  }

  async refresh() {
    const reads = [this.browseSubjects()];
    if (this.state.subject) reads.push(this.browseMessages());
    await Promise.allSettled(reads);
  }
}
