import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest"; // API call simulate
import app, { createApp } from "../../app.setup.js";
import { submitTicket } from "../../services/ticketService.js";
import { getTaskById } from "../../services/taskService.js";
import { TaskState } from "../../../generated/prisma/enums.js";

/*
checking api is woring properly or not and also checking the error handling and validation of the api
Middleware (requestId, JSON limit, headers)
POST /tickets API
GET /tasks API
*/

vi.mock("../../services/ticketService.js", () => ({
  submitTicket: vi.fn(),
}));

vi.mock("../../services/taskService.js", () => ({
  getTaskById: vi.fn(),
}));

//reusable valid input
const validTicket = {
  subject: "Login broken",
  body: "Cannot login since yesterday. Getting 401.",
  customer: { id: "cust_001", email: "user@example.com" },
};

const mockTaskResponse = {
  task_id: "e061743d-e047-46a4-acdd-cff8b8dc503e",
  state: TaskState.pending,
  current_phase: null,
  retry_count: { phase_1: 0, phase_2: 0 },
  created_at: new Date(),
  state_changed_at: new Date(),
  last_mutated_at: new Date(),
  outputs: null,
  input_ticket: null,
  fallback_info: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe("middleware", () => {
  it("generates x-request-id when client does not provide one", async () => {
    const res = await request(app).get("/unknown-route");
    expect(res.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("echoes x-request-id when client provides one", async () => {
    const clientId = "my-trace-id-abc123";
    const res = await request(app)
      .get("/unknown-route")
      .set("x-request-id", clientId);
    expect(res.headers["x-request-id"]).toBe(clientId);
  });

  it("returns 413 when payload exceeds 100kb", async () => {
    const res = await request(app)
      .post("/tickets")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ data: "x".repeat(110 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("does not expose X-Powered-By header", async () => {
    const res = await request(app).get("/unknown-route");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("returns 500 when handler throws a non-Error value", async () => {
    vi.mocked(submitTicket).mockRejectedValue("string error");
    const res = await request(app).post("/tickets").send(validTicket);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      status: "error",
      message: "Internal server error",
    });
  });

  it("createApp returns a new instance on each call", () => {
    const app1 = createApp();
    const app2 = createApp();
    expect(app1).not.toBe(app2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("POST /tickets", () => {
  it("returns 202 with task_id, state, status_url on valid ticket", async () => {
    vi.mocked(submitTicket).mockResolvedValue({
      task_id: "e061743d-e047-46a4-acdd-cff8b8dc503e",
      state: "pending",
      status_url: "/tasks/e061743d-e047-46a4-acdd-cff8b8dc503e",
    });

    const res = await request(app).post("/tickets").send(validTicket);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      task_id: expect.any(String),
      state: "pending",
      status_url: expect.stringContaining("/tasks/"),
    });
  });

  it("returns 400 when subject is missing", async () => {
    const res = await request(app)
      .post("/tickets")
      .send({ body: "Some body", customer: { id: "c1", email: "a@b.com" } });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Validation failed" });
  });

  it("returns 400 when body is missing", async () => {
    const res = await request(app)
      .post("/tickets")
      .send({ subject: "Test", customer: { id: "c1", email: "a@b.com" } });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Validation failed" });
  });

  it("returns 400 when customer email is invalid", async () => {
    const res = await request(app)
      .post("/tickets")
      .send({
        subject: "Test",
        body: "Test body",
        customer: { id: "c1", email: "not-an-email" },
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Validation failed" });
  });

  it("returns 400 when customer is missing entirely", async () => {
    const res = await request(app)
      .post("/tickets")
      .send({ subject: "Test", body: "Test body" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when body is empty string", async () => {
    const res = await request(app)
      .post("/tickets")
      .send({
        subject: "Test",
        body: "",
        customer: { id: "c1", email: "a@b.com" },
      });

    expect(res.status).toBe(400);
  });

  it("each submission returns a unique task_id", async () => {
    const id1 = "aaaaaaaa-0000-0000-0000-000000000001";
    const id2 = "aaaaaaaa-0000-0000-0000-000000000002";

    vi.mocked(submitTicket)
      .mockResolvedValueOnce({
        task_id: id1,
        state: "pending",
        status_url: `/tasks/${id1}`,
      })
      .mockResolvedValueOnce({
        task_id: id2,
        state: "pending",
        status_url: `/tasks/${id2}`,
      });

    const res1 = await request(app).post("/tickets").send(validTicket);
    const res2 = await request(app).post("/tickets").send(validTicket);

    expect(res1.body.task_id).not.toBe(res2.body.task_id);
  });

  it("accepts optional metadata field", async () => {
    vi.mocked(submitTicket).mockResolvedValue({
      task_id: "e061743d-e047-46a4-acdd-cff8b8dc503e",
      state: "pending",
      status_url: "/tasks/e061743d-e047-46a4-acdd-cff8b8dc503e",
    });

    const res = await request(app)
      .post("/tickets")
      .send({ ...validTicket, metadata: { source: "web", priority: "high" } });

    expect(res.status).toBe(202);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("GET /tasks/:taskId", () => {
  it("returns 200 with full task shape when task exists", async () => {
    vi.mocked(getTaskById).mockResolvedValue(mockTaskResponse);

    const res = await request(app).get(
      "/tasks/e061743d-e047-46a4-acdd-cff8b8dc503e",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      task_id: expect.any(String),
      state: expect.any(String),
      retry_count: { phase_1: expect.any(Number), phase_2: expect.any(Number) },
    });
  });

  it("returns 404 when task does not exist", async () => {
    vi.mocked(getTaskById).mockResolvedValue(null);

    const res = await request(app).get(
      "/tasks/00000000-0000-0000-0000-000000000000",
    );

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Task not found" });
  });

  it("returns 400 when taskId is not a valid UUID", async () => {
    const res = await request(app).get("/tasks/not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Invalid task ID" });
  });

  it("response includes outputs field", async () => {
    vi.mocked(getTaskById).mockResolvedValue(mockTaskResponse);

    const res = await request(app).get(
      "/tasks/e061743d-e047-46a4-acdd-cff8b8dc503e",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("outputs");
  });

  it("response includes fallback_info field", async () => {
    vi.mocked(getTaskById).mockResolvedValue(mockTaskResponse);

    const res = await request(app).get(
      "/tasks/e061743d-e047-46a4-acdd-cff8b8dc503e",
    );

    expect(res.body).toHaveProperty("fallback_info");
  });

  it("unknown route returns 404", async () => {
    const res = await request(app).get("/unknown-route");
    expect(res.status).toBe(404);
  });
});
