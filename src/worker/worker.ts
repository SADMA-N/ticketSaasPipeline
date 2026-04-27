import { receiveMessages, receiveDlqMessages, deleteMessage } from "./queue.js";
import { handleDlqMessage } from "./dlqHandler.js";
import { processJob } from "./processor.js";
import { workerEvents } from "./workerEvents.js";

async function pollDlq() {
  console.log("DLQ poller started.");
  while (true) {
    try {
      const messages = await receiveDlqMessages();
      for (const msg of messages) {
        const { taskId } = JSON.parse(msg.Body);
        try {
          await handleDlqMessage(taskId, msg.ReceiptHandle);
          console.log(`[dlq] handled taskId: ${taskId}`);
        } catch (err) {
          console.error(`DLQ handler failed for taskId ${taskId}:`, err);
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
          console.error(`Job failed for taskId ${taskId}:`, err);
          // No deleteMessage — visibility timeout expires → SQS retries
        }
      }
    } catch (err) {
      console.error("Poll error:", err);
    }
  }
}

workerEvents.on("phase_2_started", ({ taskId }) => {
  console.log(`[event] phase_2_started — taskId: ${taskId}`);
});

workerEvents.on("task_terminal", ({ taskId, state }) => {
  console.log(`[event] task_terminal — taskId: ${taskId}, state: ${state}`);
});

Promise.all([poll(), pollDlq()]);
