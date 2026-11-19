import { ProjectId, type ThreadWorkspaceSwitchInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectService from "./ProjectService.ts";

class ThreadWorkspaceSwitchError extends Schema.TaggedError<ThreadWorkspaceSwitchError>()(
  "ThreadWorkspaceSwitchError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class ThreadWorkspaceSwitch extends Context.Service<
  ThreadWorkspaceSwitch,
  {
    readonly switchWorkspace: (
      input: ThreadWorkspaceSwitchInput,
    ) => Effect.Effect<{ readonly projectId: ProjectId }, ThreadWorkspaceSwitchError>;
  }
>()("t3/project/ThreadWorkspaceSwitch") {}

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const switchWorkspace = Effect.fn("ThreadWorkspaceSwitch.switchWorkspace")(
    function* (input: ThreadWorkspaceSwitchInput) {
      const newProjectId = ProjectId.make(`thread-workspace:${input.commandId}`);
      const move = (projectId: ProjectId, workspaceRoot: string, newProjectTitle?: string) =>
        threads
          .dispatch({
            type: "thread.project.switch",
            commandId: input.commandId,
            threadId: input.threadId,
            sourceProjectId: input.sourceProjectId,
            projectId,
            workspaceRoot,
            ...(newProjectTitle === undefined ? {} : { newProjectTitle }),
          })
          .pipe(
            Effect.flatMap(({ storedEvents, replayed }) => {
              const switched = storedEvents.find(
                ({ event }) => event.type === "thread.metadata-updated",
              );
              if (switched?.event.type !== "thread.metadata-updated") {
                return Effect.fail(
                  new ThreadWorkspaceSwitchError({
                    message: "The workspace switch did not record a destination.",
                  }),
                );
              }
              return (replayed ? Effect.void : scheduledTasks.notifyThreadMoved).pipe(
                Effect.as(switched.event.payload.projectId),
              );
            }),
            Effect.uninterruptible,
          );
      const target = yield* projectService.withWorkspaceLock(input.workspaceRoot, (workspaceRoot) =>
        Effect.gen(function* () {
          const scratchRoot = yield* managedFolders.scratchRoot;
          if (Option.isSome(scratchRoot)) {
            // Project paths preserve symlinks, so compare the folders they resolve to.
            const [sharedFolder, selectedFolder] = yield* Effect.forEach(
              [scratchRoot.value, workspaceRoot],
              (folder) => fileSystem.realPath(folder).pipe(Effect.orElseSucceed(() => folder)),
            );
            if (selectedFolder === sharedFolder) {
              return yield* new ThreadWorkspaceSwitchError({
                message: "Choose a project folder instead of the shared scratch folder.",
              });
            }
          }
          const found = yield* projectService.getByWorkspaceRoot(workspaceRoot);
          if (Option.isSome(found)) return { existing: found.value } as const;
          const projectId = yield* move(
            newProjectId,
            workspaceRoot,
            path.basename(workspaceRoot) || workspaceRoot,
          );
          yield* projectEnrichment.invalidate([workspaceRoot]);
          return { projectId } as const;
        }),
      );
      if ("projectId" in target) return { projectId: target.projectId };
      // Project deletion takes its project lock before acquiring any thread locks.
      const { id, workspaceRoot } = target.existing;
      const projectId = yield* projectService.withProjectLock(id, move(id, workspaceRoot));
      return { projectId };
    },
    Effect.mapError((cause) =>
      cause._tag === "ThreadWorkspaceSwitchError"
        ? cause
        : new ThreadWorkspaceSwitchError({
            message:
              cause._tag === "OrchestratorDispatchError" && typeof cause.cause === "string"
                ? cause.cause
                : cause.message,
            cause,
          }),
    ),
  );

  return ThreadWorkspaceSwitch.of({ switchWorkspace });
});

export const layer = Layer.effect(ThreadWorkspaceSwitch, make);
