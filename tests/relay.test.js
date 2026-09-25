import assert from "node:assert/strict";
import test from "node:test";

import { RelayService } from "../src/relay.js";

const DAY = "2026-09-25";
const T = {
  reg: "2026-09-24T10:00:00+08:00",
  freeze: "2026-09-25T14:30:00+08:00",
  start: "2026-09-25T15:00:00+08:00",
  endA: "2026-09-25T17:00:00+08:00",
  endB: "2026-09-25T18:00:00+08:00",
  during: "2026-09-25T16:00:00+08:00",
  pickup: "2026-09-25T16:50:00+08:00",
  late: "2026-09-25T17:31:00+08:00", // 超过 endA + 15 分钟宽限
  evening: "2026-09-25T19:00:00+08:00",
};

/** 造好两个冻结课程（甲点 sess-a、乙点 sess-b）与两名儿童的基线档案。 */
function seedService() {
  const service = new RelayService();

  service.recordGuardianship({
    child_id: "child-1",
    guardians: [{ person_id: "mom-1", relation: "母亲" }],
    recorded_by: "registry-1",
    at: T.reg,
  });
  service.recordGuardianship({
    child_id: "child-2",
    guardians: [{ person_id: "dad-2", relation: "父亲" }],
    recorded_by: "registry-1",
    at: T.reg,
  });
  service.recordPickupScope({
    child_id: "child-1",
    delegates: [{ person_id: "uncle-1", sites: ["*"], valid_from: "2026-09-01", valid_to: "2026-12-31" }],
    recorded_by: "registry-1",
    at: T.reg,
  });
  service.recordPickupScope({
    child_id: "child-2",
    delegates: [{ person_id: "aunt-2", sites: ["site-a"], valid_from: "2026-09-01", valid_to: "2026-12-31" }],
    recorded_by: "registry-1",
    at: T.reg,
  });
  service.recordEmergencyContacts({
    child_id: "child-1",
    contacts: [{ person_id: "mom-1", phone: "138****0001" }],
    recorded_by: "registry-1",
    at: T.reg,
  });
  service.recordEmergencyContacts({
    child_id: "child-2",
    contacts: [{ person_id: "dad-2", phone: "138****0002" }],
    recorded_by: "registry-1",
    at: T.reg,
  });
  service.recordSupportNeeds({ child_id: "child-1", needs: ["first_aid"], recorded_by: "doctor-1", at: T.reg });

  service.planSession({
    session_id: "sess-a",
    site_id: "site-a",
    date: DAY,
    start: T.start,
    end: T.endA,
    capacity: 10,
    at: T.reg,
  });
  service.assignStaff({
    session_id: "sess-a",
    staff: [
      { staff_id: "staff-a1", role: "lead", qualifications: ["first_aid"] },
      { staff_id: "staff-a2", role: "support", qualifications: [] },
    ],
    at: T.reg,
  });
  service.planSession({
    session_id: "sess-b",
    site_id: "site-b",
    date: DAY,
    start: T.start,
    end: T.endB,
    capacity: 5,
    at: T.reg,
  });
  service.assignStaff({
    session_id: "sess-b",
    staff: [{ staff_id: "staff-b1", role: "lead", qualifications: ["first_aid"] }],
    at: T.reg,
  });

  service.placeChild({ session_id: "sess-a", child_id: "child-1", at: T.reg });
  service.placeChild({ session_id: "sess-a", child_id: "child-2", at: T.reg });

  service.freezeSession({ session_id: "sess-a", frozen_by: "director-0", at: T.freeze });
  service.freezeSession({ session_id: "sess-b", frozen_by: "director-0", at: T.freeze });
  return service;
}

