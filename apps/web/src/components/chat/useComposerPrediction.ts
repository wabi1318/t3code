import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { generateComposerPrediction } from "../../state/composerPredictions";
import { useAtomCommand } from "../../state/use-atom-command";

export function useComposerPrediction(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly completedRunId: RunId | null;
  readonly enabled: boolean;
}) {
  const { environmentId, threadId, completedRunId, enabled } = input;
  const key = `${environmentId}:${threadId ?? ""}`;
  const observed = useRef({ key, runId: completedRunId });
  const [result, setResult] = useState<{ key: string; runId: RunId; text: string } | null>(null);
  if (result && (result.key !== key || result.runId !== completedRunId)) {
    setResult(null);
  }
  const generate = useAtomCommand(generateComposerPrediction, {
    reportFailure: false,
    reportDefect: false,
  });
  const request = useEffectEvent(generate);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests an external model once per newly completed run and retains its result while input temporarily hides it
  useEffect(() => {
    if (observed.current.key !== key) {
      observed.current = { key, runId: completedRunId };
      return;
    }
    if (completedRunId === null || observed.current.runId === completedRunId) return;
    if (!enabled || threadId === null) return;
    const observation = { key, runId: completedRunId };
    observed.current = observation;
    void request({ environmentId, input: { threadId, runId: completedRunId } }).then((response) => {
      if (
        observed.current === observation &&
        response._tag === "Success" &&
        response.value.prediction
      ) {
        setResult({ key, runId: completedRunId, text: response.value.prediction });
      }
    });
  }, [key, environmentId, threadId, completedRunId, enabled]);

  return {
    prediction:
      enabled && result?.key === key && result.runId === completedRunId ? result.text : null,
  };
}
