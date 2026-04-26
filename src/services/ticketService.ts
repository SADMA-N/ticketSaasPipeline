import { createTask } from "../repositories/taskRepositories.js";
import type { Ticket } from "../schemas/ticket.js";

export async function submitTicket(ticketData: Ticket) {
  const task = await createTask(ticketData);
  return {
    task_id: task.id,
    message: "Ticket received and is being processed.",
    state: task.state,
    status_url: `/tasks/${task.id}`,
  };
}
