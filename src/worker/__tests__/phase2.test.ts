import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ZodError } from "zod";
import type { Ticket } from "../../schemas/ticket.js";

// ── mock all external dependencies ───────────────────────────────────────────
vi.mock("../../config/portkey.js", () => ({
  portkey: { chat: { completions: { create: vi.fn() } } },
}));

vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// ── imports after mocks ──────────────────────────────────────────────────────
import { runPhase2, Phase2Error, Phase2Output } from "../phase2.js";
import type { Phase1Output } from "../phase1.js";
import { portkey } from "../../config/portkey.js";

const createMock = vi.mocked(portkey.chat.completions.create);

// ── shared fixtures — typed against production contracts ─────────────────────
const STUB_TICKET: Ticket = {
  subject: "Test",
  body: "Test body",
  customer: { id: "c1", email: "a@b.com" },
};

const STUB_TRIAGE: Phase1Output = {
  category: "billing",
  priority: "high",
  sentiment: "negative",
  escalation_flag: false,
  routing_target: "billing-team",
  summary: "Customer was charged twice for the same subscription.",
};

const VALID_AI_OUTPUT: Phase2Output = {
  response_draft: "[DRAFT] Refund initiated.",
  internal_note: "Refund processed.",
  next_actions: ["issue_refund"],
};

// ── helpers ──────────────────────────────────────────────────────────────────
type LLMResponse = {
  choices: Array<{
    message: {
      tool_calls?: Array<{ function: { name: string; arguments: string } }>;
    };
  }>;
};

