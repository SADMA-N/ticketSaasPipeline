import { getTask, updateTask } from "../repositories/taskRepositories.js";
import { runPhase1 } from "./phase1.js";
import { runPhase2 } from "./phase2.js";
import { workerEvents } from "./workerEvents.js"; // Internal event bus — system er other parts k janano
import { emitSocketEvent } from "../socket/emitter.js";
import { logger } from "../logger.js";
import { TaskState } from "../../generated/prisma/enums.js";

const TERMINAL_STATES = new Set<TaskState>([
  TaskState.completed,
  TaskState.completed_with_fallback,
  TaskState.needs_manual_review,
]);

const MAX_PHASE_RETRIES = 3; // 3 baar fail korle AI ke diye hobena // manual review e pathano hoy.

const PHASE2_FALLBACK_OUTPUT = {
  response_draft: null,
  internal_note:
    "Automated resolution draft could not be generated. Manual review required.",
  next_actions: null,
};

// Db theke task ene -> skip if invalid/duplicate -> task k processing e nei -> phase1 k phase2 kre -> retry count mng kre
export async function processJob(taskId: string): Promise<void> {
  const task = await getTask(taskId);

  if (!task) {
    logger.warn({ task_id: taskId }, "Task not found — discarding message");
    return;
  }

  if (TERMINAL_STATES.has(task.state)) {
    return; // already done , then delete the msg from queue
  }

  await updateTask(taskId, {
    state: TaskState.processing,
    // phase1Done=true means resuming at phase 2 — persist the correct current phase
    currentPhase: task.phase1Done ? "phase_2" : "phase_1",
    stateChangedAt: new Date(),
  });
  emitSocketEvent(taskId, "started"); // socket diye client k jnano

  // Phase 1
  if (!task.phase1Done) {
    if (task.phase1Retries >= MAX_PHASE_RETRIES) {
      await updateTask(taskId, {
        state: TaskState.needs_manual_review,
        currentPhase: null,
        stateChangedAt: new Date(),
      });

      emitSocketEvent(taskId, "needs_manual_review", {
        reason: "Phase 1 retry limit exceeded",
        duration_ms: Date.now() - task.createdAt.getTime(),
      });

      workerEvents.emit("task_terminal", {
        taskId,
        state: TaskState.needs_manual_review,
      });

      return; // DB update -> socket event -> internal event -> return
    }

    if (task.phase1Retries > 0) {
      emitSocketEvent(taskId, "retry", {
        phase: "phase_1",
        attempt: task.phase1Retries + 1,
      });
    }

    emitSocketEvent(taskId, "phase_1_started");
    await updateTask(taskId, { phase1Retries: { increment: 1 } });
    const phase1Output = await runPhase1(task.inputTicket); // ticket -> AI -> structured JSON -> (retry safe)
    await updateTask(taskId, {
      phase1Output: phase1Output as object,
      phase1Done: true,
      currentPhase: "phase_2",
    });
    emitSocketEvent(taskId, "phase_1_complete");
  }

  //checking before phase 2 started
  const freshTask = await getTask(taskId);
  if (!freshTask) {
    logger.warn(
      { task_id: taskId },
      "Task vanished between phase 1 and phase 2",
    );
    return;
  }

  // Phase 2 (Epic 4 AI call goes here)
  if (freshTask.phase1Done && !freshTask.phase2Done) {
    if (freshTask.phase2Retries >= MAX_PHASE_RETRIES) {
      await updateTask(taskId, {
        state: TaskState.completed_with_fallback,
        currentPhase: null,
        stateChangedAt: new Date(),
        phase2Output: PHASE2_FALLBACK_OUTPUT,
        fallbackReason: "Phase 2 retry limit exceeded",
        fallbackAt: new Date(),
      });
      emitSocketEvent(taskId, "completed_with_fallback", {
        reason: "Phase 2 retry limit exceeded",
        duration_ms: Date.now() - freshTask.createdAt.getTime(),
      });
      workerEvents.emit("task_terminal", {
        taskId,
        state: TaskState.completed_with_fallback,
      });
      return;
    }
    if (freshTask.phase2Retries > 0) {
      emitSocketEvent(taskId, "retry", {
        phase: "phase_2",
        attempt: freshTask.phase2Retries + 1,
      });
    }
    emitSocketEvent(taskId, "phase_2_started");
    workerEvents.emit("phase_2_started", { taskId }); // Phase 1 done er pr pura system k janano
    await updateTask(taskId, { phase2Retries: { increment: 1 } });
    const phase2Output = await runPhase2(
      freshTask.inputTicket,
      freshTask.phase1Output,
    ); // // ticket -> AI -> structured JSON -> (retry safe)
    await updateTask(taskId, {
      phase2Output: phase2Output as object,
      phase2Done: true,
      state: TaskState.completed,
      currentPhase: null,
      stateChangedAt: new Date(),
    });
    emitSocketEvent(taskId, "phase_2_complete");
    emitSocketEvent(taskId, "completed", {
      duration_ms: Date.now() - freshTask.createdAt.getTime(),
    });
    workerEvents.emit("task_terminal", { taskId, state: TaskState.completed });
  }
}
