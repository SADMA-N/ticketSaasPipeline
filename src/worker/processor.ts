import { getTask, updateTask } from "../repositories/taskRepositories.js";
import { deleteMessage } from "./queue.js";
import { runPhase1 } from "./phase1.js";

const TERMINAL_STATES = [
  "completed",
  "completed_with_fallback",
  "needs_manual_review",
];

// Db theke task ene -> skip if invalid/duplicate -> task k processing e nei -> phase1 k phase2 kre -> retry count mng kre
export async function processJob(taskId: string, receiptHandle: string) {
  const task = await getTask(taskId);

  if (!task) {
    await deleteMessage(receiptHandle);
    return;
  }

  if (TERMINAL_STATES.includes(task.state)) {
    await deleteMessage(receiptHandle); // already done , then delete the msg from queue
    return;
  }

  await updateTask(taskId, {
    state: "processing",
    currentPhase: "phase_1",
    stateChangedAt: new Date(),
  });

  // Phase 1
  if (!task.phase1Done) {
    await updateTask(taskId, { phase1Retries: { increment: 1 } });
    const phase1Output = await runPhase1(task.inputTicket); // ticket -> AI -> structured JSON -> (retry safe)
    await updateTask(taskId, {
      phase1Output: phase1Output as object,
      phase1Done: true,
      currentPhase: "phase_2",
    });
  }

  // Phase 2 (Epic 4 AI call goes here)
  const freshTask = await getTask(taskId);
  if (freshTask && freshTask.phase1Done && !freshTask.phase2Done) {
    await updateTask(taskId, { phase2Retries: { increment: 1 } });
    // TODO: runPhase2(freshTask.inputTicket, freshTask.phase1Output)
  }
}
