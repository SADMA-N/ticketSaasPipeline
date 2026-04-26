import { Request, Response } from "express";
import { submitTicket } from "../services/ticketService.js";
import { TicketSchema } from "../schemas/ticket.js";

export const submitTickets = async (req: Request, res: Response) => {
  // AC4 — validate input
  const { success, data: ticketData, error } = TicketSchema.safeParse(req.body);
  if (!success) {
    return res.status(400).json({
      error: "Validation failed",
      details: error.issues,
    });
  }

  // AC3 — persist before responding
  const taskData = await submitTicket(ticketData);

  // AC1 + AC2 — immediate 202
  return res.status(202).json(taskData);
};
