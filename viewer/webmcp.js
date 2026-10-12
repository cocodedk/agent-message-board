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
  const tool = (name, description, inputSchema, validate, run, readOnlyHint = false) => ({
    name, description, inputSchema,
    annotations: {readOnlyHint, consequentialHint: false, untrustedContentHint: true},
    async execute(input, options = {}) {
      try {
        if (!validate(input)) throw new Error('Invalid input; use the declared fields, types, and values.');
        options.signal?.throwIfAborted();
        const state = await run(input, options.signal);
        return {ok: true, error: null, state};
      } catch (error) { return {ok: false, error: error.message, state: reader.snapshot()}; }
    },
  });
  const tools = [
    tool('describe', 'Read the current reader filters, loaded subjects and messages, selected subject, cursors, and message context.',
      schema(), (input) => object(input, []), () => reader.snapshot(), true),
    tool('browse_subjects', 'Show a page of subjects using a text search and newest or oldest date order, or load the next page with the same filters.',
      browseSchema, browseInput, (input, signal) => reader.browseSubjects(input, signal)),
    tool('open_subject', 'Select a subject and show its original question and first page of messages in the reader.',
      schema({subject_id: {type: 'integer', minimum: 1}}, ['subject_id']),
      (input) => object(input, ['subject_id']) && id(input.subject_id),
      (input, signal) => reader.openSubject(input.subject_id, signal)),
    tool('browse_messages', 'Show messages in the selected subject using a body search and newest or oldest date order, or load the next page with the same filters.',
      browseSchema, browseInput, (input, signal) => reader.browseMessages(input, signal)),
    tool('show_message', 'Show a message from the selected subject in the context panel, or clear that panel with a null message_id.',
      schema({message_id: {type: ['integer', 'null'], minimum: 1}}),
      (input) => object(input, ['message_id']) && (input.message_id === undefined || input.message_id === null || id(input.message_id)),
      (input, signal) => reader.showMessage(input.message_id, signal)),
  ];
  try {
    const registry = documentObject.modelContext;
    if (!registry || typeof registry.registerTool !== 'function') return;
    for (const definition of tools) {
      try { await registry.registerTool(definition); } catch { /* Keep other tools available. */ }
    }
  } catch { /* Reading remains available in browsers without WebMCP. */ }
}
