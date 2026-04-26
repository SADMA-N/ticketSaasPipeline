import { receiveMessages, deleteMessage } from "./queue.js";
import { processJob } from "./processor.js";

async function poll() {
  console.log("Worker started. Polling SQS...");

  while (true) {
    try {
      const messages = await receiveMessages();

      for (const msg of messages) {
        const { taskId } = JSON.parse(msg.Body!);
        try {
          await processJob(taskId, msg.ReceiptHandle!);
          await deleteMessage(msg.ReceiptHandle!);
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

poll();
