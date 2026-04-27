import { receiveMessages, deleteMessage } from "./queue.js";
import { processJob } from "./processor.js";

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

poll();
