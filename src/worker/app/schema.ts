// 建表语句与迁移步骤表（§D.2 要点 3、§N.6）：单调、逐级、每级一个事务。
//
// `kv['schema-version']` 是唯一版本源；`user_version` 只作为「读到版本之前」的镜像，
// 免得迁移过程里两个版本源打架。v1 是新库直接建表，无历史包袱。

/**
 * 建表步骤只需要 `exec`（`DatabaseSync` 结构上满足它）。用结构化类型而不是
 * `import type { DatabaseSync }`，迁移步骤就能在测试里对着最小替身跑。
 */
export interface SchemaDatabase {
  exec(sql: string): void
}

/** 一级迁移：从 `from` 升到 `to`，`run` 在调用方给的事务里执行。 */
export interface MigrationStep {
  readonly from: number
  readonly to: number
  run(db: SchemaDatabase): void
}

/**
 * 版 1 的建表语句。逐条对应 §D.2 的代码块，三处有意的补充：
 * - `settings_version` / `prompt_version` 是设计 §D.2 要点 3/5、§L.4 点名的版本表；
 * - `outbox.settled_at` 让「已结算 30 天后清理」有可比的文本时间列；
 * - 每个时间列都能被 `strftime` 解析回原值，非法时刻（如 13 月）落不进库。
 */
