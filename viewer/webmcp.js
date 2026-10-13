import {overview, subjectSummary, messagePreview} from './content.js';

const object = (input, keys) => input !== null && typeof input === 'object'
  && !Array.isArray(input) && Object.keys(input).every((key) => keys.includes(key));
const id = (value) => Number.isSafeInteger(value) && value > 0;
const schema = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const browseSchema = schema({query: {type: 'string', maxLength: 200},
  order: {type: 'string', enum: ['asc', 'desc']}, more: {type: 'boolean'}});
const browseInput = (input) => object(input, ['query', 'order', 'more'])
  && (input.query === undefined || (typeof input.query === 'string' && Array.from(input.query).length <= 200))
  && (input.order === undefined || ['asc', 'desc'].includes(input.order))
  && (input.more === undefined || typeof input.more === 'boolean');

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
    tool('describe', 'Read reader filters, selection metadata, page counts, and cursors without question descriptions or message bodies.',
      schema(), (input) => object(input, []), () => reader.snapshot(), overview, true),
    tool('browse_subjects', 'Show up to ten subject titles and metadata matching a search and date order, or replace them with the next page.',
      browseSchema, browseInput, (input, signal) => reader.browseSubjects(input, signal),
      (state) => ({...overview(state), subjects: state.subjects.map(subjectSummary)})),
    tool('open_subject', 'Open a subject with its original question and ten root-thread previews, optionally expanding its description on screen.',
      schema({subject_id: {type: 'integer', minimum: 1}, expand_description: {type: 'boolean'}}, ['subject_id']),
      (input) => object(input, ['subject_id', 'expand_description']) && id(input.subject_id)
        && (input.expand_description === undefined || typeof input.expand_description === 'boolean'),
      (input, signal) => reader.openSubject(input.subject_id, signal, input.expand_description),
      (state) => ({...overview(state), subject: state.subject, messages: state.messages.map(messagePreview)})),
    tool('open_thread', 'Open one message as a thread with its full text and up to ten direct-reply previews, without nested descendants.',
      schema({message_id: {type: 'integer', minimum: 1}}, ['message_id']),
      (input) => object(input, ['message_id']) && id(input.message_id),
      (input, signal) => reader.openThread(input.message_id, signal),
      (state) => ({...overview(state), thread: state.thread, messages: state.messages.map(messagePreview)})),
    tool('browse_messages', 'Browse ten root threads or direct replies in the current view, or search all message bodies in the selected subject with 160-character previews.',
      browseSchema, browseInput, (input, signal) => reader.browseMessages(input, signal),
      (state) => ({...overview(state), messages: state.messages.map(messagePreview)})),
    tool('show_message', 'Read one message in full inline at its row or after after_message_id, or collapse it with a null message_id.',
      schema({message_id: {type: ['integer', 'null'], minimum: 1}, after_message_id: {type: 'integer', minimum: 1}}),
      (input) => object(input, ['message_id', 'after_message_id'])
        && (input.message_id === undefined || input.message_id === null || id(input.message_id))
        && (input.after_message_id === undefined || id(input.after_message_id)),
      (input, signal) => reader.showMessage(input.message_id, signal, input.after_message_id),
      (state) => ({...overview(state), context: state.context})),
  ];
  try {
    const registry = documentObject.modelContext;
    if (!registry || typeof registry.registerTool !== 'function') return;
    for (const definition of tools) {
      try { await registry.registerTool(definition); } catch { /* Keep other tools available. */ }
    }
  } catch { /* Reading remains available in browsers without WebMCP. */ }
}
