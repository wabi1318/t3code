import { createContext, use, useEffect, useRef, useState } from "react";
import { getSchema, Node } from "@tiptap/core";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type NodeViewProps,
} from "@tiptap/react";

import { FileMarkdownPreview } from "./FileMarkdownPreview";
import {
  fileMarkdownExtensions,
  parseFileMarkdown,
  serializeFileMarkdown,
  stripFileMarkdownSourceIds,
} from "./fileMarkdownDocument";

type PreviewProps = Parameters<typeof FileMarkdownPreview>[0];
const MarkdownPreviewContext = createContext<
  (Omit<PreviewProps, "text"> & { references: string }) | null
>(null);

function RawMarkdownView({ node }: NodeViewProps) {
  const context = use(MarkdownPreviewContext);
  if (!context) return null;
  const { references, ...preview } = context;
  return (
    <NodeViewWrapper
      as={node.isInline ? "span" : "div"}
      contentEditable={false}
      className={node.isInline ? "file-markdown-raw-inline" : undefined}
    >
      <FileMarkdownPreview
        {...preview}
        text={`${node.attrs.source}\n\n${references}`}
        className="chat-markdown"
      />
    </NodeViewWrapper>
  );
}

const extensions = fileMarkdownExtensions.map((extension) =>
  extension instanceof Node &&
  (extension.name === "fileMarkdownRawBlock" || extension.name === "fileMarkdownRawInline")
    ? extension.extend({ addNodeView: () => ReactNodeViewRenderer(RawMarkdownView) })
    : extension,
);
const schema = getSchema(extensions);

export default function FileMarkdownEditor({
  text,
  onChange,
  ...preview
}: Omit<PreviewProps, "onTaskListChange"> & { readonly onChange: (text: string) => void }) {
  const [original, setOriginal] = useState(() => parseFileMarkdown(text, schema));
  const source = useRef(original);
  const emitted = useRef(text);
  const editor = useEditor({
    extensions,
    content: original.document.toJSON(),
    shouldRerenderOnTransaction: false,
    onBeforeCreate: ({ editor: created }) => {
      // 編集画面自身の型を使い、同じ内容の段落を別の型の段落として変更扱いにしない。
      source.current = parseFileMarkdown(text, created.schema);
      created.setOptions({ content: source.current.document.toJSON() });
    },
    editorProps: {
      transformPasted: stripFileMarkdownSourceIds,
      attributes: {
        class: "chat-markdown file-markdown-editor min-h-48 outline-none",
        role: "textbox",
        "aria-label": "Edit Markdown",
        "aria-multiline": "true",
        spellcheck: "false",
      },
    },
    onUpdate: ({ editor: updated }) => {
      const contents = serializeFileMarkdown(updated.state.doc, source.current);
      emitted.current = contents;
      onChange(contents);
    },
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ファイルの外部更新を編集画面へ反映し、自分の保存結果では選択位置を動かさない。
  useEffect(() => {
    if (!editor || text === emitted.current) return;
    source.current = parseFileMarkdown(text, editor.schema);
    setOriginal(source.current);
    emitted.current = text;
    editor.commands.setContent(source.current.document.toJSON(), { emitUpdate: false });
  }, [editor, text]);

  return (
    <MarkdownPreviewContext value={{ ...preview, references: original.references }}>
      <div className="mx-auto w-full max-w-4xl px-6 py-5">
        <EditorContent editor={editor} />
      </div>
    </MarkdownPreviewContext>
  );
}