const SCHEMA_V1 = `
CREATE TABLE trigger (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  at          TEXT NOT NULL CHECK (at IS strftime('%Y-%m-%dT%H:%M:%fZ', at)),
  actor       TEXT NOT NULL CHECK (json_valid(actor)),
  human       INTEGER NOT NULL CHECK (human IN (0, 1)),
  addressed   TEXT CHECK (addressed IS NULL OR addressed IN ('mention', 'direct')),
  text        TEXT NOT NULL,
  url         TEXT,
  body        TEXT NOT NULL CHECK (json_valid(body))
);
CREATE INDEX trigger_at ON trigger(at);

CREATE TABLE disposition (
  trigger_id  TEXT PRIMARY KEY REFERENCES trigger(id) ON DELETE CASCADE,
  filtered    TEXT,
  eval_id     TEXT,
  decision_id TEXT,
  requeued_at TEXT CHECK (requeued_at IS NULL OR requeued_at IS strftime('%Y-%m-%dT%H:%M:%fZ', requeued_at)),
  body        TEXT NOT NULL CHECK (json_valid(body))
);

CREATE TABLE trigger_thread (
  thread_key     TEXT NOT NULL,
  at             TEXT NOT NULL CHECK (at IS strftime('%Y-%m-%dT%H:%M:%fZ', at)),
  trigger_id     TEXT NOT NULL,
  human          INTEGER NOT NULL CHECK (human IN (0, 1)),
  primary_thread INTEGER NOT NULL CHECK (primary_thread IN (0, 1)),
  PRIMARY KEY (thread_key, at, trigger_id)
);
CREATE INDEX trigger_thread_by_trigger ON trigger_thread(trigger_id);

CREATE TABLE thread (
  key        TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  meta       TEXT NOT NULL CHECK (json_valid(meta)),
  body       TEXT NOT NULL CHECK (json_valid(body)),
  active     INTEGER GENERATED ALWAYS AS
             (json_extract(body, '$.eval.id') IS NOT NULL
              OR json_array_length(body, '$.queued') > 0) VIRTUAL,
  subscribed INTEGER GENERATED ALWAYS AS
             (json_array_length(body, '$.subscriptions') > 0) VIRTUAL
);
CREATE INDEX thread_active     ON thread(active)     WHERE active = 1;
CREATE INDEX thread_subscribed ON thread(subscribed) WHERE subscribed = 1;

CREATE TABLE ticket (
  id       TEXT PRIMARY KEY,
  at       TEXT NOT NULL CHECK (at IS strftime('%Y-%m-%dT%H:%M:%fZ', at)),
  body     TEXT NOT NULL CHECK (json_valid(body)),
  open     INTEGER GENERATED ALWAYS AS (COALESCE(json_extract(body, '$.ended') IS NULL, 1)) VIRTUAL,
  active   INTEGER GENERATED ALWAYS AS
           (COALESCE(json_array_length(body, '$.inputs') > 0
                     OR json_extract(body, '$.execution.assignment.state') IN ('pending', 'running'),
                    0)) VIRTUAL
);
CREATE INDEX ticket_open   ON ticket(open)   WHERE open = 1;
CREATE INDEX ticket_active ON ticket(active) WHERE active = 1;

CREATE TABLE decision (
  id         TEXT PRIMARY KEY,
  thread_key TEXT NOT NULL,
  at         TEXT NOT NULL CHECK (at IS strftime('%Y-%m-%dT%H:%M:%fZ', at)),
  kind       TEXT NOT NULL CHECK (kind IN ('accept', 'stop', 'ignore', 'unavailable')),
  body       TEXT NOT NULL CHECK (json_valid(body))
);
CREATE INDEX decision_thread ON decision(thread_key, at);

CREATE TABLE effect (
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  seq        INTEGER NOT NULL,
  due_at     TEXT NOT NULL CHECK (due_at IS strftime('%Y-%m-%dT%H:%M:%fZ', due_at)),
  attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  PRIMARY KEY (kind, key)
);
CREATE INDEX effect_due ON effect(due_at);

CREATE TABLE outbox (
  id             TEXT PRIMARY KEY,
  ticket_id      TEXT,
  channel        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'dropped')),
  body           TEXT NOT NULL CHECK (json_valid(body)),
  settled_at     TEXT CHECK (settled_at IS NULL OR settled_at IS strftime('%Y-%m-%dT%H:%M:%fZ', settled_at)),
  dropped_at     TEXT CHECK (dropped_at IS NULL OR dropped_at IS strftime('%Y-%m-%dT%H:%M:%fZ', dropped_at)),
  dropped_reason TEXT,
  pending        INTEGER GENERATED ALWAYS AS (status = 'pending') VIRTUAL,
  dropped        INTEGER GENERATED ALWAYS AS (status = 'dropped') VIRTUAL
);
CREATE INDEX outbox_waiting ON outbox(channel, id) WHERE pending = 1;
CREATE INDEX outbox_dropped ON outbox(dropped_at)  WHERE dropped = 1;
CREATE INDEX outbox_settled ON outbox(settled_at)  WHERE status <> 'pending';

CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);

CREATE TABLE settings_version (
  revision     INTEGER PRIMARY KEY CHECK (revision > 0),
  predecessor  INTEGER,
  at           TEXT NOT NULL CHECK (at IS strftime('%Y-%m-%dT%H:%M:%fZ', at)),
  origin       TEXT NOT NULL CHECK (origin IN ('panel', 'tool', 'sync')),
  block        TEXT NOT NULL,
  config       TEXT NOT NULL CHECK (json_valid(config)),
  policy_version TEXT
);

CREATE TABLE prompt_version (
  revision     INTEGER PRIMARY KEY CHECK (revision > 0),
  predecessor  INTEGER,
  at           TEXT NOT NULL CHECK (at IS strftime('%Y-%m-%dT%H:%M:%fZ', at)),
  origin       TEXT NOT NULL CHECK (origin IN ('panel', 'tool')),
  config       TEXT NOT NULL CHECK (json_valid(config))
);
`

/** 本插件支持的 schema 版本（首版为 1，§D.2 要点 3）。 */
export const SCHEMA_VERSION = 1

/** 单调的迁移步骤数组：每一项只升一级，永不回头。 */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    from: 0,
    to: SCHEMA_VERSION,
    run(db: SchemaDatabase): void {
      db.exec(SCHEMA_V1)
    }
  }
]
