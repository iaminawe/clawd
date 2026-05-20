import pino from "pino";
import { homedir } from "os";
import { resolve } from "path";

const LOG_PATH = resolve(homedir(), "Library/Logs/clawd-slack-bridge.log");

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination({
    dest: LOG_PATH,
    mkdir: true,
    sync: false,
  })
);
