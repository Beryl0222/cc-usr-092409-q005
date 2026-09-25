/** 邻里课堂安全协作使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
}

/** 课程在岗人员。role 为 lead 者视为现场负责人。 */
export interface StaffMember {
  staff_id: string;
  role: "lead" | "support";
  qualifications: string[];
}

/** 代接人授权范围：站点列表（"*" 表示全部）与生效日期区间。 */
export interface DelegateScope {
  person_id: string;
  sites: string[];
  valid_from: string;
  valid_to: string;
}

/** 保护案件禁交付指令：deny_list 禁止指定人员，guardian_only 仅限监护人，lifted 解除。 */
export interface NoReleaseDirective {
  case_id: string;
  child_id: string;
  mode: "deny_list" | "guardian_only" | "lifted";
  forbidden_persons: string[];
}

/** 交付判定结果。 */
export interface ReleaseDecision {
  allowed: boolean;
  reason:
    | "GUARDIAN"
    | "TEMP_GUARDIAN"
    | "DELEGATE"
    | "NOT_PLACED"
    | "ALREADY_RELEASED"
    | "DELIVERY_FROZEN"
    | "LATE_NO_RELEASE"
    | "NO_RELEASE_DIRECTIVE"
    | "NOT_AUTHORIZED"
    | "SESSION_UNKNOWN";
}
