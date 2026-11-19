import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { isMacPlatform } from "~/lib/utils";
import FileMarkdownEditor from "./FileMarkdownEditor";

function previewProps(onChange = vi.fn<(text: string) => void>()) {
  return {
    cwd: "/workspace",
    relativePath: "draft.md",
    threadRef: {
      environmentId: EnvironmentId.make("markdown-editor-test"),
      threadId: ThreadId.make("thread"),
    },
    workspaceMutationId: null,
    onChange,
  };
}

it("reveals the active paragraph, keeps autosave echoes in history, and resets history on external changes", async () => {
  const editorOrigin = {};
  const preview = { ...previewProps(), editorOrigin };
  const source = "# Original\n\nFirst **bold**\n\nSecond _italic_\n";
  await using screen = await render(<FileMarkdownEditor {...preview} text={source} />);
  const view = EditorView.findFromDOM(screen.container.querySelector<HTMLElement>(".cm-editor")!)!;
  expect(screen.container.querySelector("strong")?.textContent).toBe("bold");
  const from = source.indexOf("bold");
  view.focus();
  view.dispatch({ selection: { anchor: from } });
  await vi.waitFor(() =>
    expect(screen.container.querySelector("strong")?.textContent).toBe("**bold**"),
  );
  expect(screen.container.querySelector("em")?.textContent).toBe("italic");
  expect(preview.onChange).not.toHaveBeenCalled();
  await userEvent.keyboard("a");
  const first = preview.onChange.mock.lastCall![0];
  await screen.rerender(<FileMarkdownEditor {...preview} text={first} />);
  await userEvent.keyboard("b");
  const latest = preview.onChange.mock.lastCall![0];
  expect(latest).toBe(source.replace("bold", "abbold"));
  await screen.rerender(
    <FileMarkdownEditor {...preview} text={first} updateOrigin={editorOrigin} />,
  );
  expect(view.state.sliceDoc()).toBe(latest);
  await screen.rerender(<FileMarkdownEditor {...preview} text={latest} />);
  await userEvent.keyboard(
    isMacPlatform(navigator.platform) ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  expect(view.state.sliceDoc()).toBe(source);
  await screen.rerender(<FileMarkdownEditor {...preview} text={first} />);
  expect(view.state.sliceDoc()).toBe(first);
  const external = "# External\n";
  await screen.rerender(<FileMarkdownEditor {...preview} text={external} />);
  view.focus();
  preview.onChange.mockClear();
  await userEvent.keyboard(
    isMacPlatform(navigator.platform) ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  expect(view.state.sliceDoc()).toBe(external);
  expect(preview.onChange).not.toHaveBeenCalled();
  await userEvent.keyboard("a");
  view.dispatch({
    changes: { from: view.state.doc.length, insert: "\n\nText[^n]\n\n[^n]: Note\n" },
  });
  const footnotes = preview.onChange.mock.lastCall![0];
  await screen.rerender(<FileMarkdownEditor {...preview} text={footnotes} />);
  expect(screen.container.querySelector(".cm-editor")).not.toBeNull();
  view.contentDOM.blur();
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll("[data-footnotes]")).toHaveLength(1),
  );
  expect(EditorView.findFromDOM(screen.container.querySelector<HTMLElement>(".cm-editor")!)).toBe(
    view,
  );
  view.focus();
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll("[data-footnotes]")).toHaveLength(0),
  );
  await userEvent.keyboard(
    isMacPlatform(navigator.platform) ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  expect(preview.onChange.mock.lastCall![0]).not.toContain("[^n]");
  const metadata = "---\ntitle: Old\n---\n\n# Body\n";
  await screen.rerender(<FileMarkdownEditor {...preview} text={metadata} />);
  view.focus();
  const metadataPosition = metadata.indexOf("title");
  view.dispatch({ selection: { anchor: metadataPosition } });
  const metadataUpdated = metadata.replace("Old", "New");
  await screen.rerender(<FileMarkdownEditor {...preview} text={metadataUpdated} />);
  expect(view.state.selection.main.anchor).toBe(metadataPosition);
  await userEvent.keyboard(
    isMacPlatform(navigator.platform) ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  expect(view.state.sliceDoc()).toBe(metadataUpdated);
});

