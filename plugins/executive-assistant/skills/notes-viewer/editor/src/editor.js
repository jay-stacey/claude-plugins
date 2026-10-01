// Live-preview markdown editor for Notes Desk.
//
// The markdown text stays the single source of truth: decorations only change
// how it looks. Marks such as **, #, > and [[ ]] hide while the cursor is away
// from them and come back when it returns, so an edit changes exactly the
// characters typed and nothing else in the note. That matters because the note
// is usually the user's only copy and a sync writes the text back to disk.

import { EditorState, StateField, Compartment, EditorSelection } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, placeholder, drawSelection } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
// The language alone, not markdown(): that helper also loads HTML, CSS and
// JavaScript parsers for embedded code, which triples the bundle.
import { markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const WIKILINK = /\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g;
const TAG = /(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;

function frontmatterEnd(doc) {
  const head = doc.sliceString(0, Math.min(doc.length, 20000));
  const m = FRONTMATTER.exec(head);
  return m ? m[0].length : 0;
}

// ------------------------------------------------------------------ widgets

class CheckboxWidget extends WidgetType {
  constructor(checked, pos, readOnly) { super(); this.checked = checked; this.pos = pos; this.readOnly = readOnly; }
  eq(o) { return o.checked === this.checked && o.pos === this.pos && o.readOnly === this.readOnly; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-task';
    box.checked = this.checked;
    box.disabled = this.readOnly;
    box.setAttribute('aria-label', this.checked ? 'Done task' : 'Open task');
    box.addEventListener('mousedown', ev => {
      ev.preventDefault();
      if (this.readOnly) return;
      view.dispatch({ changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

class TextWidget extends WidgetType {
  constructor(text, cls) { super(); this.text = text; this.cls = cls; }
  eq(o) { return o.text === this.text && o.cls === this.cls; }
  toDOM() { const s = document.createElement('span'); s.className = this.cls; s.textContent = this.text; return s; }
}

class PropertiesWidget extends WidgetType {
  constructor(raw, end) { super(); this.raw = raw; this.end = end; }
  eq(o) { return o.raw === this.raw; }
  toDOM(view) {
    const box = document.createElement('div');
    box.className = 'cm-props';
    const label = document.createElement('span');
    label.className = 'cm-props-label';
    label.textContent = 'Properties';
    box.append(label);
    const keys = [];
    for (const line of this.raw.split(/\r?\n/).slice(1, -1)) {
      const m = /^([A-Za-z0-9_-]+):/.exec(line);
      if (m) keys.push(m[1]);
    }
    const sum = document.createElement('span');
    sum.className = 'cm-props-keys';
    sum.textContent = keys.length ? keys.join(' · ') : 'empty';
    box.append(sum);
    box.title = 'Click to edit the properties';
    box.addEventListener('mousedown', ev => {
      ev.preventDefault();
      const line = view.state.doc.line(Math.min(2, view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.to } });
      view.focus();
    });
    return box;
  }
  ignoreEvent() { return true; }
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
}
const plain = s => s
  .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|~~|\*|_|`)(.+?)\1/g, '$2');

class TableWidget extends WidgetType {
  constructor(src, from) { super(); this.src = src; this.from = from; }
  eq(o) { return o.src === this.src; }
  toDOM(view) {
    const lines = this.src.split('\n').filter(l => l.trim());
    const wrap = document.createElement('div');
    wrap.className = 'cm-tablew';
    const table = document.createElement('table');
    const align = (lines[1] ? splitRow(lines[1]) : []).map(c => /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : '');
    lines.forEach((line, i) => {
      if (i === 1) return;
      const tr = document.createElement('tr');
      splitRow(line).forEach((cell, j) => {
        const td = document.createElement(i === 0 ? 'th' : 'td');
        td.textContent = plain(cell);
        if (align[j]) td.style.textAlign = align[j];
        tr.append(td);
      });
      table.append(tr);
    });
    wrap.append(table);
    wrap.title = 'Click to edit the table';
    wrap.addEventListener('mousedown', ev => {
      ev.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}

// ------------------------------------------------------------------ frontmatter

// Block decorations must come from a state field, not a view plugin.
function propertiesDecos(state, readOnlyFlag) {
  const end = frontmatterEnd(state.doc);
  if (!end) return Decoration.none;
  const sel = state.selection.main;
  const inside = sel.from < end && sel.to >= 0 && sel.head < end;
  const lastLine = state.doc.lineAt(Math.max(0, end - 1));
  if (inside) {
    const decos = [];
    for (let n = 1; n <= lastLine.number; n++) decos.push(Decoration.line({ class: 'cm-fm' }).range(state.doc.line(n).from));
    return Decoration.set(decos);
  }
  const raw = state.doc.sliceString(0, lastLine.to);
  return Decoration.set([Decoration.replace({ widget: new PropertiesWidget(raw, end), block: true }).range(0, lastLine.to)]);
}

const propertiesField = StateField.define({
  create: s => propertiesDecos(s),
  update: (v, tr) => (tr.docChanged || tr.selection) ? propertiesDecos(tr.state) : v,
  provide: f => EditorView.decorations.from(f),
});

// Tables span lines, so they too are block widgets from a state field. A
// table shows as raw text while the cursor is inside it.
function tableDecos(state) {
  const out = [];
  const sel = state.selection.main;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return true;
      const from = state.doc.lineAt(node.from).from, to = state.doc.lineAt(node.to).to;
      if (!(sel.head >= from && sel.head <= to))
        out.push(Decoration.replace({ widget: new TableWidget(state.doc.sliceString(from, to), from), block: true }).range(from, to));
      return false;
    },
  });
  return Decoration.set(out);
}
const tableField = StateField.define({
  create: tableDecos,
  update: (v, tr) => (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) ? tableDecos(tr.state) : v,
  provide: f => EditorView.decorations.from(f),
});

// ------------------------------------------------------------------ live preview

const hide = Decoration.replace({});
const lineCls = cls => Decoration.line({ class: cls });
const markCls = (cls, attrs) => Decoration.mark({ class: cls, attributes: attrs });

function activeLines(view) {
  const lines = new Set();
  if (!view.hasFocus) return lines;
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number, b = view.state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return lines;
}

function buildDecos(view, opts) {
  const { state } = view;
  const doc = state.doc;
  const fmEnd = frontmatterEnd(doc);
  const active = activeLines(view);
  const isActive = (from, to) => {
    const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (active.has(n)) return true;
    return false;
  };
  const out = [];
  const code = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(node) {
        if (node.from < fmEnd) return node.to > fmEnd; // frontmatter is drawn by its own field
        const name = node.name;
        const live = !isActive(node.from, node.to);

        if (/^ATXHeading(\d)$/.test(name)) {
          out.push(lineCls('cm-h cm-h' + name.slice(-1)).range(doc.lineAt(node.from).from));
          return true;
        }
        if (/^SetextHeading(\d)$/.test(name)) {
          out.push(lineCls('cm-h cm-h' + name.slice(-1)).range(doc.lineAt(node.from).from));
          return true;
        }
        if (name === 'HeaderMark') {
          const parent = node.node.parent;
          if (parent && /^SetextHeading/.test(parent.name)) {
            if (live) out.push(lineCls('cm-setext').range(doc.lineAt(node.from).from), hide.range(node.from, node.to));
          } else if (live) {
            const after = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            out.push(hide.range(node.from, after));
          } else out.push(markCls('cm-mark').range(node.from, node.to));
          return false;
        }
        if (name === 'StrongEmphasis') { out.push(markCls('cm-strong').range(node.from, node.to)); return true; }
        if (name === 'Emphasis') { out.push(markCls('cm-em').range(node.from, node.to)); return true; }
        if (name === 'Strikethrough') { out.push(markCls('cm-strike').range(node.from, node.to)); return true; }
        if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
          out.push(live ? hide.range(node.from, node.to) : markCls('cm-mark').range(node.from, node.to));
          return false;
        }
        if (name === 'InlineCode') {
          code.push([node.from, node.to]);
          out.push(markCls('cm-icode').range(node.from, node.to));
          return true;
        }
        if (name === 'CodeMark') {
          const parent = node.node.parent;
          if (parent && parent.name === 'InlineCode') {
            if (live) out.push(hide.range(node.from, node.to));
          }
          return false;
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          code.push([node.from, node.to]);
          const a = doc.lineAt(node.from).number, b = doc.lineAt(node.to).number;
          for (let n = a; n <= b; n++) {
            const edge = name === 'FencedCode' && (n === a || n === b);
            out.push(lineCls(edge ? 'cm-codeblock cm-fence' : 'cm-codeblock').range(doc.line(n).from));
          }
          return false;
        }
        if (name === 'Blockquote') {
          const a = doc.lineAt(node.from).number, b = doc.lineAt(node.to).number;
          for (let n = a; n <= b; n++) out.push(lineCls('cm-quote').range(doc.line(n).from));
          return true;
        }
        if (name === 'QuoteMark') {
          if (live) {
            const after = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            out.push(hide.range(node.from, after));
          } else out.push(markCls('cm-mark').range(node.from, node.to));
          return false;
        }
        if (name === 'HorizontalRule') {
          if (live) out.push(lineCls('cm-hr').range(doc.lineAt(node.from).from), hide.range(node.from, node.to));
          return false;
        }
        if (name === 'ListMark') {
          const item = node.node.parent;
          const task = item && item.getChild('Task');
          const line = doc.lineAt(node.from);
          const lineLive = !active.has(line.number);
          if (task) {
            const marker = task.getChild('TaskMarker');
            if (marker && lineLive) {
              const checked = /x/i.test(doc.sliceString(marker.from + 1, marker.from + 2));
              const end = doc.sliceString(marker.to, marker.to + 1) === ' ' ? marker.to + 1 : marker.to;
              out.push(Decoration.replace({ widget: new CheckboxWidget(checked, marker.from + 1, opts.readOnly) }).range(node.from, end));
              if (checked && end < line.to) out.push(markCls('cm-done').range(end, line.to));
            }
            return false;
          }
          const bullet = /^[-*+]$/.test(doc.sliceString(node.from, node.to));
          if (bullet && lineLive) out.push(Decoration.replace({ widget: new TextWidget('•', 'cm-bullet') }).range(node.from, node.to));
          else out.push(markCls('cm-listmark').range(node.from, node.to));
          return false;
        }
        if (name === 'Link') {
          const marks = node.node.getChildren('LinkMark');
          const url = node.node.getChild('URL');
          if (live && marks.length >= 2) {
            const textFrom = marks[0].to, textTo = marks[1].from;
            const href = url ? doc.sliceString(url.from, url.to) : '';
            out.push(hide.range(marks[0].from, marks[0].to));
            if (textTo > textFrom) out.push(markCls('cm-link', { 'data-url': href, title: href }).range(textFrom, textTo));
            out.push(hide.range(marks[1].from, node.to));
            return false;
          }
          out.push(markCls('cm-link-raw').range(node.from, node.to));
          return false;
        }
        if (name === 'Image') {
          if (live) {
            const text = doc.sliceString(node.from, node.to);
            const alt = (/^!\[([^\]]*)\]/.exec(text) || [])[1] || 'image';
            out.push(Decoration.replace({ widget: new TextWidget('Image: ' + alt, 'cm-image') }).range(node.from, node.to));
          }
          return false;
        }
        if (name === 'URL') {
          const parent = node.node.parent;
          if (live && (!parent || parent.name !== 'Link')) {
            const href = doc.sliceString(node.from, node.to);
            out.push(markCls('cm-link', { 'data-url': href, title: href }).range(node.from, node.to));
          }
          return false;
        }
        if (name === 'Table') {
          const a = doc.lineAt(node.from).number, b = doc.lineAt(node.to).number;
          for (let n = a; n <= b; n++) out.push(lineCls('cm-table').range(doc.line(n).from));
          return false;
        }
        if (name === 'HTMLBlock' || name === 'CommentBlock') {
          const a = doc.lineAt(node.from).number, b = doc.lineAt(node.to).number;
          for (let n = a; n <= b; n++) out.push(lineCls('cm-html').range(doc.line(n).from));
          return false;
        }
        return true;
      },
    });

    // Wikilinks and #tags are not part of the markdown grammar, so find them
    // by pattern in the visible text, skipping code.
    const inCode = (a, b) => code.some(([x, y]) => a < y && b > x);
    const text = doc.sliceString(from, to);
    for (const m of text.matchAll(WIKILINK)) {
      const start = from + m.index, end = start + m[0].length;
      if (start < fmEnd || inCode(start, end)) continue;
      const target = m[1].trim();
      const known = opts.resolveWiki ? !!opts.resolveWiki(target) : true;
      if (isActive(start, end)) { out.push(markCls('cm-wiki-raw').range(start, end)); continue; }
      const shownFrom = m[3] ? end - 2 - m[3].length : start + 2;
      const shownTo = m[3] ? end - 2 : start + 2 + m[1].length;
      out.push(hide.range(start, shownFrom));
      out.push(markCls(known ? 'cm-wikilink' : 'cm-wikilink cm-missing', { 'data-target': target, title: known ? 'Open ' + target : target + ' is not in this snapshot' }).range(shownFrom, shownTo));
      out.push(hide.range(shownTo, end));
    }
    for (const m of text.matchAll(TAG)) {
      const start = from + m.index + m[1].length, end = start + 1 + m[2].length;
      if (start < fmEnd || inCode(start, end)) continue;
      const line = doc.lineAt(start);
      if (/^#{1,6}\s/.test(line.text) && start === line.from) continue;
      out.push(markCls('cm-tag', { 'data-tag': m[2].toLowerCase() }).range(start, end));
    }
  }
  return Decoration.set(out, true);
}

function livePreview(opts) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = buildDecos(view, opts); }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = buildDecos(u.view, opts);
    }
  }, { decorations: v => v.decorations });
}

// ------------------------------------------------------------------ commands

function wrap(view, mark) {
  const { state } = view;
  const tr = state.changeByRange(range => {
    const text = state.sliceDoc(range.from, range.to);
    const before = state.sliceDoc(range.from - mark.length, range.from);
    const after = state.sliceDoc(range.to, range.to + mark.length);
    if (before === mark && after === mark) {
      return { changes: [{ from: range.from - mark.length, to: range.from }, { from: range.to, to: range.to + mark.length }],
        range: EditorSelection.range(range.from - mark.length, range.to - mark.length) };
    }
    if (text.startsWith(mark) && text.endsWith(mark) && text.length >= mark.length * 2) {
      return { changes: { from: range.from, to: range.to, insert: text.slice(mark.length, text.length - mark.length) },
        range: EditorSelection.range(range.from, range.to - mark.length * 2) };
    }
    return { changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
      range: EditorSelection.range(range.from + mark.length, range.to + mark.length) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
  view.focus();
  return true;
}

const LINE_PREFIX = /^(\s*)(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/;

function setPrefix(view, prefix) {
  const { state } = view;
  const changes = [];
  const seen = new Set();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      const m = LINE_PREFIX.exec(line.text);
      const current = m[2] || '';
      const same = current.trim() === prefix.trim() ||
        (prefix === '1. ' && /^\d+[.)]\s+$/.test(current));
      changes.push({ from: line.from + m[1].length, to: line.from + m[1].length + current.length, insert: same ? '' : prefix });
    }
  }
  view.dispatch({ changes, userEvent: 'input' });
  view.focus();
  return true;
}

function insertAround(view, before, after, placeholderText) {
  const { state } = view;
  const tr = state.changeByRange(range => {
    const text = state.sliceDoc(range.from, range.to) || placeholderText;
    const insert = before + text + after;
    const selFrom = range.from + before.length;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(selFrom, selFrom + text.length) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
  view.focus();
  return true;
}

function insertLink(view) {
  const { state } = view;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to) || 'link text';
  const insert = `[${text}](https://)`;
  const urlFrom = r.from + text.length + 3;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: urlFrom, head: urlFrom + 8 }, userEvent: 'input' });
  view.focus();
  return true;
}

function insertRule(view) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const insert = (line.text.trim() ? '\n\n' : '') + '---\n';
  view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length }, userEvent: 'input' });
  view.focus();
  return true;
}

