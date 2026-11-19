import type { ProjectId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const moveThreadTasks = Effect.fn("ScheduledTasks.moveThreadTasks")(function* (input: {
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly projectId: ProjectId;
}) {
  if (input.threadIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ task_id: ScheduledTaskId }>`
    UPDATE scheduled_tasks SET project_id = ${input.projectId}
    WHERE project_id != ${input.projectId} AND thread_id IN ${sql.in(input.threadIds)}
    RETURNING task_id
  `;
});
