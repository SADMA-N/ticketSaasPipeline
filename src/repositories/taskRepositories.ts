import { prisma } from "../lib/prisma.js";
import { Ticket } from "../schemas/ticket.js";

export async function createTask(inputTicket: Ticket) {
  return prisma.task.create({
    data: { inputTicket: inputTicket as object },
  });
}

export async function deleteTask(id: string) {
  return prisma.task.delete({
    where: { id },
  });
}

export async function getTask(id: string) {
  return prisma.task.findUnique({
    where: { id },
  });
}
