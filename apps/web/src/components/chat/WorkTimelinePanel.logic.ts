import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type WorkTimelineStatus = "pending" | "in_progress" | "completed" | "blocked";
export interface WorkTimelineNode {
  readonly id: string;
  readonly title: string;
  readonly status: WorkTimelineStatus;
  readonly statusLabel: string;
  readonly note: string;
  readonly depth: number;
  /** A file name listed under the edit that changed it. */
  readonly compact?: boolean;
  /** When this work started, if the thread recorded it. */
  readonly startedAt?: string;
  /** When this work finished, if the thread recorded it. */
  readonly completedAt?: string;
  /** Place in a run that overlapped the rows around it. */
  readonly concurrent?: "first" | "mid" | "last";
  /** Shell command for this row. The panel shows a short line until the row is opened. */
  readonly command?: string;
  /** Recorded parent item, when the thread stored one. */
  readonly parentId?: string;
  /** Short excerpt of the user input this work followed. */
  readonly prompt?: string;
  /** Separator text. This row is not a task. */
  readonly divider?: string;
}

export interface WorkTimelineSnapshot {
  readonly nodes: readonly WorkTimelineNode[];
  readonly updatedAt: string | null;
}
const STATUS_LABELS: Record<WorkTimelineStatus, string> = {
  pending: msg("Pending"),
  in_progress: msg("In progress"),
  completed: msg("Completed"),
  blocked: msg("Blocked"),
};

type TurnVisibility = OrchestrationV2ProjectedTurnItem["visibility"];

export interface ThreadTimelineTodoStep {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "running" | "completed";
}

export interface ThreadTimelineChange {
  readonly operation: string;
  readonly path: string;
}

export interface ThreadTimelineItem {
  readonly type: string;
  readonly id?: string;
  readonly title?: string | null;
  readonly activityStatus?: string;
  readonly detail?: string;
  readonly changes?: ReadonlyArray<ThreadTimelineChange>;
  readonly text?: string;
  readonly parentId?: string | null;
  readonly startedAt?: DateTime.Utc | null;
  readonly completedAt?: DateTime.Utc | null;
  readonly updatedAt?: DateTime.Utc | null;
  readonly steps?: ReadonlyArray<ThreadTimelineTodoStep>;
  readonly visibility?: TurnVisibility;
  /** User input excerpt that this work followed. */
  readonly input?: string;
}

const WORK_TYPES = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
]);
const WORK_LIMIT = 40;
const GENERIC_FILE_TITLE =
  /^(?:changed|updated|edited|modified)(?:\s+\d+)?\s+(?:a\s+)?files?$|^file changes?$/iu;
const WORK_LABELS: Record<string, string> = {
  command_execution: msg("Ran command"),
  file_change: msg("Changed a file"),
  file_search: msg("Searched files"),
  web_search: msg("Searched the web"),
  dynamic_tool: msg("Used a tool"),
};

/** Project the open thread. This does not read the work-timeline skill. */
export function projectVisibleThreadTimeline(
  rows: ReadonlyArray<{
    readonly item: OrchestrationV2TurnItem;
    readonly visibility: TurnVisibility;
  }>,
  resolve: MessageResolver = m,
): WorkTimelineSnapshot {
  return projectThreadTimeline(
    rows.map((row) => toThreadTimelineItem(row.item, row.visibility)),
    resolve,
  );
}

export function projectThreadTimeline(
  items: ReadonlyArray<ThreadTimelineItem>,
  resolve: MessageResolver = m,
): WorkTimelineSnapshot {
  // Inherited rows are context from the parent thread. They stay out of the task tree.
  const ownItems = items.filter((item) => item.visibility !== "inherited");
  return { nodes: latestTasks(resolve, ownItems), updatedAt: lastTimestamp(items) };
}

