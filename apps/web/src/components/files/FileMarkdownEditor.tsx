import {
  memo,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  EditorSelection,
  RangeSet,
  EditorState,
  StateEffect,
  StateField,
  type Range,
} from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

import { msg, T } from "gt-react";

import { m } from "~/i18n/messages";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskEdits";
import { observeResize } from "~/lib/observeResize";
import {
  fileMarkdownSource,
  hasMarkdownSourceChanged,
  readMarkdownSource,
} from "./fileMarkdownSource";
import {
  fileMarkdownLanguage,
  fileMarkdownFrontmatter,
  parseFileMarkdown,
  presentFileMarkdown,
  refreshFileMarkdownReferences,
} from "./fileMarkdownDocument";

type PreviewProps = Parameters<typeof FileMarkdownPreview>[0];
type MarkdownEditorProps = Omit<PreviewProps, "onTaskListChange"> & {
  readonly onChange: (text: string) => void;
  readonly editorOrigin?: object | undefined;
  readonly updateOrigin?: object | undefined;
};
const focusMarkdown = StateEffect.define<boolean>();
// CodeMirrorは全体の高さが同じ場合に再計測を省くため、領域ごとの高さを状態へ反映する。
const resizePreview = StateEffect.define<{ readonly from: number; readonly height: number }>();
const UNKNOWN_PREVIEW_HEIGHT = -1;
function toggleMarkdownTask(view: EditorView, markerOffset: number, checked: boolean) {
  const previous = view.state.sliceDoc(markerOffset, markerOffset + "[ ]".length);
  const next = setMarkdownTaskChecked(previous, 0, checked);
  if (next === previous) return;
  view.dispatch({
    changes: { from: markerOffset, to: markerOffset + previous.length, insert: next },
  });
}
interface PreviewEntry {
  readonly id: number;
  readonly element: HTMLElement;
  readonly text: string;
  readonly view: EditorView;
  readonly footnotes: boolean;
}

function createPreviewStore() {
  const mounted = new Map<HTMLElement, PreviewEntry>();
  let entries: readonly PreviewEntry[] = [];
  let nextId = 0;
  let queued = false;
  const listeners = new Set<() => void>();
  const pendingResizes = new Map<HTMLElement, number>();
  let resizeQueued = false;
  const resize = (element: HTMLElement, height: number) => {
    pendingResizes.set(element, height);
    if (resizeQueued) return;
    resizeQueued = true;
    queueMicrotask(() => {
      resizeQueued = false;
      const groups = new Map<EditorView, ReturnType<typeof resizePreview.of>[]>();
      for (const [element, height] of pendingResizes) {
        const entry = mounted.get(element);
        if (!entry || !element.isConnected) continue;
        let effects = groups.get(entry.view);
        if (!effects) groups.set(entry.view, (effects = []));
        effects.push(resizePreview.of({ from: entry.view.posAtDOM(element), height }));
      }
      pendingResizes.clear();
      for (const [view, effects] of groups) {
        view.dispatch({ effects });
        view.requestMeasure();
      }
    });
  };

  const notify = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      entries = [...mounted.values()];
      // 次の描画・計測まで空の領域を残さないよう、本文も同じ通知で反映する。
      flushSync(() => {
        for (const listener of listeners) listener();
      });
    });
  };
  return {
    resize,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => entries,
    add(element: HTMLElement, text: string, view: EditorView, footnotes: boolean) {
      mounted.set(element, { id: nextId++, element, text, view, footnotes });
      notify();
    },
    remove(element: HTMLElement) {
      mounted.delete(element);
      notify();
    },
  };
}

