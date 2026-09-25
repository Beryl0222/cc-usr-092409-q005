import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { SafeguardingService } from "../src/service.js";
import { at, seedBase } from "./helpers.js";

function fileService() {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const filePath = join(dir, "events.jsonl");
  return {
    filePath,
    open: () => new SafeguardingService({ store: new EventStore({ filePath }) }),
  };
}

test("断线恢复：继续未完成核验，逾期核验与未确认通知升级", () => {
  const { open } = fileService();
  const svcA = open();
  seedBase(svcA);
  svcA.requestTempChange({
    change_id: "chg-1", child_id: "child-yu", kind: "ADD_DELEGATE",
    content: { person_id: "aunt-wang", name: "王阿姨", relation: "邻居", valid_from: at("16:00"), valid_until: at("17:30") },
    requested_by: "mom-yu", recorded_by: "staff-zhang", verify_deadline: at("15:00"), at: at("14:30"),
  });
  svcA.requestTempChange({
    change_id: "chg-2", child_id: "child-yu", kind: "ADD_DELEGATE",
    content: { person_id: "uncle-liu", name: "刘叔叔", relation: "同事", valid_from: at("17:00"), valid_until: at("18:00") },
    requested_by: "mom-yu", recorded_by: "staff-zhang", verify_deadline: at("18:00"), at: at("14:35"),
  });
  // 妈妈提前接走小宇，产生一条待确认的接送回执通知（确认时限 15:20）
  const pickup = svcA.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "mom-yu", staff_id: "staff-zhang", at: at("14:50"),
  });
  assert.equal(pickup.ok, true);

  // 断线重启：从同一事件日志恢复
  const svcB = open();
  const report = svcB.recover({ at: at("16:00") });
  assert.deepEqual(report.expired_temp_changes, ["chg-1"]);
  assert.deepEqual(report.pending_verifications.map((p) => p.change_id), ["chg-2"]);
  assert.ok(report.escalations.includes("case:VERIFICATION_OVERDUE:chg-1"));
  assert.ok(report.escalations.some((c) => c.startsWith("case:NOTIFICATION_UNCONFIRMED:")));
  assert.equal(svcB.tempChangeView("chg-1").status, "EXPIRED");

  // 恢复后继续完成未完成的核验
  assert.equal(svcB.verifyTempChange({ change_id: "chg-2", verified_by: "staff-li", at: at("16:05") }).ok, true);
  assert.equal(svcB.tempChangeView("chg-2").status, "VERIFIED");

  // 恢复扫描幂等：重复执行不产生新事件
  const count = svcB.store.events.length;
  svcB.recover({ at: at("16:10") });
  assert.equal(svcB.store.events.length, count);
});

test("课程结束逾时未接走：升级并通知监护人与紧急联系人", () => {
  const { open } = fileService();
  const svcA = open();
  seedBase(svcA);
  // 无人接走，课程 17:00 结束，宽限 30 分钟
  const report = svcA.recover({ at: at("17:45") });
  assert.deepEqual(
    report.overdue_children.map((o) => o.child_id).sort(),
    ["child-qing", "child-yu"],
  );
  const escalations = svcA.store.events.filter((e) => e.event_type === "CASE_ESCALATED" && e.payload.kind === "PICKUP_OVERDUE");
  assert.equal(escalations.length, 2);
  const notices = svcA.store.events.filter((e) => e.event_type === "NOTIFICATION_SENT" && e.payload.kind === "PICKUP_OVERDUE_NOTICE");
  assert.deepEqual(
    notices.map((n) => n.payload.to_person_id).sort(),
    ["dad-qing", "mom-yu", "uncle-yu"],
  );
  // 断线重启后再次扫描不重复升级
  const svcB = open();
  const count = svcB.store.events.length;
  svcB.recover({ at: at("17:50") });
  assert.equal(svcB.store.events.length, count);
});

test("签到按稳定标识合并：重传去重，内容变化保留待核", () => {
  const { open } = fileService();
  const svc = open();
  seedBase(svc);
  const count = svc.store.events.length;
  // 断线重传同一签到：内容一致，直接去重
  const dup = svc.checkIn({ session_id: "sess-a", child_id: "child-yu", received_by: "staff-zhang", at: at("13:55") });
  assert.equal(dup.deduplicated, true);
  assert.equal(svc.store.events.length, count);
  // 内容不同的签到：保留待核，原记录继续有效
  const revised = svc.checkIn({ session_id: "sess-a", child_id: "child-yu", received_by: "staff-li", at: at("13:58") });
  assert.equal(revised.pending_verification, true);
  assert.deepEqual(svc.sessionView("sess-a").pending_revisions, ["checkin:sess-a:child-yu"]);
  const effective = svc.store.events.find(
    (e) => e.event_type === "CHILD_CHECKED_IN" && e.payload.child_id === "child-yu" && e.payload.status === "EFFECTIVE",
  );
  assert.equal(effective.payload.received_by, "staff-zhang");
  // 恢复报告列出待核修订
  const report = svc.recover({ at: at("14:00") });
  assert.deepEqual(report.pending_revisions.map((r) => r.stable_id), ["checkin:sess-a:child-yu"]);
  // 修订提交人不能自行核验
  assert.throws(
    () => svc.verifyRecordRevision({ stable_id: "checkin:sess-a:child-yu", verified_by: "staff-li", at: at("14:05") }),
    (err) => err.code === "VERIFIER_MUST_DIFFER",
  );
  // 第三名工作人员核验通过，修订生效
  assert.equal(svc.verifyRecordRevision({ stable_id: "checkin:sess-a:child-yu", verified_by: "staff-wang", at: at("14:06") }).ok, true);
  assert.deepEqual(svc.sessionView("sess-a").pending_revisions, []);
  const verifyEvent = svc.store.events.find((e) => e.event_type === "RECORD_REVISION_VERIFIED");
  const revision = svc.store.events.find((e) => e.event_id === verifyEvent.payload.revision_event_id);
  assert.equal(revision.payload.received_by, "staff-li");
});
