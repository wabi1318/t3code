import { useGT } from "gt-react";
import { LegendList } from "@legendapp/list/react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { fileBasename, workspaceRelativeFilePath } from "@t3tools/shared/path";
import { useDeferredValue, useRef, useState } from "react";
import { useThreadHistory, useThreadProjection } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { TrajectoryInspector } from "./TrajectoryInspector";
import {
  type LucideIcon,
  ChevronRightIcon,
  FilePenLineIcon,
  MessageSquareIcon,
  TerminalIcon,
  WrenchIcon,
  TextIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { trajectoryRecord, clockLabel, type TrajectoryRecord } from "./trajectory";

function filePreview(path: string, workspaceRoot: string) {
  const relative = workspaceRelativeFilePath(path, workspaceRoot) ?? path;
  const name = fileBasename(relative);
  return {
    preview: name,
    directory: relative.slice(0, Math.max(0, relative.length - name.length - 1)),
    code: true,
  };
}

function recordPresentation(
  { row: { item }, text, label }: TrajectoryRecord,
  workspaceRoot: string,
): { Icon: LucideIcon; preview: string; kind: string | null; directory?: string; code?: boolean } {
  switch (item.type) {
    case "command_execution":
      return { Icon: TerminalIcon, preview: text || label, kind: "Command", code: true };
    case "file_change":
      return {
        Icon: FilePenLineIcon,
        kind: "File change",
        ...filePreview(text || label, workspaceRoot),
      };
    case "dynamic_tool": {
      const input = item.input;
      const path =
        input && typeof input === "object" && "path" in input && typeof input.path === "string"
          ? input.path
          : undefined;
      if (path) return { Icon: WrenchIcon, kind: label, ...filePreview(path, workspaceRoot) };
      const preview = item.title || label;
      return {
        Icon: WrenchIcon,
        preview,
        kind: preview.toLowerCase() === label.toLowerCase() ? "Tool call" : label,
      };
    }
    default: {
      const preview = (text || item.title || label)
        .trimStart()
        .slice(0, 240)
        .replace(/^#{1,6}\s+/u, "")
        .replace(/\*\*([^*]+)\*\*/gu, "$1")
        .replace(/`([^`\n]+)`/gu, "$1");
      const message = item.type === "user_message" || item.type === "assistant_message";
      return {
        Icon: message ? MessageSquareIcon : TextIcon,
        preview,
        kind: preview.toLowerCase() === label.toLowerCase() ? null : label,
      };
    }
  }
}

type LedgerRow =
  | { kind: "turn"; key: string; group: string; title: string; folded: boolean }
  | { kind: "record"; key: string; record: TrajectoryRecord; step: string | null };

export default function TrajectoryPanel({
  threadRef,
  workspaceRoot,
}: {
  threadRef: ScopedThreadRef;
  workspaceRoot: string;
}) {
  const gt = useGT();
  const projection = useThreadProjection(threadRef)?.projection;
  const history = useThreadHistory(threadRef);
  const load = useAtomCommand(threadEnvironment.loadEarlierHistory, { reportFailure: false });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadingPage = useRef(false);
  const [query, setQuery] = useState("");
  const filter = useDeferredValue(query.trim().toLowerCase());
  const [selection, setSelection] = useState<string | null>(null);
  const [folds, setFolds] = useState<ReadonlySet<string>>(new Set());
  const [hideNested, setHideNested] = useState(false);
  const source = projection?.visibleTurnItems ?? [];
  const [firstKey, setFirstKey] = useState(() => source.at(-50)?.item.id ?? source[0]?.item.id);
  const offset = firstKey
    ? Math.max(
        0,
        source.findIndex((r) => r.item.id === firstKey),
      )
    : 0;
  const records = source.slice(offset).map(trajectoryRecord);
  const scrollOffset = useRef(0);
  const runs = new Map(projection?.runs.map((run) => [run.id, run.ordinal]));
  const steps = new Map(projection?.providerTurns.map((step) => [step.id, step]));
  const rows: LedgerRow[] = [];
  let previousTurn: string | undefined;
  let previousStep: string | null = null;
  const children = new Set(records.map((r) => r.row.item.parentItemId));
  const hidden = new Set<string>();
  const groups = new Set<string>();
  const foldedParents = new Set<string>();
  for (const record of records) {
    const { item } = record.row;
    if (item.parentItemId !== null && (hideNested || foldedParents.has(item.parentItemId))) {
      hidden.add(item.id);
      foldedParents.add(item.id);
    }
    if (folds.has(record.key)) foldedParents.add(item.id);
  }
  for (const record of records.toReversed()) {
    const { item } = record.row;
    const turn = JSON.stringify([record.row.sourceThreadId, item.runId]);
    const terms = `${record.label} ${item.status} ${item.title ?? ""} ${record.text}`;
    if (
      filter &&
      !terms.toLowerCase().includes(filter) &&
      !JSON.stringify(item).toLowerCase().includes(filter)
    )
      continue;
    const group = `turn:${turn}`;
    groups.add(group);
    if (turn !== previousTurn) {
      const ordinal = item.runId && runs.get(item.runId);
      const title = item.runId
        ? ordinal
          ? gt("Turn {number}", { number: ordinal })
          : `Turn · ${item.runId}`
        : gt("Between turns");
      rows.push({
        kind: "turn",
        key: group + record.key,
        group,
        title,
        folded: folds.has(group) && !filter,
      });
      previousTurn = turn;
      previousStep = null;
    }
    if (!filter && (folds.has(group) || hidden.has(item.id))) continue;
    const step = item.providerTurnId && steps.get(item.providerTurnId);
    rows.push({
      kind: "record",
      key: record.key,
      record,
      step: step && step.id !== previousStep ? gt("Step {number}", { number: step.ordinal }) : null,
    });
    previousStep = item.providerTurnId;
  }

  const toggleRecord = (key: string) => setSelection((current) => (current === key ? null : key));
  const toggle = (key: string) =>
    setFolds((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const hasOlder = offset > 0 || history.hasMoreHistory;
  const loadPage = async (workAnchorId?: string) => {
    if (loadingPage.current || history.loading) return;
    if (!workAnchorId && offset > 0) {
      setFirstKey(source[Math.max(0, offset - 50)]?.item.id);
      return;
    }
    loadingPage.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await load({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, ...(workAnchorId ? { workAnchorId } : {}) },
      });
      if (result._tag === "Failure" || result.value._tag === "error")
        setLoadError(gt("Could not load history. Try again."));
      else if (!workAnchorId && result.value._tag === "loaded") setFirstKey(undefined);
    } catch {
      setLoadError(gt("Could not load history. Try again."));
    }
    loadingPage.current = false;
    setLoading(false);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <Input
          aria-label={gt("Search trajectory")}
          placeholder={gt("Search records…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {groups.size > 0 && !filter && (
          <Button
            size="compact"
            variant="ghost"
            onClick={() => {
              const next = new Set(folds);
              const expand = Array.from(groups).every((group) => folds.has(group));
              for (const group of groups) {
                if (expand) next.delete(group);
                else next.add(group);
              }
              setFolds(next);
            }}
          >
            {Array.from(groups).every((group) => folds.has(group))
              ? gt("Expand all turns")
              : gt("Collapse all turns")}
          </Button>
        )}
        {!filter && (children.size > 1 || (children.size === 1 && !children.has(null))) && (
          <Button
            variant="ghost"
            size="compact"
            aria-pressed={hideNested}
            onClick={() => setHideNested(!hideNested)}
          >
            {hideNested ? gt("Show nested calls") : gt("Hide nested calls")}
          </Button>
        )}
        {(hasOlder || history.error) && (
          <Button
            variant="outline"
            size="micro"
            disabled={loading || history.loading}
            onClick={() => void loadPage()}
          >
            {loading || history.loading ? gt("Loading…") : gt("Load older records")}
          </Button>
        )}
        {(loadError || history.error) && (
          <span role="alert" className="text-xs text-destructive">
            {loadError ?? history.error}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {records.length ? gt("No matching records.") : gt("No records yet.")}
          </p>
        ) : (
          <LegendList<LedgerRow>
            data={rows}
            keyExtractor={(row) => row.key}
            extraData={selection}
            onScroll={({ nativeEvent }) => {
              const { contentOffset, layoutMeasurement, contentSize } = nativeEvent;
              const scrollingDown = contentOffset.y > scrollOffset.current;
              scrollOffset.current = contentOffset.y;
              const remaining = contentSize.height - contentOffset.y - layoutMeasurement.height;
              if (
                scrollingDown &&
                remaining <= layoutMeasurement.height / 2 &&
                hasOlder &&
                !loadError &&
                !history.error
              )
                void loadPage();
            }}
            maintainVisibleContentPosition={{
              data: true,
              size: true,
              shouldRestorePosition: () => scrollOffset.current > 1,
            }}
            className="h-full"
            estimatedItemSize={55}
            renderItem={({ item: row }) => {
              if (row.kind === "turn")
                return (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 border-y bg-muted/60 px-3 py-2 text-left text-xs font-semibold"
                    aria-expanded={!row.folded}
                    onClick={() => toggle(row.group)}
                  >
                    <ChevronRightIcon
                      aria-hidden
                      className={cn("size-3.5", !row.folded && "rotate-90")}
                    />{" "}
                    {row.title}
                  </button>
                );
              const r = row.record;
              const { item } = r.row;
              const { Icon, preview, kind, directory, code } = recordPresentation(r, workspaceRoot);
              const expanded = selection === r.key;
              return (
                <div className="border-b border-border/50 px-2 text-xs">
                  <div
                    className={cn(
                      "flex items-center gap-1",
                      item.parentItemId && "ml-3 border-l pl-2",
                    )}
                  >
                    {children.has(item.id) && (
                      <Button
                        variant="ghost"
                        size="icon-micro"
                        aria-label={gt("Toggle nested calls")}
                        aria-expanded={!folds.has(r.key)}
                        onClick={() => toggle(r.key)}
                      >
                        {folds.has(r.key) ? "▸" : "▾"}
                      </Button>
                    )}
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={`${r.label} ${item.status} ${preview.slice(0, 240)}`}
                      className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:outline-ring aria-expanded:bg-muted"
                      onClick={() => toggleRecord(r.key)}
                    >
                      <Icon
                        aria-hidden
                        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            "block truncate text-foreground",
                            code ? "font-mono text-xs" : "text-sm font-medium",
                          )}
                        >
                          {preview.slice(0, 240)}
                        </span>
                        <span className="flex items-center gap-2 text-2xs text-muted-foreground">
                          {kind && <span className="shrink-0 capitalize">{kind}</span>}
                          {directory && <span className="truncate">{directory}</span>}
                          {row.step && <span className="shrink-0">{row.step}</span>}
                          {item.status !== "completed" && (
                            <span
                              className={cn(
                                "shrink-0 font-semibold capitalize",
                                item.status === "failed"
                                  ? "text-destructive"
                                  : item.status === "running"
                                    ? "text-info"
                                    : "text-warning",
                              )}
                            >
                              {item.status}
                            </span>
                          )}
                        </span>
                      </span>
                      {r.start !== null && (
                        <time className="mt-0.5 shrink-0 text-2xs tabular-nums text-muted-foreground">
                          {clockLabel(r.start)}
                        </time>
                      )}
                      <ChevronRightIcon
                        aria-hidden
                        className={cn(
                          "mt-0.5 size-3.5 shrink-0 text-muted-foreground",
                          expanded && "rotate-90",
                        )}
                      />
                    </button>
                  </div>
                  {selection === r.key && (
                    <TrajectoryInspector
                      key={r.key}
                      record={r}
                      threadRef={threadRef}
                      workspaceRoot={workspaceRoot}
                      step={item.providerTurnId ? steps.get(item.providerTurnId) : undefined}
                    />
                  )}
                  {item.deferredWork && (
                    <Button
                      variant="link"
                      size="micro"
                      disabled={loading}
                      onClick={() => void loadPage(r.row.sourceItemId)}
                    >
                      {gt("Load grouped work")}
                    </Button>
                  )}
                </div>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
