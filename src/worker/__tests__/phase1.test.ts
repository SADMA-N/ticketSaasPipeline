import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/portkey.js", () => ({
  portkey: {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  },
}));

import { runPhase1, Phase1OutputSchema } from "../phase1.js";
import { portkey } from "../../config/portkey.js";

// ── helper: build a fake portkey response with given tool call args ──────────
function mockLLMResponse(args: object) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: "classify_ticket",
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe("Phase 1 — representative ticket samples", () => {
  it("billing issue ticket → correct category, high priority, negative sentiment", async () => {
    const aiOutput = {
      category: "billing",
      priority: "high",
      sentiment: "negative",
      escalation_flag: false,
      routing_target: "billing-team",
      summary: "Customer was charged twice for the same subscription.",
    };

    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockLLMResponse(aiOutput),
    );

    const result = await runPhase1({
      subject: "Charged twice this month",
      body: "I see two charges of $49 on my card for the same subscription. Please refund.",
      customer: { id: "cust_001", email: "user@example.com" },
    });

    expect(result).toMatchObject({
      category: "billing",
      priority: "high",
      sentiment: "negative",
      escalation_flag: false,
      routing_target: "billing-team",
      summary: expect.any(String),
    });

    // validate full schema
    expect(() => Phase1OutputSchema.parse(result)).not.toThrow();
  });

  it("urgent outage ticket → critical priority, escalation flag true", async () => {
    const aiOutput = {
      category: "technical",
      priority: "critical",
      sentiment: "frustrated",
      escalation_flag: true,
      routing_target: "engineering",
      summary: "Customer's entire team cannot access the platform.",
    };

    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockLLMResponse(aiOutput),
    );

    const result = await runPhase1({
      subject: "Production down — urgent",
      body: "Our entire team is locked out since 9am. We are losing revenue every minute. URGENT.",
      customer: { id: "cust_002", email: "cto@company.com" },
    });

    expect(result.priority).toBe("critical");
    expect(result.escalation_flag).toBe(true);
    expect(result.routing_target).toBe("engineering");
    expect(() => Phase1OutputSchema.parse(result)).not.toThrow();
  });

  it("general inquiry ticket → low priority, positive sentiment, no escalation", async () => {
    const aiOutput = {
      category: "inquiry",
      priority: "low",
      sentiment: "positive",
      escalation_flag: false,
      routing_target: "support",
      summary: "Customer asking about available pricing plans.",
    };

    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockLLMResponse(aiOutput),
    );

    const result = await runPhase1({
      subject: "Pricing plans question",
      body: "Hi! I love the product. Just wanted to know if you have an annual plan with a discount?",
      customer: { id: "cust_003", email: "happy@user.com" },
    });

    expect(result.priority).toBe("low");
    expect(result.escalation_flag).toBe(false);
    expect(result.sentiment).toBe("positive");
    expect(() => Phase1OutputSchema.parse(result)).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("Phase 1 — invalid AI responses caught", () => {
  it("throws Phase1Error when AI returns missing required fields", async () => {
    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockLLMResponse({
        category: "billing",
        // missing priority, sentiment, escalation_flag, routing_target, summary
      }),
    );

    await expect(
      runPhase1({
        subject: "Test",
        body: "Test body",
        customer: { id: "c1", email: "a@b.com" },
      }),
    ).rejects.toThrow("Invalid tool call output");
  });

  it("throws Phase1Error when AI returns invalid enum value for priority", async () => {
    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockLLMResponse({
        category: "billing",
        priority: "SUPER_URGENT", // not in enum
        sentiment: "negative",
        escalation_flag: false,
        routing_target: "billing-team",
        summary: "Test summary",
      }),
    );

    await expect(
      runPhase1({
        subject: "Test",
        body: "Test body",
        customer: { id: "c1", email: "a@b.com" },
      }),
    ).rejects.toThrow("Invalid tool call output");
  });

  it("throws Phase1Error when AI returns no tool call", async () => {
    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      choices: [{ message: { tool_calls: [] } }],
    });

    await expect(
      runPhase1({
        subject: "Test",
        body: "Test body",
        customer: { id: "c1", email: "a@b.com" },
      }),
    ).rejects.toThrow("No tool call in Phase 1 response");
  });

  it("throws Phase1Error when AI returns empty choices", async () => {
    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      choices: [],
    });

    await expect(
      runPhase1({
        subject: "Test",
        body: "Test body",
        customer: { id: "c1", email: "a@b.com" },
      }),
    ).rejects.toThrow("Empty choices in LLM response");
  });
});
