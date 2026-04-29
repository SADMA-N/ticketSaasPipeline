import pino from "pino";

const level =
  process.env["LOG_LEVEL"] ??
  (process.env["NODE_ENV"] === "production"
    ? "info"
    : process.env["NODE_ENV"] === "test"
      ? "silent"
      : "debug");

export const logger = pino({
  level,
  name: "ticketProject",
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "*.password",
      "*.token",
      "*.secret",
      "*.accessKey",
    ],
    censor: "[REDACTED]",
  },
});
