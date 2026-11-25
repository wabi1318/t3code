import { useGT, useMessages } from "gt-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleSlashIcon,
  CircleXIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadStatus, useThreadVisibleTurnItems } from "~/state/entities";

import {
  projectVisibleThreadTimeline,
  type WorkTimelineNode,
  type WorkTimelineStatus,
  type WorkTimelineSnapshot,
} from "./WorkTimelinePanel.logic";

const TrajectoryPanel = lazy(() => import("./TrajectoryPanel"));

type TimelineTab = "tasks" | "trajectory";

export function WorkTimelinePanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly visible: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const items = useThreadVisibleTurnItems(props.visible ? props.threadRef : null);
  const detailStatus = useThreadStatus(props.visible ? props.threadRef : null);
  if (
    props.visible &&
    items.length === 0 &&
    (detailStatus === "empty" || detailStatus === "synchronizing")
  ) {
    return (
      <WorkTimelineFrame workspaceRoot={props.workspaceRoot}>
        <TimelineNotice title={gt("Loading timeline…")} />
      </WorkTimelineFrame>
    );
  }
  return (
    <WorkTimelineBody
      workspaceRoot={props.workspaceRoot}
      snapshot={projectVisibleThreadTimeline(items, resolve)}
      trajectory={
        props.visible && (
          <Suspense fallback={<TimelineNotice title={gt("Loading trajectory…")} />}>
            <TrajectoryPanel threadRef={props.threadRef} workspaceRoot={props.workspaceRoot} />
          </Suspense>
        )
      }
    />
  );
}

export function WorkTimelineBody(props: {
  readonly workspaceRoot: string;
  readonly snapshot: WorkTimelineSnapshot;
  readonly trajectory?: ReactNode;
}) {
  const [tab, setTab] = useState<TimelineTab>("tasks");
  return (
    <WorkTimelineFrame workspaceRoot={props.workspaceRoot}>
      <TimelineReady
        trajectory={props.trajectory}
        snapshot={props.snapshot}
        tab={tab}
        onTabChange={setTab}
      />
    </WorkTimelineFrame>
  );
}

function WorkTimelineFrame(props: {
  readonly workspaceRoot: string;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  return (
    <section aria-label={gt("Timeline")} className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b px-3 py-3">
        <Tooltip>
          <TooltipTrigger render={<h2 className="truncate text-sm font-medium text-foreground" />}>
            {workspaceBasename(props.workspaceRoot)}
          </TooltipTrigger>
          <TooltipPopup>{props.workspaceRoot}</TooltipPopup>
        </Tooltip>
      </header>
      {props.children}
    </section>
  );
}

function TimelineReady(props: {
  readonly snapshot: WorkTimelineSnapshot;
  readonly trajectory?: ReactNode;
  readonly tab: TimelineTab;
  readonly onTabChange: (tab: TimelineTab) => void;
}) {
  const gt = useGT();
  const { snapshot } = props;
  const activity = activitySummary(snapshot.nodes, gt);
  return (
    <>
      <div className="shrink-0 border-b px-3 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm text-foreground">{activity ?? gt("This thread")}</p>
          {activity ? <p className="text-xs text-muted-foreground">{gt("This thread")}</p> : null}
        </div>
        {snapshot.updatedAt ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {gt("Updated {time}", { time: formatTimestamp(snapshot.updatedAt) })}
          </p>
        ) : null}
      </div>
      <div
        className="flex shrink-0 flex-wrap gap-1 border-b px-2 py-1"
        role="tablist"
        aria-label={gt("Timeline sections")}
      >
        <TimelineTabButton
          selected={props.tab === "tasks"}
          onClick={() => props.onTabChange("tasks")}
        >
          {gt("Task tree")}
        </TimelineTabButton>
        {props.trajectory && (
          <TimelineTabButton
            selected={props.tab === "trajectory"}
            onClick={() => props.onTabChange("trajectory")}
          >
            {gt("Trajectory")}
          </TimelineTabButton>
        )}
      </div>
      {props.tab === "trajectory" ? (
        props.trajectory
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3">
          <TaskTree nodes={snapshot.nodes} />
        </div>
      )}
    </>
  );
}