const MarkdownPreviewBlock = memo(function MarkdownPreviewBlock({
  entry,
  store,
  ...preview
}: Omit<PreviewProps, "text" | "onTaskListChange"> & {
  readonly entry: PreviewEntry;
  readonly store: ReturnType<typeof createPreviewStore>;
}) {
  const { element, text, view, footnotes } = entry;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- CodeMirror must remeasure previews rendered outside its DOM lifecycle.
  useLayoutEffect(() => {
    const stopObserving = observeResize(element, ([entry]) => {
      if (!entry || !element.isConnected) return;
      const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
      store.resize(element, height);
    });
    view.requestMeasure();
    return stopObserving;
  }, [element, view, store]);
  return (
    <>
      {footnotes ? (
        <div className="border-b py-2 text-xs text-muted-foreground">
          <T>Click the text to edit the Markdown source for this file with footnotes.</T>
        </div>
      ) : null}
      <FileMarkdownPreview
        {...preview}
        text={text}
        className="chat-markdown"
        onTaskListChange={({ markerOffset, checked }) =>
          toggleMarkdownTask(view, view.posAtDOM(element) + markerOffset, checked)
        }
      />
    </>
  );
});

class MarkdownBlockWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly store: ReturnType<typeof createPreviewStore>,
    readonly footnotes = false,
    readonly height = UNKNOWN_PREVIEW_HEIGHT,
  ) {
    super();
  }
  override eq(other: MarkdownBlockWidget) {
    return (
      this.text === other.text && this.footnotes === other.footnotes && this.height === other.height
    );
  }
  override get estimatedHeight() {
    return this.height;
  }
  // CodeMirror 6.43.15は更新前の部品を第3引数へ渡すため、高さだけの変更では描画領域を再利用する。
  override updateDOM(_element: HTMLElement, _view: EditorView, previous: this) {
    return this.text === previous.text && this.footnotes === previous.footnotes;
  }
  toDOM(view: EditorView) {
    const element = document.createElement("div");
    element.className = "file-markdown-block";
    element.addEventListener("click", (event) => {
      const selection = element.ownerDocument.getSelection();
      const selectingText =
        selection &&
        !selection.isCollapsed &&
        (element.contains(selection.anchorNode) || element.contains(selection.focusNode));
      if (
        event.button !== 0 ||
        selectingText ||
        event.metaKey ||
        event.ctrlKey ||
        (event.target instanceof Element && event.target.closest("a,button,input"))
      )
        return;
      event.preventDefault();
      const anchor = this.footnotes ? view.state.selection.main.head : view.posAtDOM(element);
      view.focus();
      view.dispatch({ selection: { anchor }, effects: focusMarkdown.of(true) });
    });
    this.store.add(element, this.text, view, this.footnotes);
    return element;
  }
  override destroy(element: HTMLElement) {
    this.store.remove(element);
  }
}

function resizePreviewDecoration(
  decorations: ReturnType<typeof createDecorations>,
  from: number,
  height: number,
) {
  const replacements: Range<Decoration>[] = [];
  decorations.between(from, from, (start, end, value) => {
    const widget: unknown = value.spec.widget;
    if (start !== from || !(widget instanceof MarkdownBlockWidget) || widget.height === height)
      return;
    replacements.push(
      Decoration.replace({
        ...value.spec,
        widget: new MarkdownBlockWidget(widget.text, widget.store, widget.footnotes, height),
      }).range(start, end),
    );
  });
  return replacements.length
    ? decorations.update({
        filterFrom: from,
        filterTo: from,
        filter: (start) => start !== from,
        add: replacements,
      })
    : decorations;
}

class MarkdownBulletWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly checked: boolean | null,
    readonly markerOffset: number,
  ) {
    super();
  }
  override eq(other: MarkdownBulletWidget) {
    return (
      this.label === other.label &&
      this.checked === other.checked &&
      this.markerOffset === other.markerOffset
    );
  }
  toDOM(view: EditorView) {
    const element = document.createElement("span");
    element.className = "file-markdown-bullet";
    element.textContent = this.label;
    if (this.checked !== null) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.checked;
      checkbox.setAttribute("aria-label", m(msg("Toggle task")));
      checkbox.addEventListener("change", () =>
        toggleMarkdownTask(view, this.markerOffset, checkbox.checked),
      );
      element.append(checkbox, " ");
    }
    return element;
  }
}

