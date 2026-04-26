import { z } from "zod";
import { portkey } from "../config/portkey.js";
import type { Ticket } from "../schemas/ticket.js";

export const Phase1OutputSchema = z.object({
  category: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  sentiment: z.enum(["positive", "neutral", "negative", "frustrated"]),
  escalation_flag: z.boolean(),
  routing_target: z.string(),
  summary: z.string(),
});

export type Phase1Output = z.infer<typeof Phase1OutputSchema>;

export async function runPhase1(inputTicket: unknown): Promise<Phase1Output> {
  const ticket = inputTicket as Ticket;

  const response = await portkey.chat.completions.create({
    messages: [
      {
        role: "user",
        content: `Classify this support ticket:\n\nSubject: ${ticket.subject}\nBody: ${ticket.body}`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "classify_ticket",
          parameters: {
            type: "object",
            properties: {
              category: { type: "string" },
              priority: {
                type: "string",
                enum: ["low", "medium", "high", "critical"],
              },
              sentiment: {
                type: "string",
                enum: ["positive", "neutral", "negative", "frustrated"],
              },
              escalation_flag: { type: "boolean" },
              routing_target: { type: "string" },
              summary: { type: "string" },
            },
            required: [
              "category",
              "priority",
              "sentiment",
              "escalation_flag",
              "routing_target",
              "summary",
            ],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "classify_ticket" } },
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall || !("function" in toolCall))
    throw new Error("No tool call in Phase 1 response");

  return Phase1OutputSchema.parse(JSON.parse(toolCall.function.arguments));
}
