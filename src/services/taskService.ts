import type { Task } from "../../generated/prisma/client.js";
import { getTask } from "../repositories/taskRepositories.js";

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

export async function getTaskById(id: string) {
  const task = await getTask(id);
  if (!task) return null;

  return {
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
  };
}
