import { EditorState, StateField, type Text } from "@codemirror/state";
import { ParseContext, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownConfig } from "@lezer/markdown";
import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const literalBlockNames = new Set([
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "CommentBlock",
  "ProcessingInstructionBlock",
  "MathBlock",
]);
const mathSyntax: MarkdownConfig = {
  defineNodes: [{ name: "MathBlock", block: true }, "InlineMath"],
  parseBlock: [
    {
      name: "MathBlock",
      before: "FencedCode",
      parse(context, line) {
        const fence = /^\${2,}[ \t]*$/.exec(line.text.slice(line.pos));
        if (!fence) return false;
        const from = context.lineStart + line.pos;
        const size = fence[0].trim().length;
        let to = context.lineStart + line.text.length;
        while (context.nextLine()) {
          // Lezer omits continuation depth from Line's type, but eager blocks need its container boundary.
          if ("depth" in line && typeof line.depth === "number" && line.depth < context.depth)
            break;
          to = context.lineStart + line.text.length;
          if (new RegExp("^\\${" + size + ",}[ \\t]*$").test(line.text.slice(line.pos))) {
            context.nextLine();
            break;
          }
        }
        context.addElement(context.elt("MathBlock", from, to));
        return true;
      },
    },
  ],
  parseInline: [
    {
      name: "InlineMath",
      before: "Emphasis",
      parse(context, next, from) {
        if (next !== "$".charCodeAt(0)) return -1;
        const delimiter = context.char(from + 1) === next ? "$$" : "$";
        const rest = context.slice(from + delimiter.length, context.end);
        const end = rest.indexOf(delimiter);
        if (end < 0) return -1;
        const to = from + delimiter.length + end + delimiter.length;
        return context.addElement(context.elt("InlineMath", from, to));
      },
    },
  ],
};

const opensFrontmatter = /^\uFEFF?---[ \t]*$/;
const closesFrontmatter = /^(?:---|\.\.\.)[ \t]*$/;

function readFrontmatterEnd(document: Text): number {
  const opening = document.sliceString(0, Math.min(document.length, "\uFEFF--- ".length));
  if (!/^\uFEFF?---(?:[ \t\r\n]|$)/.test(opening)) return 0;
  const firstLine = document.line(1);
  if (!opensFrontmatter.test(firstLine.text) || document.lines === 1) return 0;
  let from = firstLine.to + 1;
  for (const line of document.iterLines(firstLine.number + 1)) {
    if (closesFrontmatter.test(line)) {
      const end = Math.min(document.length, from + line.length + 1);
      return fileMarkdownFrontmatterEnd(document.sliceString(0, end));
    }
    from += line.length + 1;
  }
  return 0;
}

export const fileMarkdownFrontmatter = StateField.define({
  create: (state) => readFrontmatterEnd(state.doc),
  update(end, transaction) {
    if (!transaction.docChanged) return end;
    if (!opensFrontmatter.test(transaction.state.doc.line(1).text)) return 0;
    const boundary = end || transaction.startState.doc.line(1).to;
    let recheck = false;
    transaction.changes.iterChangedRanges((from, _to, nextFrom, nextTo) => {
      if (from <= boundary) recheck = true;
      if (end) return;
      const first = transaction.state.doc.lineAt(nextFrom).number;
      const last = transaction.state.doc.lineAt(nextTo).number;
      for (const line of transaction.state.doc.iterLines(first, last + 1)) {
        if (closesFrontmatter.test(line)) recheck = true;
      }
    });
    return recheck ? readFrontmatterEnd(transaction.state.doc) : transaction.changes.mapPos(end);
  },
});

const sourceLanguage = markdown({
  base: markdownLanguage,
  extensions: mathSyntax,
  completeHTMLTags: false,
  pasteURLAsLink: false,
});

export function fileMarkdownLanguage() {
  const language = markdown({
    base: sourceLanguage.language,
    extensions: {
      wrap(inner, input, fragments, ranges) {
        const end =
          ParseContext.get()?.state.field(fileMarkdownFrontmatter, false) ??
          fileMarkdownFrontmatterEnd(input.read(0, input.length));
        if (!end) return inner;
        const mask = (value: string, from: number) =>
          from >= end
            ? value
            : value.slice(0, end - from).replace(/[^\r\n]/g, " ") + value.slice(end - from);
        // メタ情報の各行は空白へ置き換わり、解析器は部分木の再利用前にそれらの行を読み飛ばす。
        return sourceLanguage.language.parser.startParse(
          {
            length: input.length,
            lineChunks: input.lineChunks,
            chunk: (from) => mask(input.chunk(from), from),
            read: (from, to) => mask(input.read(from, to), from),
          },
          fragments,
          ranges,
        );
      },
    },
    completeHTMLTags: false,
    pasteURLAsLink: false,
  });
  return [fileMarkdownFrontmatter, language];
}

