import {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { sqsClient } from "../config/sqs.js";
import { config } from "../config/env.js";

export async function sendMessage(taskId: string) {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: config.SQS_QUEUE_URL,
      MessageBody: JSON.stringify({ taskId }),
    }),
  );
}

export async function receiveMessages() {
  const response = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: config.SQS_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
    }),
  );
  return response.Messages ?? [];
}

export async function deleteMessage(receiptHandle: string) {
  await sqsClient.send(
    new DeleteMessageCommand({
      QueueUrl: config.SQS_QUEUE_URL,
      ReceiptHandle: receiptHandle,
    }),
  );
}
