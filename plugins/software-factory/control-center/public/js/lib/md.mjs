// Small, escaped markdown renderer. Pure: no DOM, no vendor imports.
//
// parseMarkdown(text) -> block AST (plain objects).
// mdToHtml(text)      -> HTML string where every text run is escaped (tests, fallback).
// mdToVNodes(text, h) -> Preact vnodes (what the UI uses; no innerHTML at all).
//
// Supported: ATX headings, paragraphs, ordered/unordered lists (one level), fenced
// code blocks, block quotes, horizontal rules, pipe tables, inline code, bold,
// italic, and links whose URL starts with http:// or https://. Everything else
// is shown as text.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeUrl(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(u)) return null;
  // Reject anything the browser could still read as a scheme switch.
  if (/[\u0000-\u001f]/.test(u)) return null;
  return u;
}

// ---------- inline ----------

/** Inline tokens: {t:'text'|'code'|'strong'|'em'|'link', v, children, href} */
export function parseInline(src) {
  const out = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && /[\\`*_[\]()#+\-.!|]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((c === '*' || c === '_') && src[i + 1] === c) {
      const end = src.indexOf(c + c, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (c === '*' || (c === '_' && (i === 0 || /\W/.test(src[i - 1])))) {
      const end = src.indexOf(c, i + 1);
      if (end > i + 1 && src[i + 1] !== ' ') {
        flush();
        out.push({ t: 'em', children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const close = src.indexOf(']', i + 1);
      if (close > i && src[close + 1] === '(') {
        const pend = src.indexOf(')', close + 2);
        if (pend > close) {
          const label = src.slice(i + 1, close);
          const href = safeUrl(src.slice(close + 2, pend));
          flush();
          if (href) out.push({ t: 'link', href, children: parseInline(label) });
          else out.push({ t: 'text', v: src.slice(i, pend + 1) });
          i = pend + 1;
          continue;
        }
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

// ---------- blocks ----------

const isFence = (l) => /^\s*(```|~~~)/.test(l);
const isHr = (l) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
const isHeading = (l) => /^\s{0,3}#{1,6}\s/.test(l);
const isUl = (l) => /^\s{0,3}[-*+]\s+/.test(l);
const isOl = (l) => /^\s{0,3}\d{1,9}[.)]\s+/.test(l);
const isQuote = (l) => /^\s{0,3}>/.test(l);
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = (l) => {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};

export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (isFence(line)) {
      const fence = line.trim().slice(0, 3);
      const lang = line.trim().slice(3).trim();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) { body.push(lines[i]); i += 1; }
      i += 1;
      blocks.push({ t: 'code', lang, v: body.join('\n') });
      continue;
    }
    if (isHr(line)) { blocks.push({ t: 'hr' }); i += 1; continue; }
    if (isHeading(line)) {
      const m = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      blocks.push({ t: 'h', level: m[1].length, children: parseInline(m[2]) });
      i += 1;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i += 1; }
      blocks.push({
        t: 'table',
        head: head.map(parseInline),
        rows: rows.map((r) => head.map((_, k) => parseInline(r[k] ?? ''))),
      });
      continue;
    }
    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const test = ordered ? isOl : isUl;
      const strip = ordered ? /^\s{0,3}\d{1,9}[.)]\s+/ : /^\s{0,3}[-*+]\s+/;
      const items = [];
      while (i < lines.length && (test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (test(lines[i])) items.push(lines[i].replace(strip, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i += 1;
      }
      const start = ordered ? parseInt(/\d+/.exec(line)[0], 10) : 1;
      blocks.push({ t: ordered ? 'ol' : 'ul', start, items: items.map((s) => parseInline(s.replace(/^\[( |x|X)\]\s+/, (_, x) => (x === ' ' ? '[ ] ' : '[x] ')))) });
      continue;
    }
    if (isQuote(line)) {
      const body = [];
      while (i < lines.length && isQuote(lines[i])) { body.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i += 1; }
      blocks.push({ t: 'quote', children: parseMarkdown(body.join('\n')) });
      continue;
    }
    const para = [];
    while (
      i < lines.length && lines[i].trim() && !isFence(lines[i]) && !isHeading(lines[i]) &&
      !isHr(lines[i]) && !isUl(lines[i]) && !isOl(lines[i]) && !isQuote(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) { para.push(lines[i].trim()); i += 1; }
    blocks.push({ t: 'p', children: parseInline(para.join(' ')) });
  }
  return blocks;
}

// ---------- HTML string renderer (escaped) ----------

function inlineHtml(nodes) {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text': return escapeHtml(n.v);
      case 'code': return `<code>${escapeHtml(n.v)}</code>`;
      case 'strong': return `<strong>${inlineHtml(n.children)}</strong>`;
      case 'em': return `<em>${inlineHtml(n.children)}</em>`;
      case 'link': return `<a href="${escapeHtml(n.href)}" rel="noreferrer noopener" target="_blank">${inlineHtml(n.children)}</a>`;
      default: return '';
    }
  }).join('');
}

