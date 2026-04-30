import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type ReceiveMessageCommandOutput,
} from "@aws-sdk/client-sqs";

const { MAIN_QUEUE_URL, DLQ_QUEUE_URL } = vi.hoisted(() => ({
  MAIN_QUEUE_URL: "http://localhost:4566/000000000000/ticket-queue",
  DLQ_QUEUE_URL: "http://localhost:4566/000000000000/ticket-dlq",
}));

vi.mock("../../config/sqs.js", () => ({
  sqsClient: { send: vi.fn() },
}));

// not using real // using and inject fake here
vi.mock("../../config/env.js", () => ({
  config: {
    SQS_QUEUE_URL: MAIN_QUEUE_URL,
    SQS_DLQ_URL: DLQ_QUEUE_URL,
  },
}));

import {
  receiveMessages,
  deleteMessage,
  receiveDlqMessages,
  deleteDlqMessage,
} from "../queue.js";
import { sqsClient } from "../../config/sqs.js";

const sendMock = vi.mocked(sqsClient.send); // DRY

type SqsSendResult = Partial<ReceiveMessageCommandOutput>; // all fields optional for flexibility in tests

function mockSqsResponse(value: SqsSendResult = {}) {
  sendMock.mockResolvedValue(value as never);
}

function receiveInput(callIndex = 0) {
  const command = sendMock.mock.calls[callIndex]?.[0];
  expect(command).toBeInstanceOf(ReceiveMessageCommand);
  return (command as ReceiveMessageCommand).input;
}

function deleteInput(callIndex = 0) {
  const command = sendMock.mock.calls[callIndex]?.[0]; // if multiple test calls, we can specify which one to check
  expect(command).toBeInstanceOf(DeleteMessageCommand);
  return (command as DeleteMessageCommand).input;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockSqsResponse();
});

describe.each([
  { label: "receiveMessages", fn: receiveMessages, url: MAIN_QUEUE_URL },
  { label: "receiveDlqMessages", fn: receiveDlqMessages, url: DLQ_QUEUE_URL },
] as const)("$label", ({ fn, url }) => {
  //as const TS er jonno, fn ar url er type narrow korte.
  it("polls correct queue URL with exactly one SQS call", async () => {
    await fn();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(receiveInput().QueueUrl).toBe(url);
  });

  it("requests max 10 messages with 20s long poll", async () => {
    await fn();
    const input = receiveInput();
    expect(input.MaxNumberOfMessages).toBe(10);
    expect(input.WaitTimeSeconds).toBe(20);
  });

  it("returns empty array when SQS returns no messages", async () => {
    mockSqsResponse({ Messages: undefined });
    expect(await fn()).toEqual([]);
  });

  it("returns SQS messages as-is without transforming payload", async () => {
    const fakeMessages: Message[] = [
      { Body: '{"taskId":"task-001"}', ReceiptHandle: "rh-1" },
      { Body: '{"taskId":"task-002"}', ReceiptHandle: "rh-2" },
    ];

    mockSqsResponse({ Messages: fakeMessages });

    const messages = await fn();

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      Body: '{"taskId":"task-001"}',
      ReceiptHandle: "rh-1",
    });
  });
  //SQS fail korle error swallow korbe na// caller e bubble up hbe.
  it("propagates SQS errors to caller", async () => {
    sendMock.mockRejectedValue(new Error("SQS unavailable"));
    await expect(fn()).rejects.toThrow("SQS unavailable");
  });
});

describe.each([
  { label: "deleteMessage", fn: deleteMessage, url: MAIN_QUEUE_URL },
  { label: "deleteDlqMessage", fn: deleteDlqMessage, url: DLQ_QUEUE_URL },
] as const)("$label", ({ fn, url }) => {
  it("sends one delete command to correct queue with receipt handle", async () => {
    await fn("receipt-handle-xyz");

    const input = deleteInput();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(input.QueueUrl).toBe(url);
    expect(input.ReceiptHandle).toBe("receipt-handle-xyz");
  });

  //Delete fail korle error bubble up
  it("propagates SQS errors to caller", async () => {
    sendMock.mockRejectedValue(new Error("SQS unavailable"));
    await expect(fn("receipt-handle-xyz")).rejects.toThrow("SQS unavailable");
  });
});
