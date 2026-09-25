import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { validateEvent } from "./validator.js";

/**
 * 追加式事件存储：事件一旦接收不原地改写，业务更正产生后继记录。
 * 可选 JSONL 文件持久化，用于断线恢复；按 event_id 幂等去重，
 * 断线重传同一事件不会产生重复记录。
 */
export class EventStore {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath;
    this.events = [];
    this.byId = new Map();
    this.versions = new Map();
    if (filePath && existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (line.trim()) this.#ingest(JSON.parse(line));
      }
    }
  }

  nextVersion(aggregateType, aggregateId) {
    return (this.versions.get(`${aggregateType}:${aggregateId}`) ?? 0) + 1;
  }

  has(eventId) {
    return this.byId.has(eventId);
  }

  get(eventId) {
    return this.byId.get(eventId) ?? null;
  }

  append(event) {
    const existing = this.byId.get(event.event_id);
    if (existing) return { event: existing, duplicate: true };
    this.#assertEnvelope(event);
    const expected = this.nextVersion(event.aggregate_type, event.aggregate_id);
    if (event.version !== expected) {
      throw new Error(
        `聚合 ${event.aggregate_type}/${event.aggregate_id} 版本冲突：期望 ${expected}，收到 ${event.version}`,
      );
    }
    this.#persist([event]);
    this.#ingest(event);
    return { event, duplicate: false };
  }

  /**
   * 批量追加：同批事件共享一次落盘，要么全部接收要么全部拒绝，
   * 用于跨点接力这类必须成对出现的记录（调出签退 + 调入签到）。
   */
  appendAll(events) {
    const fresh = [];
    const seen = new Set();
    for (const event of events) {
      if (this.byId.has(event.event_id) || seen.has(event.event_id)) {
        throw new Error(`批量追加中出现重复事件：${event.event_id}`);
      }
      seen.add(event.event_id);
      this.#assertEnvelope(event);
      fresh.push(event);
    }
    const expected = new Map();
    for (const event of fresh) {
      const key = `${event.aggregate_type}:${event.aggregate_id}`;
      const base = expected.get(key) ?? this.nextVersion(event.aggregate_type, event.aggregate_id);
      if (event.version !== base) {
        throw new Error(
          `聚合 ${event.aggregate_type}/${event.aggregate_id} 版本冲突：期望 ${base}，收到 ${event.version}`,
        );
      }
      expected.set(key, base + 1);
    }
    this.#persist(fresh);
    for (const event of fresh) this.#ingest(event);
    return fresh;
  }

  ofType(...types) {
    return this.events.filter((event) => types.includes(event.event_type));
  }

  ofAggregate(aggregateType, aggregateId) {
    return this.events.filter(
      (event) => event.aggregate_type === aggregateType && event.aggregate_id === aggregateId,
    );
  }

  #assertEnvelope(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) {
      throw new Error(`事件信封不合法：${errors.join("；")}`);
    }
  }

  #persist(events) {
    if (!this.filePath || events.length === 0) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  }

  #ingest(event) {
    this.events.push(event);
    this.byId.set(event.event_id, event);
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    this.versions.set(key, Math.max(this.versions.get(key) ?? 0, event.version));
  }
}