export function parseFileMarkdown(source: string) {
  const tree = parser.parse(maskMarkdownFrontmatter(source));
  const definitions = new Map<string, string>();
  const definitionRanges: { from: number; to: number; identifier: string; source: string }[] = [];
  const footnoteRanges: { from: number; to: number }[] = [];
  const collect = (node: Nodes) => {
    if (node.type === "definition") {
      const from = node.position!.start.offset!;
      const to = node.position!.end.offset!;
      if (!definitions.has(node.identifier))
        definitions.set(node.identifier, source.slice(from, to));
      definitionRanges.push({
        from,
        to,
        identifier: node.identifier,
        source: source.slice(from, to),
      });
    }
    if (node.type === "footnoteDefinition")
      footnoteRanges.push({ from: node.position!.start.offset!, to: node.position!.end.offset! });
    if ("children" in node) for (const child of node.children) collect(child);
  };
  collect(tree);
  return { definitions, definitionRanges, footnoteRanges, hasFootnotes: footnoteRanges.length > 0 };
}

function fileMarkdownFrontmatterEnd(source: string) {
  const masked = maskMarkdownFrontmatter(source);
  if (masked === source) return 0;
  const body = masked.search(/\S/);
  let end = body < 0 ? source.length : body;
  while (end > 0 && source[end - 1] === masked[end - 1]) end--;
  return end + (/^[ \t]*(?:\r\n|\r|\n|$)/.exec(source.slice(end))?.[0].length ?? 0);
}

export function refreshFileMarkdownReferences(
  state: EditorState,
  previous: ReturnType<typeof parseFileMarkdown>["definitionRanges"],
  frontmatterEnd = 0,
  changed = { from: 0, to: state.doc.length },
  previousFootnotes: ReturnType<typeof parseFileMarkdown>["footnoteRanges"] = [],
) {
  const tree = syntaxTree(state);
  const cache = new Map(previous.map((entry) => [entry.source, entry.identifier]));
  const definitionRanges = previous.filter(
    (entry) =>
      entry.to > frontmatterEnd &&
      (entry.to < changed.from || entry.from > changed.to || entry.from >= tree.length),
  );
  tree.iterate({
    from: changed.from,
    to: changed.to,
    enter(node) {
      if (node.to <= frontmatterEnd) return false;
      if (literalBlockNames.has(node.name)) return false;
      if (node.name !== "LinkReference") return;
      const source = state.sliceDoc(node.from, node.to);
      const identifier =
        cache.get(source) ?? parseFileMarkdown(source).definitionRanges[0]?.identifier;
      if (identifier) definitionRanges.push({ from: node.from, to: node.to, identifier, source });
      return false;
    },
  });
  definitionRanges.sort((left, right) => left.from - right.from);
  const definitions = new Map<string, string>();
  for (const entry of definitionRanges)
    if (!definitions.has(entry.identifier)) definitions.set(entry.identifier, entry.source);
  const footnoteSpan = { ...changed };
  for (const range of previousFootnotes) {
    if (range.to >= changed.from && range.from <= changed.to) {
      footnoteSpan.from = Math.min(footnoteSpan.from, range.from);
      footnoteSpan.to = Math.max(footnoteSpan.to, range.to);
    }
  }
  footnoteSpan.from = Math.max(frontmatterEnd, state.doc.lineAt(footnoteSpan.from).from);
  footnoteSpan.to = Math.max(
    footnoteSpan.from,
    state.doc.lineAt(Math.min(footnoteSpan.to, state.doc.length)).to,
  );
  const footnoteRanges = previousFootnotes.filter(
    (range) =>
      range.to > frontmatterEnd && (range.to < footnoteSpan.from || range.from > footnoteSpan.to),
  );
  const source = state.sliceDoc(footnoteSpan.from, footnoteSpan.to);
  if (source.includes("[^"))
    for (const range of parseFileMarkdown(source).footnoteRanges) {
      const from = range.from + footnoteSpan.from;
      let context: SyntaxNode | null = tree.resolveInner(from, 1);
      while (context && !literalBlockNames.has(context.name)) context = context.parent;
      if (context) continue;
      footnoteRanges.push({ from, to: range.to + footnoteSpan.from });
    }
  return { definitions, definitionRanges, footnoteRanges, hasFootnotes: footnoteRanges.length > 0 };
}

interface SourceRange {
  from: number;
  to: number;
}
type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];
type MarkdownPresentation = SourceRange &
  (
    | { kind: "hide" }
    | { kind: "mark"; tag: string }
    | { kind: "line"; className: string; headingLevel?: number }
    | { kind: "preview"; text: string; footnotes?: boolean }
    | { kind: "bullet"; label: string; checked: boolean | null; markerOffset: number }
  );
const inlineTags = {
  StrongEmphasis: "strong",
  Emphasis: "em",
  Strikethrough: "s",
  InlineCode: "code",
};
const previewNodes = new Set([...literalBlockNames, "Table", "HorizontalRule"]);
const complexInline = new Set([
  "Image",
  "Link",
  "Autolink",
  "HTMLTag",
  "Comment",
  "ProcessingInstruction",
  "Entity",
  "Escape",
  "InlineMath",
]);

