import { Request, Response } from "express";
import type { Task } from "../../generated/prisma/client.js";
import { getTask } from "../db/tasks";
import { z } from "zod";

function buildOutputs(task: Task) {
  if (task.state === "pending") return null;
  if (task.state === "processing" && !task.phase1Done) return null;
  if (task.state === "needs_manual_review")
    return { phase_1: null, phase_2: null };

  if (task.phase1Done && !task.phase2Done) {
    return { phase_1: task.phase1Output, phase_2: null };
  }

  if (task.state === "completed") {
    return { phase_1: task.phase1Output, phase_2: task.phase2Output };
  }

  if (task.state === "completed_with_fallback") {
    return {
      phase_1: task.phase1Output,
      phase_2: {
        response_draft: null,
        internal_note:
          "Automated resolution draft could not be generated. Manual review required.",
        next_actions: null,
      },
    };
  }

  return null;
}
function buildFallbackInfo(task: Task) {
  if (!task.fallbackReason) return null;
  return {
    reason: task.fallbackReason,
    fallback_at: task.fallbackAt,
  };
}

const ParamsSchema = z.object({
  taskId: z.uuid(),
});

export const getTaskStatus = async (req: Request, res: Response) => {
  const result = ParamsSchema.safeParse(req.params);
  // console.log("hello");

  if (!result.success) {
    return res.status(400).json({
      error: "Invalid task ID",
      details: result.error.issues,
    });
  }

  const task = await getTask(result.data.taskId);

  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  return res.status(200).json({
    task_id: task.id,
    state: task.state,
    current_phase: task.currentPhase,
    retry_count: {
      phase_1: task.phase1Retries,
      phase_2: task.phase2Retries,
    },
    created_at: task.createdAt,
    state_changed_at: task.stateChangedAt,
    last_mutated_at: task.lastMutatedAt,
    outputs: buildOutputs(task),
    input_ticket:
      task.state === "needs_manual_review" ? task.inputTicket : null,
    fallback_info: buildFallbackInfo(task),
  });
};
