/**
 * 键控互斥锁：同一组键上的临界区串行执行，不同键互不阻塞。
 * 用于并发调班时按儿童与课程场次串行化校验与写入。
 */
export class KeyedLock {
  constructor() {
    this.tail = new Map();
  }

  async run(keys, fn) {
    const sorted = [...new Set(keys)].sort();
    const waitFor = sorted.map((key) => this.tail.get(key)).filter(Boolean);
    const gate = Promise.all(waitFor);
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = gate.then(() => current);
    for (const key of sorted) this.tail.set(key, tail);
    try {
      await gate;
      return await fn();
    } finally {
      release();
      for (const key of sorted) {
        if (this.tail.get(key) === tail) this.tail.delete(key);
      }
    }
  }
}
