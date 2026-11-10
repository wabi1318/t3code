import { EnvironmentId, ThreadId, type ProjectReadFileResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";
import { isMacPlatform } from "~/lib/utils";

const state = vi.hoisted(() => ({
  file: null as ProjectReadFileResult | null,
  optimistic: null as ProjectReadFileResult | null,
  writeFile: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((_registry: unknown, _command: unknown, request: unknown) =>
    state.writeFile(request)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.writeFile) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("~/remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenState: () => ({ mode: "local-exec" }) as never,
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ resolvedTheme: "dark" }) as never,
}));
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), () => ({
  useWorkspaceMutationRefresh: vi.fn(),
}));
vi.mock(import("./FileBreadcrumbs"), () => ({ FileBreadcrumbs: () => <></> }));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: () => ({
    data: state.file,
    error: null,
    isPending: false,
    readError: null,
    isNotFile: false,
    isFile: true,
    refresh: vi.fn(),
  }),
  getOptimisticProjectFileQueryData: () => state.optimistic,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _cwd: string,
    relativePath: string,
    contents: string,
  ) => {
    state.optimistic = { relativePath, contents, truncated: false, byteLength: contents.length };
  },
  confirmProjectFileQueryData: () => true,
}));

import FilePreviewPanel from "./FilePreviewPanel";

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
function setup() {
  const keys = ["t3code.fileExplorerOpen", "t3code.renderMarkdown"];
  const previous = keys.map((key) => localStorage.getItem(key));
  localStorage.setItem(keys[0]!, "false");
  localStorage.setItem(keys[1]!, "true");
  state.optimistic = null;
  state.writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return {
    [Symbol.dispose]() {
      for (const [index, key] of keys.entries()) {
        const value = previous[index];
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

function markdownPreview(truncated: boolean, contents = "- [ ] Keep the rest of this file\n") {
  state.file = {
    relativePath: "tasks.md",
    contents,
    byteLength: truncated ? 1_200_000 : 32,
    truncated,
  };
  return (
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/workspace"
      projectName="Project"
      relativePath="tasks.md"
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      keybindings={[]}
      availableEditors={[]}
      openInShortcutEnabled={false}
      revealLine={null}
      revealRequestId={0}
      onOpenFile={vi.fn()}
      onNavigateFolder={vi.fn()}
      folderTrail={undefined}
      onPendingChange={vi.fn()}
      selectedFilePending={false}
      workspaceMutationId={null}
    />
  );
}

describe("rendered Markdown task saves", () => {
  it("keeps a truncated read read-only without queuing a replacement", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(true));
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.readOnly).toBe(true);
    expect(screen.container.querySelector('[contenteditable="true"]')).toBeNull();
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(checkbox.checked).toBe(false);
    expect(state.optimistic).toBeNull();
    expect(state.writeFile).not.toHaveBeenCalled();
  });

  it("still toggles and saves tasks from a complete read", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(false));
    await expect.element(screen.getByRole("textbox", { name: "Edit Markdown" })).toBeVisible();
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(state.writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "tasks.md",
        contents: "- [x] Keep the rest of this file\n",
      },
    });
  });

  it("edits a heading in the rendered file and saves without changing the untouched Markdown", async () => {
    using _settings = setup();
    const contents =
      "# Title\n\nA **bold** paragraph.\n\n| Name | Value |\n| --- | --- |\n| a | 1 |\n\n<!-- keep -->\n";
    await using screen = await render(markdownPreview(false, contents));
    await expect.element(screen.getByRole("textbox", { name: "Edit Markdown" })).toBeVisible();
    const heading = screen.getByRole("heading", { name: "Title" });
    await heading.fill("Updated");
    await expect.element(screen.getByRole("heading", { name: "Updated" })).toBeVisible();
    expect(screen.container.querySelector("strong")?.textContent).toBe("bold");
    await vi.waitFor(() =>
      expect(state.writeFile).toHaveBeenLastCalledWith({
        environmentId,
        input: {
          cwd: "/workspace",
          relativePath: "tasks.md",
          contents: contents.replace("# Title", "# Updated"),
        },
      }),
    );
    await userEvent.keyboard(
      isMacPlatform(navigator.platform) ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
    );
    await expect.element(screen.getByRole("heading", { name: "Title" })).toBeVisible();
    await screen.getByRole("cell", { name: "1", exact: true }).fill("Updated cell");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("Second paragraph");
    await vi.waitFor(() =>
      expect(state.optimistic?.contents).toContain("Updated cell<br><br>Second paragraph"),
    );
    const saved = state.optimistic!.contents;
    await screen.rerender(markdownPreview(false, saved));
    await expect.element(screen.getByRole("heading", { name: "Title" })).toBeVisible();
    await screen.rerender(markdownPreview(false, "# External change\n"));
    await expect.element(screen.getByRole("heading", { name: "External change" })).toBeVisible();
  });
});
