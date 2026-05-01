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
import { runPhase1, Phase1Error, Phase1Output } from "../phase1.js";
import { portkey } from "../../config/portkey.js";

const createMock = vi.mocked(portkey.chat.completions.create);

// ── shared fixtures — typed against production contracts ─────────────────────
const STUB_TICKET: Ticket = {
  subject: "Test",
  body: "Test body",
  customer: { id: "c1", email: "a@b.com" },
};

const VALID_AI_OUTPUT: Phase1Output = {
  category: "billing",
  priority: "high",
  sentiment: "negative",
  escalation_flag: false,
  routing_target: "billing-team",
  summary: "Double charge",
};

// ── helpers ──────────────────────────────────────────────────────────────────
type LLMResponse = {
  choices: Array<{
    message: {
      tool_calls?: Array<{ function: { name: string; arguments: string } }>;
    };
  }>;
};

function mockLLMResponse(args: object, toolName = "classify_ticket"): LLMResponse {
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

function expectWrappedPhase1Error(err: unknown, cause: unknown) {
  expect(err).toBeInstanceOf(Phase1Error);
  expect((err as Phase1Error).message).toBe("LLM call failed");
  expect((err as Phase1Error).cause).toBe(cause);
}

beforeEach(() => {
  vi.resetAllMocks(); // clears call history + implementations — prevents stale mock leakage
});

describe("Phase 1 — parses valid LLM output", () => {
  it("returns parsed Phase1Output for valid tool call response", async () => {
    mockResolve(mockLLMResponse(VALID_AI_OUTPUT));

    const result = await runPhase1(STUB_TICKET);

    expect(result).toMatchObject(VALID_AI_OUTPUT);
  });

  it("calls LLM with correct tool name, tool_choice, and AbortSignal", async () => {
    mockResolve(mockLLMResponse(VALID_AI_OUTPUT));

    await runPhase1(STUB_TICKET);

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({ name: "classify_ticket" }),
          }),
        ]),
        tool_choice: { type: "function", function: { name: "classify_ticket" } },
      }),
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("Phase 1 — network errors and retry", () => {
  beforeEach(() => vi.useFakeTimers()); // scoped to retry tests only
  afterEach(() => vi.useRealTimers());

  it("wraps error in Phase1Error with cause when all retries exhausted (503)", async () => {
    const networkErr = Object.assign(new Error("Network failure"), { status: 503 });
    createMock.mockRejectedValue(networkErr);

    const p = runPhase1(STUB_TICKET).catch((e) => e); // attach before timers fire
    await vi.advanceTimersByTimeAsync(1000); // covers max backoff: 200+400ms with jitter
    const err = await p;

    expectWrappedPhase1Error(err, networkErr);
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("retries on transient 429 and succeeds on next attempt", async () => {
    const rateLimitErr = Object.assign(new Error("Rate limited"), { status: 429 });
    createMock.mockRejectedValueOnce(rateLimitErr);
    mockResolveOnce(mockLLMResponse(VALID_AI_OUTPUT));

    const p = runPhase1(STUB_TICKET);
    await vi.advanceTimersByTimeAsync(300); // covers first backoff: max 200ms
    const result = await p;

    expect(result.category).toBe("billing");
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("wraps non-transient 400 in Phase1Error without retry", async () => {
    const clientErr = Object.assign(new Error("Bad request"), { status: 400 });
    createMock.mockRejectedValue(clientErr);

    const err = await runPhase1(STUB_TICKET).catch((e) => e);

    expectWrappedPhase1Error(err, clientErr);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("wraps AbortError in Phase1Error without retry (request timeout)", async () => {
    const abortErr = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    createMock.mockRejectedValue(abortErr);

    const err = await runPhase1(STUB_TICKET).catch((e) => e);

    expectWrappedPhase1Error(err, abortErr);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe("Phase 1 — rejects invalid AI responses", () => {
  it("throws Phase1Error when AI returns missing required fields", async () => {
    mockResolve(mockLLMResponse({ category: "billing" }));

    await expect(runPhase1(STUB_TICKET)).rejects.toThrow("Invalid tool call output");
  });

  it("throws Phase1Error when AI returns invalid enum value for priority", async () => {
    mockResolve(mockLLMResponse({ ...VALID_AI_OUTPUT, priority: "SUPER_URGENT" }));

    await expect(runPhase1(STUB_TICKET)).rejects.toThrow("Invalid tool call output");
  });

  it.each(["category", "routing_target", "summary"] as const)(
    "throws Phase1Error when %s is empty string (min(1))",
    async (field) => {
      mockResolve(mockLLMResponse({ ...VALID_AI_OUTPUT, [field]: "" }));

      await expect(runPhase1(STUB_TICKET)).rejects.toThrow("Invalid tool call output");
    },
  );

  it("throws Phase1Error when tool call has wrong function name", async () => {
    mockResolve(mockLLMResponse(VALID_AI_OUTPUT, "wrong_tool"));

    await expect(runPhase1(STUB_TICKET)).rejects.toThrow(
      "No tool call in Phase 1 response",
    );
  });

  it("throws Phase1Error when arguments is not valid JSON", async () => {
    mockResolve({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "classify_ticket", arguments: "not-json{{{" } },
            ],
          },
        },
      ],
    });

    await expect(runPhase1(STUB_TICKET)).rejects.toThrow("Invalid tool call output");
  });

  it("throws Phase1Error when AI returns no tool calls", async () => {
    mockResolve({ choices: [{ message: { tool_calls: [] } }] });

    await expect(runPhase1(STUB_TICKET)).rejects.toThrow(
      "No tool call in Phase 1 response",
    );
  });

  it("throws Phase1Error when AI returns empty choices", async () => {
    mockResolve({ choices: [] });

    await expect(runPhase1(STUB_TICKET)).rejects.toThrow(
      "Empty choices in LLM response",
    );
  });
});

describe("Phase 1 — rejects invalid input before LLM call", () => {
  it("throws ZodError when ticket body is missing", async () => {
    const err = await runPhase1({
      subject: "Test",
      customer: { id: "c1", email: "a@b.com" },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ZodError);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("throws ZodError when customer email is invalid", async () => {
    const err = await runPhase1({
      subject: "Test",
      body: "Body",
      customer: { id: "c1", email: "not-an-email" },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ZodError);
    expect(createMock).not.toHaveBeenCalled();
  });
});
