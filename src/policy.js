import { AGGREGATES as A, EVENT_TYPES as E } from "./events.js";

const ts = (iso) => Date.parse(iso);

/**
 * 保障文书解析器：监护关系、代接范围、禁交付指令、紧急联系人分别版本化，
 * 所有解析都按指定时刻（at）重放事件，支撑交付决策与事后调查的"当时视角"。
 *
 * 安全语义：
 * - 代接人撤回、禁交付指令即时生效，不受课程冻结快照限制；
 * - 监护人临时变更必须完成二次核验才进入有效授权；
 * - 涉及保护案件的禁交付限制优先于一切普通授权。
 */
export class PolicyResolver {
  /** events 为事件存储的实时数组引用，追加后无需重建。 */
  constructor(events) {
    this.events = events;
  }

  /** 某儿童某类文书在 at 时刻的最新版本事件。 */
  latestDoc(childId, type, at) {
    let best = null;
    for (const event of this.events) {
      if (event.event_type !== type || event.payload?.child_id !== childId) continue;
      if (at && ts(event.occurred_at) > ts(at)) continue;
      if (!best || ts(event.occurred_at) >= ts(best.occurred_at)) best = event;
    }
    return best;
  }

  /** 某类文书聚合在 at 时刻的版本号（含撤回等全部历史事件）。 */
  docVersion(childId, doc, at) {
    const aggregateId = `policy:${childId}:${doc}`;
    let version = null;
    for (const event of this.events) {
      if (event.aggregate_type !== A.POLICY || event.aggregate_id !== aggregateId) continue;
      if (at && ts(event.occurred_at) > ts(at)) continue;
      version = Math.max(version ?? 0, event.version);
    }
    return version;
  }

  /** 临时变更单的状态机折叠。 */
  tempChange(changeId, at = null) {
    let change = null;
    for (const event of this.events) {
      const p = event.payload ?? {};
      if (p.change_id !== changeId) continue;
      if (at && ts(event.occurred_at) > ts(at)) continue;
      switch (event.event_type) {
        case E.PICKUP_CHANGED:
          change = {
            change_id: changeId,
            child_id: p.child_id,
            kind: p.kind,
            content: p.content,
            requested_by: p.requested_by,
            recorded_by: p.recorded_by,
            verify_deadline: p.verify_deadline,
            requested_at: event.occurred_at,
            status: "PENDING",
          };
          break;
        case E.TEMP_CHANGE_VERIFIED:
          if (change) {
            change.status = "VERIFIED";
            change.verified_by = p.verified_by;
            change.verified_at = event.occurred_at;
            change.method = p.method;
          }
          break;
        case E.TEMP_CHANGE_REJECTED:
          if (change) {
            change.status = "REJECTED";
            change.rejected_by = p.rejected_by;
            change.reject_reason = p.reason;
          }
          break;
        case E.TEMP_CHANGE_EXPIRED:
          if (change && change.status === "PENDING") {
            change.status = "EXPIRED";
            change.expired_at = event.occurred_at;
          }
          break;
        default:
          break;
      }
    }
    return change;
  }

  tempChangesFor(childId, at = null) {
    const ids = [];
    for (const event of this.events) {
      if (event.event_type !== E.PICKUP_CHANGED || event.payload?.child_id !== childId) continue;
      if (at && ts(event.occurred_at) > ts(at)) continue;
      ids.push(event.payload.change_id);
    }
    return [...new Set(ids)].map((id) => this.tempChange(id, at)).filter(Boolean);
  }

  /** at 时刻仍然有效的禁交付指令（未解除且在生效窗口内）。 */
  activeNoReleaseOrders(childId, at) {
    const cutoff = ts(at);
    const orders = new Map();
    for (const event of this.events) {
      const p = event.payload ?? {};
      if (p.child_id !== childId || ts(event.occurred_at) > cutoff) continue;
      if (event.event_type === E.NO_RELEASE_ISSUED) {
        orders.set(p.order_id, { ...p, issued_at: event.occurred_at, lifted: false });
      } else if (event.event_type === E.NO_RELEASE_LIFTED) {
        const order = orders.get(p.order_id);
        if (order) order.lifted = true;
      }
    }
    return [...orders.values()].filter(
      (order) =>
        !order.lifted &&
        ts(order.effective_from) <= cutoff &&
        (!order.effective_until || ts(order.effective_until) >= cutoff),
    );
  }

  /** 某人是否在 at 时刻处于"曾被授权但已撤回"的状态（用于区分陌生人与已撤回代接人）。 */
  wasDelegateWithdrawn(childId, personId, at) {
    const cutoff = ts(at);
    const docs = this.events.filter(
      (event) =>
        event.event_type === E.DELEGATION_RECORDED &&
        event.payload?.child_id === childId &&
        ts(event.occurred_at) <= cutoff,
    );
    const lastWith = docs.filter((doc) => doc.payload.delegates.some((d) => d.person_id === personId)).pop();
    if (!lastWith) return false;
    const newer = docs.filter((doc) => ts(doc.occurred_at) > ts(lastWith.occurred_at)).pop();
    if (newer) return false; // 更新版本的名单已不含此人，按未授权处理
    return this.events.some(
      (event) =>
        event.event_type === E.DELEGATE_WITHDRAWN &&
        event.payload?.child_id === childId &&
        event.payload.person_id === personId &&
        ts(event.occurred_at) >= ts(lastWith.occurred_at) &&
        ts(event.occurred_at) <= cutoff,
    );
  }

  /**
   * 解析 at 时刻的有效授权：
   * 最新监护关系版本 + 最新代接名单（扣除其后的撤回）+ 已核验临时变更 + 有效禁交付指令。
   */
  resolve(childId, at) {
    const guardianship = this.latestDoc(childId, E.GUARDIANSHIP_RECORDED, at);
    const delegation = this.latestDoc(childId, E.DELEGATION_RECORDED, at);
    const contacts = this.latestDoc(childId, E.EMERGENCY_CONTACTS_RECORDED, at);

    const withdrawn = new Set(
      this.events
        .filter(
          (event) =>
            event.event_type === E.DELEGATE_WITHDRAWN &&
            event.payload?.child_id === childId &&
            ts(event.occurred_at) <= ts(at) &&
            delegation &&
            ts(event.occurred_at) >= ts(delegation.occurred_at),
        )
        .map((event) => event.payload.person_id),
    );

    const baseDelegates = (delegation?.payload.delegates ?? [])
      .filter((d) => !withdrawn.has(d.person_id))
      .map((d) => ({ ...d, source: "DELEGATION", version: delegation.version }));

    const tempDelegates = this.tempChangesFor(childId, at)
      .filter((c) => c.status === "VERIFIED" && c.kind === "ADD_DELEGATE")
      .map((c) => ({ ...c.content, source: "TEMP_CHANGE", change_id: c.change_id }));

    // 同一人同时存在长期授权与已核验临时变更时，以临时变更为准
    const tempIds = new Set(tempDelegates.map((d) => d.person_id));
    const delegates = [...baseDelegates.filter((d) => !tempIds.has(d.person_id)), ...tempDelegates];

    return {
      guardianship: guardianship
        ? { version: guardianship.version, guardians: guardianship.payload.guardians }
        : { version: null, guardians: [] },
      // 版本号锚定文书聚合（含撤回历史），供回执与快照精确对照
      delegation_version: this.docVersion(childId, "delegation", at),
      delegates,
      no_release: this.activeNoReleaseOrders(childId, at),
      contacts: contacts
        ? { version: contacts.version, contacts: contacts.payload.contacts }
        : { version: null, contacts: [] },
    };
  }
}