function children(node: SyntaxNode) {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

function isComplex(node: SyntaxNode, cache: WeakMap<object, boolean>): boolean {
  const key = node.tree ?? node;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const complex =
    previewNodes.has(node.name) ||
    complexInline.has(node.name) ||
    children(node).some((child) => isComplex(child, cache));
  cache.set(key, complex);
  return complex;
}

export function presentFileMarkdown(
  state: EditorState,
  definitions: ReadonlyMap<string, string>,
  selections: readonly SourceRange[],
  mode: "all" | "blocks" | "inline" = "all",
  viewport: SourceRange = { from: 0, to: state.doc.length },
  complexity: WeakMap<object, boolean> = new WeakMap(),
): MarkdownPresentation[] {
  const result: MarkdownPresentation[] = [];
  const overlap = (node: SourceRange, selection: SourceRange) =>
    selection.from <= node.to && selection.to >= state.doc.lineAt(node.from).from;
  const active = (node: SourceRange) => selections.some((selection) => overlap(node, selection));
  const hide = (node: SourceRange) => {
    if (node.to > node.from) result.push({ kind: "hide", from: node.from, to: node.to });
  };
  const preview = (node: SyntaxNode) => {
    const from = state.doc.lineAt(node.from).from;
    const references = new Set<string>();
    const collect = (child: SyntaxNode) => {
      if (child.name === "Link" || child.name === "Image") {
        const source = state.sliceDoc(child.from, child.to);
        const match = /\]\[([^\]]*)\]$/.exec(source) ?? /^!?\[([^\]]+)\]$/.exec(source);
        const key = match ? match[1] || /^!?\[([^\]]+)\]/.exec(source)?.[1] : undefined;
        const definition = key
          ? definitions.get(key.trim().replace(/\s+/g, " ").toLowerCase())
          : undefined;
        if (definition) references.add(definition);
      }
      for (const nested of children(child)) collect(nested);
    };
    collect(node);
    result.push({
      kind: "preview",
      from,
      to: node.to,
      text: [state.sliceDoc(from, node.to), ...references].join("\n\n"),
    });
  };
  const render = (node: SyntaxNode, reveal = false) => {
    if (node.to < viewport.from || node.from > viewport.to) return;
    const complex =
      previewNodes.has(node.name) ||
      ["ListItem", "Blockquote", "Paragraph", "Task"].includes(node.name) ||
      /Heading/.test(node.name);
    if (complex && isComplex(node, complexity)) {
      if (mode !== "inline" && !active(node)) preview(node);
      return;
    }
    if (mode === "blocks") {
      if (["Paragraph", "Task"].includes(node.name) || /Heading/.test(node.name)) return;
      for (const child of children(node)) render(child);
      return;
    }
    if (node.name === "Paragraph" || node.name === "Task" || /Heading/.test(node.name))
      reveal = active(node);
    if (/^(ATX|Setext)Heading[1-6]$/.test(node.name)) {
      const level = Number(node.name.at(-1));
      result.push({
        kind: "line",
        from: node.from,
        to: node.to,
        className: `file-markdown-heading file-markdown-heading-${level}`,
        headingLevel: level,
      });
    }
    if (node.name in inlineTags)
      result.push({
        kind: "mark",
        from: node.from,
        to: node.to,
        tag: inlineTags[node.name as keyof typeof inlineTags],
      });
    if (node.name === "QuoteMark") {
      result.push({ kind: "line", from: node.from, to: node.to, className: "file-markdown-quote" });
      if (!active({ from: node.from, to: state.doc.lineAt(node.from).to })) hide(node);
    }
    if (
      node.name === "ListMark" &&
      !active({ from: node.from, to: state.doc.lineAt(node.from).to })
    ) {
      const marker = state.sliceDoc(node.from, node.to);
      result.push({
        kind: "bullet",
        from: node.from,
        to: node.to,
        label: /^\d/.test(marker) ? marker : "•",
        checked: null,
        markerOffset: node.from,
      });
    }
    if (node.name === "TaskMarker" && !reveal)
      result.push({
        kind: "bullet",
        from: node.from,
        to: node.to,
        label: "",
        checked: state.sliceDoc(node.from, node.to).toLowerCase() === "[x]",
        markerOffset: node.from,
      });
    if (
      !reveal &&
      ["HeaderMark", "EmphasisMark", "StrikethroughMark", "CodeMark"].includes(node.name)
    ) {
      if (node.name === "HeaderMark" && node.parent?.name.startsWith("Setext"))
        hide({ from: node.from, to: node.to });
      else
        hide({
          from: node.from,
          to:
            node.name === "HeaderMark"
              ? Math.min(
                  state.doc.lineAt(node.to).to,
                  node.to + (state.sliceDoc(node.to, node.to + 1) === " " ? 1 : 0),
                )
              : node.to,
        });
    }
    for (const child of children(node)) render(child, reveal);
  };
  const root = syntaxTree(state).topNode;
  for (
    let node = root.childAfter(viewport.from);
    node && node.from <= viewport.to;
    node = node.nextSibling
  )
    render(node);
  return result;
}
