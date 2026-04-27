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

//sqs theke msg receive krtechi
export async function receiveMessages() {
  // requesting sqs to give me messages
  const response = await sqsClient.send(
    // Instructing SQS ( which queue + how many messages + long polling time)
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

export async function receiveDlqMessages() {
  const response = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: config.SQS_DLQ_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
    }),
  );
  return response.Messages ?? [];
}

export async function deleteDlqMessage(receiptHandle: string) {
  await sqsClient.send(
    new DeleteMessageCommand({
      QueueUrl: config.SQS_DLQ_URL,
      ReceiptHandle: receiptHandle,
    }),
  );
}
/*
long pulling 
Queue khali thakle shate shate return kre na , 20sec wait 
krbe  which helps for CPU utilization + empty req kom hoi + efficient system
*/
