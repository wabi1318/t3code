import type { ComposerPredictionInput, ComposerPredictionResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

const CONTEXT_RUN_LIMIT = 6;
const CONTEXT_CHARACTER_LIMIT = 16_000;
const PREDICTION_TIMEOUT = "30 seconds";
const NO_PREDICTION: ComposerPredictionResult = { prediction: null };

export class ComposerPredictions extends Context.Service<
  ComposerPredictions,
  { readonly generate: (input: ComposerPredictionInput) => Effect.Effect<ComposerPredictionResult> }
>()("t3/textGeneration/ComposerPredictions") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const generate = Effect.fn("ComposerPredictions.generate")(
    function* (input: ComposerPredictionInput) {
      const source = yield* projections.getThreadRecords(input.threadId, ["runs"]);
      const runs = source.runs.filter((run) => run.status !== "rolled_back");
      const latestRun = runs.reduce<(typeof runs)[number] | undefined>(
        (latest, run) => (!latest || run.ordinal > latest.ordinal ? run : latest),
        undefined,
      );
      if (
        source.thread.deletedAt !== null ||
        source.thread.archivedAt !== null ||
        latestRun?.id !== input.runId ||
        latestRun.status !== "completed" ||
        runs.some((run) =>
          ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
        )
      )
        return NO_PREDICTION;

      const instance = yield* providers.getInstance(latestRun.providerInstanceId);
      if (!instance?.enabled || instance.driverKind !== "codex") return NO_PREDICTION;
      const predict = instance.textGeneration.generateComposerPrediction;
      if (!predict) return NO_PREDICTION;
      const project = yield* projects.get(source.thread.projectId);
      if (Option.isNone(project)) return NO_PREDICTION;

      const recentRuns = runs
        .filter((run) => run.status === "completed")
        .sort((left, right) => left.ordinal - right.ordinal)
        .slice(-CONTEXT_RUN_LIMIT);
      const { messages } = yield* projections.getThreadRecords(input.threadId, ["messages"], {
        messageRoles: ["user", "assistant"],
        messageRunIds: recentRuns.map((run) => run.id),
      });
      if (
        !messages.some(
          (message) =>
            message.runId === input.runId &&
            message.role === "assistant" &&
            !message.streaming &&
            message.text.trim().length > 0,
        )
      )
        return NO_PREDICTION;
      const context = messages
        .filter((message) => !message.streaming && message.text.trim().length > 0)
        .map((message) => `${message.role}: ${message.text}`)
        .join("\n\n")
        .slice(-CONTEXT_CHARACTER_LIMIT);
      return yield* predict({
        cwd: source.thread.worktreePath ?? project.value.workspaceRoot,
        context,
        modelSelection: {
          ...latestRun.modelSelection,
          options: [
            ...(latestRun.modelSelection.options ?? []).filter(
              (option) => option.id !== "reasoningEffort",
            ),
            { id: "reasoningEffort", value: "low" },
          ],
        },
      });
    },
    Effect.timeout(PREDICTION_TIMEOUT),
    Effect.orElseSucceed(() => NO_PREDICTION),
  );

  return ComposerPredictions.of({ generate });
});

export const layer = Layer.effect(ComposerPredictions, make);
