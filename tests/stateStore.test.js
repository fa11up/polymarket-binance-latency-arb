import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("stateStore: burst saves coalesce and persist latest snapshot", () => {
  const tempCwd = mkdtempSync(join(tmpdir(), "latency-state-"));

  const snippet = [
    "import { readFileSync } from 'fs';",
    "process.chdir(process.env.TEMP_CWD);",
    "const { saveState, flushStateWrites } = await import('./src/utils/stateStore.js');",
    "for (let i = 1; i <= 200; i++) saveState({ counter: i, marker: 'burst' });",
    "const drained = await flushStateWrites(5000);",
    "if (!drained) process.exit(41);",
    "const state = JSON.parse(readFileSync('data/state.json', 'utf8'));",
    "if (state.counter !== 200) process.exit(42);",
    "if (state.marker !== 'burst') process.exit(43);",
    "if (!state.savedAt) process.exit(44);",
    "console.log('ok');",
  ].join("\n");

  const res = spawnSync(process.execPath, ["--input-type=module", "-e", snippet], {
    cwd: process.cwd(),
    env: { ...process.env, TEMP_CWD: tempCwd },
    encoding: "utf8",
  });

  assert.equal(res.status, 0, `expected status=0, got status=${res.status}, stdout=${res.stdout}, stderr=${res.stderr}`);
  assert.ok((res.stdout || "").includes("ok"), `expected ok marker, got stdout=${res.stdout}`);
});
