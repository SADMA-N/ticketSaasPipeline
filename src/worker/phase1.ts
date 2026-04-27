import { z } from "zod";
import { portkey } from "../config/portkey.js";
import { TicketSchema } from "../schemas/ticket.js";
import type { Ticket } from "../schemas/ticket.js";

const CLASSIFY_TOOL = "classify_ticket";

//defining Ai output
export const Phase1OutputSchema = z.object({
  category: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  sentiment: z.enum(["positive", "neutral", "negative", "frustrated"]),
  escalation_flag: z.boolean(),
  routing_target: z.string(),
  summary: z.string(),
});

export type Phase1Output = z.infer<typeof Phase1OutputSchema>;

// custom error
export class Phase1Error extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message); // par error message set krbo
    this.name = "Phase1Error";
  }
}

// ticket -> AI -> structured JSON -> (retry safe)
async function callLLM(ticket: Ticket) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // calling LLM to classify the ticket with retry logic
    try {
      return await portkey.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "You are a support ticket classifier. Analyze tickets and extract structured information accurately.",
          },
          {
            role: "user",
            content: `Classify this support ticket:\n\nSubject: ${ticket.subject}\nBody: ${ticket.body}`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: CLASSIFY_TOOL,
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
        tool_choice: { type: "function", function: { name: CLASSIFY_TOOL } },
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      const isTransient =
        status === 429 || (status !== undefined && status >= 500);
      // 429 - rate limit | 5xx - server error
      if (!isTransient || attempt === 3) throw err; // true -> false
      await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1))); // 200 -> 400 -> 800 ms
    }
  }
}

export async function runPhase1(inputTicket: unknown): Promise<Phase1Output> {
  const ticket = TicketSchema.parse(inputTicket);
  const response = await callLLM(ticket);

  const choices = response?.choices;
  if (!choices?.length) throw new Phase1Error("Empty choices in LLM response");

  const toolCall = choices[0].message.tool_calls?.[0];
  if (!toolCall || !("function" in toolCall))
    throw new Phase1Error("No tool call in Phase 1 response");

  try {
    return Phase1OutputSchema.parse(JSON.parse(toolCall.function.arguments));
  } catch (err) {
    throw new Phase1Error("Invalid tool call output", err);
  }
}
