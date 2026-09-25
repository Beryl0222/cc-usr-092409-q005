/**
 * 生成 data/sample-relay.json：一条完整的跨点接力事件流，供联调与契约校验使用。
 * 用法：node scripts/build-sample.mjs
 */
import { writeFileSync } from "node:fs";

import { SafeguardingService } from "../src/service.js";

const DAY = "2026-09-25";
const at = (hhmm) => `${DAY}T${hhmm}:00+08:00`;

const svc = new SafeguardingService();

svc.registerSite({ site_id: "site-a", name: "甲点", capacity: 10, supported_needs: ["WHEELCHAIR"], at: at("08:00") });
svc.registerSite({ site_id: "site-b", name: "乙点", capacity: 5, supported_needs: ["WHEELCHAIR"], at: at("08:00") });
svc.clearStaff({ staff_id: "staff-zhang", name: "张敏", qualifications: ["FIRST_AID"], roles: ["LEAD"], at: at("08:00") });
svc.clearStaff({ staff_id: "staff-zhao", name: "赵敏", qualifications: ["WHEELCHAIR"], roles: ["LEAD"], at: at("08:00") });
svc.clearStaff({ staff_id: "staff-wang", name: "王岚", qualifications: [], roles: ["SAFEGUARDING_LEAD"], at: at("08:00") });
svc.confirmEnrollment({ child_id: "child-yu", name: "小宇", special_support: ["WHEELCHAIR"], at: at("08:00") });
svc.recordGuardianship({
  child_id: "child-yu",
  guardians: [{ person_id: "mom-yu", name: "陈静", relation: "母亲", phone: "13800000001" }],
  at: at("08:00"),
});
svc.recordDelegation({
  child_id: "child-yu",
  delegates: [
    { person_id: "grandpa-yu", name: "周爷爷", relation: "祖父", valid_from: at("16:30"), valid_until: at("17:00") },
  ],
  at: at("08:00"),
});
svc.recordEmergencyContacts({
  child_id: "child-yu",
  contacts: [{ person_id: "mom-yu", name: "陈静", relation: "母亲", phone: "13800000001" }],
  at: at("08:00"),
});
svc.freezeSession({
  session_id: "sess-a", site_id: "site-a", date: DAY,
  window: { start: at("14:00"), end: at("17:00") },
  staff: [{ staff_id: "staff-zhang", role: "LEAD" }], roster: ["child-yu"], at: at("13:30"),
});
svc.freezeSession({
  session_id: "sess-b", site_id: "site-b", date: DAY,
  window: { start: at("14:00"), end: at("17:30") },
  staff: [{ staff_id: "staff-zhao", role: "LEAD" }], roster: [], at: at("13:30"),
});
svc.checkIn({ session_id: "sess-a", child_id: "child-yu", received_by: "staff-zhang", at: at("13:55") });
await svc.requestTransfer({
  transfer_id: "tr-1", child_id: "child-yu", from_session_id: "sess-a", to_session_id: "sess-b",
  reason: "家长临时调到乙点", requested_by: "mom-yu", at: at("14:30"),
});
await svc.approveTransfer({ transfer_id: "tr-1", approved_by: "staff-wang", at: at("14:35") });
await svc.executeTransfer({ transfer_id: "tr-1", escorted_by: "staff-zhang", at: at("15:00") });
svc.attemptPickup({ session_id: "sess-b", child_id: "child-yu", person_id: "grandpa-yu", staff_id: "staff-zhao", at: at("16:45") });

const out = new URL("../data/sample-relay.json", import.meta.url);
writeFileSync(out, JSON.stringify(svc.store.events, null, 2) + "\n", "utf8");
console.log(`已写入 ${svc.store.events.length} 条事件到 data/sample-relay.json`);
