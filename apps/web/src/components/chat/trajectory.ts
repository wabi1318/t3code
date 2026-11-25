import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/mediaPreview";
import * as DateTime from "effect/DateTime";

function trajectoryTimes(item: OrchestrationV2TurnItem) {
  const start = item.startedAt ? DateTime.toEpochMillis(item.startedAt) : null;
  const end = item.completedAt ? DateTime.toEpochMillis(item.completedAt) : null;
  return {
    start,
    end,
    duration: start !== null && end !== null && end >= start ? end - start : null,
  };
}

function trajectoryText(item: OrchestrationV2TurnItem) {
  if ("text" in item) return item.text;
  if ("message" in item) return item.message;
  switch (item.type) {
    case "command_execution":
      return item.input;
    case "dynamic_tool":
      return item.toolName ?? "";
    case "file_change":
      return item.fileName;
    case "file_search":
      return item.pattern ?? "";
    case "web_search":
      return item.patterns?.join(" ") ?? "";
    case "error":
      return item.failure.message;
    case "subagent":
      return item.prompt;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return item.steps.map((step) => step.text).join(" · ");
    case "compaction":
    case "handoff":
      return item.summary ?? "";
    default:
      return item.title ?? "";
  }
}

export function trajectoryRecord(row: OrchestrationV2ProjectedTurnItem) {
  const { item } = row;
  const label =
    item.type === "dynamic_tool" && item.toolName ? item.toolName : item.type.replaceAll("_", " ");
  const key = JSON.stringify([row.sourceThreadId, row.sourceItemId]);
  return { key, row, label, text: trajectoryText(item), ...trajectoryTimes(item) };
}

export type TrajectoryRecord = ReturnType<typeof trajectoryRecord>;

export function clockLabel(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

type DynamicTool = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

export function isImageViewTool(item: DynamicTool) {
  return (
    /(?:^|[._])view[ _-]?images?$/i.test(item.toolName ?? "") ||
    /^view images?$/i.test(item.title ?? "")
  );
}

export function trajectoryImagePaths(item: DynamicTool): string[] {
  if (item.viewedImagePath) return [item.viewedImagePath];
  if (!isImageViewTool(item)) return [];
  const input = item.input;
  if (!input || typeof input !== "object") return [];
  const paths =
    "paths" in input && Array.isArray(input.paths)
      ? input.paths
      : "path" in input
        ? [input.path]
        : [];
  return [
    ...new Set(
      paths.filter(
        (path): path is string => typeof path === "string" && isWorkspaceImagePreviewPath(path),
      ),
    ),
  ];
}