function latestTasks(resolve: MessageResolver, items: readonly ThreadTimelineItem[]) {
  const tagged = tagInputs(items);
  let todoIndex = -1;
  let steps: ReadonlyArray<ThreadTimelineTodoStep> = [];
  tagged.forEach((item, index) => {
    if (item.type !== "todo_list" || !item.steps) return;
    todoIndex = index;
    steps = item.steps;
  });
  const plan = steps.map((step) => node(resolve, step.id, step.text, stepStatus(step.status)));
  const work = presentWork(
    resolve,
    tagged
      .slice(todoIndex + 1)
      .filter((item) => WORK_TYPES.has(item.type))
      .slice(-WORK_LIMIT),
  );
  return finishTaskNodes([...work, ...plan]);
}

const PROMPT_LIMIT = 80;

function tagInputs(items: readonly ThreadTimelineItem[]): readonly ThreadTimelineItem[] {
  let input = "";
  return items.map((item) => {
    if (item.type === "user_message") {
      const next = promptExcerpt(item.text ?? "");
      if (next) input = next;
      return item;
    }
    if (!input || !WORK_TYPES.has(item.type)) return item;
    return { ...item, input };
  });
}

function promptExcerpt(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= PROMPT_LIMIT) return flat;
  return `${flat.slice(0, PROMPT_LIMIT - 1)}…`;
}

interface WorkPiece {
  readonly kind: "work";
  readonly item: ThreadTimelineItem;
  readonly index: number;
}

interface FilePiece {
  readonly kind: "files";
  readonly items: readonly ThreadTimelineItem[];
  readonly parentId: string | null;
  readonly input: string | null;
  readonly index: number;
}

function presentWork(
  resolve: MessageResolver,
  items: readonly ThreadTimelineItem[],
): readonly WorkTimelineNode[] {
  const pieces = groupPieces(items);
  const byId = new Map(
    pieces.flatMap((piece) =>
      piece.kind === "work" && piece.item.id ? [[piece.item.id, piece] as const] : [],
    ),
  );
  const childrenByParent = new Map<string, Array<WorkPiece | FilePiece>>();
  for (const piece of pieces) {
    const parentId = pieceParentId(piece);
    if (!parentId || !byId.has(parentId)) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(piece);
    childrenByParent.set(parentId, children);
  }
  const nodes: WorkTimelineNode[] = [];
  const emitted = new Set<string>();
  const emit = (piece: WorkPiece | FilePiece, depth: number) => {
    const key = pieceKey(piece);
    if (emitted.has(key)) return;
    emitted.add(key);
    if (piece.kind === "files") {
      nodes.push(
        ...fileTree(resolve, piece.items, depth, piece.index, piece.parentId, piece.input),
      );
      return;
    }
    const row = workNode(resolve, piece.item, piece.index);
    nodes.push(depth === 0 ? row : { ...row, depth });
    const children = piece.item.id ? (childrenByParent.get(piece.item.id) ?? []) : [];
    for (const child of [...children].reverse()) emit(child, depth + 1);
  };
  for (const piece of [...pieces].reverse()) {
    const parentId = pieceParentId(piece);
    if (parentId && byId.has(parentId)) continue;
    emit(piece, 0);
  }
  return nodes;
}

function groupPieces(items: readonly ThreadTimelineItem[]): Array<WorkPiece | FilePiece> {
  const pieces: Array<WorkPiece | FilePiece> = [];
  let fileRun: ThreadTimelineItem[] = [];
  let fileParent: string | null = null;
  let fileInput: string | null = null;
  const flush = () => {
    if (fileRun.length === 0) return;
    pieces.push({
      kind: "files",
      items: fileRun,
      parentId: fileParent,
      input: fileInput,
      index: pieces.length,
    });
    fileRun = [];
    fileParent = null;
    fileInput = null;
  };
  for (const item of items) {
    if (isGenericFile(item)) {
      const parentId = item.parentId ?? null;
      const input = item.input ?? null;
      if (fileRun.length > 0 && (parentId !== fileParent || input !== fileInput)) flush();
      fileParent = parentId;
      fileInput = input;
      fileRun.push(item);
      continue;
    }
    flush();
    pieces.push({ kind: "work", item, index: pieces.length });
  }
  flush();
  return pieces;
}

