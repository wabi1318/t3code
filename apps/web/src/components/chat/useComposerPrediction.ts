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
  if (result && (!enabled || result.key !== key || result.runId !== completedRunId)) {
    setResult(null);
  }
  const generate = useAtomCommand(generateComposerPrediction, {
    reportFailure: false,
    reportDefect: false,
  });
  const request = useEffectEvent(generate);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests an external model once for a newly completed run and rejects results after navigation or input
  useEffect(() => {
    if (observed.current.key !== key) {
      observed.current = { key, runId: completedRunId };
      return;
    }
    if (completedRunId === null || observed.current.runId === completedRunId) return;
    observed.current.runId = completedRunId;
    if (!enabled || threadId === null) return;
    let current = true;
    void request({ environmentId, input: { threadId, runId: completedRunId } }).then((response) => {
      if (current && response._tag === "Success" && response.value.prediction) {
        setResult({ key, runId: completedRunId, text: response.value.prediction });
      }
    });
    return () => {
      current = false;
    };
  }, [key, environmentId, threadId, completedRunId, enabled]);

  return {
    prediction:
      enabled && result?.key === key && result.runId === completedRunId ? result.text : null,
    dismiss: () => setResult(null),
  };
}