test("跨点接力：调班审批、签到、交付与事后还原", () => {
  const service = seedService();

  const transfer = service.transferChild({
    transfer_id: "tr-1",
    child_id: "child-1",
    to_session_id: "sess-b",
    approved_by: "director-1",
    expected_version: 1,
    at: "2026-09-25T15:30:00+08:00",
  });
  assert.equal(transfer.ok, true);
  assert.equal(transfer.placement_version, 2);

  const checkin = service.checkIn({
    checkin_id: "chk-1",
    session_id: "sess-b",
    child_id: "child-1",
    recorded_by: "staff-b1",
    at: "2026-09-25T15:45:00+08:00",
  });
  assert.equal(checkin.ok, true);

  const handover = service.recordHandover({
    receipt_id: "rcpt-1",
    session_id: "sess-b",
    child_id: "child-1",
    person_id: "uncle-1",
    recorded_by: "staff-b1",
    at: T.pickup,
  });
  assert.equal(handover.ok, true);
  assert.equal(handover.via, "DELEGATE");

  // 事后调查：按当时视角还原
  const report = service.investigate("child-1", T.evening);
  assert.equal(report.site_changes.length, 1);
  assert.equal(report.site_changes[0].approved_by, "director-1");
  assert.equal(report.site_changes[0].from_site_id, "site-a");
  assert.equal(report.site_changes[0].to_site_id, "site-b");
  assert.deepEqual(
    report.on_site_responsible.map((r) => r.staff_id),
    ["staff-b1"],
  );
  assert.equal(report.released_to.length, 1);
  assert.equal(report.released_to[0].person_id, "uncle-1");
  assert.equal(report.released_to[0].site_id, "site-b");
  // 调班与交付通知尚未确认
  const unconfirmedKinds = report.unconfirmed_notifications.map((n) => n.kind).sort();
  assert.deepEqual(unconfirmedKinds, ["HANDOVER_DONE", "SITE_TRANSFER"]);

  // 调班前的当时视角：现场负责人仍是甲点 staff-a1
  const before = service.investigate("child-1", "2026-09-25T15:00:00+08:00");
  assert.deepEqual(
    before.on_site_responsible.map((r) => r.staff_id),
    ["staff-a1"],
  );
  assert.equal(before.site_changes.length, 0);

  // 确认一条通知后，未确认列表随之减少
  const target = report.unconfirmed_notifications.find((n) => n.kind === "HANDOVER_DONE");
  service.confirmNotification({
    notification_id: target.notification_id,
    confirmed_by: "mom-1",
    at: "2026-09-25T17:10:00+08:00",
  });
  const after = service.investigate("child-1", T.evening);
  assert.deepEqual(
    after.unconfirmed_notifications.map((n) => n.kind),
    ["SITE_TRANSFER"],
  );
});

