import assert from "node:assert/strict";
import { test } from "node:test";
import { workerHealth } from "../src/lib/operator-status";

test("worker health requires a recent successful tick, not just a running web process", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  assert.equal(workerHealth(null, now).healthy, false);
  assert.equal(workerHealth({ last_tick: new Date(now - 300000), error_code: null }, now).healthy, true);
  assert.equal(workerHealth({ last_tick: new Date(now - 300001), error_code: null }, now).healthy, false);
  assert.equal(workerHealth({ last_tick: "invalid", error_code: null }, now).healthy, false);
  const error = workerHealth({ last_tick: new Date(now), error_code: "photo_queue_empty" }, now);
  assert.equal(error.healthy, false);
  assert.equal(error.reason, "photo_queue_empty");
});
