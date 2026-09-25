/** 邻里课堂安全协作使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  /** 接收端落盘时间；occurred_at 为业务发生时间。 */
  recorded_at?: string;
  payload?: Record<string, unknown>;
}

/** 监护人条目。 */
export interface Guardian {
  person_id: string;
  name: string;
  relation: string;
  phone?: string;
}

/** 代接人条目：仅在 valid_from–valid_until 窗口内可接领；sites 限定可用接送点。 */
export interface DelegateEntry {
  person_id: string;
  name: string;
  relation: string;
  valid_from: string;
  valid_until: string;
  sites?: string[] | null;
}

/** 禁交付指令：source 为 PROTECTION_CASE 时优先于一切普通授权，且只能由保障负责人解除。 */
export interface NoReleaseOrder {
  order_id: string;
  child_id: string;
  target_person_id: string;
  source: "PROTECTION_CASE" | "GUARDIAN";
  reason: string;
  effective_from: string;
  effective_until?: string | null;
}

/** 紧急联系人条目。 */
export interface EmergencyContact {
  person_id: string;
  name: string;
  relation: string;
  phone: string;
  priority?: number;
}

/** 课程冻结的在岗人员；每次课程必须有一名 LEAD 现场负责人。 */
export interface SessionStaff {
  staff_id: string;
  role: "LEAD" | "SUPPORT";
}

/** SESSION_FROZEN 的载荷：冻结地点、时段、在岗人员与当日有效授权快照。 */
export interface SessionFreezePayload {
  session_id: string;
  site_id: string;
  date: string;
  window: { start: string; end: string };
  staff: SessionStaff[];
  roster: string[];
  capacity: number;
  auth_snapshot: Record<
    string,
    { guardianship: number | null; delegation: number | null; contacts: number | null }
  >;
}

/** 交付决策依据：记录在接送回执中，供事后调查按当时视角还原。 */
export interface DecisionBasis {
  matched: "GUARDIAN" | "DELEGATE";
  matched_source: "GUARDIANSHIP" | "DELEGATION" | "TEMP_CHANGE";
  guardianship_version: number | null;
  delegation_version: number | null;
  temp_change_ids: string[];
  no_release_checked: string[];
}

/** CHILD_CHECKED_OUT 的载荷：接送回执（PERSON）或调班交接（TRANSFER）。 */
export interface CheckOutPayload {
  session_id: string;
  child_id: string;
  handed_to:
    | { type: "PERSON"; person_id: string }
    | { type: "TRANSFER"; transfer_id: string; escorted_by: string };
  released_by: string;
  stable_id: string;
  status: "EFFECTIVE" | "PENDING_VERIFICATION";
  decision_basis?: DecisionBasis;
  note?: string | null;
}

/** PICKUP_CHANGED 的载荷：监护人临时变更申请，二次核验通过前不生效。 */
export interface TempChangePayload {
  change_id: string;
  child_id: string;
  kind: "ADD_DELEGATE" | string;
  content: DelegateEntry | Record<string, unknown>;
  requested_by: string;
  recorded_by: string;
  verify_deadline: string;
}