function activitySummary(
  nodes: readonly WorkTimelineNode[],
  gt: ReturnType<typeof useGT>,
): string | null {
  if (nodes.length === 0) return gt("No tasks yet.");
  const counted = nodes.filter((node) => !node.compact && !node.divider);
  const running = counted.filter((node) => node.status === "in_progress").length;
  const stopped = counted.filter((node) => node.statusLabel === gt("Stopped")).length;
  const parts = [
    running > 0 ? gt("{count} running", { count: running }) : null,
    stopped > 0 ? gt("{count} stopped", { count: stopped }) : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function TaskTree(props: { readonly nodes: readonly WorkTimelineNode[] }) {
  const gt = useGT();
  if (props.nodes.length === 0) {
    return <p className="text-sm text-muted-foreground">{gt("No tasks yet.")}</p>;
  }
  return (
    <ol>
      {props.nodes.map((node, index) =>
        node.divider ? null : (
          <li key={node.id} data-depth={node.depth} data-concurrent={node.concurrent}>
            <TaskRow
              node={node}
              guides={guideColumns(props.nodes, index)}
              connectDown={hasNestedChild(props.nodes, index)}
            />
          </li>
        ),
      )}
    </ol>
  );
}

function TaskRow(props: {
  readonly node: WorkTimelineNode;
  readonly guides: readonly { readonly id: string; readonly continues: boolean }[];
  readonly connectDown: boolean;
}) {
  const { node } = props;
  const when = formatSpan(node);
  const [commandOpen, setCommandOpen] = useState(false);
  const command = node.command ?? "";
  const expandable = command.length > 40;
  const body = (
    <>
      <div className="flex min-w-0 items-baseline gap-2">
        {expandable ? (
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 translate-y-px text-muted-foreground",
              commandOpen && "rotate-90",
            )}
          />
        ) : null}
        {node.compact ? null : (
          <span className={cn("shrink-0 text-xs", statusClass(node.status))}>
            {node.statusLabel}
          </span>
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            node.compact ? "text-xs text-muted-foreground" : "text-sm text-foreground",
          )}
        >
          {node.title}
        </span>
        {when ? (
          <time
            dateTime={node.startedAt}
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
          >
            {when}
          </time>
        ) : null}
      </div>
      {command ? (
        <p
          className={cn(
            "mt-0.5 font-mono text-2xs leading-snug text-muted-foreground",
            expandable && !commandOpen ? "truncate" : "break-words whitespace-pre-wrap",
          )}
        >
          {command}
        </p>
      ) : node.note ? (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{node.note}</p>
      ) : null}
    </>
  );
  return (
    <div className="flex min-w-0 items-stretch">
      <ConcurrentRail role={node.concurrent} />
      {props.guides.map((guide) => (
        <span key={guide.id} aria-hidden className="relative w-4 shrink-0">
          <span
            className={cn(
              "absolute left-1/2 w-px -translate-x-1/2 bg-border",
              guide.continues ? "inset-y-0" : "top-0 h-3.5",
            )}
          />
          {guide.id === props.guides.at(-1)?.id ? (
            <span className="absolute top-3.5 left-1/2 h-px w-1/2 bg-border" />
          ) : null}
        </span>
      ))}
      <span className="relative flex w-5 shrink-0 justify-center">
        {props.connectDown ? (
          <span
            aria-hidden
            className="absolute top-3.5 bottom-0 left-1/2 w-px -translate-x-1/2 bg-border"
          />
        ) : null}
        <span className="relative z-10 mt-1.5 bg-background">
          <StatusIcon status={node.status} label={node.statusLabel} />
        </span>
      </span>
      {expandable ? (
        <button
          type="button"
          className="min-w-0 flex-1 py-1 text-left"
          aria-expanded={commandOpen}
          onClick={() => setCommandOpen((open) => !open)}
        >
          {body}
        </button>
      ) : (
        <div className={cn("min-w-0 flex-1 py-1", node.compact && "py-0.5")}>{body}</div>
      )}
    </div>
  );
}

