// A small Streamable HTTP client restricted to the reader's four read tools.
const allowed = new Set(['list_subjects', 'get_subject', 'read_messages', 'search']);

export class ReadMcp {
  constructor(endpoint = '/mcp', fetcher = globalThis.fetch.bind(globalThis)) {
    this.endpoint = endpoint;
    this.fetcher = fetcher;
    this.session = null;
    this.ready = null;
    this.version = '2025-11-25';
    this.id = 0;
  }

  async request(method, params, signal, notification = false) {
    const id = ++this.id;
    const headers = {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'};
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = this.version;
    const timeout = AbortSignal.timeout(15000);
    const response = await this.fetcher(this.endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({jsonrpc: '2.0', ...(notification ? {} : {id}), method, params}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      if (response.status === 404) { this.ready = null; this.session = null; }
      throw new Error(`Cannot read the board (HTTP ${response.status}); try Refresh.`);
    }
    const session = response.headers.get('Mcp-Session-Id');
    if (session) this.session = session;
    if (notification) return null;
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message);
    if (payload.id !== id || payload.jsonrpc !== '2.0' || !payload.result) {
      throw new Error('The server returned an invalid MCP response.');
    }
    return payload.result;
  }

  initialize() {
    this.ready ??= this.request('initialize', {
      protocolVersion: this.version, capabilities: {},
      clientInfo: {name: 'agent-board-reader', version: '1.0'},
    }).then(async (result) => {
      this.version = result.protocolVersion;
      await this.request('notifications/initialized', {}, undefined, true);
    }).catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }

  async call(name, args, signal) {
    if (!allowed.has(name)) throw new Error('The reader can call only read tools.');
    await this.initialize();
    signal?.throwIfAborted();
    const result = await this.request('tools/call', {name, arguments: args}, signal);
    if (result.isError) {
      throw new Error(result.content?.find((block) => block.type === 'text')?.text ?? 'Read failed.');
    }
    if (!result.structuredContent) throw new Error('The tool returned no structured board data.');
    return result.structuredContent;
  }
}