function blocksHtml(blocks) {
  return blocks.map((b) => {
    switch (b.t) {
      case 'h': return `<h${b.level}>${inlineHtml(b.children)}</h${b.level}>`;
      case 'p': return `<p>${inlineHtml(b.children)}</p>`;
      case 'hr': return '<hr>';
      case 'code': return `<pre><code>${escapeHtml(b.v)}</code></pre>`;
      case 'quote': return `<blockquote>${blocksHtml(b.children)}</blockquote>`;
      case 'ul': return `<ul>${b.items.map((it) => `<li>${inlineHtml(it)}</li>`).join('')}</ul>`;
      case 'ol': return `<ol start="${Number(b.start) || 1}">${b.items.map((it) => `<li>${inlineHtml(it)}</li>`).join('')}</ol>`;
      case 'table':
        return `<table><thead><tr>${b.head.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead><tbody>${
          b.rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      default: return '';
    }
  }).join('\n');
}

export function mdToHtml(text) {
  return blocksHtml(parseMarkdown(text));
}

// ---------- vnode renderer ----------

function inlineV(nodes, h) {
  return nodes.map((n, k) => {
    switch (n.t) {
      case 'text': return n.v;
      case 'code': return h('code', { key: k }, n.v);
      case 'strong': return h('strong', { key: k }, inlineV(n.children, h));
      case 'em': return h('em', { key: k }, inlineV(n.children, h));
      case 'link': return h('a', { key: k, href: n.href, rel: 'noreferrer noopener', target: '_blank' }, inlineV(n.children, h));
      default: return null;
    }
  });
}

function blocksV(blocks, h) {
  return blocks.map((b, k) => {
    switch (b.t) {
      case 'h': return h(`h${Math.min(6, b.level + 1)}`, { key: k, class: `md-h${b.level}` }, inlineV(b.children, h));
      case 'p': return h('p', { key: k }, inlineV(b.children, h));
      case 'hr': return h('hr', { key: k });
      case 'code': return h('pre', { key: k, class: 'md-code', tabIndex: 0 }, h('code', null, b.v));
      case 'quote': return h('blockquote', { key: k }, blocksV(b.children, h));
      case 'ul': return h('ul', { key: k }, b.items.map((it, j) => h('li', { key: j }, inlineV(it, h))));
      case 'ol': return h('ol', { key: k, start: b.start }, b.items.map((it, j) => h('li', { key: j }, inlineV(it, h))));
      case 'table':
        return h('div', { key: k, class: 'md-table-wrap', tabIndex: 0 },
          h('table', null,
            h('thead', null, h('tr', null, b.head.map((c, j) => h('th', { key: j, scope: 'col' }, inlineV(c, h))))),
            h('tbody', null, b.rows.map((r, j) => h('tr', { key: j }, r.map((c, x) => h('td', { key: x }, inlineV(c, h))))))));
      default: return null;
    }
  });
}

/** Headings are shifted down one level so a document h1 sits under the panel's own h2. */
export function mdToVNodes(text, h) {
  return blocksV(parseMarkdown(text), h);
}
