import "~/index.css";

import * as DateTime from "effect/DateTime";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { RightPanelTabs } from "../RightPanelTabs";
import { WorkTimelineBody } from "./WorkTimelinePanel";
import { projectThreadTimeline } from "./WorkTimelinePanel.logic";

const noop = () => {};

it("shows an empty thread without inventing tasks", async () => {
  await using screen = await render(
    <WorkTimelineBody workspaceRoot="/work/empty" snapshot={projectThreadTimeline([])} />,
    { router: false },
  );
  await expect.element(screen.getByText("0%", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("No tasks yet.", { exact: true }).first()).toBeVisible();
});

it("shows running work without a percent", async () => {
  await using screen = await render(
    <WorkTimelineBody
      workspaceRoot="/work/demo"
      snapshot={projectThreadTimeline([
        {
          type: "command_execution",
          id: "cmd",
          title: "Format the panel",
          activityStatus: "running",
        },
        {
          type: "file_change",
          id: "file",
          title: "Changed files",
          activityStatus: "completed",
          changes: [{ operation: "edit", path: "/work/threadWorkTimeline.ts" }],
        },
      ])}
    />,
    { router: false },
  );

  await expect.element(screen.getByText("1 running", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("In progress", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Format the panel", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Edited threadWorkTimeline.ts", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole("progressbar")).not.toBeInTheDocument();
  await expect.element(screen.getByText("%", { exact: true })).not.toBeInTheDocument();
});

it("draws a child under its parent and lists every edited file", async () => {
  await using screen = await render(
    <WorkTimelineBody
      workspaceRoot="/work/demo"
      snapshot={projectThreadTimeline([
        {
          type: "command_execution",
          id: "parent",
          title: "Review the diff",
          activityStatus: "completed",
        },
        {
          type: "command_execution",
          id: "child",
          parentId: "parent",
          title: "Run the checks",
          activityStatus: "running",
        },
        {
          type: "file_change",
          id: "files",
          title: "Changed files",
          activityStatus: "completed",
          changes: [
            { operation: "edit", path: "/work/threadWorkTimeline.ts" },
            { operation: "edit", path: "/work/WorkTimelinePanel.tsx" },
          ],
        },
      ])}
    />,
    { router: false },
  );

  await expect.element(screen.getByText("Edited 2 files", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("threadWorkTimeline.ts", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("WorkTimelinePanel.tsx", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Parallel", { exact: true })).not.toBeInTheDocument();
  const child = screen.getByText("Run the checks", { exact: true }).element().closest("li");
  expect(child?.getAttribute("data-depth")).toBe("1");
  const parent = screen.getByText("Review the diff", { exact: true }).element().closest("li");
  expect(parent?.getAttribute("data-depth")).toBe("0");
});

it("shows the clock and a bracket when commands overlap", async () => {
  const lintStart = "2026-11-15T11:39:00.000Z";
  const lintEnd = "2026-11-15T11:40:30.000Z";
  const fmtStart = "2026-11-15T11:39:10.000Z";
  const fmtEnd = "2026-11-15T11:39:50.000Z";
  const clock = (iso: string) => {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  await using screen = await render(
    <WorkTimelineBody
      workspaceRoot="/work/demo"
      snapshot={projectThreadTimeline([
        {
          type: "command_execution",
          id: "lint",
          title: "Lint files",
          detail:
            "vp lint src && vp lint apps/web/src/components/chat/WorkTimelinePanel.tsx --max-warnings 0",
          activityStatus: "completed",
          startedAt: DateTime.makeUnsafe(lintStart),
          completedAt: DateTime.makeUnsafe(lintEnd),
        },
        {
          type: "command_execution",
          id: "fmt",
          title: "Format files",
          detail: "vp fmt src",
          activityStatus: "completed",
          startedAt: DateTime.makeUnsafe(fmtStart),
          completedAt: DateTime.makeUnsafe(fmtEnd),
        },
      ])}
    />,
    { router: false },
  );

  const lint = screen.getByText("Lint files", { exact: true }).element().closest("li");
  const fmt = screen.getByText("Format files", { exact: true }).element().closest("li");
  expect(fmt?.getAttribute("data-concurrent")).toBe("first");
  expect(lint?.getAttribute("data-concurrent")).toBe("last");
  await expect
    .element(screen.getByText(`${clock(lintStart)}–${clock(lintEnd)}`, { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("vp fmt src", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Format files", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Parallel", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Hide the rows that ran together" }))
    .not.toBeInTheDocument();

  const lintCommand = screen.getByRole("button", { name: /Lint files/ });
  expect(lintCommand.element().getAttribute("aria-expanded")).toBe("false");
  expect(lintCommand.element().querySelector("p")?.className).toContain("truncate");
  await lintCommand.click();
  const opened = screen.getByRole("button", { name: /Lint files/ });
  expect(opened.element().getAttribute("aria-expanded")).toBe("true");
  expect(opened.element().querySelector("p")?.className).not.toContain("truncate");
  await expect.element(screen.getByText("Format files", { exact: true })).toBeVisible();
});

it("opens the timeline from the surface list", async () => {
  const onAddWorkTimeline = vi.fn();
  await using screen = await render(
    <RightPanelTabs
      mode="inline"
      open
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={[]}
      environmentId={null}
      activeSurfaceId={null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={noop}
      onCloseSurface={noop}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={noop}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      onAddWorkTimeline={onAddWorkTimeline}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddDevice={noop}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable
      workTimelineAvailable
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
    >
      {null}
    </RightPanelTabs>,
  );

  await expect.element(screen.getByRole("heading", { name: "Open a surface" })).toBeVisible();
  await screen.getByRole("button", { name: /Timeline/ }).click();
  expect(onAddWorkTimeline).toHaveBeenCalledOnce();
});