function pieceParentId(piece: WorkPiece | FilePiece): string | null {
  if (piece.kind === "files") return piece.parentId;
  return piece.item.parentId ?? null;
}

function pieceKey(piece: WorkPiece | FilePiece): string {
  if (piece.kind === "files") return `files-${piece.index}`;
  return piece.item.id ?? `idx-${piece.index}`;
}

function fileTree(
  resolve: MessageResolver,
  run: readonly ThreadTimelineItem[],
  depth: number,
  index: number,
  parentId: string | null,
  input: string | null,
): readonly WorkTimelineNode[] {
  const files = uniqueFiles(resolve, [...run].reverse().flatMap(fileChangesOf));
  const merged = mergedWorkStatus(resolve, run);
  const id = run.flatMap((item) => (item.id ? [item.id] : [])).join("+") || `files-${index}`;
  const owned = (row: WorkTimelineNode) => annotate(row, parentId, input);
  if (files.length === 0) {
    return [
      owned(
        place(
          node(resolve, id, resolve(msg("Updated a file")), merged.status, "", merged.label),
          depth,
        ),
      ),
    ];
  }
  const first = files[0];
  if (!first) return [];
  if (files.length === 1) {
    return [
      owned(
        place(
          timed(
            node(resolve, id, `${first.verb} ${first.name}`, merged.status, "", merged.label),
            run,
          ),
          depth,
        ),
      ),
    ];
  }
  const sameVerb = files.every((file) => file.verb === first.verb);
  const parent = owned(
    place(
      timed(
        node(
          resolve,
          id,
          sameVerb
            ? resolve(msg("{verb} {count} files", { verb: first.verb, count: files.length }))
            : resolve(msg("{count} files", { count: files.length })),
          merged.status,
          "",
          merged.label,
        ),
        run,
      ),
      depth,
    ),
  );
  const children = files.map((file, fileIndex) => ({
    ...place(
      node(
        resolve,
        `${id}:${fileIndex}`,
        sameVerb ? file.name : `${file.verb} ${file.name}`,
        merged.status,
        "",
        merged.label,
      ),
      depth + 1,
    ),
    compact: true,
  }));
  return [parent, ...children];
}

function uniqueFiles(
  resolve: MessageResolver,
  changes: readonly ThreadTimelineChange[],
): readonly { readonly verb: string; readonly name: string }[] {
  const seen = new Set<string>();
  const files: { verb: string; name: string }[] = [];
  for (const change of changes) {
    const name = fileBasename(change.path);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    files.push({ verb: fileVerb(resolve, [change]), name });
  }
  return files;
}

function fileChangesOf(item: ThreadTimelineItem): readonly ThreadTimelineChange[] {
  if (item.changes && item.changes.length > 0) return item.changes;
  if (item.detail) return [{ operation: "edit", path: item.detail }];
  return [];
}

function isGenericFile(item: ThreadTimelineItem): boolean {
  if (item.type !== "file_change") return false;
  const raw = (item.title ?? "").trim();
  return raw.length === 0 || GENERIC_FILE_TITLE.test(raw);
}

function mergedWorkStatus(
  resolve: MessageResolver,
  items: readonly ThreadTimelineItem[],
): {
  readonly status: WorkTimelineStatus;
  readonly label: string;
} {
  const activities = items.map((item) => item.activityStatus ?? "");
  const statuses = activities.map((activity) => workStatus(activity));
  const status = statuses.includes("in_progress")
    ? "in_progress"
    : statuses.includes("blocked")
      ? "blocked"
      : "completed";
  if (status === "in_progress") return { status, label: resolve(STATUS_LABELS[status]) };
  if (activities.includes("failed")) return { status, label: resolve(msg("Failed")) };
  if (activities.includes("cancelled") || activities.includes("interrupted")) {
    return { status, label: resolve(msg("Stopped")) };
  }
  return { status, label: resolve(STATUS_LABELS[status]) };
}