test("迟到禁交付：超过宽限期拒绝交付并升级、通知紧急联系人", () => {
  const service = seedService();

  const refused = service.recordHandover({
    receipt_id: "rcpt-late",
    session_id: "sess-a",
    child_id: "child-1",
    person_id: "mom-1",
    recorded_by: "staff-a1",
    at: T.late,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "LATE_NO_RELEASE");

  const escalations = service.listEscalations();
  assert.equal(escalations.some((e) => e.kind === "LATE_PICKUP_NO_RELEASE" && e.child_id === "child-1"), true);

  // 紧急联系人收到待确认通知；逾期未确认后 tick 升级
  const report = service.investigate("child-1", T.evening);
  const lateNotice = report.unconfirmed_notifications.find((n) => n.kind === "LATE_PICKUP");
  assert.equal(lateNotice.to, "mom-1");

  const raised = service.tick("2026-09-25T18:30:00+08:00");
  assert.equal(raised.length, 1);
  assert.equal(raised[0].payload.kind, "NOTIFICATION_OVERDUE");
  assert.equal(raised[0].payload.notification_id, lateNotice.notification_id);

  // 宽限期内仍可正常交付（对照：另一天等价判定）
  const withinGrace = service.evaluateRelease("sess-a", "child-2", "dad-2", "2026-09-25T17:10:00+08:00");
  assert.equal(withinGrace.allowed, true);
});

test("代接人撤回：冻结后的新版本立即生效", () => {
  const service = seedService();

  // 冻结快照中 uncle-1 是有效代接人
  const before = service.evaluateRelease("sess-a", "child-1", "uncle-1", T.during);
  assert.equal(before.allowed, true);

  // 监护人撤回代接授权（追加新版本，不改写历史）
  service.recordPickupScope({
    child_id: "child-1",
    delegates: [],
    recorded_by: "mom-1",
    at: T.during,
  });

  const refused = service.recordHandover({
    receipt_id: "rcpt-revoked",
    session_id: "sess-a",
    child_id: "child-1",
    person_id: "uncle-1",
    recorded_by: "staff-a1",
    at: T.pickup,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "NOT_AUTHORIZED");

  // 监护人本人不受影响
  const byMom = service.recordHandover({
    receipt_id: "rcpt-mom",
    session_id: "sess-a",
    child_id: "child-1",
    person_id: "mom-1",
    recorded_by: "staff-a1",
    at: "2026-09-25T16:55:00+08:00",
  });
  assert.equal(byMom.ok, true);
  assert.equal(byMom.via, "GUARDIAN");
});

test("并发调班：同一放置版本号只允许成功一次", () => {
  const service = seedService();
  service.planSession({
    session_id: "sess-c",
    site_id: "site-c",
    date: DAY,
    start: T.start,
    end: T.endB,
    capacity: 5,
    at: T.reg,
  });
  service.assignStaff({
    session_id: "sess-c",
    staff: [{ staff_id: "staff-c1", role: "lead", qualifications: ["first_aid"] }],
    at: T.reg,
  });
  service.freezeSession({ session_id: "sess-c", frozen_by: "director-0", at: T.freeze });

  const first = service.transferChild({
    transfer_id: "tr-a",
    child_id: "child-1",
    to_session_id: "sess-b",
    approved_by: "director-1",
    expected_version: 1,
    at: T.during,
  });
  assert.equal(first.ok, true);

  // 基于同一旧版本号发起的并发调班被拒绝
  const second = service.transferChild({
    transfer_id: "tr-b",
    child_id: "child-1",
    to_session_id: "sess-c",
    approved_by: "director-2",
    expected_version: 1,
    at: T.during,
  });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "VERSION_CONFLICT");
  assert.equal(second.error.current_version, 2);

  // 同一儿童不能再被排入其他课程（不会同时出现在两个点）
  const doublePlace = service.placeChild({ session_id: "sess-c", child_id: "child-1", at: T.during });
  assert.equal(doublePlace.ok, false);
  assert.equal(doublePlace.error.code, "ALREADY_PLACED");

  // 相同调班单按稳定标识幂等重放
  const replay = service.transferChild({
    transfer_id: "tr-a",
    child_id: "child-1",
    to_session_id: "sess-b",
    approved_by: "director-1",
    expected_version: 1,
    at: T.during,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.deduplicated, true);
});

test("调班前置校验：接收点容量与特殊支持资质", () => {
  const service = seedService();

  // 容量为 1 且已被占用的课程
  service.planSession({
    session_id: "sess-full",
    site_id: "site-c",
    date: DAY,
    start: T.start,
    end: T.endB,
    capacity: 1,
    at: T.reg,
  });
  service.assignStaff({
    session_id: "sess-full",
    staff: [{ staff_id: "staff-c1", role: "lead", qualifications: ["first_aid"] }],
    at: T.reg,
  });
  service.placeChild({ session_id: "sess-full", child_id: "child-9", at: T.reg });
  service.freezeSession({ session_id: "sess-full", frozen_by: "director-0", at: T.freeze });

  const full = service.transferChild({
    transfer_id: "tr-full",
    child_id: "child-1",
    to_session_id: "sess-full",
    approved_by: "director-1",
    expected_version: 1,
    at: T.during,
  });
  assert.equal(full.ok, false);
  assert.equal(full.error.code, "TARGET_FULL");

  // 在岗人员资质不覆盖 child-1 的 first_aid 需求
  service.planSession({
    session_id: "sess-noaid",
    site_id: "site-d",
    date: DAY,
    start: T.start,
    end: T.endB,
    capacity: 5,
    at: T.reg,
  });
  service.assignStaff({
    session_id: "sess-noaid",
    staff: [{ staff_id: "staff-d1", role: "lead", qualifications: ["music"] }],
    at: T.reg,
  });
  service.freezeSession({ session_id: "sess-noaid", frozen_by: "director-0", at: T.freeze });

  const unqualified = service.transferChild({
    transfer_id: "tr-noaid",
    child_id: "child-1",
    to_session_id: "sess-noaid",
    approved_by: "director-1",
    expected_version: 1,
    at: T.during,
  });
  assert.equal(unqualified.ok, false);
  assert.equal(unqualified.error.code, "STAFF_QUALIFICATION_MISSING");
  assert.deepEqual(unqualified.error.missing, ["first_aid"]);
});

test("临时监护人变更需要二次核验", () => {
  const service = seedService();

  service.requestTemporaryGuardian({
    change_id: "chg-1",
    child_id: "child-1",
    person_id: "neighbor-9",
    valid_from: DAY,
    valid_to: DAY,
    sites: ["site-a"],
    requested_by: "staff-a1",
    at: T.during,
  });

  // 未核验前不可交付
  const early = service.recordHandover({
    receipt_id: "rcpt-early",
    session_id: "sess-a",
    child_id: "child-1",
    person_id: "neighbor-9",
    recorded_by: "staff-a2",
    at: T.pickup,
  });
  assert.equal(early.ok, false);
  assert.equal(early.error.code, "NOT_AUTHORIZED");

  // 申请人不能自行核验
  const selfConfirm = service.confirmTemporaryGuardian({
    change_id: "chg-1",
    confirmed_by: "staff-a1",
    at: T.during,
  });
  assert.equal(selfConfirm.ok, false);
  assert.equal(selfConfirm.error.code, "SAME_VERIFIER");

  // 第二名工作人员核验后生效
  const confirmed = service.confirmTemporaryGuardian({
    change_id: "chg-1",
    confirmed_by: "staff-a2",
    at: T.during,
  });
  assert.equal(confirmed.ok, true);

  const handover = service.recordHandover({
    receipt_id: "rcpt-temp",
    session_id: "sess-a",
    child_id: "child-1",
    person_id: "neighbor-9",
    recorded_by: "staff-a2",
    at: T.pickup,
  });
  assert.equal(handover.ok, true);
  assert.equal(handover.via, "TEMP_GUARDIAN");
});

test("保护案件禁交付指令优先于普通授权", () => {
  const service = seedService();

  // deny_list：即使 uncle-1 在代接范围内也禁止交付
  service.recordNoRelease({
    case_id: "case-1",
    child_id: "child-1",
    mode: "deny_list",
    forbidden_persons: ["uncle-1"],
    recorded_by: "caseworker-1",
    at: T.during,
  });
  const blocked = service.recordHandover({
    receipt_id: "rcpt-blocked",
    session_id: "sess-a",
    child_id: "child-1",
    person_id: "uncle-1",
    recorded_by: "staff-a1",
    at: T.pickup,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "NO_RELEASE_DIRECTIVE");

  // guardian_only：代接人 aunt-2 被拦截，监护人 dad-2 不受影响
  service.recordNoRelease({
    case_id: "case-2",
    child_id: "child-2",
    mode: "guardian_only",
    recorded_by: "caseworker-1",
    at: T.during,
  });
  const auntBlocked = service.recordHandover({
    receipt_id: "rcpt-aunt",
    session_id: "sess-a",
    child_id: "child-2",
    person_id: "aunt-2",
    recorded_by: "staff-a1",
    at: T.pickup,
  });
  assert.equal(auntBlocked.ok, false);
  assert.equal(auntBlocked.error.code, "NO_RELEASE_DIRECTIVE");

  const dadOk = service.recordHandover({
    receipt_id: "rcpt-dad",
    session_id: "sess-a",
    child_id: "child-2",
    person_id: "dad-2",
    recorded_by: "staff-a1",
    at: "2026-09-25T16:55:00+08:00",
  });
  assert.equal(dadOk.ok, true);
});

test("异常只冻结相关儿童的交付，不阻断其他家庭", () => {
  const service = seedService();

  const first = service.checkIn({
    checkin_id: "chk-x",
    session_id: "sess-a",
    child_id: "child-1",
    method: "card",
    recorded_by: "staff-a1",
    at: T.during,
  });
  assert.equal(first.ok, true);

  // 同一稳定标识、同一内容：幂等去重
  const dup = service.checkIn({
    checkin_id: "chk-x",
    session_id: "sess-a",
    child_id: "child-1",
    method: "card",
    recorded_by: "staff-a1",
    at: T.during,
  });
  assert.equal(dup.deduplicated, true);

  // 同一稳定标识、内容变化：保留原记录待核，并冻结该儿童交付
  const conflict = service.checkIn({
    checkin_id: "chk-x",
    session_id: "sess-a",
    child_id: "child-1",
    method: "manual",
    recorded_by: "staff-a1",
    at: T.during,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "CONTENT_CONFLICT_PENDING");

  const frozen = service.recordHandover({
    receipt_id: "rcpt-frozen",
    session_id: "sess-a",
    child_id: "child-1",
    person_id: "mom-1",
    recorded_by: "staff-a1",
    at: T.pickup,
  });
  assert.equal(frozen.ok, false);
  assert.equal(frozen.error.code, "DELIVERY_FROZEN");

  // 其他家庭不受影响
  const other = service.recordHandover({
    receipt_id: "rcpt-other",
    session_id: "sess-a",
    child_id: "child-2",
    person_id: "dad-2",
    recorded_by: "staff-a1",
    at: T.pickup,
  });
  assert.equal(other.ok, true);

  // 冲突解决后该儿童恢复交付
  const resolved = service.resolveConflict({
    kind: "checkin",
    stable_id: "chk-x",
    resolved_by: "director-1",
    at: "2026-09-25T16:55:00+08:00",
    note: "确认为刷卡记录，手工录入为误报",
  });
  assert.equal(resolved.ok, true);
  const after = service.recordHandover({
    receipt_id: "rcpt-after",
    session_id: "sess-a",
    child_id: "child-1",
    person_id: "mom-1",
    recorded_by: "staff-a1",
    at: "2026-09-25T16:58:00+08:00",
  });
  assert.equal(after.ok, true);
});

test("接送回执按稳定标识幂等合并", () => {
  const service = seedService();

  const first = service.recordHandover({
    receipt_id: "rcpt-dup",
    session_id: "sess-a",
    child_id: "child-1",
    person_id: "mom-1",
    recorded_by: "staff-a1",
    at: T.pickup,
  });
  assert.equal(first.ok, true);

  const replay = service.recordHandover({
    receipt_id: "rcpt-dup",
    session_id: "sess-a",
    child_id: "child-1",
    person_id: "mom-1",
    recorded_by: "staff-a1",
    at: T.pickup,
  });
  assert.equal(replay.deduplicated, true);

  const handoverEvents = service.events.filter((e) => e.event_type === "HANDOVER_RECORDED");
  assert.equal(handoverEvents.length, 1);
});

test("断线恢复后继续未完成的核验和逾期升级", () => {
  const service = seedService();

  service.requestTemporaryGuardian({
    change_id: "chg-r",
    child_id: "child-1",
    person_id: "neighbor-9",
    valid_from: DAY,
    valid_to: DAY,
    sites: ["site-a"],
    requested_by: "staff-a1",
    at: T.during,
  });
  // 产生一条待确认通知（交付完成 → 通知紧急联系人）
  const handover = service.recordHandover({
    receipt_id: "rcpt-r",
    session_id: "sess-a",
    child_id: "child-2",
    person_id: "dad-2",
    recorded_by: "staff-a1",
    at: T.pickup,
  });
  assert.equal(handover.ok, true);

  // 断线恢复：从事件日志重建
  const restored = RelayService.restore(service.events);

  // 未完成的二次核验可以继续
  const confirmed = restored.confirmTemporaryGuardian({
    change_id: "chg-r",
    confirmed_by: "staff-a2",
    at: "2026-09-25T16:55:00+08:00",
  });
  assert.equal(confirmed.ok, true);
  const tempOk = restored.evaluateRelease("sess-a", "child-1", "neighbor-9", "2026-09-25T16:56:00+08:00");
  assert.equal(tempOk.allowed, true);
  assert.equal(tempOk.reason, "TEMP_GUARDIAN");

  // 逾期升级在恢复后继续推进
  const raised = restored.tick("2026-09-25T17:30:00+08:00");
  assert.equal(raised.length, 1);
  assert.equal(raised[0].payload.kind, "NOTIFICATION_OVERDUE");

  // 事后调查在恢复后的视角一致
  const report = restored.investigate("child-2", T.evening);
  assert.equal(report.released_to.length, 1);
  assert.equal(report.released_to[0].person_id, "dad-2");
});
