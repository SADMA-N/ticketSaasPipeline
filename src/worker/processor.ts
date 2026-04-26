import { getTask, updateTask } from "../repositories/taskRepositories.js";
import { deleteMessage } from "./queue.js";

const TERMINAL_STATES = [
  "completed",
  "completed_with_fallback",
  "needs_manual_review",
];

export async function processJob(taskId: string, receiptHandle: string) {
  const task = await getTask(taskId);

  if (!task) {
    await deleteMessage(receiptHandle);
    return;
  }

  if (TERMINAL_STATES.includes(task.state)) {
    await deleteMessage(receiptHandle);
    return;
  }

  await updateTask(taskId, {
    state: "processing",
    currentPhase: "phase_1",
    stateChangedAt: new Date(),
  });

  // Phase 1 (Epic 3 AI call goes here)
  if (!task.phase1Done) {
    await updateTask(taskId, { phase1Retries: { increment: 1 } });
    // TODO: runPhase1(task.inputTicket)
  }

  // Phase 2 (Epic 4 AI call goes here)
  const freshTask = await getTask(taskId);
  if (freshTask && freshTask.phase1Done && !freshTask.phase2Done) {
    await updateTask(taskId, { phase2Retries: { increment: 1 } });
    // TODO: runPhase2(freshTask.inputTicket, freshTask.phase1Output)
  }
}