function place(row: WorkTimelineNode, depth: number): WorkTimelineNode {
  return depth === 0 ? row : { ...row, depth };
}

function annotate(
  row: WorkTimelineNode,
  parentId: string | null,
  input: string | null,
): WorkTimelineNode {
  return {
    ...row,
    ...(parentId ? { parentId } : {}),
    ...(input ? { prompt: input } : {}),
  };
}

function timed(row: WorkTimelineNode, items: readonly ThreadTimelineItem[]): WorkTimelineNode {
  const span = runSpan(items);
  return {
    ...row,
    ...(span.startedAt === undefined ? {} : { startedAt: span.startedAt }),
    ...(span.completedAt === undefined ? {} : { completedAt: span.completedAt }),
  };
}

function runSpan(items: readonly ThreadTimelineItem[]): {
  readonly startedAt?: string;
  readonly completedAt?: string;
} {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let open = false;
  for (const item of items) {
    const startMs = epoch(item.startedAt ?? item.updatedAt);
    if (startMs === null) continue;
    start = Math.min(start, startMs);
    const endMs = epoch(item.completedAt);
    if (endMs === null) {
      if (workStatus(item.activityStatus ?? "") === "in_progress") open = true;
      continue;
    }
    end = Math.max(end, endMs);
  }
  if (!Number.isFinite(start)) return {};
  const startedAt = new Date(start).toISOString();
  if (open || !Number.isFinite(end) || end <= start) return { startedAt };
  return { startedAt, completedAt: new Date(end).toISOString() };
}

function markConcurrent(nodes: readonly WorkTimelineNode[]): readonly WorkTimelineNode[] {
  const role = new Array<"first" | "mid" | "last" | undefined>(nodes.length);
  let cluster: number[] = [];
  let overlap: { readonly start: number; readonly end: number } | null = null;
  const flush = () => {
    const first = cluster[0];
    const last = cluster.at(-1);
    if (cluster.length >= 2 && first !== undefined && last !== undefined) {
      role[first] = "first";
      role[last] = "last";
      for (let index = first + 1; index < last; index += 1) role[index] = "mid";
    }
    cluster = [];
    overlap = null;
  };
  nodes.forEach((node, index) => {
    if (node.compact) return;
    const span = nodeSpan(node);
    if (!span) {
      flush();
      return;
    }
    if (overlap && span.start < overlap.end && overlap.start < span.end) {
      overlap = {
        start: Math.max(overlap.start, span.start),
        end: Math.min(overlap.end, span.end),
      };
      cluster.push(index);
      return;
    }
    flush();
    cluster = [index];
    overlap = span;
  });
  flush();
  return nodes.map((node, index) => {
    const concurrent = role[index];
    return concurrent === undefined ? node : { ...node, concurrent };
  });
}

function nodeSpan(node: WorkTimelineNode): { readonly start: number; readonly end: number } | null {
  if (!node.startedAt) return null;
  const start = Date.parse(node.startedAt);
  if (Number.isNaN(start)) return null;
  if (!node.completedAt) {
    return node.status === "in_progress" ? { start, end: Number.POSITIVE_INFINITY } : null;
  }
  const end = Date.parse(node.completedAt);
  if (Number.isNaN(end) || end <= start) return null;
  return { start, end };
}

function finishTaskNodes(nodes: readonly WorkTimelineNode[]): readonly WorkTimelineNode[] {
  return segmentByPrompt(nodes).flatMap((segment) => markConcurrent(segment));
}

