import { receiveMessages, receiveDlqMessages, deleteMessage } from "./queue.js";
import { handleDlqMessage } from "./dlqHandler.js";
import { processJob } from "./processor.js";
import { workerEvents } from "./workerEvents.js";
import { logger } from "../logger.js";

async function pollDlq() {
  console.log("DLQ poller started.");
  while (true) {
    try {
      const messages = await receiveDlqMessages();
      for (const msg of messages) {
        const { taskId } = JSON.parse(msg.Body);
        try {
          await handleDlqMessage(taskId, msg.ReceiptHandle);
          logger.info({ task_id: taskId }, "dlq handled");
        } catch (err) {
          logger.error({ task_id: taskId, err }, "dlq handler failed");
        }
      }
    } catch (err) {
      console.error("DLQ poll error:", err);
    }
  }
}

// SQS queue theke taskId niye , Api theke alada vabe backgrd e processing kre
async function poll() {
  console.log("Worker started. Polling SQS...");

  while (true) {
    try {
      const messages = await receiveMessages();

      for (const msg of messages) {
        const { taskId } = JSON.parse(msg.Body);
        try {
          await processJob(taskId, msg.ReceiptHandle); // to delete msg sending receiptHandle to sqs
          await deleteMessage(msg.ReceiptHandle);
        } catch (err) {
          logger.error({ task_id: taskId, err }, "job failed");
          // No deleteMessage — visibility timeout expires → SQS retries
        }
      }
    } catch (err) {
      console.error("Poll error:", err);
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
