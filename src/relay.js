/**
 * 邻里课堂接送接力服务。
 *
 * 设计要点：
 * - 监护关系、代接范围、禁交付指令、紧急联系人分别版本化；更正只追加新版本，不改写历史。
 * - 每次课程冻结地点、时段、在岗人员与当日有效授权快照，作为当日交接的核验基线。
 * - 跨点调班先校验接收点容量、工作人员资质与儿童特殊支持，再以放置版本号保证
 *   同一名儿童不会同时出现在两个点；并发调班凭版本号只会成功一次。
 * - 交付判定顺序：交付冻结（异常）→ 迟到禁交付 → 保护案件禁交付指令 → 监护人 →
 *   已二次核验的临时监护人 → 当日有效代接授权。异常只冻结相关儿童，不影响其他家庭。
 * - 签到、调班、接送回执按稳定标识幂等合并；同一标识内容变化时保留原记录并标记待核。
 * - 全部状态由事件日志推导，断线后可用 RelayService.restore(events) 恢复，
 *   未完成的二次核验与逾期升级在恢复后继续推进。
 * - investigate(child_id, as_of) 按当时视角还原：谁批准了地点变化、现场由谁负责、
 *   向谁交付、哪些通知尚未确认。
 */
import { createHash } from "node:crypto";

const DEFAULT_GRACE_MINUTES = 15;
const DEFAULT_CONFIRM_MINUTES = 30;

/** 稳定序列化，用于识别同一稳定标识下内容是否发生变化。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(payload) {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

function parseTime(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`无法解析时间：${iso}`);
  return ms;
}

function addMinutes(iso, minutes) {
  return new Date(parseTime(iso) + minutes * 60_000).toISOString();
}

/** 取截至 at 生效的最新版本（recorded_at 与 effective_from 均不晚于 at）。 */
function effectiveVersion(versions, at) {
  const atMs = parseTime(at);
  let best = null;
  for (const version of versions) {
    const effectiveMs = parseTime(version.effective_from ?? version.recorded_at);
    if (effectiveMs <= atMs && parseTime(version.recorded_at) <= atMs) {
      if (!best || version.version > best.version) best = version;
    }
  }
  return best;
}

function ok(extra = {}) {
  return { ok: true, ...extra };
}

