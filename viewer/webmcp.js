import {TREE_LIMIT, listPreview, messagePreview, overview, rootOf, subjectSummary, threadRows} from './content.js';

const object = (input, keys) => input !== null && typeof input === 'object'
  && !Array.isArray(input) && Object.keys(input).every((key) => keys.includes(key));
const id = (value) => Number.isSafeInteger(value) && value > 0;
const schema = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const browseSchema = (orders) => schema({query: {type: 'string', maxLength: 200},
  order: {type: 'string', enum: orders}, more: {type: 'boolean'}});
const browseInput = (orders) => (input) => object(input, ['query', 'order', 'more'])
  && (input.query === undefined || (typeof input.query === 'string' && Array.from(input.query).length <= 200))
  && (input.order === undefined || orders.includes(input.order))
  && (input.more === undefined || typeof input.more === 'boolean');
const subjectOrders = ['activity', 'desc', 'asc'], messageOrders = ['desc', 'asc'];
const page = (state) => state.messages.slice(state.page_start).map((message) => listPreview(state, message));

function threadTree(state) {
  const root = rootOf(state.conversation, state.focus_id);
  const rows = threadRows(state.conversation, root.id);
  return {root_id: root.id, message_id: state.focus_id, reply_count: rows.length - 1,
    messages: rows.slice(0, TREE_LIMIT).map(({message, depth}) => ({...messagePreview(message), depth})),
    omitted: Math.max(0, rows.length - TREE_LIMIT)};
}

export async function registerWebMcp(reader, documentObject = document) {
  const tool = (name, description, inputSchema, validate, run, project = overview, readOnlyHint = false) => ({
    name, description, inputSchema,
    annotations: {readOnlyHint, consequentialHint: false, untrustedContentHint: true},
    async execute(input, options = {}) {
      try {
        if (!validate(input)) throw new Error('Invalid input; use the declared fields, types, and values.');
        options.signal?.throwIfAborted();
        const state = await run(input, options.signal);
        return {ok: true, error: null, state: project(state)};
      } catch (error) { return {ok: false, error: error.message, state: overview(reader.snapshot())}; }
    },
  });
  const tools = [
    tool('describe', 'Say what the page shows: the subject list filters and counts, the open subject, its thread counts, unfolded threads, and cursors, without message bodies.',
      schema(), (input) => object(input, []), () => reader.snapshot(), overview, true),
    tool('browse_subjects', 'List up to ten subjects with message counts and last activity, by search and order (recent activity, newest, or oldest), or replace them with the next page.',
      browseSchema(subjectOrders), browseInput(subjectOrders), (input, signal) => reader.browseSubjects(input, signal),
      (state) => ({...overview(state), subjects: state.subjects.map(subjectSummary)})),
    tool('open_subject', 'Open a subject with its whole conversation and return its question and the first ten root-thread previews with reply counts.',
      schema({subject_id: {type: 'integer', minimum: 1}, expand_description: {type: 'boolean'}}, ['subject_id']),
      (input) => object(input, ['subject_id', 'expand_description']) && id(input.subject_id)
        && (input.expand_description === undefined || typeof input.expand_description === 'boolean'),
      (input, signal) => reader.openSubject(input.subject_id, signal, input.expand_description),
      (state) => ({...overview(state), subject: state.subject, messages: page(state)})),
    tool('open_thread', 'Unfold the thread containing one message of the open subject in place and return that thread as up to twenty previews with depths.',
      schema({message_id: {type: 'integer', minimum: 1}}, ['message_id']),
      (input) => object(input, ['message_id']) && id(input.message_id),
      (input) => reader.openThread(input.message_id),
      (state) => ({...overview(state), thread: threadTree(state)})),
    tool('browse_messages', 'Show ten more root threads of the open subject, or search its message bodies, and return that page as previews with reply counts.',
      browseSchema(messageOrders), browseInput(messageOrders), (input, signal) => reader.browseMessages(input, signal),
      (state) => ({...overview(state), messages: page(state)})),
  ];
  try {
    const registry = documentObject.modelContext;
    if (!registry || typeof registry.registerTool !== 'function') return;
    for (const definition of tools) {
      try { await registry.registerTool(definition); } catch { /* Keep other tools available. */ }
    }
  } catch { /* Reading remains available in browsers without WebMCP. */ }
}
