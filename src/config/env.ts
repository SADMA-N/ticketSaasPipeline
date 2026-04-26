import { z } from "zod";
import "dotenv/config";
const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.url(),
  SQS_QUEUE_URL: z.url(),
  SQS_ENDPOINT: z.url(),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  PORTKEY_API_KEY: z.string(),
  PORTKEY_CONFIG_ID: z.string(),
});

export const config = EnvSchema.parse(process.env);
