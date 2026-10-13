import assert from 'node:assert/strict';
import {test} from 'node:test';
import {markdown} from '../viewer/markdown.js';

class Node {
  constructor(tag = '#text', text = '') {this.tag = tag; this.text = text; this.children = [];}
  set textContent(value) {this.text = value; this.children = [];}
  get textContent() {return this.text + this.children.map((child) => child.textContent).join('');}
  append(...children) {this.children.push(...children);}
}
const documentObject = {baseURI: 'http://localhost:8000/board/',
  createElement: (tag) => new Node(tag), createTextNode: (text) => new Node('#text', text)};
const all = (node) => [node, ...node.children.flatMap(all)];
test('Markdown renders headings, emphasis, code, lists, quotes and tables as structured readable nodes', () => {
  const result = markdown('## Steps\n\n1. **Start** `server`\n2. *Read*\n\n> Evidence\n\n```sh\nrun & check\n```\n\n| A | B |\n| - | - |\n| one | two |', documentObject);
  const tags = all(result).map((node) => node.tag);
  for (const tag of ['h4', 'ol', 'li', 'strong', 'em', 'blockquote', 'pre', 'code', 'table', 'th', 'td']) assert.ok(tags.includes(tag), tag);
  assert.ok(result.textContent.includes('run & check'));
});
test('HTML and images stay literal readable text and never create executable or remote-loading elements', () => {
  const text = '<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n![diagram](https://example.test/image.png)\n\n<svg onload=alert(3)>danger</svg>';
  const result = markdown(text, documentObject);
  assert.ok(result.textContent.includes('<script>alert(2)</script>'));
  assert.ok(result.textContent.includes('diagram'));
  assert.ok(all(result).every((node) => !['img', 'script', 'svg', 'iframe', 'input', 'form'].includes(node.tag)));
});
test('links allow only web and email protocols and cannot execute script or data URLs', () => {
  const result = markdown('[web](https://example.test/) [local](/board/?subject=1) [mail](mailto:a@example.test) [bad](javascript:alert%281%29) [data](data:text/html,evil) [script](vbscript:evil)', documentObject);
  assert.deepEqual(all(result).filter((node) => node.tag === 'a').map((node) => node.href),
    ['https://example.test/', 'http://localhost:8000/board/?subject=1', 'mailto:a@example.test']);
  assert.ok(result.textContent.includes('bad'));
});
