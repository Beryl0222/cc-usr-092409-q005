import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/service.js";
import { at, makeService, seedBase } from "./helpers.js";

test("授权窗口内交付成功并留下可核验回执", () => {
  const svc = makeService();
  seedBase(svc);
  const result = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "grandpa-yu", staff_id: "staff-zhang", at: at("16:45"),
  });
  assert.equal(result.ok, true);
  const basis = result.event.payload.decision_basis;
  assert.equal(basis.matched, "DELEGATE");
  assert.equal(basis.matched_source, "DELEGATION");
  assert.equal(basis.delegation_version, 1);
  assert.deepEqual(basis.no_release_checked, []);
  // 监护人收到接送确认通知，等待确认
  const notice = svc.store.events.find((e) => e.event_type === "NOTIFICATION_SENT" && e.payload.kind === "PICKUP_CONFIRMATION");
  assert.equal(notice.payload.to_person_id, "mom-yu");
  assert.equal(svc.sessionView("sess-a").present.includes("child-yu"), false);
});

test("迟到禁交付：代接人超过授权窗口到达被拒绝", () => {
  const svc = makeService();
  seedBase(svc);
  const result = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "grandpa-yu", staff_id: "staff-zhang", at: at("17:15"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "OUTSIDE_VALID_WINDOW");
  // 儿童仍在场，拒绝记录可查
  const view = svc.sessionView("sess-a");
  assert.deepEqual(view.present, ["child-yu", "child-qing"]);
  assert.deepEqual(view.refusals.map((r) => r.reason), ["OUTSIDE_VALID_WINDOW"]);
});

test("保护案件禁交付优先于普通授权，异常只冻结相关儿童", () => {
  const svc = makeService();
  seedBase(svc);
  svc.issueNoRelease({
    child_id: "child-yu", order_id: "nro-1", target_person_id: "grandpa-yu",
    source: "PROTECTION_CASE", reason: "保护案件限制接触", effective_from: at("15:00"), at: at("15:00"),
  });
  // 爷爷虽在长期授权名单内，仍被禁交付拦截，且该儿童交付被冻结、案件升级
  const refused = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "grandpa-yu", staff_id: "staff-zhang", at: at("16:45"),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "NO_RELEASE_MATCH");
  assert.deepEqual(svc.sessionView("sess-a").frozen_deliveries, ["child-yu"]);
  const escalation = svc.store.events.find((e) => e.event_type === "CASE_ESCALATED");
  assert.equal(escalation.payload.kind, "DELIVERY_BLOCKED");
  // 冻结期间即使是监护人也暂不能交付
  const blocked = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "mom-yu", staff_id: "staff-zhang", at: at("16:50"),
  });
  assert.equal(blocked.reason, "DELIVERY_FROZEN");
  // 其他家庭不受阻断
  const other = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-qing", person_id: "dad-qing", staff_id: "staff-zhang", at: at("16:52"),
  });
  assert.equal(other.ok, true);
  // 保护案件指令只能由保障负责人解除
  assert.throws(
    () => svc.liftNoRelease({ child_id: "child-yu", order_id: "nro-1", lifted_by: "staff-li", at: at("16:55") }),
    (err) => err instanceof DomainError && err.code === "FORBIDDEN",
  );
  assert.equal(svc.liftNoRelease({ child_id: "child-yu", order_id: "nro-1", lifted_by: "staff-wang", at: at("16:56") }).ok, true);
  // 保障负责人解冻后，监护人可以接走
  svc.unfreezeDelivery({ session_id: "sess-a", child_id: "child-yu", by: "staff-wang", at: at("16:58") });
  const released = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "mom-yu", staff_id: "staff-zhang", at: at("17:00"),
  });
  assert.equal(released.ok, true);
  assert.equal(released.event.payload.decision_basis.matched, "GUARDIAN");
});

