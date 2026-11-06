import { expect, it } from "@effect/vitest";
import {
  MessageId,
  ProviderDriverKind,
  RunId,
  TextGenerationError,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ComposerPredictionGenerationInput } from "@t3tools/provider-core/server/textGeneration";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  v2Now,
  v2Projection,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ComposerPredictions from "./ComposerPredictions.ts";

const runId = RunId.make("run:completed");
const run: OrchestrationV2Run = {
  id: runId,
  threadId: v2Projection.thread.id,
  ordinal: 1,
  providerInstanceId: v2Projection.thread.modelSelection.instanceId,
  modelSelection: v2Projection.thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("user-message"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: v2Now,
  startedAt: v2Now,
  completedAt: v2Now,
  checkpointId: null,
  contextHandoffId: null,
};

function message(role: "user" | "assistant", text: string): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(role),
    threadId: run.threadId,
    runId,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: v2Now,
    updatedAt: v2Now,
  };
}

const makeHarness = (
  options: {
    readonly status?: OrchestrationV2Run["status"];
    readonly driver?: string;
    readonly fail?: boolean;
    readonly newerRun?: boolean;
    readonly streaming?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const calls: ComposerPredictionGenerationInput[] = [];
    const driver = ProviderDriverKind.make(options.driver ?? "codex");
    const adapter = yield* ProviderAdapter.ProviderAdapterV2.pipe(
      Effect.provide(
        Layer.mock(ProviderAdapter.ProviderAdapterV2)({
          instanceId: run.providerInstanceId,
          driver,
        }),
      ),
    );
    const unused = () => Effect.die("Unexpected provider operation");
    const instance: ProviderInstance = {
      instanceId: run.providerInstanceId,
      driverKind: driver,
      continuationIdentity: { driverKind: driver, continuationKey: "test" },
      displayName: undefined,
      enabled: true,
      orchestrationAdapter: adapter,
      snapshot: {
        getSnapshot: unused(),
        refresh: unused(),
        streamChanges: Stream.empty,
        resolveMaintenance: unused,
        applyUsageLimits: () => Effect.void,
      },
      textGeneration: {
        generateCommitMessage: unused,
        generatePrContent: unused,
        generateBranchName: unused,
        generateThreadTitle: unused,
        generateReviewGuide: unused,
        generateComposerPrediction: (input) =>
          Effect.suspend(() => {
            calls.push(input);
            return options.fail
              ? Effect.fail(
                  new TextGenerationError({
                    operation: "generateComposerPrediction",
                    detail: "offline",
                  }),
                )
              : Effect.succeed({ prediction: "具体例を見せて。" });
          }),
      },
    };
    const projection = {
      ...v2Projection,
      runs: [
        { ...run, status: options.status ?? run.status },
        ...(options.newerRun
          ? [{ ...run, id: RunId.make("run:new"), ordinal: 2, status: "running" as const }]
          : []),
      ],
      messages: [
        message("user", "仕組みを教えて。"),
        {
          ...message("assistant", "設定を読み込んで処理します。"),
          streaming: options.streaming ?? false,
        },
      ],
    };
    const service = yield* ComposerPredictions.ComposerPredictions.pipe(
      Effect.provide(
        ComposerPredictions.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadRecords: () => Effect.succeed(projection),
              }),
              Layer.mock(ProjectStore.ProjectStoreV2)({
                get: () =>
                  Effect.succeedSome({
                    projectId: v2Projection.thread.projectId,
                    title: "Project",
                    workspaceRoot: "/workspace/project",
                    defaultModelSelection: null,
                    defaultThreadEnvMode: null,
                    autoPull: false,
                    faviconPath: null,
                    projectIcon: null,
                    scripts: [],
                    pinnedAt: null,
                    archivedAt: null,
                    deletedAt: null,
                    createdAt: "2026-06-20T00:00:00Z",
                    updatedAt: "2026-06-20T00:00:00Z",
                  }),
              }),
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                getInstance: () => Effect.succeed(instance),
              }),
            ),
          ),
        ),
      ),
    );
    return { service, calls };
  });

it.effect(
  "uses the completed run's Codex instance and conversation without starting a chat turn",
  () =>
    Effect.gen(function* () {
      const { service, calls } = yield* makeHarness();
      expect(yield* service.generate({ threadId: run.threadId, runId })).toEqual({
        prediction: "具体例を見せて。",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        cwd: "/workspace/project",
        context: "user: 仕組みを教えて。\n\nassistant: 設定を読み込んで処理します。",
        modelSelection: {
          ...run.modelSelection,
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      });
    }),
);

it.effect.each([
  { status: "running" as const },
  { status: "failed" as const },
  { status: "interrupted" as const },
  { newerRun: true },
  { driver: "claudeAgent" },
  { streaming: true },
])("does not invoke a model for an unfinished, superseded, or non-Codex response: %j", (options) =>
  Effect.gen(function* () {
    const { service, calls } = yield* makeHarness(options);
    expect(yield* service.generate({ threadId: run.threadId, runId })).toEqual({
      prediction: null,
    });
    expect(calls).toEqual([]);
  }),
);

it.effect("returns no suggestion when prediction generation fails", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness({ fail: true });
    expect(yield* service.generate({ threadId: run.threadId, runId })).toEqual({
      prediction: null,
    });
  }),
);
