import { z } from "zod";
import { portkey } from "../config/portkey.js";
import { logger } from "../logger.js";
import { TicketSchema } from "../schemas/ticket.js";
import type { Ticket } from "../schemas/ticket.js";
import { Phase1OutputSchema } from "./phase1.js";
import type { Phase1Output } from "./phase1.js";

const DRAFT_TOOL = "generate_resolution";
const LLM_TIMEOUT_MS = 30_000;

// .describe() fields propagate into tool parameters via z.toJSONSchema — single source of truth
export const Phase2OutputSchema = z.object({
  response_draft: z
    .string()
    .trim()
    .min(1)
    .describe("Customer-facing response draft. Start with [DRAFT]."),
  internal_note: z
    .string()
    .trim()
    .min(1)
    .describe("Internal note for the support team."),
  next_actions: z
    .array(z.string().trim().min(1))
    .describe("Recommended next actions."),
});

export type Phase2Output = z.infer<typeof Phase2OutputSchema>;

// Phase2OutputSchema theke directly derive kora — schema change hole parameters auto update hobe
const { $schema: _$schema, ...DRAFT_TOOL_PARAMETERS } =
  z.toJSONSchema(Phase2OutputSchema);

// custom error — ES2022 standard Error.cause use kore
export class Phase2Error extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "Phase2Error";
  }
}

// ticket + triage -> AI -> structured JSON -> (retry safe)
async function callLLM(ticket: Ticket, triage: Phase1Output) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // calling LLM to generate resolution draft with retry logic
    try {
      return await portkey.chat.completions.create(
        {
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
                parameters: DRAFT_TOOL_PARAMETERS as Record<string, unknown>,
              },
            },
          ],
          tool_choice: { type: "function", function: { name: DRAFT_TOOL } },
        },
        undefined,
        { signal: AbortSignal.timeout(LLM_TIMEOUT_MS) },
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      const isTransient =
        status === 429 || (status !== undefined && status >= 500);
      // 429 - rate limit | 5xx - server error
      if (!isTransient || attempt === 3)
        throw err instanceof Phase2Error
          ? err
          : new Phase2Error("LLM call failed", err);
      logger.warn(
        { task: "phase2", attempt, status },
        "LLM transient error — retrying",
      );
      // jitter: randomized backoff to avoid synchronized retries across workers
      await new Promise((r) =>
        setTimeout(r, 200 * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5)),
      );
    }
  }
  // retry loop shesh — TypeScript k satisfy korte (never reach hobe na)
  throw new Phase2Error("LLM retry loop exhausted");
}

export async function runPhase2(
  inputTicket: unknown,
  phase1Output: unknown,
): Promise<Phase2Output> {
  const ticket = TicketSchema.parse(inputTicket);
  const triage = Phase1OutputSchema.parse(phase1Output);
  const response = await callLLM(ticket, triage);

  const choices = response.choices;
  if (!choices?.length) throw new Phase2Error("Empty choices in LLM response");

  const toolCall = choices[0].message.tool_calls?.[0];
  if (
    !toolCall ||
    !("function" in toolCall) ||
    toolCall.function.name !== DRAFT_TOOL ||
    typeof toolCall.function.arguments !== "string"
  )
    throw new Phase2Error("No tool call in Phase 2 response");

  try {
    return Phase2OutputSchema.parse(JSON.parse(toolCall.function.arguments));
  } catch (err) {
    throw new Phase2Error("Invalid tool call output", err);
  }
}
