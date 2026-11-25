import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { Fragment } from "react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import { resolveCacheHitPercentage } from "./ComposerStatusLine.logic";

/** One muted line under the composer: model, harness, effort, context, cache hits, and turns. */
export function ComposerStatusLine(props: {
  model: string | null;
  harness: string | null;
  effort: string | null;
  contextWindow: ContextWindowSnapshot | null;
  turns: number;
}) {
  const { contextWindow } = props;
  const cacheHit = resolveCacheHitPercentage(contextWindow);
  const context =
    contextWindow === null
      ? "ctx n/a"
      : contextWindow.maxTokens != null && contextWindow.usedPercentage !== null
        ? `ctx ${formatContextWindowTokens(contextWindow.maxTokens)} ${contextWindow.usedPercentage.toFixed(1)}%`
        : `ctx ${formatContextWindowTokens(contextWindow.usedTokens)} used`;
  const entries: ReadonlyArray<readonly [key: string, text: string | null]> = [
    ["model", props.model],
    ["harness", props.harness],
    ["effort", props.effort],
    ["context", context],
    ["cache", `cache hit ${cacheHit === null ? "n/a" : `${Math.round(cacheHit)}%`}`],
    ["turns", `${props.turns} ${props.turns === 1 ? "turn" : "turns"}`],
  ];
  const parts = entries.flatMap(([key, text]) => (text ? [[key, text] as const] : []));

  return (
    <div
      data-chat-composer-status-line="true"
      className="hidden min-w-0 items-center gap-2 overflow-hidden px-4 pt-1.5 font-mono text-2xs text-muted-foreground tabular-nums sm:flex"
    >
      {parts.map(([key, text], index) => (
        <Fragment key={key}>
          {index > 0 ? (
            <span aria-hidden="true" className="shrink-0 text-muted-foreground/40">
              ·
            </span>
          ) : null}
          <span className="min-w-0 truncate whitespace-nowrap">{text}</span>
        </Fragment>
      ))}
    </div>
  );
}
