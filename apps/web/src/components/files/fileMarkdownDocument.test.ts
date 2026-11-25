import { expect, it, vi } from "vite-plus/test";
import { ensureSyntaxTree } from "@codemirror/language";
import * as frontmatter from "@t3tools/shared/markdownFrontmatter";
import { EditorState, Transaction } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { fileMarkdownSource, readMarkdownSource } from "./fileMarkdownSource";
import {
  fileMarkdownLanguage,
  fileMarkdownFrontmatter,
  parseFileMarkdown,
  presentFileMarkdown,
  refreshFileMarkdownReferences,
} from "./fileMarkdownDocument";

it("reveals only the selected paragraph and keeps original syntax as source", () => {
  const beyondInitialViewport = "Paragraph\n\n".repeat(400);
  const source = `# Title\n\nFirst **bold**\n\n- [ ] Second _italic_\n- ![badge](x.png)\n${beyondInitialViewport}| A | B |\n|---|---|\n| 1 | 2 |\n`;
  const document = parseFileMarkdown(source);
  let state = EditorState.create({ doc: source, extensions: fileMarkdownLanguage() });
  // 編集画面を持たない単体テストでは、表示結果の検査前に全文の解析を完了させる。
  expect(ensureSyntaxTree(state, state.doc.length, Infinity)).not.toBeNull();
  state = state.update({}).state;
  const inactive = presentFileMarkdown(state, document.definitions, []);
  expect(inactive.filter((item) => item.kind === "preview")).toHaveLength(2);
  const caret = source.indexOf("bold");
  const active = presentFileMarkdown(state, document.definitions, [{ from: caret, to: caret }]);
  expect(
    active
      .filter((item) => item.kind === "hide")
      .some((item) => item.from >= source.indexOf("First") && item.to <= source.indexOf("\n\n-")),
  ).toBe(false);
  expect(
    active.filter((item) => item.kind === "hide").map((item) => source.slice(item.from, item.to)),
  ).toContain("_");
  expect(state.doc.toString()).toBe(source);
  for (const markup of ["<!-- hidden -->", "<?xml hidden ?>"]) {
    const inlineSource = `Before ${markup} after`;
    const inlineState = EditorState.create({
      doc: inlineSource,
      extensions: fileMarkdownLanguage(),
    });
    const inlinePreview = presentFileMarkdown(inlineState, new Map(), []).find(
      (item) => item.kind === "preview",
    );
    expect(inlinePreview?.kind === "preview" && inlinePreview.text).toBe(inlineSource);
    const caret = inlineSource.indexOf(markup);
    expect(
      presentFileMarkdown(inlineState, new Map(), [{ from: caret, to: caret }]).some(
        (item) => item.kind === "preview",
      ),
    ).toBe(false);
    expect(inlineState.doc.toString()).toBe(inlineSource);
  }
  for (const opening of ["```", "$$", "<div>"]) {
    const closing = "---  ";
    const metadata = `---\nexample: |\n  ${opening}\n${closing}\n\n# Visible body\n`;
    const withMetadata = EditorState.create({
      doc: metadata,
      extensions: fileMarkdownLanguage(),
    });
    const presentation = presentFileMarkdown(withMetadata, new Map(), []);
    expect(withMetadata.field(fileMarkdownFrontmatter)).toBe(
      metadata.indexOf("\n\n# Visible body") + 1,
    );
    expect(
      presentation.some(
        (item) =>
          item.kind === "line" &&
          item.headingLevel === 1 &&
          item.from === metadata.indexOf("# Visible body"),
      ),
    ).toBe(true);
    expect(presentation.some((item) => item.from < metadata.indexOf("# Visible body"))).toBe(false);
  }
  for (const mathSource of ["- $$\n  x\n\n# After\n", "> $$\n> x\n\n# After\n"]) {
    const mathState = EditorState.create({ doc: mathSource, extensions: fileMarkdownLanguage() });
    expect(
      presentFileMarkdown(mathState, new Map(), []).some(
        (item) => item.kind === "line" && item.headingLevel === 1,
      ),
    ).toBe(true);
  }
  const quote = EditorState.create({ doc: "> Quote\n", extensions: fileMarkdownLanguage() });
  expect(
    presentFileMarkdown(quote, new Map(), [{ from: 4, to: 4 }], "inline").filter(
      (item) => item.kind === "hide",
    ),
  ).toHaveLength(0);
  const multilineTask = EditorState.create({
    doc: "- \n  [ ] Task\n",
    extensions: fileMarkdownLanguage(),
  });
  const markers = presentFileMarkdown(multilineTask, new Map(), [], "inline").filter(
    (item) => item.kind === "hide" || item.kind === "bullet",
  );
  expect(markers.some((item) => multilineTask.sliceDoc(item.from, item.to).includes("\n"))).toBe(
    false,
  );
});