const COMMANDS = {
  bold: v => wrap(v, '**'),
  italic: v => wrap(v, '*'),
  strike: v => wrap(v, '~~'),
  code: v => wrap(v, '`'),
  h1: v => setPrefix(v, '# '),
  h2: v => setPrefix(v, '## '),
  h3: v => setPrefix(v, '### '),
  bullet: v => setPrefix(v, '- '),
  number: v => setPrefix(v, '1. '),
  task: v => setPrefix(v, '- [ ] '),
  quote: v => setPrefix(v, '> '),
  link: insertLink,
  wikilink: v => insertAround(v, '[[', ']]', 'Note name'),
  rule: insertRule,
};

// ------------------------------------------------------------------ public api

export function createEditor({ parent, doc = '', readOnly = false, live = true, onChange, onOpenLink, onOpenWiki, onTag, resolveWiki }) {
  const opts = { readOnly, resolveWiki };
  const previewSlot = new Compartment();
  const editSlot = new Compartment();
  let silent = false;

  const preview = () => live ? [livePreview(opts), propertiesField, tableField] : [];
  const editable = () => [EditorState.readOnly.of(opts.readOnly), EditorView.editable.of(!opts.readOnly)];

  const extensions = [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    markdownLanguage.extension,
    keymap.of([
      { key: 'Mod-b', run: COMMANDS.bold },
      { key: 'Mod-i', run: COMMANDS.italic },
      { key: 'Mod-k', run: COMMANDS.link },
      { key: 'Mod-Shift-x', run: COMMANDS.strike },
      { key: 'Mod-Enter', run: COMMANDS.task },
      { key: 'Enter', run: insertNewlineContinueMarkup },
      { key: 'Backspace', run: deleteMarkupBackward },
      ...defaultKeymap, ...historyKeymap, indentWithTab,
    ]),
    placeholder('Start writing…'),
    previewSlot.of(preview()),
    editSlot.of(editable()),
    EditorView.updateListener.of(u => {
      if (u.docChanged && !silent && onChange) onChange(u.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      mousedown(ev) {
        const el = ev.target instanceof Element ? ev.target : null;
        if (!el || ev.button !== 0) return false;
        const wiki = el.closest('.cm-wikilink');
        if (wiki && onOpenWiki) { ev.preventDefault(); onOpenWiki(wiki.getAttribute('data-target')); return true; }
        const link = el.closest('.cm-link');
        // A rendered link only exists while its line is not being edited.
        if (link && onOpenLink) {
          const url = link.getAttribute('data-url');
          if (url) { ev.preventDefault(); onOpenLink(url); return true; }
        }
        const tag = el.closest('.cm-tag');
        if (tag && onTag && (ev.ctrlKey || ev.metaKey || opts.readOnly)) { ev.preventDefault(); onTag(tag.getAttribute('data-tag')); return true; }
        return false;
      },
    }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
  view.dom.classList.toggle('cm-source', !live);

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(text, { readOnly: ro } = {}) {
      silent = true;
      if (ro !== undefined && ro !== opts.readOnly) {
        opts.readOnly = ro;
        view.dispatch({ effects: [editSlot.reconfigure(editable()), previewSlot.reconfigure(preview())] });
      }
      // Start below the properties block so it opens collapsed.
      const fm = FRONTMATTER.exec(text.slice(0, 20000));
      const start = fm ? fm[0].length : 0;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: start } });
      view.scrollDOM.scrollTop = 0;
      silent = false;
    },
    setLive(on) {
      live = on;
      view.dom.classList.toggle('cm-source', !on);
      view.dispatch({ effects: previewSlot.reconfigure(preview()) });
    },
    setReadOnly(ro) { opts.readOnly = ro; view.dispatch({ effects: [editSlot.reconfigure(editable()), previewSlot.reconfigure(preview())] }); },
    run(name) { return COMMANDS[name] ? COMMANDS[name](view) : false; },
    refresh() { view.dispatch({ effects: previewSlot.reconfigure(preview()) }); },
    scrollToLine(n) {
      const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 80 }) });
      view.focus();
    },
    focus() { view.focus(); },
    destroy() { view.destroy(); },
  };
}
