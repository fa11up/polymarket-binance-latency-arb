import { appendFile, mkdirSync } from "fs";
import { join } from "path";
import { createLogger } from "./logger.js";

const log = createLogger("FEATURELOG");

const DATA_DIR = join(process.cwd(), "data");
const LOG_PATH = join(DATA_DIR, "features.ndjson");

// Ensure data dir exists (no-op if already present)
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore — dir already exists */ }

/**
 * Append one feature row to data/features.ndjson (one JSON object per line).
 * Called on every strategy evaluation that passes initial null-checks.
 * Non-fatal: a write error will not crash the engine, but IS logged so the
 * operator knows the dataset may have gaps.
 */
export function logFeature(record) {
  appendFile(LOG_PATH, JSON.stringify({ ...record, _at: new Date().toISOString() }) + "\n", (err) => {
    if (err) log.warn("Feature log write failed", { error: err.message, outcome: record.outcome });
  });
}
