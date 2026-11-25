import { expect } from "e2e";
import { test, WEB } from "./t3.ts";

test("Inspect a replayed turn in the trajectory", WEB, async ({ t3, screen, app }) => {
  await t3.project("demo");
  await t3.open();
  await screen.getByRole("textbox").fill("Trace this turn");
  await screen.getByRole("textbox").press("Enter");
  await expect(screen.getByText("This turn is a replay.", { exact: false })).toBeVisible();
  await screen.getByRole("button", "Toggle right panel").tap();
  await app.screenshot("surface-list");
  await screen.getByRole("button", /^Timeline\b/).tap();
  await expect(screen.getByRole("tab", "Task tree")).toBeVisible();
  await expect(screen.getByRole("tab", "Graph")).toBeHidden();
  await expect(screen.getByRole("tab", /Reports/)).toBeHidden();
  await app.screenshot("task-tree");
  await screen.getByRole("tab", "Trajectory").tap();
  const assistant = await screen
    .getByRole("button", /assistant message/i)
    .first()
    .boundingBox();
  const user = await screen.getByRole("button", /user message/i).boundingBox();
  expect(assistant && user && assistant.y < user.y).toBe(true);
  await screen.getByRole("textbox", "Search trajectory").fill("Trace this turn");
  await screen.getByRole("button", /user message/i).tap();
  await expect(screen.getByRole("region", "Record inspector")).toBeVisible();
  await screen.getByRole("button", "Raw record").tap();
  await expect(screen.getByText('"type": "user_message"', { exact: false })).toBeVisible();
  await screen.getByRole("button", /user message/i).tap();
  await expect(screen.getByRole("region", "Record inspector")).toBeHidden();
  await screen.getByRole("textbox", "Search trajectory").fill("vp test run");
  await screen.getByRole("button", /command execution completed.*vp test run/i).tap();
  await screen.getByRole("button", "Tool details").tap();
  await expect(
    screen.getByRole("region", "Record inspector").getByRole("button", "Copy code"),
  ).toBeVisible();
  await screen.getByRole("button", "Output").tap();
  await expect(screen.getByRole("region", "Record inspector").getByText(/12 passed/)).toBeVisible();
  await screen.getByRole("textbox", "Search trajectory").fill("");
  await screen.getByRole("button", /command execution completed.*vp test run/i).tap();
  await app.screenshot("trajectory");
  await screen.getByRole("textbox", "Search trajectory").fill("Check the live ledger");
  await expect(screen.getByText("No matching records.")).toBeVisible();
  const composer = screen.getByTestId("composer-editor");
  await composer.fill("Check the live ledger");
  await composer.press("Enter");
  await expect(screen.getByRole("button", /user message.*Check the live ledger/i)).toBeVisible();
});
