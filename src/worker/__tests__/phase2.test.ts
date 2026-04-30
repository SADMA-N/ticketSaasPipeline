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

import { runPhase2, Phase2OutputSchema } from "../phase2.js";
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
                name: "generate_resolution",
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

// ── representative Phase 1 outputs ──────────────────────────────────────────
const billingTriage = {
  category: "billing",
  priority: "high",
  sentiment: "negative",
  escalation_flag: false,
  routing_target: "billing-team",
  summary: "Customer was charged twice for the same subscription.",
};

const outageTriage = {
  category: "technical",
  priority: "critical",
  sentiment: "frustrated",
  escalation_flag: true,
  routing_target: "engineering",
  summary: "Customer's entire team cannot access the platform.",
};

const inquiryTriage = {
  category: "inquiry",
  priority: "low",
  sentiment: "positive",
  escalation_flag: false,
  routing_target: "support",
  summary: "Customer asking about available pricing plans.",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe("Phase 2 — representative ticket + Phase 1 output pairs", () => {
  it("billing issue → response draft, internal note, next actions all present", async () => {
    const aiOutput = {
      response_draft:
        "[DRAFT] We sincerely apologise for the duplicate charge. A full refund of $49 has been initiated and will appear within 3-5 business days.",
      internal_note:
        "Customer double-charged due to billing system glitch on renewal. Refund processed. Monitor for recurrence.",
      next_actions: ["issue_refund", "audit_billing_logs", "send_confirmation_email"],
    };

    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockLLMResponse(aiOutput),
    );

    const result = await runPhase2(
      {
        subject: "Charged twice this month",
        body: "I see two charges of $49 on my card for the same subscription.",
        customer: { id: "cust_001", email: "user@example.com" },
      },
      billingTriage,
    );

    expect(result.response_draft).toContain("[DRAFT]");
    expect(result.internal_note).toBeTruthy();
    expect(result.next_actions).toBeInstanceOf(Array);
    expect(result.next_actions.length).toBeGreaterThan(0);
    expect(() => Phase2OutputSchema.parse(result)).not.toThrow();
  });

  it("critical outage → escalation context reflected in draft and actions", async () => {
    const aiOutput = {
      response_draft:
        "[DRAFT] We are aware of the access issue affecting your team and our engineering team is actively investigating. We will provide an update within 30 minutes.",
      internal_note:
        "Critical outage — escalation flag is true. Engineering has been paged. SLA breach risk.",
      next_actions: ["page_engineering", "open_incident", "update_status_page", "follow_up_in_30min"],
    };

    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockLLMResponse(aiOutput),
    );

    const result = await runPhase2(
      {
        subject: "Production down — urgent",
        body: "Our entire team is locked out since 9am. We are losing revenue every minute.",
        customer: { id: "cust_002", email: "cto@company.com" },
      },
      outageTriage,
    );

    expect(result.next_actions.length).toBeGreaterThan(0);
    expect(result.internal_note).toBeTruthy();
    expect(() => Phase2OutputSchema.parse(result)).not.toThrow();
  });

  it("general inquiry → friendly draft with pricing info, low urgency actions", async () => {
    const aiOutput = {
      response_draft:
        "[DRAFT] Thank you for your kind words! Yes, we do offer an annual plan with a 20% discount. You can upgrade anytime from your account settings.",
      internal_note:
        "Low priority inquiry. Customer is satisfied. No action needed beyond standard response.",
      next_actions: ["send_pricing_link", "log_interest_in_annual_plan"],
    };

    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockLLMResponse(aiOutput),
    );

    const result = await runPhase2(
      {
        subject: "Pricing plans question",
        body: "Hi! I love the product. Just wanted to know if you have an annual plan?",
        customer: { id: "cust_003", email: "happy@user.com" },
      },
      inquiryTriage,
    );

    expect(result.response_draft).toContain("[DRAFT]");
    expect(result.next_actions).toBeInstanceOf(Array);
    expect(() => Phase2OutputSchema.parse(result)).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("Phase 2 — network errors", () => {
  it("passes through network error when all retries exhausted", async () => {
    const networkErr = Object.assign(new Error("Network failure"), { status: 503 });

    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockRejectedValue(networkErr);

    await expect(
      runPhase2(
        { subject: "Test", body: "Test body", customer: { id: "c1", email: "a@b.com" } },
        billingTriage,
      ),
    ).rejects.toThrow("Network failure");
  });

  it("retries on transient 429 and succeeds on next attempt", async () => {
    const rateLimitErr = Object.assign(new Error("Rate limited"), { status: 429 });
    const aiOutput = {
      response_draft: "[DRAFT] Refund initiated.",
      internal_note: "Refund processed.",
      next_actions: ["issue_refund"],
    };

    (portkey.chat.completions.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce(mockLLMResponse(aiOutput));

    const result = await runPhase2(
      { subject: "Test", body: "Test body", customer: { id: "c1", email: "a@b.com" } },
      billingTriage,
    );

    expect(result.response_draft).toContain("[DRAFT]");
    expect(portkey.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-transient 400 error", async () => {
    const clientErr = Object.assign(new Error("Bad request"), { status: 400 });

    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockRejectedValue(clientErr);

    await expect(
      runPhase2(
        { subject: "Test", body: "Test body", customer: { id: "c1", email: "a@b.com" } },
        billingTriage,
      ),
    ).rejects.toThrow("Bad request");

    expect(portkey.chat.completions.create).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("Phase 2 — invalid AI responses caught", () => {
  it("throws Phase2Error when AI returns missing required fields", async () => {
    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockLLMResponse({
        response_draft: "Some draft",
        // missing internal_note and next_actions
      }),
    );

    await expect(
      runPhase2(
        { subject: "Test", body: "Test body", customer: { id: "c1", email: "a@b.com" } },
        billingTriage,
      ),
    ).rejects.toThrow("Invalid tool call output");
  });

  it("throws Phase2Error when next_actions is not an array", async () => {
    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockLLMResponse({
        response_draft: "[DRAFT] Some response",
        internal_note: "Some note",
        next_actions: "do this then that", // string instead of array
      }),
    );

    await expect(
      runPhase2(
        { subject: "Test", body: "Test body", customer: { id: "c1", email: "a@b.com" } },
        billingTriage,
      ),
    ).rejects.toThrow("Invalid tool call output");
  });

  it("throws Phase2Error when AI returns no tool call", async () => {
    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      choices: [{ message: { tool_calls: [] } }],
    });

    await expect(
      runPhase2(
        { subject: "Test", body: "Test body", customer: { id: "c1", email: "a@b.com" } },
        billingTriage,
      ),
    ).rejects.toThrow("No tool call in Phase 2 response");
  });

  it("throws Phase2Error when AI returns empty choices", async () => {
    (portkey.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      choices: [],
    });

    await expect(
      runPhase2(
        { subject: "Test", body: "Test body", customer: { id: "c1", email: "a@b.com" } },
        billingTriage,
      ),
    ).rejects.toThrow("Empty choices in LLM response");
  });
});
