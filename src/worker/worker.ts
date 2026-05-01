import { receiveMessages, receiveDlqMessages, deleteMessage } from "./queue.js";
import { handleDlqMessage } from "./dlqHandler.js";
import { processJob } from "./processor.js";
import { workerEvents } from "./workerEvents.js";
import { logger } from "../logger.js";

async function pollDlq() {
  logger.info("DLQ poller started");
  while (true) {
    try {
      const messages = await receiveDlqMessages();
      for (const msg of messages) {
        const { taskId } = JSON.parse(msg.Body!);
        try {
          await handleDlqMessage(taskId, msg.ReceiptHandle!);
          logger.info({ task_id: taskId }, "dlq handled");
        } catch (err) {
          logger.error({ task_id: taskId, err }, "dlq handler failed");
        }
      }
    } catch (err) {
      logger.error({ err }, "DLQ poll error");
    }
  }
}

// SQS queue theke taskId niye , Api theke alada vabe backgrd e processing kre
async function poll() {
  logger.info("Worker started. Polling SQS...");

  while (true) {
    try {
      const messages = await receiveMessages();

      for (const msg of messages) {
        const { taskId } = JSON.parse(msg.Body!);
        try {
          await processJob(taskId);
          await deleteMessage(msg.ReceiptHandle!); // processJob returned normally = done, ack the message
        } catch (err) {
          logger.error({ task_id: taskId, err }, "job failed");
          // No deleteMessage — visibility timeout expires → SQS retries
        }
      }
    } catch (err) {
      logger.error({ err }, "Poll error");
    }
  }
}

workerEvents.on("phase_2_started", ({ taskId }) => {
  logger.info({ task_id: taskId, event: "phase_2_started" }, "worker event");
});

workerEvents.on("task_terminal", ({ taskId, state }) => {
  logger.info(
    { task_id: taskId, event: "task_terminal", outcome: state },
    "worker event",
  );
});

Promise.all([poll(), pollDlq()]);