function fail(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function initialState() {
  return {
    records: {
      guardianship: new Map(),
      pickupScope: new Map(),
      noRelease: new Map(),
      emergencyContacts: new Map(),
      supportNeeds: new Map(),
    },
    sessions: new Map(),
    placements: new Map(),
    tempGuardians: new Map(),
    checkins: new Map(),
    conflicts: new Map(),
    deliveryFreezes: new Map(),
    notifications: new Map(),
    handovers: [],
    refusals: [],
    escalations: [],
  };
}

export class RelayService {
  #events = [];
  #state = initialState();
  #seq = new Map();
  #commandIndex = new Map();
  #graceMinutes;
  #confirmMinutes;

  constructor(options = {}) {
    this.#graceMinutes = options.graceMinutes ?? DEFAULT_GRACE_MINUTES;
    this.#confirmMinutes = options.confirmMinutes ?? DEFAULT_CONFIRM_MINUTES;
  }

  /** 断线恢复：从事件日志重放，未完成的核验与待升级通知保持原状可继续推进。 */
  static restore(events, options = {}) {
    const service = new RelayService(options);
    for (const event of events) service.#ingest(event);
    return service;
  }

  get events() {
    return this.#events.map((event) => ({ ...event }));
  }

  #ingest(event) {
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    this.#seq.set(key, Math.max(this.#seq.get(key) ?? 0, event.version));
    this.#events.push(event);
    this.#apply(event);
  }

  #append(eventType, aggregateType, aggregateId, occurredAt, summary, payload) {
    const key = `${aggregateType}:${aggregateId}`;
    const version = (this.#seq.get(key) ?? 0) + 1;
    this.#seq.set(key, version);
    const event = {
      event_id: `evt-${String(this.#events.length + 1).padStart(4, "0")}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: occurredAt,
      version,
      summary,
      payload,
    };
    this.#events.push(event);
    this.#apply(event);
    return event;
  }

  #pushVersion(kind, childId, event, payload) {
    const store = this.#state.records[kind];
    const list = store.get(payload.child_id ?? childId) ?? [];
    list.push({
      version: list.length + 1,
      recorded_at: event.occurred_at,
      effective_from: payload.effective_from ?? null,
      ...payload,
    });
    store.set(payload.child_id ?? childId, list);
  }

  #freezeDelivery(childId, reason) {
    const reasons = this.#state.deliveryFreezes.get(childId) ?? new Set();
    reasons.add(reason);
    this.#state.deliveryFreezes.set(childId, reasons);
  }

  #unfreezeDelivery(childId, reason) {
    const reasons = this.#state.deliveryFreezes.get(childId);
    if (!reasons) return;
    reasons.delete(reason);
    if (reasons.size === 0) this.#state.deliveryFreezes.delete(childId);
  }

  #apply(event) {
    const p = event.payload ?? {};
    const s = this.#state;
    switch (event.event_type) {
      case "GUARDIANSHIP_RECORDED":
        this.#pushVersion("guardianship", p.child_id, event, p);
        break;
      case "PICKUP_SCOPE_RECORDED":
        this.#pushVersion("pickupScope", p.child_id, event, p);
        break;
      case "NO_RELEASE_RECORDED":
        this.#pushVersion("noRelease", p.child_id, event, p);
        break;
      case "EMERGENCY_CONTACTS_RECORDED":
        this.#pushVersion("emergencyContacts", p.child_id, event, p);
        break;
      case "SUPPORT_NEEDS_RECORDED":
        this.#pushVersion("supportNeeds", p.child_id, event, p);
        break;
      case "SESSION_PLANNED":
        s.sessions.set(p.session_id, {
          session_id: p.session_id,
          site_id: p.site_id,
          date: p.date,
          start: p.start,
          end: p.end,
          capacity: p.capacity,
          staff: [],
          frozen: null,
        });
        break;
      case "STAFF_ASSIGNED": {
        const session = s.sessions.get(p.session_id);
        if (session) session.staff = p.staff;
        break;
      }
      case "SESSION_FROZEN": {
        const session = s.sessions.get(p.session_id);
        if (session) {
          session.frozen = {
            staff: p.staff,
            authorizations: p.authorizations,
            frozen_at: event.occurred_at,
            frozen_by: p.frozen_by,
          };
        }
        break;
      }
      case "CHILD_PLACED":
        s.placements.set(p.child_id, {
          session_id: p.session_id,
          version: p.placement_version,
          active: true,
        });
        break;
      case "CHILD_TRANSFERRED":
        s.placements.set(p.child_id, {
          session_id: p.to_session_id,
          version: p.placement_version,
          active: true,
        });
        break;
      case "CHECK_IN_RECORDED":
        s.checkins.set(p.checkin_id, {
          session_id: p.session_id,
          child_id: p.child_id,
          method: p.method,
          at: event.occurred_at,
        });
        break;
      case "CONTENT_CONFLICT_FLAGGED":
        s.conflicts.set(`${p.kind}:${p.stable_id}`, {
          kind: p.kind,
          stable_id: p.stable_id,
          child_id: p.child_id,
          status: "pending_review",
        });
        this.#freezeDelivery(p.child_id, `conflict:${p.kind}:${p.stable_id}`);
        break;
      case "CONFLICT_RESOLVED": {
        const conflict = s.conflicts.get(`${p.kind}:${p.stable_id}`);
        if (conflict) conflict.status = "resolved";
        this.#unfreezeDelivery(p.child_id, `conflict:${p.kind}:${p.stable_id}`);
        break;
      }
      case "TEMP_GUARDIAN_REQUESTED":
        s.tempGuardians.set(p.change_id, { ...p, confirmations: [], status: "pending" });
        break;
      case "TEMP_GUARDIAN_CONFIRMED": {
        const change = s.tempGuardians.get(p.change_id);
        if (change) {
          change.confirmations.push({ confirmed_by: p.confirmed_by, at: event.occurred_at });
          if (change.confirmations.length >= 1) change.status = "active";
        }
        break;
      }
      case "HANDOVER_RECORDED":
        s.handovers.push({ ...p, at: event.occurred_at });
        break;
      case "RELEASE_REFUSED":
        s.refusals.push({ ...p, at: event.occurred_at });
        break;
      case "NOTIFICATION_SENT":
        s.notifications.set(p.notification_id, {
          ...p,
          status: "pending",
          sent_at: event.occurred_at,
        });
        break;
      case "NOTIFICATION_CONFIRMED": {
        const notification = s.notifications.get(p.notification_id);
        if (notification) {
          notification.status = "confirmed";
          notification.confirmed_by = p.confirmed_by;
        }
        break;
      }
      case "ESCALATION_RAISED":
        s.escalations.push({ ...p, at: event.occurred_at });
        break;
      default:
        break;
    }
  }

  /**
   * 稳定标识合并：同一标识同一内容 → 幂等去重；同一标识不同内容 → 保留原记录，
   * 标记待核并冻结相关儿童交付。
   */
  #mergeCheck(kind, stableId, childId, payload, at) {
    const key = `${kind}:${stableId}`;
    const hash = contentHash(payload);
    const existing = this.#commandIndex.get(key);
    if (!existing) return { first: true, key, hash };
    if (existing.hash === hash) return { deduplicated: true, event_id: existing.event_id };
    this.#append(
      "CONTENT_CONFLICT_FLAGGED",
      "child_enrollment",
      childId,
      at,
      `稳定标识 ${stableId} 内容发生变化，保留原记录待核`,
      { kind, stable_id: stableId, child_id: childId },
    );
    return {
      conflict: true,
      result: fail(
        "CONTENT_CONFLICT_PENDING",
        `稳定标识 ${stableId} 已存在且内容不一致，原记录保留待核`,
        { stable_id: stableId },
      ),
    };
  }

  #registerCommand(key, hash, eventId) {
    this.#commandIndex.set(key, { hash, event_id: eventId });
  }

  // ---- 版本化记录 -------------------------------------------------------

  recordGuardianship({ child_id, guardians, recorded_by, at, effective_from }) {
    const event = this.#append(
      "GUARDIANSHIP_RECORDED",
      "child_enrollment",
      child_id,
      at,
      `登记儿童 ${child_id} 监护关系新版本`,
      { child_id, guardians, recorded_by, effective_from },
    );
    return ok({ event });
  }

  recordPickupScope({ child_id, delegates, recorded_by, at, effective_from }) {
    const event = this.#append(
      "PICKUP_SCOPE_RECORDED",
      "child_enrollment",
      child_id,
      at,
      `登记儿童 ${child_id} 代接范围新版本`,
      { child_id, delegates, recorded_by, effective_from },
    );
    return ok({ event });
  }

  recordNoRelease({ case_id, child_id, mode, forbidden_persons = [], recorded_by, at, effective_from }) {
    const event = this.#append(
      "NO_RELEASE_RECORDED",
      "safeguarding_case",
      case_id,
      at,
      `保护案件 ${case_id} 禁交付指令新版本`,
      { case_id, child_id, mode, forbidden_persons, recorded_by, effective_from },
    );
    return ok({ event });
  }

  recordEmergencyContacts({ child_id, contacts, recorded_by, at, effective_from }) {
    const event = this.#append(
      "EMERGENCY_CONTACTS_RECORDED",
      "child_enrollment",
      child_id,
      at,
      `登记儿童 ${child_id} 紧急联系人新版本`,
      { child_id, contacts, recorded_by, effective_from },
    );
    return ok({ event });
  }

  recordSupportNeeds({ child_id, needs, recorded_by, at, effective_from }) {
    const event = this.#append(
      "SUPPORT_NEEDS_RECORDED",
      "child_enrollment",
      child_id,
      at,
      `登记儿童 ${child_id} 特殊支持需求新版本`,
      { child_id, needs, recorded_by, effective_from },
    );
    return ok({ event });
  }

  // ---- 课程与冻结 -------------------------------------------------------

  planSession({ session_id, site_id, date, start, end, capacity, at }) {
    if (this.#state.sessions.has(session_id)) {
      return fail("SESSION_EXISTS", `课程 ${session_id} 已存在`);
    }
    const event = this.#append("SESSION_PLANNED", "site_session", session_id, at, `排定课程 ${session_id}`, {
      session_id,
      site_id,
      date,
      start,
      end,
      capacity,
    });
    return ok({ event });
  }

  assignStaff({ session_id, staff, at }) {
    const session = this.#state.sessions.get(session_id);
    if (!session) return fail("SESSION_UNKNOWN", `课程 ${session_id} 不存在`);
    if (session.frozen) return fail("ALREADY_FROZEN", `课程 ${session_id} 已冻结，不能再调整在岗人员`);
    const event = this.#append("STAFF_ASSIGNED", "staff_assignment", session_id, at, `安排课程 ${session_id} 在岗人员`, {
      session_id,
      staff,
    });
    return ok({ event });
  }

  /** 冻结课程：地点、时段、在岗人员与当日有效授权快照，之后作为当日核验基线。 */
  freezeSession({ session_id, frozen_by, at }) {
    const session = this.#state.sessions.get(session_id);
    if (!session) return fail("SESSION_UNKNOWN", `课程 ${session_id} 不存在`);
    if (session.frozen) return fail("ALREADY_FROZEN", `课程 ${session_id} 已冻结`);
    if (session.staff.length === 0) return fail("NO_STAFF", `课程 ${session_id} 尚未安排在岗人员`);

    const authorizations = {};
    for (const [childId, placement] of this.#state.placements) {
      if (!placement.active || placement.session_id !== session_id) continue;
      const guardianship = effectiveVersion(this.#state.records.guardianship.get(childId) ?? [], at);
      const scope = effectiveVersion(this.#state.records.pickupScope.get(childId) ?? [], at);
      const temporary = [...this.#state.tempGuardians.values()]
        .filter((change) => change.child_id === childId && change.status === "active")
        .map((change) => change.person_id);
      authorizations[childId] = {
        guardians: guardianship?.guardians ?? [],
        delegates: scope?.delegates ?? [],
        temporary_guardians: temporary,
      };
    }

    const event = this.#append("SESSION_FROZEN", "site_session", session_id, at, `冻结课程 ${session_id} 当日安排`, {
      session_id,
      staff: session.staff,
      authorizations,
      frozen_by,
    });
    return ok({ event });
  }

  // ---- 在点与调班 -------------------------------------------------------

  placeChild({ session_id, child_id, at }) {
    const session = this.#state.sessions.get(session_id);
    if (!session) return fail("SESSION_UNKNOWN", `课程 ${session_id} 不存在`);
    const current = this.#state.placements.get(child_id);
    if (current?.active) {
      return fail("ALREADY_PLACED", `儿童 ${child_id} 已在课程 ${current.session_id}，不能同时出现在两个点`);
    }
    const version = (current?.version ?? 0) + 1;
    const event = this.#append("CHILD_PLACED", "child_enrollment", child_id, at, `儿童 ${child_id} 排入课程 ${session_id}`, {
      child_id,
      session_id,
      placement_version: version,
    });
    return ok({ event, placement_version: version });
  }

  /**
   * 跨点调班。expected_version 是当前放置版本号：并发调班只有一个能匹配成功。
   * 前置校验：接收点已冻结、容量充足、在岗人员资质覆盖儿童特殊支持、有负责人在岗。
   */
  transferChild({ transfer_id, child_id, to_session_id, approved_by, expected_version, at }) {
    const merge = this.#mergeCheck("transfer", transfer_id, child_id, {
      child_id,
      to_session_id,
      expected_version,
    }, at);
    if (merge.deduplicated) return ok({ deduplicated: true, event_id: merge.event_id });
    if (merge.conflict) return merge.result;

    const placement = this.#state.placements.get(child_id);
    if (!placement?.active) return fail("NOT_PLACED", `儿童 ${child_id} 当前不在任何课程`);
    if (expected_version !== placement.version) {
      return fail("VERSION_CONFLICT", `儿童 ${child_id} 放置版本已变化，调班冲突`, {
        expected_version,
        current_version: placement.version,
      });
    }
    const from = this.#state.sessions.get(placement.session_id);
    const to = this.#state.sessions.get(to_session_id);
    if (!to) return fail("SESSION_UNKNOWN", `课程 ${to_session_id} 不存在`);
    if (to.session_id === from.session_id) return fail("SAME_SESSION", "调班目标与当前课程相同");
    if (!to.frozen) return fail("TARGET_NOT_FROZEN", `接收课程 ${to_session_id} 尚未冻结，无法核验当日安排`);

    const occupied = [...this.#state.placements.values()].filter(
      (p) => p.active && p.session_id === to_session_id,
    ).length;
    if (occupied >= to.capacity) {
      return fail("TARGET_FULL", `接收课程 ${to_session_id} 容量不足`, { capacity: to.capacity, occupied });
    }

    const needs = effectiveVersion(this.#state.records.supportNeeds.get(child_id) ?? [], at)?.needs ?? [];
    const covered = new Set(to.frozen.staff.flatMap((member) => member.qualifications ?? []));
    const missing = needs.filter((need) => !covered.has(need));
    if (missing.length > 0) {
      return fail("STAFF_QUALIFICATION_MISSING", `接收课程 ${to_session_id} 在岗人员资质不覆盖特殊支持`, {
        missing,
      });
    }
    if (!to.frozen.staff.some((member) => member.role === "lead")) {
      return fail("NO_RESPONSIBLE_STAFF", `接收课程 ${to_session_id} 没有负责人在岗`);
    }

    const event = this.#append(
      "CHILD_TRANSFERRED",
      "child_enrollment",
      child_id,
      at,
      `儿童 ${child_id} 由 ${from.site_id} 调往 ${to.site_id}，批准人 ${approved_by}`,
      {
        transfer_id,
        child_id,
        from_session_id: from.session_id,
        to_session_id,
        from_site_id: from.site_id,
        to_site_id: to.site_id,
        approved_by,
        placement_version: placement.version + 1,
      },
    );
    this.#registerCommand(merge.key, merge.hash, event.event_id);
    this.#notifyContacts(child_id, "SITE_TRANSFER", at, `transfer:${transfer_id}`);
    return ok({ event, placement_version: placement.version + 1 });
  }

  // ---- 签到 -------------------------------------------------------------

  checkIn({ checkin_id, session_id, child_id, method = "staff_record", recorded_by, at }) {
    const merge = this.#mergeCheck("checkin", checkin_id, child_id, { session_id, child_id, method }, at);
    if (merge.deduplicated) return ok({ deduplicated: true, event_id: merge.event_id });
    if (merge.conflict) return merge.result;

    const placement = this.#state.placements.get(child_id);
    if (!placement?.active || placement.session_id !== session_id) {
      return fail("NOT_PLACED", `儿童 ${child_id} 不在课程 ${session_id}，无法签到`);
    }
    const event = this.#append("CHECK_IN_RECORDED", "site_session", session_id, at, `儿童 ${child_id} 在课程 ${session_id} 签到`, {
      checkin_id,
      session_id,
      child_id,
      method,
      recorded_by,
    });
    this.#registerCommand(merge.key, merge.hash, event.event_id);
    return ok({ event });
  }

  // ---- 临时监护人二次核验 -------------------------------------------------

  requestTemporaryGuardian({ change_id, child_id, person_id, valid_from, valid_to, sites, requested_by, at }) {
    if (this.#state.tempGuardians.has(change_id)) {
      return fail("CHANGE_EXISTS", `临时变更 ${change_id} 已存在`);
    }
    const event = this.#append(
      "TEMP_GUARDIAN_REQUESTED",
      "child_enrollment",
      child_id,
      at,
      `申请儿童 ${child_id} 临时接送人 ${person_id}，待二次核验`,
      { change_id, child_id, person_id, valid_from, valid_to, sites, requested_by },
    );
    return ok({ event });
  }

  confirmTemporaryGuardian({ change_id, confirmed_by, at }) {
    const change = this.#state.tempGuardians.get(change_id);
    if (!change) return fail("CHANGE_UNKNOWN", `临时变更 ${change_id} 不存在`);
    if (confirmed_by === change.requested_by) {
      return fail("SAME_VERIFIER", "二次核验人不能与申请人相同");
    }
    if (change.confirmations.some((c) => c.confirmed_by === confirmed_by)) {
      return ok({ deduplicated: true });
    }
    const event = this.#append(
      "TEMP_GUARDIAN_CONFIRMED",
      "child_enrollment",
      change.child_id,
      at,
      `临时变更 ${change_id} 经 ${confirmed_by} 二次核验生效`,
      { change_id, confirmed_by },
    );
    return ok({ event });
  }

  // ---- 交付判定 -----------------------------------------------------------

  #activeDirectives(childId, at) {
    const versions = this.#state.records.noRelease.get(childId) ?? [];
    const byCase = new Map();
    for (const version of versions) {
      const list = byCase.get(version.case_id) ?? [];
      list.push(version);
      byCase.set(version.case_id, list);
    }
    const active = [];
    for (const list of byCase.values()) {
      const directive = effectiveVersion(list, at);
      if (directive && directive.mode !== "lifted") active.push(directive);
    }
    return active;
  }

  #isGuardian(childId, personId, at) {
    const guardianship = effectiveVersion(this.#state.records.guardianship.get(childId) ?? [], at);
    return (guardianship?.guardians ?? []).some((g) => g.person_id === personId);
  }

  #delegateGranted(session, childId, personId, at) {
    const scope = effectiveVersion(this.#state.records.pickupScope.get(childId) ?? [], at);
    return (scope?.delegates ?? []).some((delegate) => {
      if (delegate.person_id !== personId) return false;
      const siteOk = delegate.sites.includes("*") || delegate.sites.includes(session.site_id);
      const dateOk = delegate.valid_from <= session.date && session.date <= delegate.valid_to;
      return siteOk && dateOk;
    });
  }

  #tempGuardianGranted(session, childId, personId) {
    return [...this.#state.tempGuardians.values()].some((change) => {
      if (change.child_id !== childId || change.person_id !== personId) return false;
      if (change.status !== "active") return false;
      const siteOk = change.sites.includes("*") || change.sites.includes(session.site_id);
      const dateOk = change.valid_from <= session.date && session.date <= change.valid_to;
      return siteOk && dateOk;
    });
  }

  /** 交付判定：返回 { allowed, reason }，不写入事件。 */
  evaluateRelease(session_id, child_id, person_id, at) {
    const session = this.#state.sessions.get(session_id);
    if (!session) return { allowed: false, reason: "SESSION_UNKNOWN" };
    const placement = this.#state.placements.get(child_id);
    if (!placement?.active || placement.session_id !== session_id) {
      return { allowed: false, reason: "NOT_PLACED" };
    }
    if (this.#state.handovers.some((h) => h.child_id === child_id && h.session_id === session_id)) {
      return { allowed: false, reason: "ALREADY_RELEASED" };
    }
    const freezes = this.#state.deliveryFreezes.get(child_id);
    if (freezes?.size) {
      return { allowed: false, reason: "DELIVERY_FROZEN", freeze_reasons: [...freezes] };
    }
    if (parseTime(at) > parseTime(session.end) + this.#graceMinutes * 60_000) {
      return { allowed: false, reason: "LATE_NO_RELEASE" };
    }
    const guardian = this.#isGuardian(child_id, person_id, at);
    for (const directive of this.#activeDirectives(child_id, at)) {
      if (directive.mode === "deny_list" && directive.forbidden_persons.includes(person_id)) {
        return { allowed: false, reason: "NO_RELEASE_DIRECTIVE", case_id: directive.case_id };
      }
      if (directive.mode === "guardian_only" && !guardian) {
        return { allowed: false, reason: "NO_RELEASE_DIRECTIVE", case_id: directive.case_id };
      }
    }
    if (guardian) return { allowed: true, reason: "GUARDIAN" };
    if (this.#tempGuardianGranted(session, child_id, person_id)) {
      return { allowed: true, reason: "TEMP_GUARDIAN" };
    }
    if (this.#delegateGranted(session, child_id, person_id, at)) {
      return { allowed: true, reason: "DELEGATE" };
    }
    return { allowed: false, reason: "NOT_AUTHORIZED" };
  }

  /** 接送回执：先判定再记录；拒绝与交付都留痕，交付后通知紧急联系人待确认。 */
  recordHandover({ receipt_id, session_id, child_id, person_id, recorded_by, at }) {
    const merge = this.#mergeCheck("receipt", receipt_id, child_id, { session_id, child_id, person_id }, at);
    if (merge.deduplicated) return ok({ deduplicated: true, event_id: merge.event_id });
    if (merge.conflict) return merge.result;

    const session = this.#state.sessions.get(session_id);
    const decision = this.evaluateRelease(session_id, child_id, person_id, at);
    if (!decision.allowed) {
      const event = this.#append(
        "RELEASE_REFUSED",
        "child_enrollment",
        child_id,
        at,
        `拒绝向 ${person_id} 交付儿童 ${child_id}：${decision.reason}`,
        { receipt_id, session_id, child_id, person_id, reason: decision.reason, recorded_by },
      );
      this.#registerCommand(merge.key, merge.hash, event.event_id);
      if (decision.reason === "LATE_NO_RELEASE") {
        this.#append("ESCALATION_RAISED", "child_enrollment", child_id, at, `儿童 ${child_id} 迟到禁交付，升级处理`, {
          kind: "LATE_PICKUP_NO_RELEASE",
          child_id,
          session_id,
        });
        this.#notifyContacts(child_id, "LATE_PICKUP", at, `late:${receipt_id}`);
      }
      return fail(decision.reason, `拒绝交付：${decision.reason}`, { event });
    }

    const event = this.#append(
      "HANDOVER_RECORDED",
      "child_enrollment",
      child_id,
      at,
      `儿童 ${child_id} 交付给 ${person_id}（${decision.reason}）`,
      {
        receipt_id,
        session_id,
        site_id: session.site_id,
        child_id,
        person_id,
        via: decision.reason,
        recorded_by,
      },
    );
    this.#registerCommand(merge.key, merge.hash, event.event_id);
    this.#notifyContacts(child_id, "HANDOVER_DONE", at, `handover:${receipt_id}`);
    return ok({ event, via: decision.reason });
  }

  // ---- 冲突处理 -----------------------------------------------------------

  resolveConflict({ kind, stable_id, resolved_by, at, note }) {
    const key = `${kind}:${stable_id}`;
    const conflict = this.#state.conflicts.get(key);
    if (!conflict) return fail("CONFLICT_UNKNOWN", `稳定标识 ${stable_id} 没有待核冲突`);
    if (conflict.status !== "pending_review") return ok({ deduplicated: true });
    const event = this.#append(
      "CONFLICT_RESOLVED",
      "child_enrollment",
      conflict.child_id,
      at,
      `稳定标识 ${stable_id} 冲突经 ${resolved_by} 核验解决`,
      { kind, stable_id, child_id: conflict.child_id, resolved_by, note },
    );
    return ok({ event });
  }

  // ---- 通知与升级 -----------------------------------------------------------

  #notifyContacts(childId, kind, at, key) {
    const contacts = effectiveVersion(this.#state.records.emergencyContacts.get(childId) ?? [], at)?.contacts ?? [];
    for (const contact of contacts) {
      const notificationId = `ntf:${key}:${contact.person_id}`;
      if (this.#state.notifications.has(notificationId)) continue;
      this.#append(
        "NOTIFICATION_SENT",
        "child_enrollment",
        childId,
        at,
        `通知 ${contact.person_id}：${kind}`,
        {
          notification_id: notificationId,
          child_id: childId,
          kind,
          to: contact.person_id,
          confirm_by: addMinutes(at, this.#confirmMinutes),
        },
      );
    }
  }

  confirmNotification({ notification_id, confirmed_by, at }) {
    const notification = this.#state.notifications.get(notification_id);
    if (!notification) return fail("NOTIFICATION_UNKNOWN", `通知 ${notification_id} 不存在`);
    if (notification.status === "confirmed") return ok({ deduplicated: true });
    const event = this.#append(
      "NOTIFICATION_CONFIRMED",
      "child_enrollment",
      notification.child_id,
      at,
      `通知 ${notification_id} 已确认`,
      { notification_id, confirmed_by },
    );
    return ok({ event });
  }

  /** 推进时钟：对逾期未确认的通知发起升级。断线恢复后调用即可继续升级流程。 */
  tick(now) {
    const raised = [];
    for (const notification of this.#state.notifications.values()) {
      if (notification.status !== "pending") continue;
      if (parseTime(notification.confirm_by) >= parseTime(now)) continue;
      const already = this.#state.escalations.some(
        (e) => e.kind === "NOTIFICATION_OVERDUE" && e.notification_id === notification.notification_id,
      );
      if (already) continue;
      const event = this.#append(
        "ESCALATION_RAISED",
        "child_enrollment",
        notification.child_id,
        now,
        `通知 ${notification.notification_id} 逾期未确认，升级`,
        { kind: "NOTIFICATION_OVERDUE", notification_id: notification.notification_id, child_id: notification.child_id },
      );
      raised.push(event);
    }
    return raised;
  }

  listEscalations() {
    return this.#state.escalations.map((e) => ({ ...e }));
  }

  // ---- 事后调查 -----------------------------------------------------------

  /** 按 as_of 当时视角还原：地点变化审批人、现场负责人、交付对象、未确认通知。 */
  investigate(child_id, as_of) {
    const cutoff = parseTime(as_of);
    const events = this.#events.filter(
      (event) => parseTime(event.occurred_at) <= cutoff,
    );

    const siteChanges = events
      .filter((e) => e.event_type === "CHILD_TRANSFERRED" && e.payload.child_id === child_id)
      .map((e) => ({
        transfer_id: e.payload.transfer_id,
        from_session_id: e.payload.from_session_id,
        to_session_id: e.payload.to_session_id,
        from_site_id: e.payload.from_site_id,
        to_site_id: e.payload.to_site_id,
        approved_by: e.payload.approved_by,
        at: e.occurred_at,
      }));

    let placementSessionId = null;
    for (const event of events) {
      if (event.event_type === "CHILD_PLACED" && event.payload.child_id === child_id) {
        placementSessionId = event.payload.session_id;
      }
      if (event.event_type === "CHILD_TRANSFERRED" && event.payload.child_id === child_id) {
        placementSessionId = event.payload.to_session_id;
      }
    }

    let onSiteResponsible = [];
    if (placementSessionId) {
      const planned = events.find(
        (e) => e.event_type === "SESSION_PLANNED" && e.payload.session_id === placementSessionId,
      );
      const frozen = [...events]
        .reverse()
        .find((e) => e.event_type === "SESSION_FROZEN" && e.payload.session_id === placementSessionId);
      onSiteResponsible = (frozen?.payload.staff ?? [])
        .filter((member) => member.role === "lead")
        .map((member) => ({
          session_id: placementSessionId,
          site_id: planned?.payload.site_id ?? null,
          staff_id: member.staff_id,
          role: member.role,
        }));
    }

    const releasedTo = events
      .filter((e) => e.event_type === "HANDOVER_RECORDED" && e.payload.child_id === child_id)
      .map((e) => ({
        receipt_id: e.payload.receipt_id,
        person_id: e.payload.person_id,
        session_id: e.payload.session_id,
        site_id: e.payload.site_id,
        via: e.payload.via,
        recorded_by: e.payload.recorded_by,
        at: e.occurred_at,
      }));

    const confirmedIds = new Set(
      events.filter((e) => e.event_type === "NOTIFICATION_CONFIRMED").map((e) => e.payload.notification_id),
    );
    const unconfirmed = events
      .filter((e) => e.event_type === "NOTIFICATION_SENT" && e.payload.child_id === child_id)
      .filter((e) => !confirmedIds.has(e.payload.notification_id))
      .map((e) => ({
        notification_id: e.payload.notification_id,
        kind: e.payload.kind,
        to: e.payload.to,
        sent_at: e.occurred_at,
        confirm_by: e.payload.confirm_by,
      }));

    return {
      child_id,
      as_of,
      site_changes: siteChanges,
      on_site_responsible: onSiteResponsible,
      released_to: releasedTo,
      unconfirmed_notifications: unconfirmed,
    };
  }
}
