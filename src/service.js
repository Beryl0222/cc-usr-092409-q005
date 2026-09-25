import { randomUUID } from "node:crypto";

import { AGGREGATES as A, EVENT_TYPES as E } from "./events.js";
import { KeyedLock } from "./locks.js";
import { PolicyResolver } from "./policy.js";
import { EventStore } from "./store.js";

const ts = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();

/** 业务规则冲突：调用方可按 code 分支处理。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/**
 * 邻里课堂接送接力核心服务。
 *
 * 安全不变量：
 * 1. 四类保障文书（监护关系、代接范围、禁交付指令、紧急联系人）分别版本化，
 *    事件不可原地改写，更正产生后继版本。
 * 2. 每次课程冻结地点、时段、在岗人员与当日有效授权快照；安全类撤回
 *   （代接人撤回、禁交付指令）即时生效，不受快照限制。
 * 3. 跨点调班必须先确认接收点容量、工作人员资质与儿童特殊支持，
 *    同一名儿童同一时刻只能出现在一个点。
 * 4. 监护人临时变更必须二次核验（核验人≠登记人）；保护案件的禁交付
 *    优先于一切普通授权。
 * 5. 异常只冻结相关儿童的交付，不阻断其他家庭。
 * 6. 签到、调班、接送回执按稳定标识合并；内容变化保留待核；
 *    断线恢复后继续未完成的核验并升级逾期事项。
 */
export class SafeguardingService {
  constructor({
    store = new EventStore(),
    clock = () => new Date().toISOString(),
    idgen = (prefix) => `${prefix}-${randomUUID()}`,
    ackWindowMs = 30 * 60 * 1000,
    overdueGraceMs = 30 * 60 * 1000,
  } = {}) {
    this.store = store;
    this.clock = clock;
    this.idgen = idgen;
    this.ackWindowMs = ackWindowMs;
    this.overdueGraceMs = overdueGraceMs;
    this.locks = new KeyedLock();
    this.policy = new PolicyResolver(store.events);
  }

  // ------------------------------------------------------------------
  // 基础设施
  // ------------------------------------------------------------------

