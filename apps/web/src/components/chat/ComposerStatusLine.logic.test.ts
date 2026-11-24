import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { countUserTurns, resolveCacheHitPercentage } from "./ComposerStatusLine.logic";

const usage = (
  inputTokens: number | null,
  cachedInputTokens: number | null,
  lastInputTokens: number | null = null,
  lastCachedInputTokens: number | null = null,
) => ({ inputTokens, cachedInputTokens, lastInputTokens, lastCachedInputTokens });

describe("resolveCacheHitPercentage", () => {
  it.each([
    ["the latest request when reported", usage(1000, 100, 200, 150), 75],
    ["totals without a latest request", usage(1000, 250), 25],
    ["no input yet", usage(0, 0), null],
    ["no cache report", usage(1000, null), null],
  ] as const)("uses %s", (_, snapshot, expected) => {
    expect(resolveCacheHitPercentage(snapshot)).toBe(expected);
  });
});

describe("countUserTurns", () => {
  it("counts runs with a user message, so steering adds none", () => {
    const item = (type: string, runId: string | null) =>
      ({ item: { type, runId } }) as unknown as { item: ThreadStructureTurnItem };
    expect(
      countUserTurns([
        item("user_message", "run-1"),
        item("assistant_message", "run-1"),
        item("user_message", "run-1"),
        item("user_message", "run-2"),
        item("user_message", null),
      ]),
    ).toBe(2);
  });
});
