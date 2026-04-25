import { z } from "zod";

export const TicketSchema = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(10000),
  customer: z.object({
    id: z.string(),
    email: z.email(),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Ticket = z.infer<typeof TicketSchema>;
