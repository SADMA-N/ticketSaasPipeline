import { z } from "zod";
import { portkey } from "../config/portkey.js";
import { TicketSchema } from "../schemas/ticket.js";
import type { Ticket } from "../schemas/ticket.js";
import { Phase1OutputSchema } from "./phase1.js";
import type { Phase1Output } from "./phase1.js";

const DRAFT_TOOL = "generate_resolution";

export const Phase2OutputSchema = z.object({
  response_draft: z.string(),
  internal_note: z.string(),
  next_actions: z.array(z.string()),
});

export type Phase2Output = z.infer<typeof Phase2OutputSchema>;

// custom error
export class Phase2Error extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "Phase2Error";
  }
}

// ticket + triage -> AI -> structured JSON -> (retry safe)
async function callLLM(ticket: Ticket, triage: Phase1Output) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // calling LLM to generate resolution draft with retry logic
    try {
      return await portkey.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "You are a support agent assistant. Generate resolution drafts based on ticket triage data.",
          },
          {
            role: "user",
            content: `Ticket:\nSubject: ${ticket.subject}\nBody: ${ticket.body}\n\nTriage:\nCategory: ${triage.category}\nPriority: ${triage.priority}\nSentiment: ${triage.sentiment}\nEscalation: ${triage.escalation_flag}\nRouting: ${triage.routing_target}\nSummary: ${triage.summary}`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: DRAFT_TOOL,
              parameters: {
                type: "object",
                properties: {
                  response_draft: {
                    type: "string",
                    description:
                      "Customer-facing response draft. Start with [DRAFT].",
                  },
                  internal_note: {
                    type: "string",
                    description: "Internal note for the support team.",
                  },
                  next_actions: {
                    type: "array",
                    items: { type: "string" },
                    description: "Recommended next actions.",
                  },
                },
                required: ["response_draft", "internal_note", "next_actions"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: DRAFT_TOOL } },
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      const isTransient =
        status === 429 || (status !== undefined && status >= 500);
      // 429 - rate limit | 5xx - server error
      if (!isTransient || attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1))); // 200 -> 400 -> 800 ms
    }
  }
}

export async function runPhase2(
  inputTicket: unknown,
  phase1Output: unknown,
): Promise<Phase2Output> {
  const ticket = TicketSchema.parse(inputTicket);
  const triage = Phase1OutputSchema.parse(phase1Output);
  const response = await callLLM(ticket, triage);

  const choices = response?.choices;
  if (!choices?.length) throw new Phase2Error("Empty choices in LLM response");

  const toolCall = choices[0].message.tool_calls?.[0];
  if (!toolCall || !("function" in toolCall))
    throw new Phase2Error("No tool call in Phase 2 response");

  try {
    return Phase2OutputSchema.parse(JSON.parse(toolCall.function.arguments));
  } catch (err) {
    throw new Phase2Error("Invalid tool call output", err);
  }
}
