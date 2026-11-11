import { Extension, Node, type JSONContent, type Extensions } from "@tiptap/core";
import type { Node as DocumentNode, Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { BulletList, OrderedList } from "@tiptap/extension-list";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import type { BlockContent, Literal, PhrasingContent, RootContent } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { defaultHandlers, toMarkdown } from "mdast-util-to-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";
import { setMarkdownTaskChecked } from "./filePreviewMode";

interface RawMarkdown extends Literal {
  type: "fileMarkdownRaw";
  value: string;
}

declare module "mdast" {
  interface ListData {
    fileMarkdownBullet?: "-" | "+" | "*";
    fileMarkdownDelimiter?: "." | ")";
  }
  interface BlockContentMap {
    fileMarkdownRaw: RawMarkdown;
  }
  interface PhrasingContentMap {
    fileMarkdownRaw: RawMarkdown;
  }
  interface RootContentMap {
    fileMarkdownRaw: RawMarkdown;
  }
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

const rawBlock = Node.create({
  name: "fileMarkdownRawBlock",
  group: "block",
  atom: true,
  addAttributes: () => ({ source: { default: "" } }),
  parseHTML: () => [
    { tag: "div[data-markdown-raw]", getAttrs: (element) => ({ source: element.textContent }) },
  ],
  renderHTML: ({ node }) => ["div", { "data-markdown-raw": "" }, node.attrs.source],
});

const rawInline = rawBlock.extend({
  name: "fileMarkdownRawInline",
  group: "inline",
  inline: true,
  parseHTML: () => [
    { tag: "span[data-markdown-raw]", getAttrs: (element) => ({ source: element.textContent }) },
  ],
  renderHTML: ({ node }) => ["span", { "data-markdown-raw": "" }, node.attrs.source],
});

function tableNode(name: string, tag: string, content: string) {
  return Node.create({
    name,
    group: name === "fileMarkdownTable" ? "block" : undefined,
    content,
    isolating: true,
    parseHTML: () => [{ tag }],
    addAttributes: () => ({ align: { default: null } }),
    renderHTML: ({ node }) => [
      tag,
      { style: node.attrs.align ? `text-align: ${node.attrs.align}` : null },
      0,
    ],
  });
}

export const fileMarkdownExtensions: Extensions = [
  StarterKit.configure({
    bulletList: false,
    orderedList: false,
    link: { openOnClick: false },
    underline: false,
    trailingNode: false,
  }),
  BulletList.extend({ content: "(listItem | taskItem)+" }),
  OrderedList.extend({ content: "(listItem | taskItem)+" }),
  TaskList,
  TaskItem.configure({ nested: true }),
  tableNode("fileMarkdownTable", "table", "fileMarkdownRow+"),
  tableNode("fileMarkdownRow", "tr", "(fileMarkdownHeader | fileMarkdownCell)+"),
  tableNode("fileMarkdownHeader", "th", "paragraph+"),
  tableNode("fileMarkdownCell", "td", "paragraph+"),
  rawBlock,
  rawInline,
  Extension.create({
    name: "fileMarkdownSource",
    addGlobalAttributes: () => [
      {
        types: [
          "paragraph",
          "heading",
          "bulletList",
          "orderedList",
          "taskList",
          "blockquote",
          "codeBlock",
          "horizontalRule",
          "fileMarkdownTable",
          "fileMarkdownRawBlock",
        ],
        attributes: { sourceId: { default: null, rendered: false } },
      },
      {
        types: ["bulletList", "orderedList", "taskList"],
        attributes: {
          bullet: { default: "-", rendered: false },
          delimiter: { default: ".", rendered: false },
          spread: { default: false, rendered: false },
        },
      },
      {
        types: ["listItem", "taskItem"],
        attributes: { spread: { default: false, rendered: false } },
      },
      { types: ["codeBlock"], attributes: { meta: { default: null, rendered: false } } },
    ],
  }),
];

interface SourceBlock {
  readonly node: DocumentNode;
  readonly source: string;
  readonly before: string;
  readonly taskMarkers: ReadonlyArray<number>;
}

export interface FileMarkdownDocument {
  readonly document: DocumentNode;
  readonly blocks: ReadonlyMap<number, SourceBlock>;
  readonly prefix: string;
  readonly suffix: string;
  readonly newline: string;
  readonly references: string;
}

function originalSource(node: RootContent | PhrasingContent, source: string): string {
  if (node.type === "html") return node.value;
  if (node.type === "code") return toMarkdown(node, { fences: true }).replace(/\n$/, "");
  if (node.type === "math") {
    const opening = source.slice(node.position?.start.offset).split(/\r?\n/)[0]!;
    const closing = /^\$+/.exec(opening)?.[0] ?? "$$";
    return `${opening}\n${node.value}\n${closing}`;
  }
  return source.slice(node.position?.start.offset, node.position?.end.offset);
}

function parseInline(nodes: ReadonlyArray<PhrasingContent>, source: string): JSONContent[] {
  return nodes.flatMap((node): JSONContent[] => {
    if (node.type === "text") return node.value ? [{ type: "text", text: node.value }] : [];
    if (node.type === "break") return [{ type: "hardBreak" }];
    if (node.type === "html" && /^<br\s*\/?>$/i.test(node.value)) return [{ type: "hardBreak" }];
    if (node.type === "inlineCode")
      return [{ type: "text", text: node.value, marks: [{ type: "code" }] }];
    if (node.type === "strong" || node.type === "emphasis" || node.type === "delete") {
      const mark = { type: { strong: "bold", emphasis: "italic", delete: "strike" }[node.type] };
      return parseInline(node.children, source).map((child) => ({
        ...child,
        marks: [mark, ...(child.marks ?? [])],
      }));
    }
    return [{ type: "fileMarkdownRawInline", attrs: { source: originalSource(node, source) } }];
  });
}

function parseBlock(node: RootContent, source: string): JSONContent {
  switch (node.type) {
    case "paragraph":
      if (node.children.length === 1 && node.children[0]?.type === "image") break;
      return { type: "paragraph", content: parseInline(node.children, source) };
    case "heading":
      return {
        type: "heading",
        attrs: { level: node.depth },
        content: parseInline(node.children, source),
      };
    case "blockquote":
      return {
        type: "blockquote",
        content: node.children.map((child) => parseBlock(child, source)),
      };
    case "list":
      return {
        type: node.ordered
          ? "orderedList"
          : node.children.every((item) => item.checked !== null && item.checked !== undefined)
            ? "taskList"
            : "bulletList",
        attrs: {
          start: node.start ?? 1,
          bullet: source[node.position!.start.offset!] ?? "-",
          delimiter: /^\d+([.)])/.exec(source.slice(node.position!.start.offset!))?.[1] ?? ".",
          spread: node.spread ?? false,
        },
        content: node.children.map((item) => ({
          type: typeof item.checked === "boolean" ? "taskItem" : "listItem",
          attrs: { checked: item.checked, spread: item.spread ?? false },
          content: item.children.map((child) => parseBlock(child, source)),
        })),
      };
    case "code":
      break;
    case "thematicBreak":
      return { type: "horizontalRule" };
    case "table":
      return {
        type: "fileMarkdownTable",
        content: node.children.map((row, index) => ({
          type: "fileMarkdownRow",
          content: row.children.map((cell, column) => ({
            type: index === 0 ? "fileMarkdownHeader" : "fileMarkdownCell",
            attrs: { align: node.align?.[column] },
            content: [{ type: "paragraph", content: parseInline(cell.children, source) }],
          })),
        })),
      };
  }
  return { type: "fileMarkdownRawBlock", attrs: { source: originalSource(node, source) } };
}

function taskMarkerOffsets(nodes: ReadonlyArray<RootContent>, source: string): number[] {
  return nodes.flatMap((node) => {
    if (node.type === "blockquote") return taskMarkerOffsets(node.children, source);
    if (node.type !== "list") return [];
    return node.children.flatMap((item) => {
      const start = item.position!.start.offset!;
      const marker =
        typeof item.checked === "boolean"
          ? /^(?:[*+-]|\d+[.)])[ \t]+\[/.exec(source.slice(start))
          : null;
      return [
        ...(marker ? [start + marker[0].length - 1] : []),
        ...taskMarkerOffsets(item.children, source),
      ];
    });
  });
}

export function parseFileMarkdown(source: string, schema: Schema): FileMarkdownDocument {
  const root = parser.parse(maskMarkdownFrontmatter(source));
  const content = root.children.map((node, sourceId) => {
    const block = parseBlock(node, source);
    return { ...block, attrs: { ...block.attrs, sourceId } };
  });
  const document = schema.nodeFromJSON({
    type: "doc",
    content: content.length ? content : [{ type: "paragraph" }],
  });
  const blocks = new Map<number, SourceBlock>();
  let end = root.children[0]?.position?.start.offset ?? source.length;
  const prefix = source.slice(0, end);
  document.forEach((node, _offset, index) => {
    const original = root.children[index];
    if (!original) return;
    const start = original.position!.start.offset!;
    const nextEnd = original.position!.end.offset!;
    blocks.set(index, {
      node,
      source: source.slice(start, nextEnd),
      before: source.slice(end, start),
      taskMarkers: taskMarkerOffsets([original], source).map((offset) => offset - start),
    });
    end = nextEnd;
  });
  return {
    document,
    blocks,
    prefix,
    suffix: source.slice(end),
    newline: source.includes("\r\n") ? "\r\n" : "\n",
    references: root.children
      .filter((node) => node.type === "definition" || node.type === "footnoteDefinition")
      .map((node) => originalSource(node, source))
      .join("\n\n"),
  };
}

function inlineMarkdown(parent: DocumentNode, inTable = false): PhrasingContent[] {
  const children: PhrasingContent[] = [];
  parent.forEach((node) => {
    if (node.type.name === "hardBreak") {
      children.push(inTable ? { type: "fileMarkdownRaw", value: "<br>" } : { type: "break" });
      return;
    }
    if (node.type.name === "fileMarkdownRawInline") {
      children.push({ type: "fileMarkdownRaw", value: node.attrs.source });
      return;
    }
    let content: PhrasingContent = { type: "text", value: node.text ?? "" };
    for (const mark of node.marks.toReversed()) {
      switch (mark.type.name) {
        case "code":
          content = { type: "inlineCode", value: node.text ?? "" };
          break;
        case "bold":
          content = { type: "strong", children: [content] };
          break;
        case "italic":
          content = { type: "emphasis", children: [content] };
          break;
        case "strike":
          content = { type: "delete", children: [content] };
          break;
        case "link":
          content = {
            type: "link",
            url: mark.attrs.href,
            title: mark.attrs.title,
            children: [content],
          };
          break;
      }
    }
    children.push(content);
  });
  return children;
}

function childBlocks(node: DocumentNode): BlockContent[] {
  const children: BlockContent[] = [];
  node.forEach((child) => children.push(blockMarkdown(child)));
  return children;
}

function blockMarkdown(node: DocumentNode): BlockContent {
  switch (node.type.name) {
    case "paragraph":
      return { type: "paragraph", children: inlineMarkdown(node) };
    case "heading":
      return { type: "heading", depth: node.attrs.level, children: inlineMarkdown(node) };
    case "blockquote":
      return { type: "blockquote", children: childBlocks(node) };
    case "codeBlock":
      return {
        type: "code",
        lang: node.attrs.language,
        meta: node.attrs.meta,
        value: node.textContent,
      };
    case "horizontalRule":
      return { type: "thematicBreak" };
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const children: Extract<RootContent, { type: "list" }>["children"] = [];
      node.forEach((item) =>
        children.push({
          type: "listItem",
          checked: item.type.name === "taskItem" ? item.attrs.checked : null,
          spread: item.attrs.spread === true,
          children: childBlocks(item),
        }),
      );
      return {
        type: "list",
        ordered: node.type.name === "orderedList",
        start: node.attrs.start ?? 1,
        spread: node.attrs.spread === true,
        data: {
          fileMarkdownBullet:
            node.attrs.bullet === "+" || node.attrs.bullet === "*" ? node.attrs.bullet : "-",
          fileMarkdownDelimiter: node.attrs.delimiter === ")" ? ")" : ".",
        },
        children,
      };
    }
    case "fileMarkdownTable": {
      const children: Extract<RootContent, { type: "table" }>["children"] = [];
      const align: Extract<RootContent, { type: "table" }>["align"] = [];
      node.forEach((row, _offset, rowIndex) => {
        const cells: Extract<RootContent, { type: "tableCell" }>[] = [];
        row.forEach((cell) => {
          if (rowIndex === 0) align.push(cell.attrs.align);
          const content: PhrasingContent[] = [];
          cell.forEach((paragraph, _offset, index) => {
            if (index > 0) content.push({ type: "fileMarkdownRaw", value: "<br><br>" });
            content.push(...inlineMarkdown(paragraph, true));
          });
          cells.push({ type: "tableCell", children: content });
        });
        children.push({ type: "tableRow", children: cells });
      });
      return { type: "table", align, children };
    }
    default:
      return { type: "fileMarkdownRaw", value: node.attrs.source ?? "" };
  }
}