function segmentByPrompt(nodes: readonly WorkTimelineNode[]): WorkTimelineNode[][] {
  const segments: WorkTimelineNode[][] = [];
  let current: WorkTimelineNode[] = [];
  let prompt: string | undefined;
  let open = false;
  const flush = () => {
    if (current.length === 0) return;
    segments.push(current);
    current = [];
  };
  for (const node of nodes) {
    if (node.depth === 0 && !node.compact && !node.divider) {
      const next = node.prompt;
      if (open && next !== prompt) flush();
      prompt = next;
      open = true;
    }
    current.push(node);
  }
  flush();
  return segments;
}

function workNode(
  resolve: MessageResolver,
  item: ThreadTimelineItem,
  index: number,
): WorkTimelineNode {
  const activity = item.activityStatus ?? "";
  const status = workStatus(activity);
  const phrase =
    item.type === "file_change" ? fileChangePhrase(resolve, item) : workPhrase(resolve, item);
  const row = annotate(
    timed(
      node(
        resolve,
        item.id || `work-${index}`,
        phrase.title,
        status,
        phrase.note,
        workStatusLabel(resolve, activity, status),
      ),
      [item],
    ),
    item.parentId ?? null,
    item.input ?? null,
  );
  const command = item.type === "command_execution" ? commandText(item.detail ?? "") : "";
  return command && command !== phrase.title ? { ...row, command } : row;
}

function workPhrase(
  resolve: MessageResolver,
  item: ThreadTimelineItem,
): { readonly title: string; readonly note: string } {
  switch (item.type) {
    case "command_execution":
      return commandPhrase(resolve, item);
    case "file_search":
      return searchPhrase(resolve, "files", item);
    case "web_search":
      return searchPhrase(resolve, "the web", item);
    case "dynamic_tool":
      return toolPhrase(resolve, item);
    default:
      return plainPhrase(resolve, item);
  }
}

function plainPhrase(
  resolve: MessageResolver,
  item: ThreadTimelineItem,
): { readonly title: string; readonly note: string } {
  const detail = shortenPaths(excerpt(item.detail ?? ""));
  const titled = shortenPaths(excerpt((item.title ?? "").trim()));
  const title = titled || detail || resolve(WORK_LABELS[item.type] ?? msg("Work"));
  return { title, note: detail && detail !== title ? detail : "" };
}

function commandPhrase(
  resolve: MessageResolver,
  item: ThreadTimelineItem,
): {
  readonly title: string;
  readonly note: string;
} {
  const rawTitle = (item.title ?? "").trim();
  const command = commandText(item.detail ?? "");
  const summary = commandSummary(item.detail ?? "");
  const title = isHumanTitle(rawTitle)
    ? excerpt(shortenPaths(rawTitle))
    : commandWords(resolve, summary);
  const note = command && command !== title ? command : "";
  return { title, note };
}

function searchPhrase(
  resolve: MessageResolver,
  kind: "files" | "the web",
  item: ThreadTimelineItem,
): { readonly title: string; readonly note: string } {
  const rawTitle = (item.title ?? "").trim();
  if (isHumanTitle(rawTitle) && !/^searched\b/iu.test(rawTitle)) {
    return { title: excerpt(shortenPaths(rawTitle)), note: "" };
  }
  const query = shortenPaths((item.detail ?? "").trim());
  if (!query)
    return {
      title: kind === "files" ? resolve(msg("Searched files")) : resolve(msg("Searched the web")),
      note: "",
    };
  const short = query.length > 40 ? `${query.slice(0, 39)}…` : query;
  return {
    title:
      kind === "files"
        ? resolve(msg("Searched files for {query}", { query: short }))
        : resolve(msg("Searched the web for {query}", { query: short })),
    note: "",
  };
}

