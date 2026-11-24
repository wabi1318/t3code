import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { projectThreadTimeline, type ThreadTimelineItem } from "./WorkTimelinePanel.logic";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function item(input: ThreadTimelineItem): ThreadTimelineItem {
  return input;
}

function shownText(
  nodes: readonly {
    readonly title: string;
    readonly note: string;
    readonly command?: string;
    readonly detail?: string;
    readonly divider?: string;
  }[],
): string {
  return nodes
    .map((node) =>
      [node.title, node.note, node.command ?? "", node.detail ?? "", node.divider ?? ""].join("\n"),
    )
    .join("\n");
}

describe("projectThreadTimeline", () => {
  it("uses the latest tasks in the thread and the turns around them", () => {
    const snapshot = projectThreadTimeline([
      item({
        type: "user_message",
        text: "Check the panel",
        startedAt: at("2026-11-15T09:00:00.000Z"),
        updatedAt: at("2026-11-15T09:00:00.000Z"),
      }),
      item({
        type: "todo_list",
        updatedAt: at("2026-11-15T09:01:00.000Z"),
        steps: [{ id: "old", text: "Old plan", status: "completed" }],
      }),
      item({
        type: "assistant_message",
        text: "The panel is open.",
        updatedAt: at("2026-11-15T09:02:00.000Z"),
      }),
      item({
        type: "user_message",
        text: "Show the current tasks",
        startedAt: at("2026-11-15T09:03:00.000Z"),
        updatedAt: at("2026-11-15T09:03:00.000Z"),
      }),
      item({
        type: "todo_list",
        updatedAt: at("2026-11-15T09:04:00.000Z"),
        steps: [
          { id: "done", text: "Read the thread", status: "completed" },
          { id: "now", text: "Update the panel", status: "running" },
          { id: "later", text: "Leave the skill alone", status: "pending" },
        ],
      }),
    ]);

    expect(snapshot.nodes.map((node) => [node.title, node.statusLabel])).toEqual([
      ["Read the thread", "Completed"],
      ["Update the panel", "In progress"],
      ["Leave the skill alone", "Pending"],
    ]);
  });

  it("uses this thread's own work when the thread has no task list", () => {
    const snapshot = projectThreadTimeline([
      item({
        type: "user_message",
        text: "Update the panel",
        startedAt: at("2026-11-15T09:00:00.000Z"),
      }),
      item({
        type: "command_execution",
        id: "cmd",
        activityStatus: "completed",
        detail: "vp test",
      }),
      item({
        type: "file_change",
        id: "file",
        title: "Update the panel",
        activityStatus: "running",
        detail: "WorkTimelinePanel.tsx",
      }),
      item({
        type: "command_execution",
        id: "failed",
        activityStatus: "failed",
        detail: "vp lint",
      }),
    ]);

    expect(
      snapshot.nodes
        .filter((node) => !node.divider)
        .map((node) => [node.title, node.statusLabel, node.note]),
    ).toEqual([
      ["Linted files", "Failed", "vp lint"],
      ["Update the panel", "In progress", "WorkTimelinePanel.tsx"],
      ["Ran tests", "Completed", "vp test"],
    ]);
    expect(snapshot.nodes.some((node) => node.divider)).toBe(false);
  });

  it("adds work that happens after the latest task list", () => {
    const snapshot = projectThreadTimeline([
      item({
        type: "todo_list",
        steps: [{ id: "plan", text: "Decouple the panel", status: "completed" }],
      }),
      item({
        type: "command_execution",
        id: "cmd",
        title: "Format the panel",
        activityStatus: "running",
      }),
    ]);

    expect(snapshot.nodes.map((node) => [node.title, node.statusLabel])).toEqual([
      ["Format the panel", "In progress"],
      ["Decouple the panel", "Completed"],
    ]);
  });

  it("keeps the latest task list ahead of tool work", () => {
    const snapshot = projectThreadTimeline([
      item({
        type: "command_execution",
        id: "cmd",
        title: "Ran the tests",
        activityStatus: "completed",
      }),
      item({
        type: "todo_list",
        steps: [{ id: "plan", text: "Decouple the panel", status: "running" }],
      }),
    ]);

    expect(snapshot.nodes.map((node) => node.title)).toEqual(["Decouple the panel"]);
    expect(snapshot.nodes[0]?.statusLabel).toBe("In progress");
  });

  it("keeps the latest work when the thread is long", () => {
    const snapshot = projectThreadTimeline(
      Array.from({ length: 41 }, (_, index) =>
        item({
          type: "command_execution",
          id: `cmd-${index}`,
          title: `Command ${index}`,
          activityStatus: "completed",
        }),
      ),
    );

    expect(snapshot.nodes.length).toBe(40);
    expect(snapshot.nodes[0]?.title).toBe("Command 40");
    expect(snapshot.nodes.at(-1)?.title).toBe("Command 1");
  });

  it("names a file edit and puts the newest work first", () => {
    const snapshot = projectThreadTimeline([
      item({
        type: "todo_list",
        steps: [{ id: "plan", text: "Decouple the panel", status: "completed" }],
      }),
      item({
        type: "file_change",
        id: "old",
        title: "Changed files",
        activityStatus: "completed",
        detail: "/work/old.ts",
        changes: [{ operation: "edit", path: "/work/old.ts" }],
      }),
      item({
        type: "file_change",
        id: "new",
        title: "Changed files",
        activityStatus: "completed",
        detail: "/Users/me/apps/web/src/components/chat/threadWorkTimeline.ts",
        changes: [
          {
            operation: "edit",
            path: "/Users/me/apps/web/src/components/chat/threadWorkTimeline.ts",
          },
          {
            operation: "edit",
            path: "/Users/me/apps/web/src/components/chat/WorkTimelinePanel.tsx",
          },
        ],
      }),
    ]);

    expect(snapshot.nodes.map((node) => [node.title, node.depth, node.compact ?? false])).toEqual([
      ["Edited 3 files", 0, false],
      ["threadWorkTimeline.ts", 1, true],
      ["WorkTimelinePanel.tsx", 1, true],
      ["old.ts", 1, true],
      ["Decouple the panel", 0, false],
    ]);
  });

  it("describes commands, reads, and searches in words", () => {
    const snapshot = projectThreadTimeline([
      item({
        type: "command_execution",
        id: "install",
        title: "Install task tree label update",
        activityStatus: "completed",
        detail: "cd /Users/me/project && ./node_modules/.bin/vp run app-sync && echo EXIT:$?",
      }),
      item({
        type: "dynamic_tool",
        id: "read",
        title: "Read /Users/me/project/apps/web/src/components/chat/threadWorkTimeline.ts",
        detail: "Read",
        activityStatus: "completed",
      }),
      item({
        type: "file_search",
        id: "search",
        title: "Searched files",
        detail: "workTimeline",
        activityStatus: "completed",
      }),
    ]);

    expect(snapshot.nodes.map((node) => [node.title, node.note])).toEqual([
      ["Searched files for workTimeline", ""],
      ["Read threadWorkTimeline.ts", ""],
      ["Install task tree label update", "cd project && vp run app-sync && echo EXIT:$?"],
    ]);
  });

  it("nests a child under its parent", () => {
    const snapshot = projectThreadTimeline([
      item({
        type: "command_execution",
        id: "parent",
        title: "Review the diff",
        activityStatus: "completed",
        startedAt: at("2026-11-15T10:00:00.000Z"),
        completedAt: at("2026-11-15T10:01:00.000Z"),
      }),
      item({
        type: "command_execution",
        id: "child",
        parentId: "parent",
        title: "Run the checks",
        activityStatus: "running",
        startedAt: at("2026-11-15T10:01:00.000Z"),
      }),
    ]);

    expect(snapshot.nodes.map((node) => [node.title, node.depth, node.parentId ?? null])).toEqual([
      ["Review the diff", 0, null],
      ["Run the checks", 1, "parent"],
    ]);
  });

  it("keeps file edits that are split by other work on separate lines", () => {
    const snapshot = projectThreadTimeline([
      item({
        type: "file_change",
        id: "old",
        title: "Changed files",
        activityStatus: "completed",
        changes: [{ operation: "edit", path: "/work/old.ts" }],
      }),
      item({
        type: "command_execution",
        id: "cmd",
        title: "Run the tests",
        activityStatus: "completed",
      }),
      item({
        type: "file_change",
        id: "new",
        title: "Changed files",
        activityStatus: "completed",
        changes: [{ operation: "edit", path: "/work/new.ts" }],
      }),
    ]);

    expect(snapshot.nodes.map((node) => [node.title, node.depth])).toEqual([
      ["Edited new.ts", 0],
      ["Run the tests", 0],
      ["Edited old.ts", 0],
    ]);
  });

  it("brackets commands whose run times overlap", () => {
    const snapshot = projectThreadTimeline([
      item({
        type: "command_execution",
        id: "lint",
        title: "Lint files",
        activityStatus: "completed",
        detail: "vp lint src",
        startedAt: at("2026-11-15T11:39:00.000Z"),
        completedAt: at("2026-11-15T11:40:30.000Z"),
      }),
      item({
        type: "file_change",
        id: "edit",
        title: "Changed files",
        activityStatus: "completed",
        startedAt: at("2026-11-15T11:39:20.000Z"),
        completedAt: at("2026-11-15T11:39:40.000Z"),
        changes: [{ operation: "edit", path: "/work/panel.tsx" }],
      }),
      item({
        type: "command_execution",
        id: "fmt",
        title: "Format files",
        activityStatus: "completed",
        detail: "vp fmt src",
        startedAt: at("2026-11-15T11:39:10.000Z"),
        completedAt: at("2026-11-15T11:40:00.000Z"),
      }),
      item({
        type: "command_execution",
        id: "test",
        title: "Run tests",
        activityStatus: "completed",
        startedAt: at("2026-11-15T11:41:00.000Z"),
        completedAt: at("2026-11-15T11:42:00.000Z"),
      }),
    ]);

    expect(snapshot.nodes.map((node) => [node.title, node.note, node.concurrent ?? null])).toEqual([
      ["Run tests", "", null],
      ["Format files", "vp fmt src", "first"],
      ["Edited panel.tsx", "", "mid"],
      ["Lint files", "vp lint src", "last"],
    ]);
  });

  it("leaves commands that only meet at an endpoint on their own", () => {
    const snapshot = projectThreadTimeline([
      item({
        type: "command_execution",
        id: "lint",
        title: "Lint files",
        activityStatus: "completed",
        startedAt: at("2026-11-15T11:39:00.000Z"),
        completedAt: at("2026-11-15T11:40:00.000Z"),
      }),
      item({
        type: "command_execution",
        id: "fmt",
        title: "Format files",
        activityStatus: "completed",
        startedAt: at("2026-11-15T11:40:00.000Z"),
        completedAt: at("2026-11-15T11:41:00.000Z"),
      }),
    ]);

    expect(snapshot.nodes.map((node) => node.concurrent ?? null)).toEqual([null, null]);
  });

  it("stays empty when the thread has no tasks or messages", () => {
    const snapshot = projectThreadTimeline([]);
    expect(snapshot.nodes).toEqual([]);
  });

  it("splits file edits when the user input changes", () => {
    const snapshot = projectThreadTimeline([
      item({ type: "user_message", text: "Fix the header" }),
      item({
        type: "file_change",
        id: "old",
        title: "Changed files",
        activityStatus: "completed",
        changes: [{ operation: "edit", path: "/work/Header.tsx" }],
      }),
      item({ type: "user_message", text: "Draw the graph" }),
      item({
        type: "file_change",
        id: "next",
        title: "Changed files",
        activityStatus: "completed",
        changes: [{ operation: "edit", path: "/work/Graph.tsx" }],
      }),
    ]);

    expect(snapshot.nodes.some((node) => node.divider)).toBe(false);
    expect(shownText(snapshot.nodes)).not.toContain("Fix the header");
    expect(shownText(snapshot.nodes)).not.toContain("Draw the graph");
    expect(snapshot.nodes.map((node) => node.title)).toEqual([
      "Edited Graph.tsx",
      "Edited Header.tsx",
    ]);
  });
});
