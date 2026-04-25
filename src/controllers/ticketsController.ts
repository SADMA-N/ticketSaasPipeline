import { Request, Response } from "express";
import { TicketSchema } from "../schemas/ticket";
import { createTask } from "../db/tasks";

export const submitTicket = async (req: Request, res: Response) => {
  // AC4 — validate input
  const { success, data: ticketData, error } = TicketSchema.safeParse(req.body);
  if (!success) {
    return res.status(400).json({
      error: "Validation failed",
      details: error.issues,
    });
  }

  // AC3 — persist before responding
  const task = await createTask(ticketData);

  // AC1 + AC2 — immediate 202
  return res.status(202).json({
    task_id: task.id,
    message: "Ticket received and is being processed.",
    state: task.state,
    status_url: `/tasks/${task.id}`,
  });
};
