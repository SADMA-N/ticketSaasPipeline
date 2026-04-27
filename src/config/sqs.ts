import { SQSClient } from "@aws-sdk/client-sqs";
import { config } from "./env.js";

// sqs e req pathabo
export const sqsClient = new SQSClient({
  region: config.AWS_REGION,
  endpoint: config.SQS_ENDPOINT,
  //AWS authentication
  credentials: {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  },
});

//creating client using credentials + region to use SQS
