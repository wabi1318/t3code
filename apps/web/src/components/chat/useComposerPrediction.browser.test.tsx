import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

type PredictionResult = AtomCommandResult<{ prediction: string | null }, unknown>;

const state = vi.hoisted(() => ({
  generate: vi.fn<() => Promise<PredictionResult>>(),
}));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => state.generate) as never,
}));

import { render } from "../../../test/render";
import { useComposerPrediction } from "./useComposerPrediction";

const environmentId = EnvironmentId.make("environment:prediction");
const threadId = ThreadId.make("thread:prediction");
const completedRunId = RunId.make("run:completed");

function Prediction(props: { enabled: boolean; completedRunId: RunId | null }) {
  const { prediction } = useComposerPrediction({ environmentId, threadId, ...props });
  return <output aria-label="Prediction">{prediction ?? "No prediction"}</output>;
}

it("shows a prediction when a newly completed run becomes eligible later", async () => {
  state.generate
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ prediction: "Show an example" }));
  await using screen = await render(<Prediction enabled={false} completedRunId={null} />);
  await screen.rerender(<Prediction enabled={false} completedRunId={completedRunId} />);
  await screen.rerender(<Prediction enabled completedRunId={completedRunId} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Show an example");
});

it("retries an interrupted prediction and ignores its stale response", async () => {
  state.generate.mockReset();
  let resolveInterrupted!: (result: PredictionResult) => void;
  const interrupted = new Promise<PredictionResult>((resolve) => {
    resolveInterrupted = resolve;
  });
  state.generate
    .mockReturnValueOnce(interrupted)
    .mockResolvedValue(AsyncResult.success({ prediction: "Current prediction" }));
  await using screen = await render(<Prediction enabled completedRunId={null} />);
  await screen.rerender(<Prediction enabled completedRunId={completedRunId} />);
  await vi.waitFor(() => expect(state.generate).toHaveBeenCalledOnce());
  await screen.rerender(<Prediction enabled={false} completedRunId={completedRunId} />);
  await screen.rerender(<Prediction enabled completedRunId={completedRunId} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Current prediction");
  resolveInterrupted(AsyncResult.success({ prediction: "Stale prediction" }));
  await interrupted;
  await expect.element(screen.getByRole("status")).toHaveTextContent("Current prediction");
});
