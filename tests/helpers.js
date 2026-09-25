import { SafeguardingService } from "../src/service.js";
import { EventStore } from "../src/store.js";

export const DAY = "2026-09-25";
export const at = (hhmm) => `${DAY}T${hhmm}:00+08:00`;

export function makeService(options = {}) {
  const { store = new EventStore(), ...rest } = options;
  return new SafeguardingService({ store, ...rest });
}

/**
 * 基础场景：甲点课程 sess-a，名册小宇、小晴；
 * 小宇监护人妈妈，代接人爷爷（16:30–17:00 窗口），紧急联系人妈妈与舅舅。
 */
export function seedBase(svc) {
  svc.registerSite({ site_id: "site-a", name: "甲点", capacity: 10, supported_needs: ["WHEELCHAIR"], at: at("08:00") });
  svc.registerSite({ site_id: "site-b", name: "乙点", capacity: 5, supported_needs: ["WHEELCHAIR"], at: at("08:00") });
  svc.clearStaff({ staff_id: "staff-zhang", name: "张敏", qualifications: ["FIRST_AID"], roles: ["LEAD"], at: at("08:00") });
  svc.clearStaff({ staff_id: "staff-li", name: "李强", qualifications: ["WHEELCHAIR"], roles: ["STAFF"], at: at("08:00") });
  svc.clearStaff({ staff_id: "staff-wang", name: "王岚", qualifications: [], roles: ["SAFEGUARDING_LEAD"], at: at("08:00") });
  svc.confirmEnrollment({ child_id: "child-yu", name: "小宇", special_support: ["WHEELCHAIR"], at: at("08:00") });
  svc.confirmEnrollment({ child_id: "child-qing", name: "小晴", special_support: [], at: at("08:00") });
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
    contacts: [
      { person_id: "mom-yu", name: "陈静", relation: "母亲", phone: "13800000001" },
      { person_id: "uncle-yu", name: "陈舅舅", relation: "舅舅", phone: "13800000002" },
    ],
    at: at("08:00"),
  });
  svc.recordGuardianship({
    child_id: "child-qing",
    guardians: [{ person_id: "dad-qing", name: "林父", relation: "父亲", phone: "13800000003" }],
    at: at("08:00"),
  });
  svc.recordEmergencyContacts({
    child_id: "child-qing",
    contacts: [{ person_id: "dad-qing", name: "林父", relation: "父亲", phone: "13800000003" }],
    at: at("08:00"),
  });
  svc.freezeSession({
    session_id: "sess-a",
    site_id: "site-a",
    date: DAY,
    window: { start: at("14:00"), end: at("17:00") },
    staff: [
      { staff_id: "staff-zhang", role: "LEAD" },
      { staff_id: "staff-li", role: "SUPPORT" },
    ],
    roster: ["child-yu", "child-qing"],
    at: at("13:30"),
  });
  svc.checkIn({ session_id: "sess-a", child_id: "child-yu", received_by: "staff-zhang", at: at("13:55") });
  svc.checkIn({ session_id: "sess-a", child_id: "child-qing", received_by: "staff-zhang", at: at("13:56") });
}

/** 跨点调班目标：乙点 sess-b（资质齐全）、丙点 sess-c（缺资质）、丁点 sess-d（不支持特殊需求）。 */
export function seedTransferTargets(svc) {
  svc.registerSite({ site_id: "site-c", name: "丙点", capacity: 5, supported_needs: ["WHEELCHAIR"], at: at("08:00") });
  svc.registerSite({ site_id: "site-d", name: "丁点", capacity: 5, supported_needs: [], at: at("08:00") });
  svc.clearStaff({ staff_id: "staff-zhao", name: "赵敏", qualifications: ["WHEELCHAIR"], roles: ["LEAD"], at: at("08:00") });
  svc.clearStaff({ staff_id: "staff-qian", name: "钱进", qualifications: [], roles: ["LEAD"], at: at("08:00") });
  svc.clearStaff({ staff_id: "staff-sun", name: "孙华", qualifications: ["WHEELCHAIR"], roles: ["LEAD"], at: at("08:00") });
  svc.freezeSession({
    session_id: "sess-b", site_id: "site-b", date: DAY,
    window: { start: at("14:00"), end: at("17:30") },
    staff: [{ staff_id: "staff-zhao", role: "LEAD" }], roster: [], at: at("13:30"),
  });
  svc.freezeSession({
    session_id: "sess-c", site_id: "site-c", date: DAY,
    window: { start: at("14:00"), end: at("17:30") },
    staff: [{ staff_id: "staff-qian", role: "LEAD" }], roster: [], at: at("13:30"),
  });
  svc.freezeSession({
    session_id: "sess-d", site_id: "site-d", date: DAY,
    window: { start: at("14:00"), end: at("17:30") },
    staff: [{ staff_id: "staff-sun", role: "LEAD" }], roster: [], at: at("13:30"),
  });
}
