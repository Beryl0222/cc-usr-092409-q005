import assert from "node:assert/strict";
import test from "node:test";

import { at, makeService, seedBase } from "./helpers.js";

test("代接人撤回即时生效，不受课程冻结快照限制", () => {
  const svc = makeService();
  seedBase(svc);
  // 课程在 13:30 冻结，当日授权快照记录代接文书第 1 版
  assert.equal(svc.sessionView("sess-a").frozen.auth_snapshot["child-yu"].delegation, 1);
  // 15:00 监护人撤回爷爷
  svc.withdrawDelegate({ child_id: "child-yu", person_id: "grandpa-yu", withdrawn_by: "mom-yu", reason: "行程变更", at: at("15:00") });
  // 16:45 爷爷到场，虽在冻结快照内仍被拒绝
  const result = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "grandpa-yu", staff_id: "staff-zhang", at: at("16:45"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DELEGATE_WITHDRAWN");
  // 快照仍保留当日基线，供事后调查对照
  assert.equal(svc.sessionView("sess-a").frozen.auth_snapshot["child-yu"].delegation, 1);
});

test("撤回后重新登记授权（新版本）恢复有效", () => {
  const svc = makeService();
  seedBase(svc);
  svc.withdrawDelegate({ child_id: "child-yu", person_id: "grandpa-yu", withdrawn_by: "mom-yu", reason: "行程变更", at: at("15:00") });
  const recorded = svc.recordDelegation({
    child_id: "child-yu",
    delegates: [
      { person_id: "grandpa-yu", name: "周爷爷", relation: "祖父", valid_from: at("16:30"), valid_until: at("17:00") },
    ],
    at: at("16:00"),
  });
  // 撤回本身也是文书历史的一个版本：v1 登记、v2 撤回、v3 重新登记
  assert.equal(recorded.version, 3);
  const result = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-yu", person_id: "grandpa-yu", staff_id: "staff-zhang", at: at("16:45"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.event.payload.decision_basis.delegation_version, 3);
});

test("代接范围限定接送点时，跨点接领被拒绝", () => {
  const svc = makeService();
  seedBase(svc);
  svc.recordDelegation({
    child_id: "child-qing",
    delegates: [
      { person_id: "aunt-qing", name: "林姑姑", relation: "姑姑", valid_from: at("16:00"), valid_until: at("18:00"), sites: ["site-b"] },
    ],
    at: at("09:00"),
  });
  const result = svc.attemptPickup({
    session_id: "sess-a", child_id: "child-qing", person_id: "aunt-qing", staff_id: "staff-zhang", at: at("16:30"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SITE_NOT_IN_SCOPE");
});
