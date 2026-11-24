import "~/index.css";
import { EMPTY_THREAD_HISTORY_META } from "@t3tools/client-runtime/state/thread-history-merge";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import TrajectoryPanel from "./TrajectoryPanel";

vi.mock(import("~/state/entities"), async (original) => {
  const { ENVIRONMENT_ID, projectionOf, threadWithHistory } =
    await import("../../../test/fakeEnvironment");
  const thread = {
    environmentId: ENVIRONMENT_ID,
    projection: projectionOf(threadWithHistory("long-thread", 40)),
  };
  return {
    ...(await original()),
    useThreadProjection: () => thread,
    useThreadHistory: () => EMPTY_THREAD_HISTORY_META,
  };
});

it("reveals older turns as the reader scrolls to the end", async () => {
  await using screen = await render(
    <div className="flex h-96 flex-col">
      <TrajectoryPanel
        threadRef={{
          environmentId: EnvironmentId.make("fixture"),
          threadId: ThreadId.make("long-thread"),
        }}
        workspaceRoot="/repo"
      />
    </div>,
  );
  const more = screen.getByRole("button", { name: "Load older records" });
  await expect.element(more).toBeVisible();
  const lastTurn = screen.getByRole("button", { name: /Turn 40$/ });
  await expect.element(lastTurn).toBeVisible();
  let viewport = lastTurn.element().parentElement;
  while (
    viewport &&
    !(
      viewport.clientHeight > 0 &&
      viewport.scrollHeight > viewport.clientHeight &&
      ["auto", "scroll"].includes(getComputedStyle(viewport).overflowY)
    )
  )
    viewport = viewport.parentElement;
  if (!viewport) throw new Error("Could not find the trajectory scroll viewport");
  viewport.scrollTop = viewport.scrollHeight;
  await expect.element(more).not.toBeInTheDocument();
  await screen.getByRole("textbox", { name: "Search trajectory" }).fill("long-thread: question 0");
  await expect
    .element(screen.getByRole("button", { name: /user message.*question 0/i }))
    .toBeVisible();
});
