import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/service.js";
import { at, makeService, seedBase, seedTransferTargets } from "./helpers.js";

test("跨点接力全链路：申请、批准、交接、在乙点交付", async () => {
  const svc = makeService();
  seedBase(svc);
  seedTransferTargets(svc);
  const requested = await svc.requestTransfer({
    transfer_id: "tr-1", child_id: "child-yu", from_session_id: "sess-a", to_session_id: "sess-b",
    reason: "家长临时调到乙点", requested_by: "mom-yu", at: at("14:30"),
  });
  assert.equal(requested.ok, true);
  // 非保障负责人不能批准
  await assert.rejects(
    () => svc.approveTransfer({ transfer_id: "tr-1", approved_by: "staff-li", at: at("14:31") }),
    (err) => err instanceof DomainError && err.code === "FORBIDDEN",
  );
  const approved = await svc.approveTransfer({ transfer_id: "tr-1", approved_by: "staff-wang", at: at("14:35") });
  assert.equal(approved.ok, true);
  const executed = await svc.executeTransfer({ transfer_id: "tr-1", escorted_by: "staff-zhang", at: at("15:00") });
  assert.equal(executed.ok, true);
  // 儿童只出现在乙点
  assert.equal(svc.presenceOf("child-yu", at("18:00")).session_id, "sess-b");
  assert.deepEqual(svc.sessionView("sess-b").present, ["child-yu"]);
  assert.deepEqual(svc.sessionView("sess-a").present, ["child-qing"]);
  // 甲点不再能交付
  const atA = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "grandpa-yu", staff_id: "staff-zhang", at: at("16:45"),
  });
  assert.equal(atA.ok, false);
  assert.equal(atA.reason, "CHILD_NOT_PRESENT");
  // 乙点按当日有效授权交付给爷爷
  const atB = svc.attemptPickup({
    session_id: "sess-b", child_id: "child-yu", person_id: "grandpa-yu", staff_id: "staff-zhao", at: at("16:45"),
  });
  assert.equal(atB.ok, true);
  // 监护人收到调班通知
  const notice = svc.store.events.find((e) => e.event_type === "NOTIFICATION_SENT" && e.payload.kind === "TRANSFER_NOTICE");
  assert.equal(notice.payload.to_person_id, "mom-yu");
  // 儿童档案留下课程变更记录
  assert.ok(svc.store.events.some((e) => e.event_type === "SESSION_REASSIGNED" && e.payload.transfer_id === "tr-1"));
});

test("调班前置确认：容量不足、资质不足、特殊支持不足分别拒绝", async () => {
  const svc = makeService();
  seedBase(svc);
  seedTransferTargets(svc);
  svc.confirmEnrollment({ child_id: "child-han", name: "小涵", special_support: [], at: at("08:00") });
  svc.freezeSession({
    session_id: "sess-b1", site_id: "site-b", date: "2026-09-25",
    window: { start: at("14:00"), end: at("17:30") },
    staff: [{ staff_id: "staff-zhao", role: "LEAD" }], roster: ["child-han"], capacity: 1, at: at("13:30"),
  });
  // 容量：sess-b1 名册已满
  await svc.requestTransfer({ transfer_id: "tr-cap", child_id: "child-yu", from_session_id: "sess-a", to_session_id: "sess-b1", reason: "测试", requested_by: "mom-yu", at: at("14:30") });
  const cap = await svc.approveTransfer({ transfer_id: "tr-cap", approved_by: "staff-wang", at: at("14:31") });
  assert.equal(cap.ok, false);
  assert.equal(cap.reason, "CAPACITY_FULL");
  // 资质：sess-c 在岗人员不具备 WHEELCHAIR 资质
  await svc.requestTransfer({ transfer_id: "tr-qual", child_id: "child-yu", from_session_id: "sess-a", to_session_id: "sess-c", reason: "测试", requested_by: "mom-yu", at: at("14:32") });
  const qual = await svc.approveTransfer({ transfer_id: "tr-qual", approved_by: "staff-wang", at: at("14:33") });
  assert.equal(qual.ok, false);
  assert.equal(qual.reason, "STAFF_QUALIFICATION_INSUFFICIENT");
  // 特殊支持：丁点不支持 WHEELCHAIR
  await svc.requestTransfer({ transfer_id: "tr-site", child_id: "child-yu", from_session_id: "sess-a", to_session_id: "sess-d", reason: "测试", requested_by: "mom-yu", at: at("14:34") });
  const site = await svc.approveTransfer({ transfer_id: "tr-site", approved_by: "staff-wang", at: at("14:35") });
  assert.equal(site.ok, false);
  assert.equal(site.reason, "SITE_SUPPORT_INSUFFICIENT");
  // 儿童始终留在甲点
  assert.equal(svc.presenceOf("child-yu", at("18:00")).session_id, "sess-a");
});

