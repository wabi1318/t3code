import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";

/** Share of the latest request's input read from the prompt cache; adapters count cached input inside input. */
export function resolveCacheHitPercentage(
  usage: Pick<
    ContextWindowSnapshot,
    "inputTokens" | "cachedInputTokens" | "lastInputTokens" | "lastCachedInputTokens"
  > | null,
): number | null {
  if (usage === null) return null;
  const hasLast = usage.lastInputTokens != null && usage.lastCachedInputTokens != null;
  const input = hasLast ? usage.lastInputTokens : usage.inputTokens;
  const cached = hasLast ? usage.lastCachedInputTokens : usage.cachedInputTokens;
  if (input == null || cached == null || input <= 0) return null;
  return Math.min(100, (cached / input) * 100);
}

/** Turns the user started: steering messages join their run instead of adding one. */
export function countUserTurns(
  entries: ReadonlyArray<{ readonly item: ThreadStructureTurnItem }>,
): number {
  const runIds = new Set<string>();
  for (const { item } of entries) {
    if (item.type === "user_message" && item.runId !== null) runIds.add(item.runId);
  }
  return runIds.size;
}