function createDecorations(
  state: EditorState,
  items: ReturnType<typeof presentFileMarkdown>,
  store: ReturnType<typeof createPreviewStore>,
) {
  const ranges: Range<Decoration>[] = [];
  for (const item of items) {
    if (item.kind === "line")
      ranges.push(
        Decoration.line({
          attributes: {
            class: item.className,
            ...(item.headingLevel
              ? { role: "heading", "aria-level": String(item.headingLevel) }
              : {}),
          },
        }).range(state.doc.lineAt(item.from).from),
      );
    else if (item.kind === "mark")
      ranges.push(Decoration.mark({ tagName: item.tag }).range(item.from, item.to));
    else if (item.to > item.from)
      ranges.push(
        Decoration.replace(
          item.kind === "preview"
            ? {
                block: true,
                widget: new MarkdownBlockWidget(item.text, store, item.footnotes ?? false),
              }
            : item.kind === "bullet"
              ? { widget: new MarkdownBulletWidget(item.label, item.checked, item.markerOffset) }
              : {},
        ).range(item.from, item.to),
      );
  }
  return Decoration.set(ranges, true);
}

function createMarkdownState(
  text: string,
  store: ReturnType<typeof createPreviewStore>,
  initialFocus = false,
) {
  const complexity = new WeakMap<object, boolean>();
  const createFootnotePreview = (state: EditorState) =>
    createDecorations(
      state,
      [
        {
          kind: "preview",
          from: 0,
          to: state.doc.length,
          text: state.doc.toString(),
          footnotes: true,
        },
      ],
      store,
    );
  const foldFrontmatter = (
    decorations: ReturnType<typeof Decoration.set>,
    end: number,
    visible = false,
  ) =>
    end > 0 && !visible
      ? decorations.update({ add: [Decoration.replace({ block: true }).range(0, end)], sort: true })
      : decorations;
  const presentation = StateField.define({
    create(state) {
      const document = parseFileMarkdown(state.doc.toString());
      const frontmatterEnd = state.field(fileMarkdownFrontmatter);
      const blocks = createDecorations(
        state,
        presentFileMarkdown(
          state,
          document.definitions,
          [],
          "blocks",
          { from: frontmatterEnd, to: state.doc.length },
          complexity,
        ),
        store,
      );
      const previewDocument = document.hasFootnotes && !initialFocus ? state.doc : null;
      const footnotePreview = previewDocument ? createFootnotePreview(state) : Decoration.none;
      return {
        document,
        tree: syntaxTree(state),
        focused: initialFocus,
        frontmatterEnd,
        blocks,
        previewDocument,
        footnotePreview,
        decorations: document.hasFootnotes
          ? footnotePreview
          : foldFrontmatter(blocks, frontmatterEnd),
      };
    },
    update(value, transaction) {
      const focused = transaction.effects.reduce(
        (current, effect) => (effect.is(focusMarkdown) ? effect.value : current),
        value.focused,
      );
      const tree = syntaxTree(transaction.state);
      const frontmatterEnd = transaction.state.field(fileMarkdownFrontmatter);
      let document = value.document;
      let blocks = value.blocks;
      if (transaction.docChanged || tree !== value.tree) {
        const changed = { from: transaction.state.doc.length, to: 0 };
        const includeBlocks = (
          syntax: ReturnType<typeof syntaxTree>,
          from: number,
          to: number,
          map = (position: number) => position,
        ) => {
          const first = syntax.topNode.childAfter(Math.max(0, from - 1));
          const last = syntax.topNode.childBefore(Math.min(syntax.length, to + 1));
          changed.from = Math.min(changed.from, map(Math.min(from, first?.from ?? from)));
          changed.to = Math.max(changed.to, map(Math.max(to, last?.to ?? to)));
        };
        transaction.changes.iterChangedRanges((from, to, nextFrom, nextTo) => {
          includeBlocks(value.tree, from, to, (position) => transaction.changes.mapPos(position));
          includeBlocks(tree, nextFrom, nextTo);
        });
        if (!transaction.docChanged)
          includeBlocks(tree, Math.min(value.tree.length, tree.length), tree.length);
        if (frontmatterEnd !== value.frontmatterEnd) {
          changed.from = 0;
          changed.to = Math.max(
            changed.to,
            frontmatterEnd,
            transaction.changes.mapPos(value.frontmatterEnd),
          );
        }
        document = refreshFileMarkdownReferences(
          transaction.state,
          value.document.definitionRanges.map((range) => ({
            ...range,
            from: transaction.changes.mapPos(range.from),
            to: transaction.changes.mapPos(range.to),
          })),
          frontmatterEnd,
          changed,
          value.document.footnoteRanges.map((range) => ({
            from: transaction.changes.mapPos(range.from),
            to: transaction.changes.mapPos(range.to),
          })),
        );
        const referencesChanged =
          document.definitions.size !== value.document.definitions.size ||
          [...document.definitions].some(
            ([identifier, source]) => value.document.definitions.get(identifier) !== source,
          );
        blocks = value.blocks.map(transaction.changes);
        if (referencesChanged) {
          // 参照先が変わると、変更行の外にある画像やリンクも描き直す必要がある。
          changed.from = frontmatterEnd;
          changed.to = transaction.state.doc.length;
        }
        const fresh = createDecorations(
          transaction.state,
          presentFileMarkdown(
            transaction.state,
            document.definitions,
            [],
            "blocks",
            { from: Math.max(frontmatterEnd, changed.from), to: changed.to },
            complexity,
          ),
          store,
        );
        const retained = blocks.update({
          filter: (from, to) => to < changed.from || from > changed.to,
        });
        blocks = RangeSet.join([retained, fresh]);
      }
      let previewDocument = value.previewDocument;
      let footnotePreview = value.footnotePreview;
      if (!document.hasFootnotes) {
        previewDocument = null;
        footnotePreview = Decoration.none;
      } else if (!focused && previewDocument !== transaction.state.doc) {
        previewDocument = transaction.state.doc;
        footnotePreview = createFootnotePreview(transaction.state);
      }
      for (const effect of transaction.effects) {
        if (!effect.is(resizePreview)) continue;
        const { from, height } = effect.value;
        if (document.hasFootnotes)
          footnotePreview = resizePreviewDecoration(footnotePreview, from, height);
        else blocks = resizePreviewDecoration(blocks, from, height);
      }
      const decorations = focused
        ? blocks.update({
            filter: (from, to) =>
              !transaction.state.selection.ranges.some(
                (range) => range.from <= to && range.to >= from,
              ),
          })
        : blocks;
      return {
        document,
        tree,
        focused,
        frontmatterEnd,
        blocks,
        previewDocument,
        footnotePreview,
        decorations: document.hasFootnotes
          ? focused
            ? Decoration.none
            : footnotePreview
          : foldFrontmatter(
              decorations,
              frontmatterEnd,
              focused &&
                transaction.state.selection.ranges.some((range) => range.from < frontmatterEnd),
            ),
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
  const decorateViewport = (view: EditorView) => {
    const value = view.state.field(presentation);
    if (value.document.hasFootnotes) return Decoration.none;
    return createDecorations(
      view.state,
      presentFileMarkdown(
        view.state,
        value.document.definitions,
        value.focused ? view.state.selection.ranges : [],
        "inline",
        { from: Math.max(value.frontmatterEnd, view.viewport.from), to: view.viewport.to },
        complexity,
      ),
      store,
    );
  };
  const inline = ViewPlugin.fromClass(
    class {
      decorations;
      constructor(view: EditorView) {
        this.decorations = decorateViewport(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState) ||
          update.state.field(presentation).focused !== update.startState.field(presentation).focused
        )
          this.decorations = decorateViewport(update.view);
      }
    },
    { decorations: (value) => value.decorations },
  );
  const state = EditorState.create({
    doc: text,
    extensions: [
      fileMarkdownSource(text),
      fileMarkdownLanguage(),
      history(),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      presentation,
      EditorState.transactionFilter.of((transaction) => {
        if (
          !transaction.docChanged ||
          transaction.isUserEvent("undo") ||
          transaction.isUserEvent("redo")
        )
          return transaction;
        const value = transaction.startState.field(presentation);
        // 全選択などで原文を表示した後の変更は、そのまま適用する。
        const visible =
          value.focused &&
          (value.document.hasFootnotes ||
            transaction.startState.selection.ranges.some(
              (range) => range.from < value.frontmatterEnd,
            ));
        if (!value.frontmatterEnd || visible) return transaction;
        let revealAt: number | null = null;
        transaction.changes.iterChangedRanges((from) => {
          if (from < value.frontmatterEnd) revealAt = Math.min(revealAt ?? from, from);
        });
        if (revealAt === null) return transaction;
        return {
          selection: { anchor: Math.min(revealAt, value.frontmatterEnd - 1) },
          effects: focusMarkdown.of(true),
          scrollIntoView: true,
        };
      }),
      inline,
      EditorView.lineWrapping,
      EditorView.focusChangeEffect.of((_state, focusing) => focusMarkdown.of(focusing)),
      EditorView.editorAttributes.of((view) => ({
        "data-markdown-source": String(
          view.state.field(presentation).document.hasFootnotes &&
            view.state.field(presentation).focused,
        ),
      })),
      EditorView.contentAttributes.of({
        role: "textbox",
        "aria-label": m(msg("Edit Markdown")),
        "aria-multiline": "true",
        spellcheck: "false",
      }),
    ],
  });
  return state.update({
    selection: { anchor: state.field(presentation).frontmatterEnd },
    effects: focusMarkdown.of(initialFocus),
  }).state;
}

export default function FileMarkdownEditor({
  text,
  onChange,
  editorOrigin: suppliedOrigin,
  updateOrigin,
  ...preview
}: MarkdownEditorProps) {
  const parent = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const initial = useRef(text);
  const [fallbackOrigin] = useState(() => ({}));
  const editorOrigin = suppliedOrigin ?? fallbackOrigin;
  const [store] = useState(createPreviewStore);
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const emitChange = useEffectEvent((contents: string) => onChange(contents));
  const mountEditor = useEffectEvent(
    (element: HTMLElement) =>
      new EditorView({
        state: createMarkdownState(initial.current, store),
        parent: element,
        dispatchTransactions(transactions, view) {
          view.update(transactions);
          if (transactions.some(hasMarkdownSourceChanged))
            emitChange(readMarkdownSource(view.state));
        },
      }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 原文エディタのDOMと入力履歴をコンポーネントの生存期間へ結び付ける。
  useLayoutEffect(() => {
    const view = mountEditor(parent.current!);
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 自分の入力の再通知は無視し、別の画面や外部からの本文だけを読み直す。
  useLayoutEffect(() => {
    const view = editor.current;
    if (view && updateOrigin !== editorOrigin && text !== readMarkdownSource(view.state)) {
      const next = createMarkdownState(text, store, view.hasFocus);
      const previousFrontmatterEnd = view.state.field(fileMarkdownFrontmatter);
      const editingFrontmatter =
        view.hasFocus &&
        view.state.selection.ranges.some((range) => range.from < previousFrontmatterEnd);
      const minimumSelectionPosition = editingFrontmatter ? 0 : next.selection.main.head;
      const selection = EditorSelection.create(
        view.state.selection.ranges.map((range) =>
          EditorSelection.range(
            Math.max(minimumSelectionPosition, Math.min(range.anchor, next.doc.length)),
            Math.max(minimumSelectionPosition, Math.min(range.head, next.doc.length)),
          ),
        ),
        view.state.selection.mainIndex,
      );
      // 外部更新を取り消して古い本文に戻さないよう、履歴も新しい本文へ切り替える。
      view.setState(next.update({ selection }).state);
    }
  }, [text, store, editorOrigin, updateOrigin]);
  return (
    <div className="file-markdown-editor mx-auto w-full max-w-4xl px-6 py-5">
      <div ref={parent} />
      {entries.map((entry) =>
        createPortal(
          <MarkdownPreviewBlock {...preview} entry={entry} store={store} />,
          entry.element,
          String(entry.id),
        ),
      )}
    </div>
  );
}
