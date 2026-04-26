import { SQSClient } from "@aws-sdk/client-sqs";
import { config } from "./env.js";

export const sqsClient = new SQSClient({
  region: config.AWS_REGION,
  endpoint: config.SQS_ENDPOINT,
  credentials: {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  },
});
