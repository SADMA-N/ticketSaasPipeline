import { z } from "zod";
import { portkey } from "../config/portkey.js";
import { logger } from "../logger.js";
import { TicketSchema } from "../schemas/ticket.js";
import type { Ticket } from "../schemas/ticket.js";

const CLASSIFY_TOOL = "classify_ticket";
const LLM_TIMEOUT_MS = 30_000;

//defining Ai output
export const Phase1OutputSchema = z.object({
  category: z.string().trim().min(1),
  priority: z.enum(["low", "medium", "high", "critical"]),
  sentiment: z.enum(["positive", "neutral", "negative", "frustrated"]),
  escalation_flag: z.boolean(),
  routing_target: z.string().trim().min(1),
  summary: z.string().trim().min(1),
});

export type Phase1Output = z.infer<typeof Phase1OutputSchema>;

// Phase1OutputSchema theke directly derive kora — schema change hole parameters auto update hobe
const { $schema: _$schema, ...CLASSIFY_TOOL_PARAMETERS } =
  z.toJSONSchema(Phase1OutputSchema);

// custom error — ES2022 standard Error.cause use kore
export class Phase1Error extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "Phase1Error";
  }
}

// ticket -> AI -> structured JSON -> (retry safe)
async function callLLM(ticket: Ticket) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // calling LLM to classify the ticket with retry logic
    try {
      return await portkey.chat.completions.create(
        {
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
                parameters: CLASSIFY_TOOL_PARAMETERS as Record<string, unknown>,
              },
            },
          ],
          tool_choice: { type: "function", function: { name: CLASSIFY_TOOL } },
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
        throw err instanceof Phase1Error
          ? err
          : new Phase1Error("LLM call failed", err);
      logger.warn(
        { task: "phase1", attempt, status },
        "LLM transient error — retrying",
      );
      // jitter: randomized backoff to avoid synchronized retries across workers
      await new Promise((r) =>
        setTimeout(r, 200 * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5)),
      );
    }
  }
  // retry loop shesh — TypeScript k satisfy korte (never reach hobe na)
  throw new Phase1Error("LLM retry loop exhausted");
}

export async function runPhase1(inputTicket: unknown): Promise<Phase1Output> {
  const ticket = TicketSchema.parse(inputTicket);
  // Bad ticket = bad data from SQS. Let it throw ZodError -> propagates up -> processor increments retry -> eventually needs_manual_review. No reason to catch it here
  const response = await callLLM(ticket);

  const choices = response.choices;
  if (!choices?.length) throw new Phase1Error("Empty choices in LLM response");

  const toolCall = choices[0].message.tool_calls?.[0];
  if (
    !toolCall ||
    !("function" in toolCall) ||
    toolCall.function.name !== CLASSIFY_TOOL ||
    typeof toolCall.function.arguments !== "string"
  )
    throw new Phase1Error("No tool call in Phase 1 response");

  try {
    return Phase1OutputSchema.parse(JSON.parse(toolCall.function.arguments));
  } catch (err) {
    throw new Phase1Error("Invalid tool call output", err);
  }
}