test("监护人临时变更必须二次核验，核验人不得与登记人相同", () => {
  const svc = makeService();
  seedBase(svc);
  const { change_id } = svc.requestTempChange({
    child_id: "child-yu", kind: "ADD_DELEGATE",
    content: { person_id: "aunt-wang", name: "王阿姨", relation: "邻居", valid_from: at("16:00"), valid_until: at("17:30") },
    requested_by: "mom-yu", recorded_by: "staff-zhang", verify_deadline: at("15:30"), at: at("14:30"),
  });
  // 核验前：临时代接人不能接领
  const early = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "aunt-wang", staff_id: "staff-zhang", at: at("16:00"),
  });
  assert.equal(early.ok, false);
  assert.equal(early.reason, "PENDING_VERIFICATION");
  // 登记人不能自行核验
  assert.throws(
    () => svc.verifyTempChange({ change_id, verified_by: "staff-zhang", at: at("15:00") }),
    (err) => err instanceof DomainError && err.code === "VERIFIER_MUST_DIFFER",
  );
  // 第二名工作人员回拨核验通过
  assert.equal(svc.verifyTempChange({ change_id, verified_by: "staff-li", method: "CALLBACK", at: at("15:05") }).ok, true);
  const done = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "aunt-wang", staff_id: "staff-zhang", at: at("16:30"),
  });
  assert.equal(done.ok, true);
  assert.equal(done.event.payload.decision_basis.matched_source, "TEMP_CHANGE");
  assert.deepEqual(done.event.payload.decision_basis.temp_change_ids, [change_id]);
});

test("二次核验逾期：变更失效并升级保障负责人", () => {
  const svc = makeService();
  seedBase(svc);
  const { change_id } = svc.requestTempChange({
    child_id: "child-yu", kind: "ADD_DELEGATE",
    content: { person_id: "aunt-wang", name: "王阿姨", relation: "邻居", valid_from: at("16:00"), valid_until: at("17:30") },
    requested_by: "mom-yu", recorded_by: "staff-zhang", verify_deadline: at("15:00"), at: at("14:30"),
  });
  const result = svc.verifyTempChange({ change_id, verified_by: "staff-li", at: at("15:30") });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "VERIFICATION_EXPIRED");
  assert.equal(svc.tempChangeView(change_id).status, "EXPIRED");
  const escalation = svc.store.events.find((e) => e.event_type === "CASE_ESCALATED" && e.payload.kind === "VERIFICATION_OVERDUE");
  assert.equal(escalation.payload.ref_id, change_id);
  // 失效后临时代接人按陌生人处理：拒绝并冻结
  const refused = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "aunt-wang", staff_id: "staff-zhang", at: at("16:30"),
  });
  assert.equal(refused.reason, "UNKNOWN_PERSON");
  assert.deepEqual(svc.sessionView("sess-a").frozen_deliveries, ["child-yu"]);
});

test("陌生人接领触发冻结与升级，但不阻断其他家庭", () => {
  const svc = makeService();
  seedBase(svc);
  const result = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "stranger-1", staff_id: "staff-zhang", at: at("16:40"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNKNOWN_PERSON");
  assert.deepEqual(svc.sessionView("sess-a").frozen_deliveries, ["child-yu"]);
  assert.equal(svc.store.events.filter((e) => e.event_type === "CASE_ESCALATED").length, 1);
  const other = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-qing", person_id: "dad-qing", staff_id: "staff-li", at: at("16:45"),
  });
  assert.equal(other.ok, true);
});

test("断线重传同一回执被去重，不同人员重复接领被拒绝", () => {
  const svc = makeService();
  seedBase(svc);
  const first = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "mom-yu", staff_id: "staff-zhang", at: at("16:40"),
  });
  assert.equal(first.ok, true);
  const count = svc.store.events.length;
  const retry = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "mom-yu", staff_id: "staff-zhang", at: at("16:41"),
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduplicated, true);
  assert.equal(svc.store.events.length, count);
  const another = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "grandpa-yu", staff_id: "staff-zhang", at: at("16:45"),
  });
  assert.equal(another.ok, false);
  assert.equal(another.reason, "CHILD_NOT_PRESENT");
});
