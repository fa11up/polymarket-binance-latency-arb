import { readFileSync, mkdirSync } from "fs";
import { rename, writeFile } from "fs/promises";
import { join } from "path";
import { createLogger } from "./logger.js";

const log = createLogger("STATE");

const DATA_DIR = join(process.cwd(), "data");
const STATE_PATH = join(DATA_DIR, "state.json");
const TMP_PATH  = STATE_PATH + ".tmp";

try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore — dir already exists */ }

// Single-writer queue state:
// - queuedPayload keeps only the latest snapshot (coalescing burst saves)
// - writing ensures at most one write+rename is in-flight
let writing = false;
let queuedPayload = null;

async function _flushQueue() {
  if (writing) return;
  writing = true;
  try {
    while (queuedPayload !== null) {
      const payload = queuedPayload;
      queuedPayload = null;
      try {
        await writeFile(TMP_PATH, payload);
        await rename(TMP_PATH, STATE_PATH);
      } catch (err) {
        log.warn("State save failed — crash recovery data may be stale", { error: err.message });
      }
    }
  } finally {
    writing = false;
    // If a new payload landed after exiting the loop but before we dropped the lock.
    if (queuedPayload !== null) void _flushQueue();
  }
}

/**
 * Atomically write state to data/state.json.
 * Uses write-to-temp + rename so a crash mid-write never corrupts the file.
 * Non-fatal: logs a warning on failure so the operator knows recovery data is stale.
 */
export function saveState(state) {
  queuedPayload = JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2);
  void _flushQueue();
}

/**
 * Wait until all queued state writes are drained.
 * Useful for graceful shutdown to avoid exiting before async flush completes.
 */
export async function flushStateWrites(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while ((writing || queuedPayload !== null) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
  return !writing && queuedPayload === null;
}

/**
 * Load state from data/state.json.
 * Returns null if the file doesn't exist (first run) or is unparseable.
 */
export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch (err) {
    // ENOENT on first run is expected and not worth logging.
    if (err.code !== "ENOENT") {
      log.warn("State load failed — starting fresh", { error: err.message });
    }
    return null;
  }
}