function hasOnlyTaskCheckChanges(node: DocumentNode, original: DocumentNode): boolean {
  const originalAttributes =
    node.type.name === "taskItem"
      ? { ...original.attrs, checked: node.attrs.checked }
      : original.attrs;
  if (
    !node.hasMarkup(original.type, originalAttributes, original.marks) ||
    node.text !== original.text ||
    node.childCount !== original.childCount
  )
    return false;
  for (let index = 0; index < node.childCount; index += 1) {
    if (!hasOnlyTaskCheckChanges(node.child(index), original.child(index))) return false;
  }
  return true;
}

function serializeTaskChecks(node: DocumentNode, original: SourceBlock): string | undefined {
  if (!hasOnlyTaskCheckChanges(node, original.node)) return undefined;
  const checks: boolean[] = [];
  node.descendants((child) => {
    if (child.type.name === "taskItem") checks.push(child.attrs.checked === true);
  });
  if (checks.length !== original.taskMarkers.length) return undefined;
  return original.taskMarkers.reduce(
    (source, offset, index) =>
      /[xX]/.test(source[offset + 1] ?? "") === checks[index]
        ? source
        : setMarkdownTaskChecked(source, offset, checks[index]!),
    original.source,
  );
}

export function serializeFileMarkdown(
  document: DocumentNode,
  original: FileMarkdownDocument,
): string {
  const parts: string[] = [];
  const seen = new Set<number>();
  document.forEach((node, _offset, index) => {
    const id: unknown = node.attrs.sourceId;
    const block = typeof id === "number" && !seen.has(id) ? original.blocks.get(id) : undefined;
    if (typeof id === "number") seen.add(id);
    const before = index === 0 ? "" : block?.before || original.newline + original.newline;
    const source = block?.node.eq(node)
      ? block.source
      : ((block ? serializeTaskChecks(node, block) : undefined) ??
        toMarkdown(blockMarkdown(node), {
          extensions: [gfmToMarkdown()],
          handlers: {
            fileMarkdownRaw: (raw) => raw.value,
            listItem: (item, parent, state, info) => {
              const checkable =
                typeof item.checked === "boolean" && item.children[0]?.type === "paragraph";
              const checkbox = `[${item.checked ? "x" : " "}] `;
              const tracker = state.createTracker(info);
              if (checkable) tracker.move(checkbox);
              const value = defaultHandlers.listItem(item, parent, state, {
                ...info,
                ...tracker.current(),
              });
              // 項目番号が「)」で終わる場合も、保存時にチェックを保持する。
              return checkable
                ? value.replace(/^(?:[*+-]|\d+[.)])([\r\n]| {1,3})/, `$&${checkbox}`)
                : value;
            },
            list: (list, parent, state, info) => {
              const previous = state.options;
              state.options = {
                ...previous,
                bullet: list.data?.fileMarkdownBullet ?? previous.bullet,
                bulletOrdered: list.data?.fileMarkdownDelimiter ?? previous.bulletOrdered,
              };
              try {
                return defaultHandlers.list(list, parent, state, info);
              } finally {
                state.options = previous;
              }
            },
          },
        })
          .replace(/\n$/, "")
          .replace(/\r\n?/g, "\n")
          .replace(/\n/g, original.newline));
    parts.push(before, source);
  });
  return original.prefix + parts.join("") + original.suffix;
}