  #buildEvent(type, aggregateType, aggregateId, payload, at, summary, eventId = null) {
    return {
      event_id: eventId ?? this.idgen("evt"),
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: at ?? this.clock(),
      recorded_at: this.clock(),
      version: this.store.nextVersion(aggregateType, aggregateId),
      summary,
      payload,
    };
  }

  #emit(type, aggregateType, aggregateId, payload, at, summary, eventId = null) {
    const event = this.#buildEvent(type, aggregateType, aggregateId, payload, at, summary, eventId);
    this.store.append(event);
    return event;
  }

  #mustChild(childId) {
    const found = this.store.events.some(
      (e) => e.event_type === E.ENROLLMENT_CONFIRMED && e.payload?.child_id === childId,
    );
    if (!found) throw new DomainError("CHILD_NOT_FOUND", `未登记的儿童：${childId}`);
    return this.store.events.find(
      (e) => e.event_type === E.ENROLLMENT_CONFIRMED && e.payload?.child_id === childId,
    ).payload;
  }

  #staffRecord(staffId) {
    let record = null;
    for (const e of this.store.events) {
      if (e.event_type === E.STAFF_CLEARED && e.payload?.staff_id === staffId) record = e.payload;
    }
    return record;
  }

  #mustStaff(staffId) {
    const record = this.#staffRecord(staffId);
    if (!record) throw new DomainError("STAFF_NOT_CLEARED", `未通过资质审核的工作人员：${staffId}`);
    return record;
  }

  #staffHasRole(staffId, role) {
    return (this.#staffRecord(staffId)?.roles ?? []).includes(role);
  }

  #siteView(siteId) {
    let site = null;
    for (const e of this.store.events) {
      if (e.event_type === E.SITE_REGISTERED && e.payload?.site_id === siteId) site = e.payload;
    }
    return site;
  }

  #mustSite(siteId) {
    const site = this.#siteView(siteId);
    if (!site) throw new DomainError("SITE_NOT_FOUND", `未登记的接送点：${siteId}`);
    return site;
  }

  // ------------------------------------------------------------------
  // 登记类命令
  // ------------------------------------------------------------------

  registerSite({ site_id, name, capacity, supported_needs = [], at }) {
    if (!site_id || !name) throw new DomainError("INVALID", "接送点需要 site_id 与 name");
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new DomainError("INVALID", "接送点容量必须是正整数");
    }
    const event = this.#emit(
      E.SITE_REGISTERED, A.SITE, site_id,
      { site_id, name, capacity, supported_needs }, at, `登记接送点：${name}`,
    );
    return { ok: true, event };
  }

  confirmEnrollment({ child_id, name, special_support = [], at }) {
    if (!child_id || !name) throw new DomainError("INVALID", "儿童登记需要 child_id 与 name");
    const event = this.#emit(
      E.ENROLLMENT_CONFIRMED, A.CHILD, child_id,
      { child_id, name, special_support }, at, `登记儿童：${name}`,
    );
    return { ok: true, event };
  }

  clearStaff({ staff_id, name, qualifications = [], roles = [], valid_until = null, at }) {
    if (!staff_id || !name) throw new DomainError("INVALID", "工作人员登记需要 staff_id 与 name");
    const event = this.#emit(
      E.STAFF_CLEARED, A.STAFF, staff_id,
      { staff_id, name, qualifications, roles, valid_until }, at, `工作人员资质审核：${name}`,
    );
    return { ok: true, event };
  }

  // ------------------------------------------------------------------
  // 保障文书（分别版本化）
  // ------------------------------------------------------------------

  recordGuardianship({ child_id, guardians, at }) {
    this.#mustChild(child_id);
    if (!Array.isArray(guardians) || guardians.length === 0) {
      throw new DomainError("INVALID", "监护关系至少包含一名监护人");
    }
    const event = this.#emit(
      E.GUARDIANSHIP_RECORDED, A.POLICY, `policy:${child_id}:guardianship`,
      { child_id, guardians }, at, `登记监护关系（${guardians.length} 人）`,
    );
    return { ok: true, event, version: event.version };
  }

  recordDelegation({ child_id, delegates, at }) {
    this.#mustChild(child_id);
    for (const d of delegates ?? []) {
      if (!d.person_id || !d.valid_from || !d.valid_until) {
        throw new DomainError("INVALID", "代接人必须包含 person_id、valid_from、valid_until");
      }
    }
    const event = this.#emit(
      E.DELEGATION_RECORDED, A.POLICY, `policy:${child_id}:delegation`,
      { child_id, delegates: delegates ?? [] }, at, `登记代接范围（${(delegates ?? []).length} 人）`,
    );
    return { ok: true, event, version: event.version };
  }

  recordEmergencyContacts({ child_id, contacts, at }) {
    this.#mustChild(child_id);
    const event = this.#emit(
      E.EMERGENCY_CONTACTS_RECORDED, A.POLICY, `policy:${child_id}:contacts`,
      { child_id, contacts: contacts ?? [] }, at, `登记紧急联系人（${(contacts ?? []).length} 人）`,
    );
    return { ok: true, event, version: event.version };
  }

  /** 代接人撤回：即时生效，即使当日课程已冻结授权快照。 */
  withdrawDelegate({ child_id, person_id, withdrawn_by, reason, at }) {
    this.#mustChild(child_id);
    const event = this.#emit(
      E.DELEGATE_WITHDRAWN, A.POLICY, `policy:${child_id}:delegation`,
      { child_id, person_id, withdrawn_by, reason }, at, `撤回代接人：${person_id}`,
    );
    return { ok: true, event };
  }

  issueNoRelease({ child_id, order_id = null, target_person_id, source, reason, effective_from, effective_until = null, at }) {
    this.#mustChild(child_id);
    if (!["PROTECTION_CASE", "GUARDIAN"].includes(source)) {
      throw new DomainError("INVALID", "禁交付指令来源必须是 PROTECTION_CASE 或 GUARDIAN");
    }
    const id = order_id ?? this.idgen("nro");
    const event = this.#emit(
      E.NO_RELEASE_ISSUED, A.POLICY, `policy:${child_id}:norelease`,
      { child_id, order_id: id, target_person_id, source, reason, effective_from: effective_from ?? (at ?? this.clock()), effective_until },
      at, `禁交付指令：${target_person_id}（${source}）`,
    );
    return { ok: true, order_id: id, event };
  }

  liftNoRelease({ child_id, order_id, lifted_by, at }) {
    const order = this.store.events.find(
      (e) => e.event_type === E.NO_RELEASE_ISSUED && e.payload?.child_id === child_id && e.payload.order_id === order_id,
    )?.payload;
    if (!order) throw new DomainError("ORDER_NOT_FOUND", `未找到禁交付指令：${order_id}`);
    if (order.source === "PROTECTION_CASE" && !this.#staffHasRole(lifted_by, "SAFEGUARDING_LEAD")) {
      throw new DomainError("FORBIDDEN", "保护案件的禁交付指令只能由保障负责人解除");
    }
    const event = this.#emit(
      E.NO_RELEASE_LIFTED, A.POLICY, `policy:${child_id}:norelease`,
      { child_id, order_id, lifted_by }, at, `解除禁交付指令：${order_id}`,
    );
    return { ok: true, event };
  }

  // ------------------------------------------------------------------
  // 监护人临时变更（二次核验）
  // ------------------------------------------------------------------

  requestTempChange({ change_id = null, child_id, kind = "ADD_DELEGATE", content, requested_by, recorded_by, verify_deadline, at }) {
    this.#mustChild(child_id);
    this.#mustStaff(recorded_by);
    if (!verify_deadline) throw new DomainError("INVALID", "临时变更必须给出二次核验时限");
    if (kind === "ADD_DELEGATE") {
      if (!content?.person_id || !content?.valid_from || !content?.valid_until) {
        throw new DomainError("INVALID", "临时代接人必须包含 person_id、valid_from、valid_until");
      }
    }
    const id = change_id ?? this.idgen("chg");
    this.#emit(
      E.PICKUP_CHANGED, A.POLICY, `temp:${id}`,
      { change_id: id, child_id, kind, content, requested_by, recorded_by, verify_deadline },
      at, `临时接送变更申请（${kind}）`,
    );
    return { ok: true, change_id: id };
  }

  verifyTempChange({ change_id, verified_by, method = "CALLBACK", at }) {
    const change = this.policy.tempChange(change_id);
    if (!change) throw new DomainError("CHANGE_NOT_FOUND", `未找到临时变更：${change_id}`);
    this.#mustStaff(verified_by);
    if (verified_by === change.recorded_by) {
      throw new DomainError("VERIFIER_MUST_DIFFER", "二次核验人不能与登记人相同");
    }
    if (change.status === "VERIFIED") return { ok: true, deduplicated: true };
    if (change.status !== "PENDING") {
      throw new DomainError("NOT_PENDING", `临时变更当前状态为 ${change.status}，无法核验`);
    }
    const now = at ?? this.clock();
    if (ts(now) > ts(change.verify_deadline)) {
      this.#expireTempChange(change, now);
      return { ok: false, reason: "VERIFICATION_EXPIRED" };
    }
    this.#emit(
      E.TEMP_CHANGE_VERIFIED, A.POLICY, `temp:${change_id}`,
      { change_id, child_id: change.child_id, verified_by, method }, now, `临时变更二次核验通过（${method}）`,
    );
    return { ok: true };
  }

  rejectTempChange({ change_id, rejected_by, reason, at }) {
    const change = this.policy.tempChange(change_id);
    if (!change) throw new DomainError("CHANGE_NOT_FOUND", `未找到临时变更：${change_id}`);
    this.#mustStaff(rejected_by);
    if (change.status !== "PENDING") {
      throw new DomainError("NOT_PENDING", `临时变更当前状态为 ${change.status}，无法驳回`);
    }
    this.#emit(
      E.TEMP_CHANGE_REJECTED, A.POLICY, `temp:${change_id}`,
      { change_id, child_id: change.child_id, rejected_by, reason }, at, "临时变更被驳回",
    );
    return { ok: true };
  }

  #expireTempChange(change, at) {
    this.#emit(
      E.TEMP_CHANGE_EXPIRED, A.POLICY, `temp:${change.change_id}`,
      { change_id: change.change_id, child_id: change.child_id }, at, "临时变更核验逾期失效",
      `evt:temp-expired:${change.change_id}`,
    );
    this.#escalate({
      case_id: `case:VERIFICATION_OVERDUE:${change.change_id}`,
      child_id: change.child_id,
      kind: "VERIFICATION_OVERDUE",
      ref_id: change.change_id,
      detail: `临时变更 ${change.change_id} 超过二次核验时限 ${change.verify_deadline}`,
      at,
    });
  }

  // ------------------------------------------------------------------
  // 课程场次：冻结、签到、更正
  // ------------------------------------------------------------------

  freezeSession({ session_id, site_id, date, window, staff, roster, capacity = null, at }) {
    const site = this.#mustSite(site_id);
    if (this.#sessionState(session_id).frozen) {
      throw new DomainError("ALREADY_FROZEN", `课程 ${session_id} 已冻结，不能重复冻结`);
    }
    if (!window?.start || !window?.end) throw new DomainError("INVALID", "课程必须冻结时段");
    if (!Array.isArray(staff) || staff.length === 0) {
      throw new DomainError("INVALID", "课程必须冻结在岗人员");
    }
    if (!staff.some((s) => s.role === "LEAD")) {
      throw new DomainError("NO_SESSION_LEAD", "课程在岗人员中必须有一名现场负责人（LEAD）");
    }
    const cap = capacity ?? site.capacity;
    if (cap > site.capacity) {
      throw new DomainError("CAPACITY_EXCEEDED", "课程容量不能超过接送点容量");
    }
    for (const s of staff) {
      const record = this.#mustStaff(s.staff_id);
      if (record.valid_until && record.valid_until.slice(0, 10) < date) {
        throw new DomainError("STAFF_CLEARANCE_EXPIRED", `工作人员 ${s.staff_id} 的资质在课程日期前已过期`);
      }
    }
    const uniqueRoster = [...new Set(roster ?? [])];
    for (const childId of uniqueRoster) this.#mustChild(childId);
    const now = at ?? this.clock();
    const auth_snapshot = {};
    for (const childId of uniqueRoster) {
      auth_snapshot[childId] = {
        guardianship: this.policy.docVersion(childId, "guardianship", now),
        delegation: this.policy.docVersion(childId, "delegation", now),
        contacts: this.policy.docVersion(childId, "contacts", now),
      };
    }
    const event = this.#emit(
      E.SESSION_FROZEN, A.SESSION, session_id,
      { session_id, site_id, date, window, staff, roster: uniqueRoster, capacity: cap, auth_snapshot },
      now, `冻结课程：${site.name} ${date}（名册 ${uniqueRoster.length} 人）`,
    );
    return { ok: true, event };
  }

  #transferredIn(sessionId, childId) {
    return this.store.events.some(
      (e) => e.event_type === E.TRANSFER_COMPLETED && e.payload?.to_session_id === sessionId && e.payload.child_id === childId,
    );
  }

  /** 签到：按稳定标识 checkin:{session}:{child} 合并；内容变化保留待核。 */
  checkIn({ session_id, child_id, received_by, at, note = null }) {
    const session = this.#sessionState(session_id);
    if (!session.frozen) throw new DomainError("SESSION_NOT_FROZEN", `课程 ${session_id} 尚未冻结`);
    if (session.closed) throw new DomainError("SESSION_CLOSED", `课程 ${session_id} 已结束`);
    if (!session.frozen.staff.some((s) => s.staff_id === received_by)) {
      throw new DomainError("STAFF_NOT_ON_DUTY", "签到接收人不在当次课程在岗名单中");
    }
    const rostered =
      session.frozen.roster.includes(child_id) || this.#transferredIn(session_id, child_id);
    if (!rostered) throw new DomainError("CHILD_NOT_ROSTERED", `儿童 ${child_id} 不在当次课程名册中`);
    const now = at ?? this.clock();
    const presence = this.#presenceAt(child_id, now);
    if (presence && presence.session_id !== session_id) {
      return { ok: false, reason: "PRESENT_ELSEWHERE", presence };
    }
    const stableId = `checkin:${session_id}:${child_id}`;
    const existing = session.checkins.get(child_id);
    if (existing) {
      if (existing.payload.received_by === received_by && (existing.payload.note ?? null) === note) {
        return { ok: true, deduplicated: true, event: existing };
      }
      const event = this.#emit(
        E.CHILD_CHECKED_IN, A.SESSION, session_id,
        { session_id, child_id, received_by, note, stable_id: stableId, status: "PENDING_VERIFICATION", supersedes: existing.event_id, recorded_by: received_by },
        now, `签到内容变更待核验：${child_id}`,
      );
      return { ok: true, pending_verification: true, event };
    }
    const event = this.#emit(
      E.CHILD_CHECKED_IN, A.SESSION, session_id,
      { session_id, child_id, received_by, note, stable_id: stableId, status: "EFFECTIVE" },
      now, `儿童签到：${child_id}`,
    );
    return { ok: true, event };
  }

  /** 对已生效的签到/回执提出更正：保留待核，核验通过前原记录继续有效。 */
  correctRecord({ stable_id, content, recorded_by, at }) {
    const [kind, sessionId, childId] = stable_id.split(":");
    if (!["checkin", "checkout"].includes(kind)) {
      throw new DomainError("INVALID", `不支持的记录标识：${stable_id}`);
    }
    this.#mustStaff(recorded_by);
    const session = this.#sessionState(sessionId);
    const existing = (kind === "checkin" ? session.checkins : session.checkouts).get(childId);
    if (!existing) throw new DomainError("RECORD_NOT_FOUND", `未找到可更正的记录：${stable_id}`);
    const type = kind === "checkin" ? E.CHILD_CHECKED_IN : E.CHILD_CHECKED_OUT;
    const event = this.#emit(
      type, A.SESSION, sessionId,
      { ...existing.payload, ...content, session_id: sessionId, child_id: childId, stable_id, status: "PENDING_VERIFICATION", supersedes: existing.event_id, recorded_by },
      at, `记录更正待核验：${stable_id}`,
    );
    return { ok: true, pending_verification: true, event };
  }

  verifyRecordRevision({ stable_id, verified_by, at }) {
    const [, sessionId] = stable_id.split(":");
    this.#mustStaff(verified_by);
    const session = this.#sessionState(sessionId);
    const pending = session.pendingRevisions.find((e) => e.payload?.stable_id === stable_id);
    if (!pending) throw new DomainError("REVISION_NOT_FOUND", `没有待核验的修订：${stable_id}`);
    if (pending.payload.recorded_by === verified_by) {
      throw new DomainError("VERIFIER_MUST_DIFFER", "核验人不能与修订提交人相同");
    }
    this.#emit(
      E.RECORD_REVISION_VERIFIED, A.SESSION, sessionId,
      { stable_id, session_id: sessionId, revision_event_id: pending.event_id, verified_by },
      at, `记录修订核验通过：${stable_id}`,
    );
    return { ok: true };
  }

  rejectRecordRevision({ stable_id, rejected_by, reason, at }) {
    const [, sessionId] = stable_id.split(":");
    this.#mustStaff(rejected_by);
    const session = this.#sessionState(sessionId);
    const pending = session.pendingRevisions.find((e) => e.payload?.stable_id === stable_id);
    if (!pending) throw new DomainError("REVISION_NOT_FOUND", `没有待核验的修订：${stable_id}`);
    this.#emit(
      E.RECORD_REVISION_REJECTED, A.SESSION, sessionId,
      { stable_id, session_id: sessionId, revision_event_id: pending.event_id, rejected_by, reason },
      at, `记录修订被驳回：${stable_id}`,
    );
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // 接送交付
  // ------------------------------------------------------------------

  /**
   * 交付尝试。返回 { ok: true, event } 或 { ok: false, reason, event }。
   * 命中禁交付或陌生人时自动冻结该儿童交付并升级，不影响其他家庭。
   */
  attemptPickup({ session_id, child_id, person_id, staff_id, at, note = null }) {
    const now = at ?? this.clock();
    const session = this.#sessionState(session_id);
    if (!session.frozen) throw new DomainError("SESSION_NOT_FROZEN", `课程 ${session_id} 尚未冻结`);
    if (session.closed) throw new DomainError("SESSION_CLOSED", `课程 ${session_id} 已结束`);
    if (!session.frozen.staff.some((s) => s.staff_id === staff_id)) {
      throw new DomainError("STAFF_NOT_ON_DUTY", "交付经办人不在当次课程在岗名单中");
    }
    const checkin = session.checkins.get(child_id);
    const checkout = session.checkouts.get(child_id);
    if (!checkin || checkout) {
      if (
        checkout &&
        checkout.payload.handed_to?.type === "PERSON" &&
        checkout.payload.handed_to.person_id === person_id &&
        checkout.payload.released_by === staff_id
      ) {
        return { ok: true, deduplicated: true, event: checkout };
      }
      return this.#refuse(session, { child_id, person_id, staff_id, reason: "CHILD_NOT_PRESENT", at: now });
    }
    if (session.frozenDeliveries.has(child_id)) {
      return this.#refuse(session, { child_id, person_id, staff_id, reason: "DELIVERY_FROZEN", at: now });
    }

    const auth = this.policy.resolve(child_id, now);
    const order = auth.no_release.find((o) => o.target_person_id === person_id);
    if (order) {
      const refusal = this.#refuse(session, {
        child_id, person_id, staff_id, reason: "NO_RELEASE_MATCH",
        detail: { order_id: order.order_id, source: order.source }, at: now,
      });
      this.#freezeDelivery(session, child_id, `命中禁交付指令 ${order.order_id}`, staff_id, now);
      return refusal;
    }

    const guardian = auth.guardianship.guardians.find((g) => g.person_id === person_id);
    const delegate = guardian ? null : auth.delegates.find((d) => d.person_id === person_id);
    if (guardian || delegate) {
      if (delegate) {
        if (delegate.sites?.length && !delegate.sites.includes(session.frozen.site_id)) {
          return this.#refuse(session, { child_id, person_id, staff_id, reason: "SITE_NOT_IN_SCOPE", at: now });
        }
        if (ts(now) < ts(delegate.valid_from) || ts(now) > ts(delegate.valid_until)) {
          return this.#refuse(session, {
            child_id, person_id, staff_id, reason: "OUTSIDE_VALID_WINDOW",
            detail: { valid_from: delegate.valid_from, valid_until: delegate.valid_until }, at: now,
          });
        }
      }
      const basis = {
        matched: guardian ? "GUARDIAN" : "DELEGATE",
        matched_source: guardian ? "GUARDIANSHIP" : delegate.source,
        guardianship_version: auth.guardianship.version,
        delegation_version: auth.delegation_version,
        temp_change_ids: delegate?.source === "TEMP_CHANGE" ? [delegate.change_id] : [],
        no_release_checked: auth.no_release.map((o) => o.order_id),
      };
      return this.#completePickup(session, { child_id, person_id, staff_id, basis, at: now, note });
    }

    const pending = this.policy
      .tempChangesFor(child_id, now)
      .find((c) => c.status === "PENDING" && c.content?.person_id === person_id);
    if (pending) {
      return this.#refuse(session, {
        child_id, person_id, staff_id, reason: "PENDING_VERIFICATION",
        detail: { change_id: pending.change_id }, at: now,
      });
    }
    if (this.#wasDelegateWithdrawn(child_id, person_id, now)) {
      return this.#refuse(session, { child_id, person_id, staff_id, reason: "DELEGATE_WITHDRAWN", at: now });
    }
    const refusal = this.#refuse(session, { child_id, person_id, staff_id, reason: "UNKNOWN_PERSON", at: now });
    this.#freezeDelivery(session, child_id, `陌生人尝试接领：${person_id}`, staff_id, now);
    return refusal;
  }

  #completePickup(session, { child_id, person_id, staff_id, basis, at, note }) {
    const sessionId = session.frozen.session_id;
    const event = this.#emit(
      E.CHILD_CHECKED_OUT, A.SESSION, sessionId,
      {
        session_id: sessionId, child_id,
        handed_to: { type: "PERSON", person_id },
        released_by: staff_id, note,
        stable_id: `checkout:${sessionId}:${child_id}`, status: "EFFECTIVE",
        decision_basis: basis,
      },
      at, `交付儿童 ${child_id} 给 ${person_id}`,
    );
    this.#notifyGuardians(child_id, "PICKUP_CONFIRMATION", event.event_id, at, {
      session_id: sessionId, delivered_to: person_id,
    });
    return { ok: true, event };
  }

  #refuse(session, { child_id, person_id, staff_id, reason, detail = null, at }) {
    const event = this.#emit(
      E.PICKUP_REFUSED, A.SESSION, session.frozen.session_id,
      { session_id: session.frozen.session_id, child_id, person_id, staff_id, reason, detail },
      at, `拒绝交付：${child_id} → ${person_id}（${reason}）`,
    );
    return { ok: false, reason, event };
  }

  #freezeDelivery(session, childId, reason, by, at) {
    const sessionId = session.frozen.session_id;
    this.#emit(
      E.DELIVERY_FROZEN, A.SESSION, sessionId,
      { session_id: sessionId, child_id: childId, reason, frozen_by: by },
      at, `冻结交付：${childId}`,
    );
    this.#escalate({
      case_id: `case:DELIVERY_BLOCKED:${sessionId}:${childId}`,
      child_id: childId,
      kind: "DELIVERY_BLOCKED",
      ref_id: `${sessionId}:${childId}`,
      detail: reason,
      at,
    });
  }

  unfreezeDelivery({ session_id, child_id, by, note = null, at }) {
    const session = this.#sessionState(session_id);
    if (!session.frozenDeliveries.has(child_id)) {
      throw new DomainError("NOT_FROZEN", `儿童 ${child_id} 的交付未处于冻结状态`);
    }
    const isLead = session.frozen?.staff.some((s) => s.staff_id === by && s.role === "LEAD");
    if (!isLead && !this.#staffHasRole(by, "SAFEGUARDING_LEAD")) {
      throw new DomainError("FORBIDDEN", "只有现场负责人或保障负责人可以解除交付冻结");
    }
    const event = this.#emit(
      E.DELIVERY_UNFROZEN, A.SESSION, session_id,
      { session_id, child_id, unfrozen_by: by, note }, at, `解除交付冻结：${child_id}`,
    );
    return { ok: true, event };
  }

  #wasDelegateWithdrawn(childId, personId, at) {
    const docs = this.store.events.filter(
      (e) => e.event_type === E.DELEGATION_RECORDED && e.payload?.child_id === childId && ts(e.occurred_at) <= ts(at),
    );
    const lastWith = docs.filter((d) => d.payload.delegates.some((x) => x.person_id === personId)).pop();
    if (!lastWith) return false;
    const newerWithout = docs.find((d) => ts(d.occurred_at) > ts(lastWith.occurred_at));
    if (newerWithout) return false;
    return this.store.events.some(
      (e) =>
        e.event_type === E.DELEGATE_WITHDRAWN &&
        e.payload?.child_id === childId &&
        e.payload.person_id === personId &&
        ts(e.occurred_at) >= ts(lastWith.occurred_at) &&
        ts(e.occurred_at) <= ts(at),
    );
  }

  // ------------------------------------------------------------------
  // 跨点调班
  // ------------------------------------------------------------------

  async requestTransfer({ transfer_id = null, child_id, from_session_id, to_session_id, reason, requested_by, at }) {
    this.#mustChild(child_id);
    if (from_session_id === to_session_id) {
      throw new DomainError("SAME_SESSION", "调出与调入课程不能相同");
    }
    const id = transfer_id ?? this.idgen("tr");
    return this.locks.run([`child:${child_id}`], async () => {
      const from = this.#sessionState(from_session_id);
      const to = this.#sessionState(to_session_id);
      if (!from.frozen || !to.frozen) {
        throw new DomainError("SESSION_NOT_FROZEN", "调出与调入课程都必须已冻结");
      }
      if (from.frozen.date !== to.frozen.date) {
        throw new DomainError("CROSS_DAY_UNSUPPORTED", "仅支持当日跨点调班");
      }
      const rostered =
        from.frozen.roster.includes(child_id) ||
        from.checkins.has(child_id) ||
        this.#transferredIn(from_session_id, child_id);
      if (!rostered) {
        throw new DomainError("CHILD_NOT_IN_SOURCE", `儿童 ${child_id} 不在调出课程名册中`);
      }
      const open = this.#openTransferFor(child_id);
      if (open) {
        return { ok: false, reason: "TRANSFER_CONFLICT", existing_transfer_id: open.transfer_id };
      }
      this.#emit(
        E.TRANSFER_REQUESTED, A.TRANSFER, id,
        { transfer_id: id, child_id, from_session_id, to_session_id, reason, requested_by },
        at, `申请跨点调班：${child_id}（${from_session_id} → ${to_session_id}）`,
      );
      return { ok: true, transfer_id: id };
    });
  }

  /** 批准调班：必须由保障负责人批准，批准前确认容量、资质与特殊支持。 */
  async approveTransfer({ transfer_id, approved_by, at }) {
    const view = this.#transferView(transfer_id);
    if (!view) throw new DomainError("TRANSFER_NOT_FOUND", `未找到调班：${transfer_id}`);
    if (!this.#staffHasRole(approved_by, "SAFEGUARDING_LEAD")) {
      throw new DomainError("FORBIDDEN", "跨点调班必须由保障负责人批准");
    }
    return this.locks.run([`child:${view.child_id}`, `session:${view.to_session_id}`], async () => {
      const now = at ?? this.clock();
      const current = this.#transferView(transfer_id);
      if (current.status !== "REQUESTED") {
        return { ok: false, reason: "TRANSFER_NOT_OPEN", status: current.status };
      }
      const checks = this.#transferChecks(current, now);
      if (!checks.ok) {
        this.#emit(
          E.TRANSFER_REJECTED, A.TRANSFER, transfer_id,
          { transfer_id, child_id: current.child_id, reason: checks.reason, detail: checks.detail ?? null, rejected_by: approved_by, stage: "APPROVE" },
          now, `调班被拒：${checks.reason}`,
        );
        return { ok: false, reason: checks.reason, detail: checks.detail ?? null };
      }
      this.#emit(
        E.TRANSFER_APPROVED, A.TRANSFER, transfer_id,
        { transfer_id, child_id: current.child_id, approved_by, checks: checks.detail },
        now, `调班批准：${transfer_id}`,
      );
      return { ok: true };
    });
  }

  /** 执行接力：调出签退与调入签到成批落盘，任一环节失败则整批不生效。 */
  async executeTransfer({ transfer_id, escorted_by, at }) {
    const view = this.#transferView(transfer_id);
    if (!view) throw new DomainError("TRANSFER_NOT_FOUND", `未找到调班：${transfer_id}`);
    const keys = [`child:${view.child_id}`, `session:${view.from_session_id}`, `session:${view.to_session_id}`];
    return this.locks.run(keys, async () => {
      const now = at ?? this.clock();
      const current = this.#transferView(transfer_id);
      if (current.status === "COMPLETED") return { ok: false, reason: "TRANSFER_ALREADY_COMPLETED" };
      if (current.status !== "APPROVED") {
        return { ok: false, reason: "TRANSFER_NOT_APPROVED", status: current.status };
      }
      const from = this.#sessionState(current.from_session_id);
      if (from.checkouts.has(current.child_id)) {
        return { ok: false, reason: "CHILD_ALREADY_RELEASED" };
      }
      if (!from.frozen.staff.some((s) => s.staff_id === escorted_by)) {
        throw new DomainError("STAFF_NOT_ON_DUTY", "交接护送人须为调出课程在岗人员");
      }
      const checks = this.#transferChecks(current, now);
      if (!checks.ok) {
        this.#emit(
          E.TRANSFER_REJECTED, A.TRANSFER, transfer_id,
          { transfer_id, child_id: current.child_id, reason: checks.reason, detail: checks.detail ?? null, rejected_by: "SYSTEM", stage: "EXECUTE" },
          now, `调班执行前复核未通过：${checks.reason}`,
        );
        return { ok: false, reason: checks.reason, detail: checks.detail ?? null };
      }
      const childId = current.child_id;
      const outEvent = this.#buildEvent(
        E.CHILD_CHECKED_OUT, A.SESSION, current.from_session_id,
        {
          session_id: current.from_session_id, child_id: childId,
          handed_to: { type: "TRANSFER", transfer_id, escorted_by },
          released_by: escorted_by, note: null,
          stable_id: `checkout:${current.from_session_id}:${childId}`, status: "EFFECTIVE",
        },
        now, `调班调出：${childId}`,
      );
      const inEvent = this.#buildEvent(
        E.CHILD_CHECKED_IN, A.SESSION, current.to_session_id,
        {
          session_id: current.to_session_id, child_id: childId, received_by: escorted_by,
          note: null, via_transfer: transfer_id,
          stable_id: `checkin:${current.to_session_id}:${childId}`, status: "EFFECTIVE",
        },
        now, `调班调入：${childId}`,
      );
      const doneEvent = this.#buildEvent(
        E.TRANSFER_COMPLETED, A.TRANSFER, transfer_id,
        {
          transfer_id, child_id: childId,
          from_session_id: current.from_session_id, to_session_id: current.to_session_id,
          checkout_event: outEvent.event_id, checkin_event: inEvent.event_id, escorted_by,
        },
        now, `跨点接力完成：${childId}`,
      );
      const movedEvent = this.#buildEvent(
        E.SESSION_REASSIGNED, A.CHILD, childId,
        { child_id: childId, from_session_id: current.from_session_id, to_session_id: current.to_session_id, transfer_id },
        now, `儿童当日课程变更：${childId}`,
      );
      this.store.appendAll([outEvent, inEvent, doneEvent, movedEvent]);
      this.#notifyGuardians(childId, "TRANSFER_NOTICE", doneEvent.event_id, now, { transfer_id });
      return { ok: true };
    });
  }

  #transferChecks(transfer, at) {
    const child = this.#mustChild(transfer.child_id);
    const to = this.#sessionState(transfer.to_session_id);
    const needs = child.special_support ?? [];
    // 容量：名册 + 已批准/已完成的调入 − 已完成的调出（按调班单去重）
    const incomingIds = new Set();
    for (const e of this.store.events) {
      if (e.event_type !== E.TRANSFER_APPROVED && e.event_type !== E.TRANSFER_COMPLETED) continue;
      const id = e.payload?.transfer_id;
      if (id && id !== transfer.transfer_id) incomingIds.add(id);
    }
    let incoming = 0;
    for (const id of incomingIds) {
      const v = this.#transferView(id);
      if (v && v.to_session_id === transfer.to_session_id && ["APPROVED", "COMPLETED"].includes(v.status)) {
        incoming += 1;
      }
    }
    const outgoing = this.store.events.filter(
      (e) => e.event_type === E.TRANSFER_COMPLETED && e.payload?.from_session_id === transfer.to_session_id,
    ).length;
    const headcount = to.frozen.roster.length + incoming - outgoing;
    if (headcount >= to.frozen.capacity) {
      return { ok: false, reason: "CAPACITY_FULL", detail: { headcount, capacity: to.frozen.capacity } };
    }
    // 工作人员资质覆盖儿童特殊支持
    const quals = new Set();
    for (const s of to.frozen.staff) {
      for (const q of this.#staffRecord(s.staff_id)?.qualifications ?? []) quals.add(q);
    }
    const missingQuals = needs.filter((n) => !quals.has(n));
    if (missingQuals.length > 0) {
      return { ok: false, reason: "STAFF_QUALIFICATION_INSUFFICIENT", detail: { missing: missingQuals } };
    }
    // 接收点支持儿童特殊需求
    const site = this.#mustSite(to.frozen.site_id);
    const unsupported = needs.filter((n) => !(site.supported_needs ?? []).includes(n));
    if (unsupported.length > 0) {
      return { ok: false, reason: "SITE_SUPPORT_INSUFFICIENT", detail: { missing: unsupported } };
    }
    // 同一名儿童不能同时出现在两个点
    const presence = this.#presenceAt(transfer.child_id, at);
    if (presence && presence.session_id !== transfer.from_session_id) {
      return { ok: false, reason: "CHILD_DOUBLE_PRESENT", detail: { presence } };
    }
    const open = this.#openTransferFor(transfer.child_id);
    if (open && open.transfer_id !== transfer.transfer_id) {
      return { ok: false, reason: "TRANSFER_CONFLICT", detail: { existing_transfer_id: open.transfer_id } };
    }
    return {
      ok: true,
      detail: { capacity_ok: true, qualifications_ok: true, special_needs_ok: true, headcount_after: headcount + 1 },
    };
  }

  #openTransferFor(childId) {
    const ids = [];
    for (const e of this.store.events) {
      if (e.event_type === E.TRANSFER_REQUESTED && e.payload?.child_id === childId) {
        ids.push(e.payload.transfer_id);
      }
    }
    for (const id of ids) {
      const view = this.#transferView(id);
      if (["REQUESTED", "APPROVED"].includes(view.status)) return view;
    }
    return null;
  }

  #transferView(transferId) {
    let view = null;
    for (const e of this.store.events) {
      const p = e.payload ?? {};
      if (p.transfer_id !== transferId) continue;
      switch (e.event_type) {
        case E.TRANSFER_REQUESTED:
          view = {
            transfer_id: transferId, child_id: p.child_id,
            from_session_id: p.from_session_id, to_session_id: p.to_session_id,
            reason: p.reason, requested_by: p.requested_by, requested_at: e.occurred_at,
            status: "REQUESTED",
          };
          break;
        case E.TRANSFER_APPROVED:
          if (view) {
            view.status = "APPROVED";
            view.approved_by = p.approved_by;
            view.approved_at = e.occurred_at;
            view.checks = p.checks;
          }
          break;
        case E.TRANSFER_REJECTED:
          if (view) {
            view.status = "REJECTED";
            view.reject_reason = p.reason;
            view.rejected_by = p.rejected_by;
            view.rejected_at = e.occurred_at;
          }
          break;
        case E.TRANSFER_COMPLETED:
          if (view) {
            view.status = "COMPLETED";
            view.completed_at = e.occurred_at;
            view.escorted_by = p.escorted_by;
          }
          break;
        default:
          break;
      }
    }
    return view;
  }

  // ------------------------------------------------------------------
  // 通知与升级
  // ------------------------------------------------------------------

  #notifyGuardians(childId, kind, refId, at, extra = {}) {
    const guardianship = this.policy.latestDoc(childId, E.GUARDIANSHIP_RECORDED, at);
    const recipients = (guardianship?.payload.guardians ?? []).map((g) => g.person_id);
    return this.#notify(childId, kind, refId, at, recipients, extra);
  }

  #notify(childId, kind, refId, at, recipients, extra = {}) {
    const sent = [];
    for (const personId of recipients) {
      const notificationId = `ntf:${kind}:${refId}:${personId}`;
      const event = this.#emit(
        E.NOTIFICATION_SENT, A.NOTIFICATION, notificationId,
        {
          notification_id: notificationId, child_id: childId, kind,
          to_person_id: personId, ref_id: refId,
          ack_deadline: iso(ts(at) + this.ackWindowMs),
          ...extra,
        },
        at, `通知 ${personId}：${kind}`, `evt:${notificationId}`,
      );
      sent.push(event);
    }
    return sent;
  }

  acknowledgeNotification({ notification_id, acknowledged_by, at }) {
    const sent = this.store.events.find(
      (e) => e.event_type === E.NOTIFICATION_SENT && e.payload?.notification_id === notification_id,
    );
    if (!sent) throw new DomainError("NOTIFICATION_NOT_FOUND", `未找到通知：${notification_id}`);
    const already = this.store.events.some(
      (e) => e.event_type === E.NOTIFICATION_ACKNOWLEDGED && e.payload?.notification_id === notification_id,
    );
    if (already) return { ok: true, deduplicated: true };
    const event = this.#emit(
      E.NOTIFICATION_ACKNOWLEDGED, A.NOTIFICATION, notification_id,
      { notification_id, acknowledged_by }, at, `通知已确认：${notification_id}`,
    );
    return { ok: true, event };
  }

  #escalate({ case_id, child_id, kind, ref_id, detail, at }) {
    return this.#emit(
      E.CASE_ESCALATED, A.CASE, case_id,
      { case_id, child_id, kind, ref_id, escalated_to: "SAFEGUARDING_LEAD", detail },
      at, `升级保障案件：${kind}（${child_id}）`, `evt:${case_id}`,
    );
  }

  // ------------------------------------------------------------------
  // 课程结束与断线恢复
  // ------------------------------------------------------------------

  closeSession({ session_id, at }) {
    const session = this.#sessionState(session_id);
    if (!session.frozen) throw new DomainError("SESSION_NOT_FROZEN", `课程 ${session_id} 尚未冻结`);
    if (session.closed) return { ok: true, deduplicated: true };
    const now = at ?? this.clock();
    this.#emit(E.SESSION_CLOSED, A.SESSION, session_id, { session_id }, now, `课程结束：${session_id}`);
    const overdue = this.#escalateOverduePresent(session_id, now);
    return { ok: true, overdue_children: overdue };
  }

  /** 课程结束后仍在场的儿童：升级并通知监护人与紧急联系人（幂等）。 */
  #escalateOverduePresent(sessionId, at) {
    const session = this.#sessionState(sessionId);
    const overdue = [];
    for (const [childId] of session.checkins) {
      if (session.checkouts.has(childId)) continue;
      overdue.push(childId);
      this.#escalate({
        case_id: `case:PICKUP_OVERDUE:${sessionId}:${childId}`,
        child_id: childId,
        kind: "PICKUP_OVERDUE",
        ref_id: `${sessionId}:${childId}`,
        detail: `课程 ${sessionId} 结束后儿童仍未被接走`,
        at,
      });
      const guardianship = this.policy.latestDoc(childId, E.GUARDIANSHIP_RECORDED, at);
      const contacts = this.policy.latestDoc(childId, E.EMERGENCY_CONTACTS_RECORDED, at);
      const recipients = [
        ...(guardianship?.payload.guardians ?? []).map((g) => g.person_id),
        ...(contacts?.payload.contacts ?? []).map((c) => c.person_id),
      ];
      this.#notify(childId, "PICKUP_OVERDUE_NOTICE", `${sessionId}:${childId}`, at, [...new Set(recipients)], {
        session_id: sessionId,
      });
    }
    return overdue;
  }

  /**
   * 断线恢复：继续未完成的核验，升级逾期事项。全部操作幂等，可重复调用。
   */
  recover({ at } = {}) {
    const now = at ?? this.clock();
    const report = {
      expired_temp_changes: [],
      pending_verifications: [],
      escalations: [],
      overdue_children: [],
      pending_revisions: [],
    };
    // 1. 临时变更：逾期的失效并升级，未逾期的继续核验
    for (const change of this.#allTempChanges()) {
      if (change.status !== "PENDING") continue;
      if (ts(change.verify_deadline) < ts(now)) {
        this.#expireTempChange(change, now);
        report.expired_temp_changes.push(change.change_id);
        report.escalations.push(`case:VERIFICATION_OVERDUE:${change.change_id}`);
      } else {
        report.pending_verifications.push({
          change_id: change.change_id,
          child_id: change.child_id,
          verify_deadline: change.verify_deadline,
        });
      }
    }
    // 2. 通知逾期未确认
    for (const n of this.#notifications()) {
      if (n.acknowledged || ts(n.ack_deadline) >= ts(now)) continue;
      const caseId = `case:NOTIFICATION_UNCONFIRMED:${n.notification_id}`;
      this.#escalate({
        case_id: caseId, child_id: n.child_id, kind: "NOTIFICATION_UNCONFIRMED",
        ref_id: n.notification_id,
        detail: `通知 ${n.notification_id} 超过确认时限 ${n.ack_deadline} 仍未确认`,
        at: now,
      });
      report.escalations.push(caseId);
    }
    // 3. 课程结束逾时仍有儿童在场
    for (const sessionId of this.#sessionIds()) {
      const session = this.#sessionState(sessionId);
      if (!session.frozen || session.closed) continue;
      if (ts(now) <= ts(session.frozen.window.end) + this.overdueGraceMs) continue;
      const overdue = this.#escalateOverduePresent(sessionId, now);
      report.overdue_children.push(...overdue.map((childId) => ({ session_id: sessionId, child_id: childId })));
    }
    // 4. 待核修订继续保留并提示
    for (const sessionId of this.#sessionIds()) {
      const session = this.#sessionState(sessionId);
      for (const revision of session.pendingRevisions) {
        report.pending_revisions.push({
          stable_id: revision.payload.stable_id,
          session_id: sessionId,
          recorded_by: revision.payload.recorded_by,
        });
      }
    }
    return report;
  }

  #allTempChanges() {
    const ids = [];
    for (const e of this.store.events) {
      if (e.event_type === E.PICKUP_CHANGED) ids.push(e.payload.change_id);
    }
    return [...new Set(ids)].map((id) => this.policy.tempChange(id)).filter(Boolean);
  }

  #notifications() {
    const map = new Map();
    for (const e of this.store.events) {
      const p = e.payload ?? {};
      if (e.event_type === E.NOTIFICATION_SENT) {
        map.set(p.notification_id, { ...p, sent_at: e.occurred_at, acknowledged: false });
      } else if (e.event_type === E.NOTIFICATION_ACKNOWLEDGED) {
        const n = map.get(p.notification_id);
        if (n) {
          n.acknowledged = true;
          n.acknowledged_at = e.occurred_at;
          n.acknowledged_by = p.acknowledged_by;
        }
      }
    }
    return [...map.values()];
  }

  #sessionIds() {
    return [
      ...new Set(
        this.store.events
          .filter((e) => e.event_type === E.SESSION_FROZEN)
          .map((e) => e.payload.session_id),
      ),
    ];
  }

  // ------------------------------------------------------------------
  // 查询
  // ------------------------------------------------------------------

  #sessionState(sessionId) {
    const state = {
      session_id: sessionId,
      frozen: null,
      closed: false,
      checkins: new Map(),
      checkouts: new Map(),
      pendingRevisions: [],
      frozenDeliveries: new Map(),
      refusals: [],
    };
    const pendingByStable = new Map();
    for (const e of this.store.events) {
      if (e.aggregate_type !== A.SESSION || e.aggregate_id !== sessionId) continue;
      const p = e.payload ?? {};
      switch (e.event_type) {
        case E.SESSION_FROZEN:
          state.frozen = p;
          break;
        case E.SESSION_CLOSED:
          state.closed = true;
          break;
        case E.CHILD_CHECKED_IN:
        case E.CHILD_CHECKED_OUT: {
          const map = e.event_type === E.CHILD_CHECKED_IN ? state.checkins : state.checkouts;
          if (p.status === "PENDING_VERIFICATION") {
            pendingByStable.set(p.stable_id, e);
            state.pendingRevisions.push(e);
          } else {
            map.set(p.child_id, e);
          }
          break;
        }
        case E.RECORD_REVISION_VERIFIED: {
          const pending = pendingByStable.get(p.stable_id) ?? this.store.get(p.revision_event_id);
          if (pending) {
            const map = pending.event_type === E.CHILD_CHECKED_IN ? state.checkins : state.checkouts;
            map.set(pending.payload.child_id, pending);
            pendingByStable.delete(p.stable_id);
            state.pendingRevisions = state.pendingRevisions.filter((x) => x.event_id !== pending.event_id);
          }
          break;
        }
        case E.RECORD_REVISION_REJECTED: {
          const pending = pendingByStable.get(p.stable_id);
          if (pending) {
            pendingByStable.delete(p.stable_id);
            state.pendingRevisions = state.pendingRevisions.filter((x) => x.event_id !== pending.event_id);
          }
          break;
        }
        case E.PICKUP_REFUSED:
          state.refusals.push(e);
          break;
        case E.DELIVERY_FROZEN:
          state.frozenDeliveries.set(p.child_id, e);
          break;
        case E.DELIVERY_UNFROZEN:
          state.frozenDeliveries.delete(p.child_id);
          break;
        default:
          break;
      }
    }
    return state;
  }

  #presenceAt(childId, at) {
    const cutoff = ts(at);
    let presence = null;
    for (const e of this.store.events) {
      if (ts(e.occurred_at) > cutoff) continue;
      const p = e.payload ?? {};
      if (p.child_id !== childId || p.status === "PENDING_VERIFICATION") continue;
      if (e.event_type === E.CHILD_CHECKED_IN) {
        presence = { session_id: p.session_id, since: e.occurred_at, via_transfer: p.via_transfer ?? null };
      } else if (e.event_type === E.CHILD_CHECKED_OUT) {
        if (presence && presence.session_id === p.session_id) presence = null;
      }
    }
    return presence;
  }

  sessionView(sessionId) {
    const s = this.#sessionState(sessionId);
    return {
      session_id: sessionId,
      frozen: s.frozen,
      closed: s.closed,
      present: [...s.checkins.keys()].filter((c) => !s.checkouts.has(c)),
      checked_out: [...s.checkouts.keys()],
      frozen_deliveries: [...s.frozenDeliveries.keys()],
      pending_revisions: s.pendingRevisions.map((e) => e.payload.stable_id),
      refusals: s.refusals.map((e) => ({ child_id: e.payload.child_id, person_id: e.payload.person_id, reason: e.payload.reason, at: e.occurred_at })),
    };
  }

  presenceOf(childId, at = null) {
    return this.#presenceAt(childId, at ?? this.clock());
  }

  authorizationFor(childId, at = null) {
    return this.policy.resolve(childId, at ?? this.clock());
  }

  transferView(transferId) {
    return this.#transferView(transferId);
  }

  tempChangeView(changeId) {
    return this.policy.tempChange(changeId);
  }

  notificationView(notificationId) {
    return this.#notifications().find((n) => n.notification_id === notificationId) ?? null;
  }

  /**
   * 事后调查：按 as_of 当时视角还原——谁批准了地点变化、现场由谁负责、
   * 向谁交付、哪些通知尚未确认、哪些核验仍在进行。
   */
  investigate(childId, asOf = null) {
    const at = asOf ?? this.clock();
    const cutoff = ts(at);
    const events = this.store.events.filter((e) => ts(e.occurred_at) <= cutoff);

    const transferIds = [
      ...new Set(
        events
          .filter((e) => e.event_type === E.TRANSFER_REQUESTED && e.payload?.child_id === childId)
          .map((e) => e.payload.transfer_id),
      ),
    ];
    const locationChanges = transferIds.map((id) => {
      const view = { transfer_id: id, status: "REQUESTED" };
      for (const e of events) {
        const p = e.payload ?? {};
        if (p.transfer_id !== id) continue;
        if (e.event_type === E.TRANSFER_REQUESTED) {
          Object.assign(view, {
            child_id: p.child_id, from_session_id: p.from_session_id,
            to_session_id: p.to_session_id, reason: p.reason,
            requested_by: p.requested_by, requested_at: e.occurred_at,
          });
        } else if (e.event_type === E.TRANSFER_APPROVED) {
          Object.assign(view, { status: "APPROVED", approved_by: p.approved_by, approved_at: e.occurred_at });
        } else if (e.event_type === E.TRANSFER_REJECTED) {
          Object.assign(view, { status: "REJECTED", reject_reason: p.reason, rejected_by: p.rejected_by });
        } else if (e.event_type === E.TRANSFER_COMPLETED) {
          Object.assign(view, { status: "COMPLETED", completed_at: e.occurred_at, escorted_by: p.escorted_by });
        }
      }
      return view;
    });

    const presence = [];
    const staffBySession = new Map();
    const sessionsOf = new Set();
    for (const e of events) {
      const p = e.payload ?? {};
      if (e.event_type === E.SESSION_FROZEN && (p.roster ?? []).includes(childId)) {
        sessionsOf.add(p.session_id);
      }
      if (p.child_id !== childId || p.status === "PENDING_VERIFICATION") continue;
      if (e.event_type === E.CHILD_CHECKED_IN) {
        sessionsOf.add(p.session_id);
        presence.push({
          session_id: p.session_id,
          checked_in_at: e.occurred_at,
          checked_out_at: null,
          via_transfer: p.via_transfer ?? null,
        });
      } else if (e.event_type === E.CHILD_CHECKED_OUT) {
        const open = [...presence].reverse().find((x) => x.session_id === p.session_id && !x.checked_out_at);
        if (open) open.checked_out_at = e.occurred_at;
      }
    }
    for (const sessionId of sessionsOf) {
      const frozen = events.find((e) => e.event_type === E.SESSION_FROZEN && e.payload?.session_id === sessionId)?.payload;
      if (!frozen) continue;
      staffBySession.set(sessionId, {
        session_id: sessionId,
        site_id: frozen.site_id,
        window: frozen.window,
        staff: frozen.staff.map((s) => ({
          ...s,
          name: this.#staffRecord(s.staff_id)?.name ?? null,
        })),
      });
    }

    const deliveries = events
      .filter(
        (e) =>
          e.event_type === E.CHILD_CHECKED_OUT &&
          e.payload?.child_id === childId &&
          e.payload.handed_to?.type === "PERSON" &&
          e.payload.status !== "PENDING_VERIFICATION",
      )
      .map((e) => ({
        session_id: e.payload.session_id,
        delivered_to: e.payload.handed_to.person_id,
        released_by: e.payload.released_by,
        at: e.occurred_at,
        decision_basis: e.payload.decision_basis ?? null,
      }));

    const refusals = events
      .filter((e) => e.event_type === E.PICKUP_REFUSED && e.payload?.child_id === childId)
      .map((e) => ({ session_id: e.payload.session_id, person_id: e.payload.person_id, reason: e.payload.reason, at: e.occurred_at }));

    const acked = new Map(
      events
        .filter((e) => e.event_type === E.NOTIFICATION_ACKNOWLEDGED)
        .map((e) => [e.payload.notification_id, e]),
    );
    const notifications = events
      .filter((e) => e.event_type === E.NOTIFICATION_SENT && e.payload?.child_id === childId)
      .map((e) => {
        const ack = acked.get(e.payload.notification_id);
        return {
          notification_id: e.payload.notification_id,
          kind: e.payload.kind,
          to_person_id: e.payload.to_person_id,
          sent_at: e.occurred_at,
          ack_deadline: e.payload.ack_deadline,
          status: ack ? "ACKNOWLEDGED" : "UNCONFIRMED",
          acknowledged_at: ack?.occurred_at ?? null,
        };
      });

    const pendingVerifications = this.policy
      .tempChangesFor(childId, at)
      .filter((c) => c.status === "PENDING")
      .map((c) => ({ change_id: c.change_id, kind: c.kind, verify_deadline: c.verify_deadline }));

    const escalations = events
      .filter((e) => e.event_type === E.CASE_ESCALATED && e.payload?.child_id === childId)
      .map((e) => ({ case_id: e.payload.case_id, kind: e.payload.kind, ref_id: e.payload.ref_id, at: e.occurred_at }));

    return {
      child_id: childId,
      as_of: at,
      location_changes: locationChanges,
      presence,
      responsible_staff: [...staffBySession.values()],
      deliveries,
      refusals,
      notifications,
      unconfirmed_notifications: notifications.filter((n) => n.status === "UNCONFIRMED").map((n) => n.notification_id),
      pending_verifications: pendingVerifications,
      escalations,
    };
  }
}
