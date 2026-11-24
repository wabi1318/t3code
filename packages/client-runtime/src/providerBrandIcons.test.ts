import { describe, expect, it } from "vite-plus/test";
import { resolveProviderIconKind } from "./providerBrandIcons.ts";

describe("resolveProviderIconKind", () => {
  it.each([
    [undefined, "deepseek"],
    ['["deepseek-account","deepseek-flash"]', "deepseek"],
    ['["openai-codex","gpt-6-luna"]', "codex"],
    ['["openai","gpt-6-luna"]', "codex"],
    ['["anthropic","claude-haiku-4-5"]', "claudeAgent"],
    ['["xai","grok-4.3"]', "grok"],
    ['["grok-cli","grok-4.3"]', "grok"],
    ['["unknown","gpt-6-luna"]', "deepseek"],
    ['["openai",42]', "deepseek"],
    ['{"0":"openai","1":"gpt-6-luna"}', "deepseek"],
    ["gpt-6-luna", "deepseek"],
  ])("keeps harness branding separate from model %s", (model, expected) => {
    expect(
      resolveProviderIconKind({ driverKind: "acpRegistry", brandIcon: "deepseek", model }),
    ).toBe(expected);
  });

  it.each([
    ["pi", "openai-codex/gpt-6.1-sol", "codex"],
    ["pi", "openai/gpt-6-sol", "codex"],
    ["opencode", "anthropic/claude-haiku-4-5", "claudeAgent"],
    ["opencode", "openrouter/anthropic/claude-haiku-4-5", "claudeAgent"],
    ["opencode", "xai/grok-4.3", "grok"],
    ["opencode", "deepseek/deepseek-chat", "deepseek"],
    ["opencode", "opencode/big-pickle", "opencode"],
    ["pi", "gpt-6-luna", "pi"],
    ["pi", undefined, "pi"],
  ])("gives %s's model %s its vendor's icon", (driverKind, model, expected) => {
    expect(resolveProviderIconKind({ driverKind, model })).toBe(expected);
  });

  it("leaves other harnesses alone even with a matching model ID", () => {
    expect(resolveProviderIconKind({ driverKind: "acpRegistry", model: '["anthropic","x"]' })).toBe(
      "acpRegistry",
    );
    expect(resolveProviderIconKind({ driverKind: "cursor", model: "anthropic/x" })).toBe("cursor");
  });
});
