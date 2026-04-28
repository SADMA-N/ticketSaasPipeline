import { getTask, updateTask } from "../repositories/taskRepositories.js";
import { deleteDlqMessage } from "./queue.js";
import { workerEvents } from "./workerEvents.js";
import { emitSocketEvent } from "../socket/emitter.js";

export async function handleDlqMessage(taskId: string, receiptHandle: string) {
  const task = await getTask(taskId);

  if (!task) {
    await deleteDlqMessage(receiptHandle);
    return;
  }

  const newState = task.phase1Done
    ? "completed_with_fallback"
    : "needs_manual_review";

  await updateTask(taskId, {
    state: newState,
    currentPhase: null,
    stateChangedAt: new Date(),
    ...(newState === "completed_with_fallback" && {
      phase2Output: {
        response_draft: null,
        internal_note:
          "Automated resolution draft could not be generated. Manual review required.",
        next_actions: null,
      },
      fallbackReason: "Exceeded SQS delivery attempts",
      fallbackAt: new Date(),
    }),
  });
  emitSocketEvent(taskId, newState, { reason: "Exceeded SQS delivery attempts", duration_ms: Date.now() - task.createdAt.getTime() });
  workerEvents.emit("task_terminal", { taskId, state: newState });

  await deleteDlqMessage(receiptHandle);
}
