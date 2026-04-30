import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { sqsClient } from "../config/sqs.js"; // connect with aws // sqs req pathai
import { config } from "../config/env.js";

async function receiveFrom(queueUrl: string): Promise<Message[]> {
  //( tell sqs to send this -> which queue + how many messages + long polling time
  const response = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
    }),
  );
  return response.Messages ?? [];
}

// SQS k bole to delete this specific mesg
async function deleteFrom(
  queueUrl: string,
  receiptHandle: string,
): Promise<void> {
  await sqsClient.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle, //SQS er unique ID for each received message
    }),
  );
}

//sqs queue theke msg receive kre  // called by worker
export async function receiveMessages(): Promise<Message[]> {
  return receiveFrom(config.SQS_QUEUE_URL);
}

// delete processed msg from queue// processor.ts r worker.ts ei ta use kore.
export async function deleteMessage(receiptHandle: string): Promise<void> {
  await deleteFrom(config.SQS_QUEUE_URL, receiptHandle);
}

//DLQ poller (worker.ts) ei ta use kore to handle failed messages // Dlq theke msg nei
export async function receiveDlqMessages(): Promise<Message[]> {
  return receiveFrom(config.SQS_DLQ_URL);
}

export async function deleteDlqMessage(receiptHandle: string): Promise<void> {
  await deleteFrom(config.SQS_DLQ_URL, receiptHandle);
}

/*
long pulling
Queue khali thakle shate shate return kre na , 20sec wait
krbe  which helps for CPU utilization + empty req kom hoi + efficient system
*/
