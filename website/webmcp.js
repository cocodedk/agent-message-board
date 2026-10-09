// This draft API is document.modelContext; re-check the spec before editing.
const names = ['create_subject', 'list_subjects', 'search', 'get_subject', 'get_message', 'post_message', 'read_messages', 'help'];
const text = (selector, root = document) => root.querySelector(selector)?.textContent.trim() ?? '';
const language = () => document.documentElement.lang;
const objectInput = (input, keys) => input !== null && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every((key) => keys.includes(key));
const schema = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const failure = (error) => ({ok: false, error});
const definitions = [
  {
    name: 'describe',
    description: 'Read the current documentation page summary, language, section headings, and available server tool names.',
    inputSchema: schema(),
    execute(input) {
      if (!objectInput(input, [])) return failure('Expected an object with no properties.');
      return {ok: true, language: language(), title: text('h1'), summary: text('#page-summary'), sections: Array.from(document.querySelectorAll('main h2'), (node) => node.textContent.trim()), tools: Array.from(document.querySelectorAll('[data-tool]'), (node) => node.dataset.tool)};
    },
  },
  {
    name: 'get_setup',
    description: 'Read the visible server setup commands, requirements, stdio and HTTP transport details, endpoint, and SQLite storage guidance.',
    inputSchema: schema(),
    execute(input) {
      if (!objectInput(input, [])) return failure('Expected an object with no properties.');
      return {ok: true, language: language(), requirements: text('[data-requirements]'), stdio_command: text('[data-setup-stdio]'), stdio: text('[data-stdio-info]'), http_command: text('[data-setup-http]'), http: text('[data-http-info]'), endpoint: text('[data-endpoint]'), storage: text('[data-storage]')};
    },
  },
  {
    name: 'get_tool_help',
    description: 'Read a named MCP server tool description, parameters, and example input from this documentation page in its current language.',
    inputSchema: schema({name: {type: 'string', enum: names}}, ['name']),
    execute(input) {
      if (!objectInput(input, ['name']) || typeof input.name !== 'string' || !names.includes(input.name)) return failure(`Choose name from: ${names.join(', ')}.`);
      const section = document.querySelector(`[data-tool="${input.name}"]`);
      if (!section) return failure('This tool section is unavailable on the page.');
      return {ok: true, language: language(), name: input.name, description: text('[data-description]', section), parameters: text('[data-parameters]', section), example: text('[data-example]', section)};
    },
  },
];
async function initWebMcp() {
  try {
    const registry = document.modelContext;
    if (!registry || typeof registry.registerTool !== 'function') return;
    for (const definition of definitions) {
      try {
        await registry.registerTool({...definition, annotations: {readOnlyHint: true, untrustedContentHint: false, consequentialHint: false}});
      } catch { /* A rejected tool must not prevent other registrations. */ }
    }
  } catch { /* Browsers without an available registry keep the same document. */ }
}
void initWebMcp();