function ConcurrentRail(props: { readonly role: WorkTimelineNode["concurrent"] }) {
  if (props.role === undefined) return <span aria-hidden className="w-3 shrink-0" />;
  const vertical =
    props.role === "first"
      ? "top-3.5 bottom-0"
      : props.role === "last"
        ? "top-0 h-3.5"
        : "inset-y-0";
  return (
    <span aria-hidden className="relative w-3 shrink-0">
      <span className={cn("absolute left-1/2 w-px -translate-x-1/2 bg-border", vertical)} />
      {props.role === "mid" ? null : (
        <span className="absolute top-3.5 left-1/2 h-px w-1/2 bg-border" />
      )}
    </span>
  );
}

function formatSpan(node: WorkTimelineNode): string | null {
  if (node.compact || node.startedAt === undefined) return null;
  const start = formatClock(node.startedAt);
  if (start === null) return null;
  if (node.completedAt === undefined) return start;
  const end = formatClock(node.completedAt);
  if (end === null || end === start) return start;
  return `${start}–${end}`;
}

function formatClock(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function guideColumns(
  nodes: readonly WorkTimelineNode[],
  index: number,
): readonly { readonly id: string; readonly continues: boolean }[] {
  const depth = nodes[index]?.depth ?? 0;
  return Array.from({ length: depth }, (_, level) => ({
    id: `level-${level}`,
    continues: guideContinues(nodes, index, level),
  }));
}

function guideContinues(nodes: readonly WorkTimelineNode[], index: number, level: number): boolean {
  for (let next = index + 1; next < nodes.length; next += 1) {
    const depth = nodes[next]?.depth ?? 0;
    if (depth <= level) return false;
    if (depth === level + 1) return true;
  }
  return false;
}

function hasNestedChild(nodes: readonly WorkTimelineNode[], index: number): boolean {
  const depth = nodes[index]?.depth ?? 0;
  const next = nodes[index + 1];
  return next !== undefined && next.depth > depth;
}

function StatusIcon(props: { readonly status: WorkTimelineStatus; readonly label: string }) {
  const gt = useGT();
  const className = "size-3.5";
  const icon =
    props.label === gt("Failed") ? (
      <CircleXIcon aria-hidden className={cn(className, "text-destructive")} />
    ) : props.label === gt("Stopped") ? (
      <CircleSlashIcon aria-hidden className={cn(className, "text-warning")} />
    ) : props.status === "in_progress" ? (
      <LoaderCircleIcon aria-hidden className={cn(className, "animate-spin text-primary")} />
    ) : props.status === "completed" ? (
      <CircleCheckIcon aria-hidden className={cn(className, "text-success")} />
    ) : (
      <CircleIcon aria-hidden className={cn(className, "text-muted-foreground")} />
    );
  return (
    <span role="img" aria-label={props.label}>
      {icon}
    </span>
  );
}

function statusClass(status: WorkTimelineStatus): string {
  if (status === "in_progress") return "text-primary";
  if (status === "blocked") return "text-warning";
  return "text-muted-foreground";
}

function TimelineTabButton(props: {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.selected}
      onClick={props.onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-(--control-radius) px-2 text-sm",
        props.selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
      )}
    >
      {props.children}
    </button>
  );
}

function TimelineNotice(props: { readonly title: string; readonly detail?: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
      <p className="text-sm text-foreground">{props.title}</p>
      {props.detail ? (
        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{props.detail}</p>
      ) : null}
    </div>
  );
}

function workspaceBasename(cwd: string): string {
  const trimmed = cwd.trim().replace(/[/\\]+$/u, "");
  const parts = trimmed.split(/[\\/]/u);
  return parts.at(-1) || trimmed;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}
