import { getTask, updateTask } from "../repositories/taskRepositories.js";
import { deleteDlqMessage } from "./queue.js";

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
  });

  await deleteDlqMessage(receiptHandle);
}