function mockLLMResponse(args: object, toolName = "generate_resolution"): LLMResponse {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            { function: { name: toolName, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

function mockResolve(value: LLMResponse) {
  createMock.mockResolvedValue(value as never);
}

function mockResolveOnce(value: LLMResponse) {
  createMock.mockResolvedValueOnce(value as never);
}

function expectWrappedPhase2Error(err: unknown, cause: unknown) {
  expect(err).toBeInstanceOf(Phase2Error);
  expect((err as Phase2Error).message).toBe("LLM call failed");
  expect((err as Phase2Error).cause).toBe(cause);
}

beforeEach(() => {
  vi.resetAllMocks(); // clears call history + implementations — prevents stale mock leakage
});

describe("Phase 2 — parses valid LLM output", () => {
  it("returns parsed Phase2Output for valid tool call response", async () => {
    mockResolve(mockLLMResponse(VALID_AI_OUTPUT));

    const result = await runPhase2(STUB_TICKET, STUB_TRIAGE);

    expect(result).toMatchObject(VALID_AI_OUTPUT);
  });

  it("calls LLM with correct tool name, tool_choice, and AbortSignal", async () => {
    mockResolve(mockLLMResponse(VALID_AI_OUTPUT));

    await runPhase2(STUB_TICKET, STUB_TRIAGE);

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({ name: "generate_resolution" }),
          }),
        ]),
        tool_choice: {
          type: "function",
          function: { name: "generate_resolution" },
        },
      }),
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("Phase 2 — network errors and retry", () => {
  beforeEach(() => vi.useFakeTimers()); // scoped to retry tests only
  afterEach(() => vi.useRealTimers());

  it("wraps error in Phase2Error with cause when all retries exhausted (503)", async () => {
    const networkErr = Object.assign(new Error("Network failure"), { status: 503 });
    createMock.mockRejectedValue(networkErr);

    const p = runPhase2(STUB_TICKET, STUB_TRIAGE).catch((e) => e); // attach before timers fire
    await vi.advanceTimersByTimeAsync(1000); // covers max backoff: 200+400ms with jitter
    const err = await p;

    expectWrappedPhase2Error(err, networkErr);
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("retries on transient 429 and succeeds on next attempt", async () => {
    const rateLimitErr = Object.assign(new Error("Rate limited"), { status: 429 });
    createMock.mockRejectedValueOnce(rateLimitErr);
    mockResolveOnce(mockLLMResponse(VALID_AI_OUTPUT));

    const p = runPhase2(STUB_TICKET, STUB_TRIAGE);
    await vi.advanceTimersByTimeAsync(300); // covers first backoff: max 200ms
    const result = await p;

    expect(result.response_draft).toContain("[DRAFT]");
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("wraps non-transient 400 in Phase2Error without retry", async () => {
    const clientErr = Object.assign(new Error("Bad request"), { status: 400 });
    createMock.mockRejectedValue(clientErr);

    const err = await runPhase2(STUB_TICKET, STUB_TRIAGE).catch((e) => e);

    expectWrappedPhase2Error(err, clientErr);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("wraps AbortError in Phase2Error without retry (request timeout)", async () => {
    const abortErr = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    createMock.mockRejectedValue(abortErr);

    const err = await runPhase2(STUB_TICKET, STUB_TRIAGE).catch((e) => e);

    expectWrappedPhase2Error(err, abortErr);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe("Phase 2 — rejects invalid AI responses", () => {
  it("throws Phase2Error when AI returns missing required fields", async () => {
    mockResolve(mockLLMResponse({ response_draft: "[DRAFT] Some draft" }));

    await expect(runPhase2(STUB_TICKET, STUB_TRIAGE)).rejects.toThrow(
      "Invalid tool call output",
    );
  });

  it("throws Phase2Error when next_actions is not an array", async () => {
    mockResolve(
      mockLLMResponse({
        ...VALID_AI_OUTPUT,
        next_actions: "do this then that",
      }),
    );

    await expect(runPhase2(STUB_TICKET, STUB_TRIAGE)).rejects.toThrow(
      "Invalid tool call output",
    );
  });

  it.each(["response_draft", "internal_note"] as const)(
    "throws Phase2Error when %s is empty string (min(1))",
    async (field) => {
      mockResolve(mockLLMResponse({ ...VALID_AI_OUTPUT, [field]: "" }));

      await expect(runPhase2(STUB_TICKET, STUB_TRIAGE)).rejects.toThrow(
        "Invalid tool call output",
      );
    },
  );

  it("throws Phase2Error when next_actions contains empty string (min(1))", async () => {
    mockResolve(mockLLMResponse({ ...VALID_AI_OUTPUT, next_actions: [""] }));

    await expect(runPhase2(STUB_TICKET, STUB_TRIAGE)).rejects.toThrow(
      "Invalid tool call output",
    );
  });

  it("throws Phase2Error when tool call has wrong function name", async () => {
    mockResolve(mockLLMResponse(VALID_AI_OUTPUT, "wrong_tool"));

    await expect(runPhase2(STUB_TICKET, STUB_TRIAGE)).rejects.toThrow(
      "No tool call in Phase 2 response",
    );
  });

  it("throws Phase2Error when arguments is not valid JSON", async () => {
    mockResolve({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "generate_resolution", arguments: "not-json{{{" } },
            ],
          },
        },
      ],
    });

    await expect(runPhase2(STUB_TICKET, STUB_TRIAGE)).rejects.toThrow(
      "Invalid tool call output",
    );
  });

  it("throws Phase2Error when AI returns no tool calls", async () => {
    mockResolve({ choices: [{ message: { tool_calls: [] } }] });

    await expect(runPhase2(STUB_TICKET, STUB_TRIAGE)).rejects.toThrow(
      "No tool call in Phase 2 response",
    );
  });

  it("throws Phase2Error when AI returns empty choices", async () => {
    mockResolve({ choices: [] });

    await expect(runPhase2(STUB_TICKET, STUB_TRIAGE)).rejects.toThrow(
      "Empty choices in LLM response",
    );
  });
});

describe("Phase 2 — rejects invalid input before LLM call", () => {
  it("throws ZodError when input ticket body is missing", async () => {
    const err = await runPhase2(
      { subject: "Test", customer: { id: "c1", email: "a@b.com" } },
      STUB_TRIAGE,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ZodError);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("throws ZodError when phase1Output is missing required fields", async () => {
    const err = await runPhase2(STUB_TICKET, { category: "billing" }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(ZodError);
    expect(createMock).not.toHaveBeenCalled();
  });
});