it("keeps only referenced definitions in block previews and detects document footnotes", () => {
  const source = "![badge][used]\n\n[used]: x.png\n[unused]: y.png\n";
  const state = EditorState.create({ doc: source, extensions: fileMarkdownLanguage() });
  const preview = presentFileMarkdown(state, parseFileMarkdown(source).definitions, []).find(
    (item) => item.kind === "preview",
  );
  expect(preview?.kind === "preview" && preview.text).toBe("![badge][used]\n\n[used]: x.png");
  const references = parseFileMarkdown(source);
  const fenced = state.update({
    changes: [
      { from: source.indexOf("[used]:"), insert: "```\n" },
      { from: source.length, insert: "```\n" },
    ],
  });
  const hidden = refreshFileMarkdownReferences(
    fenced.state,
    references.definitionRanges.map((range) => ({
      ...range,
      from: fenced.changes.mapPos(range.from),
      to: fenced.changes.mapPos(range.to),
    })),
  );
  expect(hidden.definitions.size).toBe(0);
  const restored = fenced.state.update({ changes: fenced.changes.invert(state.doc) }).state;
  expect(
    refreshFileMarkdownReferences(restored, hidden.definitionRanges).definitions.get("used"),
  ).toBe("[used]: x.png");
  expect(parseFileMarkdown("Text[^note]\n\n[^note]: Footnote").hasFootnotes).toBe(true);
  expect(parseFileMarkdown("```\n[^note]: Code\n```").hasFootnotes).toBe(false);
  for (const literal of [
    "```md\n[^note]: Code\n```\n",
    "    [^note]: Code\n",
    "<div>\n[^note]: HTML\n</div>\n",
    "<!--\n[^note]: Comment\n-->\n",
    "<?xml\n[^note]: Instruction\n?>\n",
    "$$\n[^note]: Math\n$$\n",
  ]) {
    expect(parseFileMarkdown(literal).hasFootnotes, literal).toBe(false);
    const literalState = EditorState.create({ doc: literal, extensions: fileMarkdownLanguage() });
    const from = literal.indexOf("[^note]");
    const changed = literalState.update({ changes: { from: from + 2, insert: "a" } }).state;
    const refreshed = refreshFileMarkdownReferences(changed, [], 0, {
      from,
      to: changed.doc.lineAt(from).to,
    });
    expect(refreshed.hasFootnotes, literal).toBe(false);
    expect(
      presentFileMarkdown(changed, new Map(), [], "blocks").filter(
        (item) => item.kind === "preview",
      ),
      literal,
    ).toHaveLength(1);
  }
});

it("preserves mixed line endings through text edits, joined undo and newline deletion", () => {
  const regressionSource = "Before\r\nKeep LF\nTail\r\n";
  const regression = EditorState.create({
    doc: regressionSource,
    extensions: [fileMarkdownSource(regressionSource)],
  });
  const edited = regression.update({ changes: { from: 0, to: 6, insert: "After" } }).state;
  expect(readMarkdownSource(edited)).toBe(regressionSource.replace("Before", "After"));
  const source = "# Title\r\n\r\nBefore **bold**\n\nAfter\rLast";
  let state = EditorState.create({
    doc: source,
    extensions: [fileMarkdownSource(source), history()],
  });
  const from = state.doc.toString().indexOf("Before");
  const annotations = [Transaction.userEvent.of("input.type"), Transaction.time.of(0)];
  state = state.update({ changes: { from, to: from + 6, insert: "After" }, annotations }).state;
  state = state.update({ changes: { from: from + 5, insert: "!" }, annotations }).state;
  expect(readMarkdownSource(state)).toBe(source.replace("Before", "After!"));
  const dispatch = (transaction: Transaction) => {
    state = transaction.state;
  };
  expect(undo({ state, dispatch })).toBe(true);
  expect(readMarkdownSource(state)).toBe(source);
  expect(redo({ state, dispatch })).toBe(true);
  expect(readMarkdownSource(state)).toBe(source.replace("Before", "After!"));
  const end = state.doc.line(1).to;
  state = state.update({ changes: { from: end, to: end + 1 } }).state;
  expect(readMarkdownSource(state)).toBe(source.replace("Before", "After!").replace("\r\n", ""));
  expect(undo({ state, dispatch })).toBe(true);
  expect(readMarkdownSource(state)).toBe(source.replace("Before", "After!"));
  state = state.update({
    changes: [
      { from: 0, insert: "Top\n" },
      { from: state.doc.length, insert: "\nEnd" },
    ],
  }).state;
  expect(readMarkdownSource(state)).toBe(`Top\r\n${source.replace("Before", "After!")}\r\nEnd`);
  expect(undo({ state, dispatch })).toBe(true);
  expect(readMarkdownSource(state)).toBe(source.replace("Before", "After!"));
});

it("does not rescan frontmatter on unrelated body edits and detects new closing delimiters", () => {
  using mask = vi.spyOn(frontmatter, "maskMarkdownFrontmatter");
  for (const source of [
    `---\n\n# Visible\n\n${"Before\n\n".repeat(100)}`,
    `---\n# Visible\n${"Before\n".repeat(100)}`,
    "---\ntitle: Draft\n---\n\n# Visible\n\nBefore\n",
  ]) {
    let state = EditorState.create({ doc: source, extensions: fileMarkdownLanguage() });
    ensureSyntaxTree(state, state.doc.length);
    mask.mockClear();
    const from = source.indexOf("Before");
    state = state.update({ changes: { from, to: from + "Before".length, insert: "After" } }).state;
    ensureSyntaxTree(state, state.doc.length);
    expect(mask).not.toHaveBeenCalled();
    expect(state.doc.toString()).toBe(source.replace("Before", "After"));
    if (!state.field(fileMarkdownFrontmatter)) {
      for (const closing of ["---", "..."]) {
        const closed = state.update({
          changes: { from: state.doc.length, insert: `${closing}\n` },
        }).state;
        expect(ensureSyntaxTree(closed, closed.doc.length)?.toString()).not.toContain("ATXHeading");
        expect(
          presentFileMarkdown(closed, new Map(), []).some(
            (item) => item.kind === "line" && item.headingLevel === 1,
          ),
        ).toBe(false);
        const restored = closed.update({
          changes: { from: state.doc.length, to: closed.doc.length },
        }).state;
        expect(ensureSyntaxTree(restored, restored.doc.length)?.toString()).toContain("ATXHeading");
        expect(
          presentFileMarkdown(restored, new Map(), []).some(
            (item) => item.kind === "line" && item.headingLevel === 1,
          ),
        ).toBe(true);
      }
    }
  }
});