function toolPhrase(
  resolve: MessageResolver,
  item: ThreadTimelineItem,
): { readonly title: string; readonly note: string } {
  const tool = (item.detail ?? "").trim();
  const title = shortenPaths((item.title ?? "").trim());
  if (title && title.toLowerCase() !== tool.toLowerCase())
    return { title: excerpt(title), note: "" };
  if (/^read$/iu.test(tool)) return { title: resolve(msg("Read a file")), note: "" };
  if (tool) return { title: resolve(msg("Used {tool}", { tool })), note: "" };
  return { title: resolve(msg("Used a tool")), note: "" };
}

function isHumanTitle(title: string): boolean {
  if (!/\s/u.test(title)) return false;
  if (/[\\/]|&&|\|\||[<>]|\.bin\b/u.test(title)) return false;
  if (
    /^(?:cd|vp|pnpm|npm|npx|git|rg|ls|cat|echo|ln|rm|mkdir|node|python|bash|sh|effect-tsgo)\b/u.test(
      title,
    )
  ) {
    return false;
  }
  return !/^(?:ran command|command|bash|shell)$/iu.test(title);
}

function commandText(raw: string): string {
  const line = (raw.split("\n", 1)[0] ?? "").trim();
  if (!line) return "";
  return excerpt(
    shortenPaths(line)
      .replace(/\.\/node_modules\/\.bin\//gu, "")
      .replace(/\s+/gu, " ")
      .trim(),
  );
}

function commandSummary(raw: string): string {
  const line = raw.split("\n", 1)[0] ?? "";
  const parts = line
    .split(/\s*(?:&&|\|\||;)\s*/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const useful =
    parts.find((part) => !/^(?:cd|echo|ln|rm|mkdir)\b/u.test(part)) ?? parts.at(-1) ?? line.trim();
  const command = shortenPaths(useful)
    .replace(/\.\/node_modules\/\.bin\//gu, "")
    .replace(/\s*(?:>>?|2>&1)\b.*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (command.length <= 60) return command;
  return `${command.slice(0, 59)}…`;
}

function commandWords(resolve: MessageResolver, summary: string): string {
  if (!summary) return resolve(msg("Ran a command"));
  if (/^vp\s+test\b/u.test(summary)) return resolve(msg("Ran tests"));
  if (/\bapp-sync\b/u.test(summary)) return resolve(msg("Installed the app"));
  if (/^vp\s+fmt\b/u.test(summary)) return resolve(msg("Formatted files"));
  if (/^vp\s+lint\b/u.test(summary)) return resolve(msg("Linted files"));
  if (/\beffect-tsgo\b|\btsc\b|\btsrs\b/u.test(summary)) return resolve(msg("Typechecked"));
  if (/^git\b/u.test(summary)) return resolve(msg("Ran git"));
  if (/^rg\b/u.test(summary)) return resolve(msg("Searched files"));
  const tokens = summary.split(/\s+/u).slice(0, 3).join(" ");
  return resolve(msg("Ran {command}", { command: tokens }));
}

function shortenPaths(text: string): string {
  return text.replace(/(?:^|[\s"'`(])((?:\.\.?\/|\/)[^\s"'`)]+)/gu, (match, path: string) => {
    return `${match.slice(0, match.length - path.length)}${fileBasename(path)}`;
  });
}

function fileChangePhrase(
  resolve: MessageResolver,
  item: ThreadTimelineItem,
): {
  readonly title: string;
  readonly note: string;
} {
  const changes = item.changes ?? [];
  const paths = changes.map((change) => change.path).filter((path) => path.length > 0);
  if (paths.length === 0 && item.detail) paths.push(item.detail);
  const names = [...new Set(paths.map(fileBasename))];
  const verb = fileVerb(resolve, changes);
  const raw = (item.title ?? "").trim();
  const generic = raw.length === 0 || GENERIC_FILE_TITLE.test(raw);
  if (!generic) {
    const title = excerpt(raw);
    const note = names
      .filter((name) => !title.includes(name))
      .slice(0, 4)
      .join(", ");
    return { title, note };
  }
  if (names.length === 0) return { title: resolve(msg("Updated a file")), note: "" };
  if (names.length === 1) return { title: `${verb} ${names[0]}`, note: "" };
  return {
    title: resolve(
      msg("{verb} {name} and {count} more", { verb, name: names[0], count: names.length - 1 }),
    ),
    note: names.slice(0, 4).join(", "),
  };
}

function fileVerb(resolve: MessageResolver, changes: ReadonlyArray<ThreadTimelineChange>): string {
  const operations = changes.map((change) => change.operation.toLowerCase());
  if (operations.length === 0) return resolve(msg("Updated"));
  if (operations.every((operation) => /delete|remove/u.test(operation)))
    return resolve(msg("Deleted"));
  if (operations.every((operation) => /rename|move/u.test(operation)))
    return resolve(msg("Renamed"));
  if (operations.every((operation) => /add|create|write/u.test(operation)))
    return resolve(msg("Created"));
  return resolve(msg("Edited"));
}

function fileBasename(path: string): string {
  const parts = path.split(/[\\/]/u).filter((part) => part.length > 0);
  return parts.at(-1) || path;
}

function workStatus(activity: string): WorkTimelineStatus {
  if (activity === "completed") return "completed";
  if (activity === "failed" || activity === "cancelled" || activity === "interrupted") {
    return "blocked";
  }
  return "in_progress";
}

function workStatusLabel(
  resolve: MessageResolver,
  activity: string,
  status: WorkTimelineStatus,
): string {
  if (activity === "failed") return resolve(msg("Failed"));
  if (activity === "cancelled" || activity === "interrupted") return resolve(msg("Stopped"));
  return resolve(STATUS_LABELS[status]);
}

function node(
  resolve: MessageResolver,
  id: string,
  title: string,
  status: WorkTimelineStatus,
  note = "",
  statusLabel = resolve(STATUS_LABELS[status]),
): WorkTimelineNode {
  return {
    id,
    title,
    status,
    statusLabel,
    note,
    depth: 0,
  };
}

function toThreadTimelineItem(
  item: OrchestrationV2TurnItem,
  visibility: TurnVisibility,
): ThreadTimelineItem {
  const view: ThreadTimelineItem = {
    type: item.type,
    id: item.id,
    title: item.title,
    activityStatus: item.status,
    detail: workDetail(item),
    parentId: item.parentItemId,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    updatedAt: item.updatedAt,
    ...(visibility === "local" ? {} : { visibility }),
  };
  if (item.type === "user_message") return { ...view, text: item.text };
  if (item.type === "todo_list") return { ...view, steps: item.steps };
  if (item.type === "file_change") {
    return {
      ...view,
      ...(item.changes === undefined
        ? {}
        : {
            changes: item.changes.map((change) => ({
              operation: change.operation,
              path: change.path,
            })),
          }),
    };
  }
  return view;
}

function workDetail(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "command_execution":
      return item.input.split("\n", 1)[0]?.trim() ?? "";
    case "file_change":
      return item.fileName;
    case "file_search":
      return item.pattern ?? "";
    case "web_search":
      return item.patterns?.join(", ") ?? "";
    case "dynamic_tool":
      return item.toolName ?? "";
    default:
      return "";
  }
}

function stepStatus(status: ThreadTimelineTodoStep["status"]): WorkTimelineStatus {
  if (status === "completed") return "completed";
  if (status === "running") return "in_progress";
  return "pending";
}

function lastTimestamp(items: ReadonlyArray<ThreadTimelineItem>): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const stamp = timestamp(items[index]?.updatedAt ?? items[index]?.startedAt);
    if (stamp) return stamp;
  }
  return null;
}

function epoch(value: DateTime.Utc | null | undefined): number | null {
  if (!value) return null;
  return DateTime.toEpochMillis(value);
}

function timestamp(value: DateTime.Utc | null | undefined): string | null {
  if (!value) return null;
  return DateTime.formatIso(value);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= 240) return flat;
  return `${flat.slice(0, 239)}…`;
}
