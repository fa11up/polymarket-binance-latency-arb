import { CONFIG } from "../config.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, trade: 1 };
const currentLevel = LEVELS[CONFIG.execution.logLevel] ?? 1;

const COLORS = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  trade: "\x1b[32m",
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, -1);
}

function formatMsg(level, tag, msg, data) {
  const c = COLORS[level] || COLORS.info;
  const prefix = `${COLORS.dim}${ts()}${COLORS.reset} ${c}${level.toUpperCase().padEnd(5)}${COLORS.reset} ${COLORS.bold}[${tag}]${COLORS.reset}`;
  const dataStr = data ? ` ${COLORS.dim}${JSON.stringify(data)}${COLORS.reset}` : "";
  return `${prefix} ${msg}${dataStr}`;
}

// When a TUI is active, all log output routes here instead of stdout.
let _logSink = null;
export function setLogSink(fn) { _logSink = fn; }

function emit(line) {
  if (_logSink) _logSink(line);
  else console.log(line);
}

class Logger {
  constructor(tag) {
    this.tag = tag;
  }

  debug(msg, data) {
    if (currentLevel <= LEVELS.debug) emit(formatMsg("debug", this.tag, msg, data));
  }

  info(msg, data) {
    if (currentLevel <= LEVELS.info) emit(formatMsg("info", this.tag, msg, data));
  }

  warn(msg, data) {
    if (currentLevel <= LEVELS.warn) emit(formatMsg("warn", this.tag, msg, data));
  }

  error(msg, data) {
    emit(formatMsg("error", this.tag, msg, data));
  }

  trade(msg, data) {
    if (currentLevel <= LEVELS.trade) emit(formatMsg("trade", this.tag, msg, data));
  }
}

export function createLogger(tag) {
  return new Logger(tag);
}