it("renders inline HTML and switches its paragraph to editable source", async () => {
  const preview = previewProps();
  const source =
    "Before <kbd>x</kbd> after\n\n[Document](./draft.md)\n\n- [ ] See [docs](./draft.md)\n";
  await using screen = await render(<FileMarkdownEditor {...preview} text={source} />);
  await vi.waitFor(() => expect(screen.container.querySelector("kbd")?.textContent).toBe("x"));
  const link = screen.container.querySelector<HTMLAnchorElement>("a")!;
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  link.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(false);
  expect(link.isConnected).toBe(true);
  const view = EditorView.findFromDOM(screen.container.querySelector<HTMLElement>(".cm-editor")!)!;
  const renderedParagraph = screen.container.querySelector("kbd")!.parentElement!;
  const selectionStart = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  renderedParagraph.dispatchEvent(selectionStart);
  expect(selectionStart.defaultPrevented).toBe(false);
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(renderedParagraph);
  selection.removeAllRanges();
  selection.addRange(range);
  try {
    renderedParagraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 100 }));
    renderedParagraph.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 100 }));
    expect(selection.toString()).toBe("Before x after");
    expect(screen.container.querySelector("kbd")?.textContent).toBe("x");
  } finally {
    selection.removeAllRanges();
  }
  renderedParagraph.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await vi.waitFor(() => expect(screen.container.querySelector("kbd")).toBeNull());
  view.focus();
  view.dispatch({ selection: { anchor: source.indexOf("<kbd>") } });
  await vi.waitFor(() => expect(screen.container.querySelector("kbd")).toBeNull());
  expect(screen.container.querySelector(".cm-content")?.textContent).toContain("<kbd>x</kbd>");
  expect(view.state.sliceDoc()).toBe(source);
  expect(preview.onChange).not.toHaveBeenCalled();
  await screen.getByRole("checkbox").click();
  expect(preview.onChange).toHaveBeenLastCalledWith(source.replace("[ ]", "[x]"));
  expect(view.hasFocus).toBe(false);
  await vi.waitFor(() => expect(screen.container.querySelector("kbd")?.textContent).toBe("x"));
});

it("switches footnotes between a full preview and source without remounting", async () => {
  const preview = previewProps();
  const text =
    "---\ntitle: Notes\n---\n\nFirst[^one] and second[^two].\n\n- [ ] Task\n\n[^one]: First note\n[^two]: Second note\n";
  await using screen = await render(<FileMarkdownEditor {...preview} text={text} />);
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll("[data-footnotes]")).toHaveLength(1),
  );
  expect(screen.container.querySelector("p [data-footnotes]")).toBeNull();
  const view = EditorView.findFromDOM(screen.container.querySelector<HTMLElement>(".cm-editor")!)!;
  await screen.getByRole("checkbox").click();
  expect(preview.onChange).toHaveBeenLastCalledWith(text.replace("[ ]", "[x]"));
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll("[data-footnotes]")).toHaveLength(1),
  );
  await expect.element(screen.getByRole("checkbox")).toBeVisible();
  view.focus();
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll("[data-footnotes]")).toHaveLength(0),
  );
  expect(view.dom.dataset.markdownSource).toBe("true");
  const title = view.state.doc.toString().indexOf("Notes");
  view.dispatch({ changes: { from: title, to: title + "Notes".length, insert: "Updated" } });
  expect(preview.onChange).toHaveBeenLastCalledWith(
    text.replace("[ ]", "[x]").replace("Notes", "Updated"),
  );
  view.contentDOM.blur();
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll("[data-footnotes]")).toHaveLength(1),
  );
  await screen.rerender(<FileMarkdownEditor {...preview} text={"# Editable\n"} />);
  await expect.element(screen.getByRole("textbox", { name: "Edit Markdown" })).toBeVisible();
  await screen.rerender(<FileMarkdownEditor {...preview} text={text} />);
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll("[data-footnotes]")).toHaveLength(1),
  );
  expect(EditorView.findFromDOM(screen.container.querySelector<HTMLElement>(".cm-editor")!)).toBe(
    view,
  );
  expect(preview.onChange).toHaveBeenCalledTimes(2);
});

it("keeps the height map aligned when preview blocks change size without changing total height", async () => {
  const viewportHeight = 180;
  const expandedHeight = 360;
  const collapsedHeight = 40;
  const source = "| A |\n|---|\n| One |\n\nBetween\n\n| B |\n|---|\n| Two |\n";
  const props = previewProps();
  await using screen = await render(
    <div style={{ height: viewportHeight, overflow: "auto" }}>
      <style>{".file-markdown-editor .cm-scroller { overflow: visible; }"}</style>
      <FileMarkdownEditor {...props} text={source} />
    </div>,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll(".file-markdown-block")).toHaveLength(2),
  );
  const view = EditorView.findFromDOM(screen.container.querySelector<HTMLElement>(".cm-editor")!)!;
  const [first, second] = screen.container.querySelectorAll<HTMLElement>(".file-markdown-block");
  const observedSizes: number[] = [];
  const observer = new ResizeObserver(([entry]) => observedSizes.push(entry!.contentRect.height));
  observer.observe(first!);
  try {
    first!.style.height = `${expandedHeight}px`;
    second!.style.height = `${collapsedHeight}px`;
    const position = view.posAtDOM(first!);
    await vi.waitFor(() => expect(observedSizes).toContain(expandedHeight));
    await vi.waitFor(() => expect(view.lineBlockAt(position).height).toBe(expandedHeight));
    using updates = vi.spyOn(view, "update");
    first!.style.height = `${collapsedHeight}px`;
    second!.style.height = `${expandedHeight}px`;
    await vi.waitFor(() => expect(view.lineBlockAt(position).height).toBe(collapsedHeight));
    expect(first!.isConnected).toBe(true);
    expect(second!.isConnected).toBe(true);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(props.onChange).not.toHaveBeenCalled();
  } finally {
    observer.disconnect();
  }
});
