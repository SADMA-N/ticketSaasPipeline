import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { sqsClient } from "../config/sqs.js";
import { config } from "../config/env.js";
import { createTask, deleteTask } from "../repositories/taskRepositories.js";
import { logger } from "../logger.js";
import type { Ticket } from "../schemas/ticket.js";

export async function submitTicket(ticketData: Ticket) {
  const task = await createTask(ticketData); // Db te task create hoi
  logger.info({ task_id: task.id }, "Task created");

  try {
    // req to sqs -> new msg send krteChai (which queue + main content)
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: config.SQS_QUEUE_URL,
        MessageBody: JSON.stringify({ taskId: task.id }), // sqs onty take string
      }),
    );
  } catch (err) {
    logger.error(
      { task_id: task.id, err },
      "SQS enqueue failed — rolling back task",
    );
    try {
      await deleteTask(task.id);
    } catch (deleteErr) {
      logger.error(
        { task_id: task.id, err: deleteErr },
        "Rollback failed — task orphaned in DB",
      );
    }
    throw new Error("Failed to enqueue task");
  }

  return {
    task_id: task.id,
    state: task.state,
    status_url: `/tasks/${task.id}`,
  };
}
