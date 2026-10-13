import {marked} from './marked.js';

// Render lexer tokens as DOM nodes: board text never becomes executable HTML.
export function markdown(text, documentObject = document) {
  const node = (tag, value) => {
    const result = documentObject.createElement(tag);
    if (value !== undefined) result.textContent = value;
    return result;
  };
  const append = (parent, tokens = []) => {
    for (const token of tokens) {
      let child;
      switch (token.type) {
        case 'space': continue;
        case 'heading': child = node(`h${Math.min(6, token.depth + 2)}`); break;
        case 'paragraph': child = node('p'); break;
        case 'strong': child = node('strong'); break;
        case 'em': child = node('em'); break;
        case 'del': child = node('del'); break;
        case 'br': child = node('br'); break;
        case 'hr': child = node('hr'); break;
        case 'codespan': child = node('code', token.text); break;
        case 'code': child = node('pre'); child.append(node('code', token.text)); break;
        case 'blockquote': child = node('blockquote'); break;
        case 'list':
          child = node(token.ordered ? 'ol' : 'ul');
          if (token.ordered && Number.isSafeInteger(token.start)) child.start = token.start;
          for (const item of token.items) {
            const entry = node('li');
            if (item.task) entry.append(documentObject.createTextNode(item.checked ? '☑ ' : '☐ '));
            append(entry, item.tokens); child.append(entry);
          }
          parent.append(child); continue;
        case 'table': {
          child = node('div'); child.className = 'table-scroll';
          const table = node('table'), head = node('thead'), row = node('tr'), body = node('tbody');
          for (const cell of token.header) {const entry = node('th'); append(entry, cell.tokens); row.append(entry);}
          head.append(row);
          for (const cells of token.rows) {
            const line = node('tr');
            for (const cell of cells) {const entry = node('td'); append(entry, cell.tokens); line.append(entry);}
            body.append(line);
          }
          table.append(head, body); child.append(table); parent.append(child); continue;
        }
        case 'link':
          child = node('span');
          try {
            const href = new URL(token.href, documentObject.baseURI);
            if (['http:', 'https:', 'mailto:'].includes(href.protocol)) {
              child = node('a'); child.href = href.href; child.rel = 'nofollow noopener noreferrer';
            }
          } catch { /* Invalid links remain readable text. */ }
          break;
        case 'text':
          if (token.tokens) {append(parent, token.tokens); continue;}
          parent.append(documentObject.createTextNode(token.text)); continue;
        default: parent.append(documentObject.createTextNode(token.text ?? token.raw ?? '')); continue;
      }
      if (token.tokens) append(child, token.tokens);
      parent.append(child);
    }
  };
  const result = node('div'); result.className = 'markdown';
  append(result, marked.lexer(text));
  return result;
}
