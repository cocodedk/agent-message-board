const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = readFileSync(process.env.WEBMCP_SOURCE || path.join(root, 'website/webmcp.js'), 'utf8');
const names = ['create_subject', 'list_subjects', 'search', 'get_subject', 'get_message', 'post_message', 'read_messages', 'addressed_to_me', 'help'];
const decode = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
  if (entity.startsWith('#')) return String.fromCodePoint(entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  return {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'"}[entity];
});
function parseHtml(html) {
  const rootNode = {tag:'document', attrs:{}, children:[]};
  const stack = [rootNode];
  const voidTags = new Set(['meta','link','br','img','input','hr','source','area','base','embed','param','track','wbr']);
  for (const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const tag = token.slice(2, -1).trim();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
    } else if (token.startsWith('<')) {
      const tag = token.match(/^<([\w-]+)/)[1];
      const attrs = {};
      for (const attribute of token.slice(tag.length + 1).matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[attribute[1]] = decode(attribute[2] ?? '');
      const node = {tag, attrs, children:[]};
      stack.at(-1).children.push(node);
      if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(node);
    } else stack.at(-1).children.push(decode(token));
  }
  return rootNode;
}

// A minimal selector adapter over a tree parsed from the actual published HTML.
class Element {
  constructor(raw) {
    this.tag = raw.tag;
    this.attrs = raw.attrs;
    this.children = raw.children.map((child) => typeof child === 'string' ? child : new Element(child));
    this.dataset = Object.fromEntries(Object.entries(raw.attrs).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5), value]));
  }
  get textContent() { return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.children = [value]; }
  matches(selector) {
    if (selector.startsWith('#')) return this.attrs.id === selector.slice(1);
    const attribute = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attribute) return Object.hasOwn(this.attrs, attribute[1]) && (attribute[2] === undefined || this.attrs[attribute[1]] === attribute[2]);
    return this.tag === selector;
  }
  querySelectorAll(selector) {
    const [ancestor, descendant] = selector.split(' ');
    const results = [];
    for (const child of this.children) {
      if (typeof child === 'string') continue;
      if (descendant && child.matches(ancestor)) results.push(...child.querySelectorAll(descendant));
      else {
        if (!descendant && child.matches(ancestor)) results.push(child);
        results.push(...child.querySelectorAll(selector));
      }
    }
    return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
function page(locale) {
  const filename = path.join(root, 'website', locale === 'fa' ? 'fa/index.html' : 'index.html');
  const document = new Element(parseHtml(readFileSync(filename, 'utf8')));
  document.documentElement = document.querySelector('html');
  document.documentElement.lang = document.documentElement.attrs.lang;
  return document;
}
async function register(document, registryOptions = {}) {
  const registered = new Map();
  const attempts = [];
  if (!registryOptions.absent) {
    document.modelContext = {
      async registerTool(tool) {
        attempts.push(tool.name);
        if (tool.name === registryOptions.refuse) throw new Error('refused');
        registered.set(tool.name, tool);
      },
      getTools() { throw new Error('A registration module must not require registry discovery.'); },
    };
  }
  vm.runInNewContext(source, {document});
  await new Promise((resolve) => setImmediate(resolve));
  return {registered, attempts};
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const keys = (answer, expected) => assert.deepEqual(Object.keys(answer).toSorted(), expected.toSorted());
const failure = (answer) => { keys(answer, ['ok', 'error']); assert.equal(answer.ok, false); assert.equal(typeof answer.error, 'string'); assert.ok(answer.error.length > 0); };

for (const locale of ['en', 'fa']) {
  test(`${locale}: the actual page registers three read-only tools with closed inputs`, async () => {
    const {registered} = await register(page(locale));
    assert.deepEqual([...registered.keys()], ['describe', 'get_setup', 'get_tool_help']);
    for (const tool of registered.values()) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.consequentialHint, false);
      assert.equal(tool.annotations.untrustedContentHint, false);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(typeof tool.description, 'string');
    }
    assert.deepEqual(plain(registered.get('get_tool_help').inputSchema.properties.name.enum), names);
  });
  test(`${locale}: describe answers from the page with a closed shape`, async () => {
    const document = page(locale);
    const {registered} = await register(document);
    const answer = plain(await registered.get('describe').execute({}));
    keys(answer, ['ok', 'language', 'title', 'summary', 'sections', 'tools']);
    assert.equal(answer.ok, true);
    assert.equal(answer.language, locale);
    assert.equal(answer.title, document.querySelector('h1').textContent.trim());
    assert.equal(answer.summary, document.querySelector('#page-summary').textContent.trim());
    assert.equal(answer.sections.length, 4);
    assert.deepEqual(answer.tools, names);
    document.querySelector('#page-summary').textContent = 'Changed visible summary';
    assert.equal((await registered.get('describe').execute({})).summary, 'Changed visible summary');
  });
  test(`${locale}: setup returns the visible commands, endpoint, and storage`, async () => {
    const document = page(locale);
    const {registered} = await register(document);
    const answer = plain(await registered.get('get_setup').execute({}));
    keys(answer, ['ok', 'language', 'requirements', 'stdio_command', 'stdio', 'http_command', 'http', 'endpoint', 'storage']);
    assert.equal(answer.ok, true);
    assert.equal(answer.language, locale);
    assert.equal(answer.stdio_command, 'uv sync --locked\nuv run python server.py');
    assert.equal(answer.http_command, 'uv run python server.py --transport streamable-http');
    assert.equal(answer.endpoint, 'http://127.0.0.1:8000/mcp');
    assert.match(answer.storage, /data\/board\.sqlite3/);
    for (const [field, selector] of Object.entries({requirements:'[data-requirements]', stdio:'[data-stdio-info]', http:'[data-http-info]', storage:'[data-storage]'})) assert.equal(answer[field], document.querySelector(selector).textContent.trim());
  });
  test(`${locale}: every server tool returns its actual visible help`, async () => {
    const document = page(locale);
    const {registered} = await register(document);
    for (const name of names) {
      const answer = plain(await registered.get('get_tool_help').execute({name}));
      keys(answer, ['ok', 'language', 'name', 'description', 'parameters', 'example']);
      assert.equal(answer.ok, true);
      assert.equal(answer.language, locale);
      assert.equal(answer.name, name);
      const section = document.querySelector(`[data-tool="${name}"]`);
      assert.equal(answer.description, section.querySelector('[data-description]').textContent.trim());
      assert.equal(answer.parameters, section.querySelector('[data-parameters]').textContent.trim());
      assert.equal(answer.example, section.querySelector('[data-example]').textContent.trim());
      assert.equal(typeof JSON.parse(answer.example), 'object');
    }
    document.querySelector('[data-tool="help"]').querySelector('[data-description]').textContent = 'Changed visible help';
    assert.equal((await registered.get('get_tool_help').execute({name:'help'})).description, 'Changed visible help');
  });
  test(`${locale}: malformed, extra, and array inputs return only closed errors`, async () => {
    const {registered} = await register(page(locale));
    for (const tool of registered.values()) {
      const invalid = [null, undefined, [], ['help'], 'help', 3, true, {unexpected:'help'}];
      if (tool.name === 'get_tool_help') invalid.push({}, {name:3}, {name:null}, {name:[]}, {name:'help', extra:true});
      else invalid.push({name:'help'});
      for (const input of invalid) failure(plain(await tool.execute(input)));
    }
  });
  test(`${locale}: existing page IDs cannot bypass the server tool allowlist`, async () => {
    const document = page(locale);
    assert.ok(document.querySelector('#setup'), 'The hostile input must name an existing page element.');
    const {registered} = await register(document);
    const queries = [];
    const original = document.querySelector.bind(document);
    document.querySelector = (selector) => { queries.push(selector); return original(selector); };
    for (const name of ['setup', 'storage', 'get_setup', 'help"] [data-tool="search', '__proto__']) {
      const answer = plain(await registered.get('get_tool_help').execute({name}));
      failure(answer);
      assert.match(answer.error, /^Choose name from:/);
    }
    assert.deepEqual(queries, [], 'Unapproved names must be rejected before any DOM lookup.');
  });
}
test('absence of WebMCP leaves the documentation untouched', async () => {
  const document = page('en');
  const before = document.textContent;
  const {registered, attempts} = await register(document, {absent:true});
  assert.equal(registered.size, 0);
  assert.deepEqual(attempts, []);
  assert.equal(document.textContent, before);
});
test('one refused registration does not prevent the remaining tools', async () => {
  const {registered, attempts} = await register(page('en'), {refuse:'describe'});
  assert.deepEqual(attempts, ['describe', 'get_setup', 'get_tool_help']);
  assert.deepEqual([...registered.keys()], ['get_setup', 'get_tool_help']);
});
test('a missing tool section returns a closed error', async () => {
  const document = page('en');
  const {registered} = await register(document);
  document.querySelector('[data-tool="help"]').attrs['data-tool'] = 'unavailable';
  failure(plain(await registered.get('get_tool_help').execute({name:'help'})));
});
test('a throwing registry getter is silent', async () => {
  const document = page('en');
  Object.defineProperty(document, 'modelContext', {get() { throw new Error('Unavailable API'); }});
  vm.runInNewContext(source, {document});
  await new Promise((resolve) => setImmediate(resolve));
});
