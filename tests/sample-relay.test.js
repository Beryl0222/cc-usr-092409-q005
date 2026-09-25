import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AGGREGATE_LIST, EVENT_TYPE_LIST } from "../src/events.js";
import { validateEvent } from "../src/validator.js";

const events = JSON.parse(await readFile(new URL("../data/sample-relay.json", import.meta.url), "utf8"));

test("接力样例事件流符合领域约定", () => {
  assert.ok(events.length > 0);
  const versions = new Map();
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 信封不合法`);
    assert.ok(EVENT_TYPE_LIST.includes(event.event_type), `未知事件类型 ${event.event_type}`);
    assert.ok(AGGREGATE_LIST.includes(event.aggregate_type), `未知聚合类型 ${event.aggregate_type}`);
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    const expected = (versions.get(key) ?? 0) + 1;
    assert.equal(event.version, expected, `聚合 ${key} 版本不连续`);
    versions.set(key, event.version);
  }
});

test("接力样例包含完整的跨点链路", () => {
  const types = events.map((e) => e.event_type);
  for (const required of [
    "SESSION_FROZEN",
    "CHILD_CHECKED_IN",
    "TRANSFER_REQUESTED",
    "TRANSFER_APPROVED",
    "TRANSFER_COMPLETED",
    "SESSION_REASSIGNED",
    "CHILD_CHECKED_OUT",
    "NOTIFICATION_SENT",
  ]) {
    assert.ok(types.includes(required), `样例缺少 ${required}`);
  }
  const completed = events.find((e) => e.event_type === "TRANSFER_COMPLETED");
  const checkout = events.find((e) => e.event_id === completed.payload.checkout_event);
  const checkin = events.find((e) => e.event_id === completed.payload.checkin_event);
  assert.equal(checkout.payload.handed_to.type, "TRANSFER");
  assert.equal(checkin.payload.via_transfer, completed.payload.transfer_id);
});