test("并发调班同一儿童：只有一笔成交，不会同时出现在两个点", async () => {
  const svc = makeService();
  seedBase(svc);
  seedTransferTargets(svc);
  const [r1, r2] = await Promise.all([
    svc.requestTransfer({ transfer_id: "tr-a", child_id: "child-yu", from_session_id: "sess-a", to_session_id: "sess-b", reason: "调乙点", requested_by: "mom-yu", at: at("14:30") }),
    svc.requestTransfer({ transfer_id: "tr-b", child_id: "child-yu", from_session_id: "sess-a", to_session_id: "sess-c", reason: "调丙点", requested_by: "mom-yu", at: at("14:30") }),
  ]);
  const results = [r1, r2];
  assert.equal(results.filter((r) => r.ok).length, 1);
  const conflict = results.find((r) => !r.ok);
  assert.equal(conflict.reason, "TRANSFER_CONFLICT");
  const winner = r1.ok ? "tr-a" : "tr-b";
  const target = r1.ok ? "sess-b" : "sess-c";
  // 胜出的调班需要资质复核：若目标是 sess-c（缺资质）则批准失败，改测 sess-b 路径
  if (target === "sess-c") {
    const rejected = await svc.approveTransfer({ transfer_id: winner, approved_by: "staff-wang", at: at("14:35") });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "STAFF_QUALIFICATION_INSUFFICIENT");
    return;
  }
  assert.equal((await svc.approveTransfer({ transfer_id: winner, approved_by: "staff-wang", at: at("14:35") })).ok, true);
  assert.equal((await svc.executeTransfer({ transfer_id: winner, escorted_by: "staff-zhang", at: at("15:00") })).ok, true);
  assert.equal(svc.presenceOf("child-yu", at("18:00")).session_id, target);
  assert.deepEqual(svc.sessionView("sess-c").present, []);
});

test("并发调班容量竞争：接收点只剩一个名额时只成交一笔", async () => {
  const svc = makeService();
  seedBase(svc);
  seedTransferTargets(svc);
  svc.freezeSession({
    session_id: "sess-b2", site_id: "site-b", date: "2026-09-25",
    window: { start: at("14:00"), end: at("17:30") },
    staff: [{ staff_id: "staff-zhao", role: "LEAD" }], roster: [], capacity: 1, at: at("13:30"),
  });
  await svc.requestTransfer({ transfer_id: "tr-yu", child_id: "child-yu", from_session_id: "sess-a", to_session_id: "sess-b2", reason: "调班", requested_by: "mom-yu", at: at("14:30") });
  await svc.requestTransfer({ transfer_id: "tr-qing", child_id: "child-qing", from_session_id: "sess-a", to_session_id: "sess-b2", reason: "调班", requested_by: "dad-qing", at: at("14:30") });
  const [a1, a2] = await Promise.all([
    svc.approveTransfer({ transfer_id: "tr-yu", approved_by: "staff-wang", at: at("14:35") }),
    svc.approveTransfer({ transfer_id: "tr-qing", approved_by: "staff-wang", at: at("14:35") }),
  ]);
  assert.equal([a1, a2].filter((r) => r.ok).length, 1);
  const loser = [a1, a2].find((r) => !r.ok);
  assert.equal(loser.reason, "CAPACITY_FULL");
});

test("调班执行幂等：已完成的接力不能重复执行", async () => {
  const svc = makeService();
  seedBase(svc);
  seedTransferTargets(svc);
  await svc.requestTransfer({ transfer_id: "tr-1", child_id: "child-yu", from_session_id: "sess-a", to_session_id: "sess-b", reason: "调班", requested_by: "mom-yu", at: at("14:30") });
  await svc.approveTransfer({ transfer_id: "tr-1", approved_by: "staff-wang", at: at("14:35") });
  assert.equal((await svc.executeTransfer({ transfer_id: "tr-1", escorted_by: "staff-zhang", at: at("15:00") })).ok, true);
  const again = await svc.executeTransfer({ transfer_id: "tr-1", escorted_by: "staff-zhang", at: at("15:05") });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "TRANSFER_ALREADY_COMPLETED");
  // 已接走的儿童不能再次从甲点调出
  assert.equal(svc.presenceOf("child-yu", at("18:00")).session_id, "sess-b");
});
