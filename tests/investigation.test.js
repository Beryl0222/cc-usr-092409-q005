import assert from "node:assert/strict";
import test from "node:test";

import { at, makeService, seedBase, seedTransferTargets } from "./helpers.js";

async function seedRelay(svc) {
  seedBase(svc);
  seedTransferTargets(svc);
  await svc.requestTransfer({
    transfer_id: "tr-1", child_id: "child-yu", from_session_id: "sess-a", to_session_id: "sess-b",
    reason: "家长临时调到乙点", requested_by: "mom-yu", at: at("14:30"),
  });
  await svc.approveTransfer({ transfer_id: "tr-1", approved_by: "staff-wang", at: at("14:35") });
  await svc.executeTransfer({ transfer_id: "tr-1", escorted_by: "staff-zhang", at: at("15:00") });
  svc.attemptPickup({ session_id: "sess-b", child_id: "child-yu", person_id: "grandpa-yu", staff_id: "staff-zhao", at: at("16:45") });
  const notice = svc.store.events.find((e) => e.event_type === "NOTIFICATION_SENT" && e.payload.kind === "TRANSFER_NOTICE");
  svc.acknowledgeNotification({ notification_id: notice.payload.notification_id, acknowledged_by: "mom-yu", at: at("17:10") });
}

test("按当时视角还原：谁批准地点变化、现场谁负责、向谁交付、哪些通知未确认", async () => {
  const svc = makeService();
  await seedRelay(svc);

  // 14:40 视角：调班已批准未执行，儿童在甲点，尚无通知
  const during = svc.investigate("child-yu", at("14:40"));
  assert.equal(during.location_changes[0].status, "APPROVED");
  assert.equal(during.location_changes[0].approved_by, "staff-wang");
  assert.equal(during.location_changes[0].requested_by, "mom-yu");
  assert.deepEqual(
    during.presence.map((p) => [p.session_id, p.checked_out_at]),
    [["sess-a", null]],
  );
  assert.equal(during.deliveries.length, 0);
  assert.equal(during.notifications.length, 0);

  // 16:00 视角：接力完成，儿童在乙点，调班通知尚未确认
  const after = svc.investigate("child-yu", at("16:00"));
  assert.equal(after.location_changes[0].status, "COMPLETED");
  assert.equal(after.location_changes[0].escorted_by, "staff-zhang");
  assert.deepEqual(
    after.presence.map((p) => [p.session_id, Boolean(p.checked_out_at)]),
    [["sess-a", true], ["sess-b", false]],
  );
  const transferNotice = after.notifications.find((n) => n.kind === "TRANSFER_NOTICE");
  assert.equal(transferNotice.status, "UNCONFIRMED");
  assert.deepEqual(after.unconfirmed_notifications, [transferNotice.notification_id]);
  // 现场责任：甲点负责人张敏，乙点负责人赵敏
  const leadA = after.responsible_staff.find((s) => s.session_id === "sess-a").staff.find((s) => s.role === "LEAD");
  const leadB = after.responsible_staff.find((s) => s.session_id === "sess-b").staff.find((s) => s.role === "LEAD");
  assert.equal(leadA.name, "张敏");
  assert.equal(leadB.name, "赵敏");

  // 18:00 视角：交付完成，调班通知已确认，接送确认通知仍未确认
  const end = svc.investigate("child-yu", at("18:00"));
  assert.equal(end.deliveries.length, 1);
  assert.equal(end.deliveries[0].delivered_to, "grandpa-yu");
  assert.equal(end.deliveries[0].released_by, "staff-zhao");
  assert.equal(end.deliveries[0].session_id, "sess-b");
  assert.equal(end.deliveries[0].decision_basis.delegation_version, 1);
  const byKind = Object.fromEntries(end.notifications.map((n) => [n.kind, n]));
  assert.equal(byKind.TRANSFER_NOTICE.status, "ACKNOWLEDGED");
  assert.equal(byKind.PICKUP_CONFIRMATION.status, "UNCONFIRMED");
  assert.deepEqual(end.unconfirmed_notifications, [byKind.PICKUP_CONFIRMATION.notification_id]);
});

test("调查视角中的待核事项与升级记录", async () => {
  const svc = makeService();
  seedBase(svc);
  svc.requestTempChange({
    change_id: "chg-1", child_id: "child-yu", kind: "ADD_DELEGATE",
    content: { person_id: "aunt-wang", name: "王阿姨", relation: "邻居", valid_from: at("16:00"), valid_until: at("17:30") },
    requested_by: "mom-yu", recorded_by: "staff-zhang", verify_deadline: at("15:00"), at: at("14:30"),
  });
  svc.recover({ at: at("16:00") });
  const inv = svc.investigate("child-yu", at("16:30"));
  // 16:30 时变更已逾期失效，不再处于待核；升级记录可见
  assert.equal(inv.pending_verifications.length, 0);
  assert.ok(inv.escalations.some((e) => e.kind === "VERIFICATION_OVERDUE"));
  // 14:45 当时视角：变更仍在待核，尚无升级
  const earlier = svc.investigate("child-yu", at("14:45"));
  assert.deepEqual(earlier.pending_verifications.map((p) => p.change_id), ["chg-1"]);
  assert.equal(earlier.escalations.length, 0);
});
