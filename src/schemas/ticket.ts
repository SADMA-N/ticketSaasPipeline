import { z } from "zod";

export const TicketSchema = z.object({
  subject: z.string().trim().min(1, "Subject required").max(500),
  body: z.string().trim().min(1, "Body required").max(10_000),
  customer: z.object({
    id: z.string().trim().min(1, "Customer ID required"),
    email: z.email("Invalid customer email"),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Ticket = z.infer<typeof TicketSchema>;
