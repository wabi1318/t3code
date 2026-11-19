import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createElement } from "react";
import { render } from "../../../test/render";
import { isMacPlatform } from "~/lib/utils";
import FileMarkdownEditor from "./FileMarkdownEditor";

it("preserves source and metadata Undo, and replaces all text with Mod+A", async () => {
  for (const eol of ["\n", "\r\n"]) {
    const source = [
      "---",
      "title: Draft",
      "---  ",
      "# Title",
      "",
      "Before **bold**",
      "",
      "- ![badge](x.png)",
      "",
      "~~~mermaid",
      "graph LR",
      "A --> B",
      "~~~",
      "",
    ].join(eol);
    const onChange = vi.fn();
    await using screen = await render(
      createElement(FileMarkdownEditor, {
        text: source,
        cwd: "/workspace",
        relativePath: "draft.md",
        threadRef: {
          environmentId: EnvironmentId.make("markdown-test"),
          threadId: ThreadId.make("thread"),
        },
        workspaceMutationId: null,
        onChange,
      }),
    );
    const element = screen.container.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(element)!;
    expect(screen.container.querySelector(".cm-content")?.textContent).not.toContain(
      "title: Draft",
    );
    const from = view.state.doc.toString().indexOf("Before");
    view.focus();
    await userEvent.keyboard("{Backspace}");
    expect(view.state.doc.toString()).toBe(source.replaceAll("\r\n", "\n"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.container.querySelector(".cm-content")?.textContent).toContain("title: Draft");
    const title = view.state.doc.toString().indexOf("Draft");
    view.dispatch({ selection: { anchor: title } });
    view.dispatch({ changes: { from: title, to: title + "Draft".length, insert: "Ready" } });
    view.dispatch({ selection: { anchor: from } });
    expect(undo(view)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(source);
    view.dispatch({ selection: { anchor: from } });
    expect(redo(view)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(source.replace("Draft", "Ready"));
    view.dispatch({ selection: { anchor: from } });
    expect(undo(view)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(source);
    onChange.mockClear();
    view.dispatch({ selection: { anchor: from } });
    expect(view.state.doc.toString()).toBe(source.replaceAll("\r\n", "\n"));
    expect(onChange).not.toHaveBeenCalled();
    view.dispatch({ changes: { from, to: from + "Before".length, insert: "After" } });
    expect(onChange).toHaveBeenLastCalledWith(source.replace("Before", "After"));
    expect(undo(view)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(source);
    expect(redo(view)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(source.replace("Before", "After"));
    view.dispatch({ selection: { anchor: 0 } });
    view.dispatch({ changes: { from: 0, insert: "New\n\n" } });
    expect(view.state.doc.line(3).text).toBe("---");
    expect(onChange).toHaveBeenLastCalledWith(
      `New${eol}${eol}${source.replace("Before", "After")}`,
    );
    await screen.rerender(
      createElement(FileMarkdownEditor, {
        text: source,
        cwd: "/workspace",
        relativePath: "draft.md",
        threadRef: {
          environmentId: EnvironmentId.make("markdown-test"),
          threadId: ThreadId.make("thread"),
        },
        workspaceMutationId: null,
        onChange,
      }),
    );
    await userEvent.keyboard(
      isMacPlatform(navigator.platform)
        ? "{Meta>}a{/Meta}Replacement"
        : "{Control>}a{/Control}Replacement",
    );
    expect(view.state.doc.toString()).toBe("Replacement");
    expect(onChange).toHaveBeenLastCalledWith("Replacement");
  }
});
