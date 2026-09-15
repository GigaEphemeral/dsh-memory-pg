-- ============================================================================
-- dsh_memory_pg 全量建库 + 建表 SQL
--
-- 用途：手动准备 PostgreSQL 数据库时执行（插件**不会自动建库**，见 README 安装章节）。
-- 执行方式：
--   1. 建库（连 postgres 库执行，库名可改）：
--        psql -U postgres -c "CREATE DATABASE dsh_memory_pg;"
--   2. 建扩展 + 建表（连入目标库执行本文件）：
--        psql -U postgres -d dsh_memory_pg -f sql/schema.sql
--
-- 幂等性：全部语句带 IF NOT EXISTS，可重复执行（与插件内 src/schema.ts 的
-- EXTENSION_SQL + SCHEMA_SQL 一致，插件首次连接 migrate 也会自动执行）。
--
-- 注意：
--   - pg_trgm 是关键词检索主路径（必须）
--   - vector 仅开启向量检索时需要（可选，默认关 D7）
--   - 表结构一次建全；v1 实际写入 messages + facts（ltm_entries 周期合并 v1.5，
--     embeddings 开向量才写）
-- ============================================================================

-- ============ 0. 扩展 ============
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- ============ 1. 原始日志层：完整消息/事件（目的3：审计与回溯） ============
CREATE TABLE IF NOT EXISTS messages (
  message_id     BIGSERIAL PRIMARY KEY,
  workspace_id   TEXT        NOT NULL,
  session_id     TEXT        NOT NULL,
  agent_id       TEXT,
  role           TEXT        NOT NULL,
  event_type     TEXT        NOT NULL DEFAULT 'message',
  content        TEXT        NOT NULL,
  source_seq     BIGINT,
  content_hash   TEXT        NOT NULL,
  token_count    INTEGER,
  created_at     TIMESTAMPTZ NOT NULL,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  retention_until TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_messages_ws_session_time ON messages (workspace_id, session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_ws_hash ON messages (workspace_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_messages_content_trgm ON messages USING gin (content gin_trgm_ops);

-- ============ 2. 结构化事实层：原子事实（目的1&3：核心记忆） ============
CREATE TABLE IF NOT EXISTS facts (
  fact_id          BIGSERIAL PRIMARY KEY,
  workspace_id     TEXT        NOT NULL,
  session_id       TEXT,
  agent_id         TEXT,
  subject          TEXT        NOT NULL,
  predicate        TEXT        NOT NULL,
  object           TEXT        NOT NULL,
  content          TEXT        NOT NULL,
  kind             TEXT        NOT NULL DEFAULT 'fact',
  tags             TEXT[]      DEFAULT '{}',
  importance       NUMERIC(3,1),
  confidence       NUMERIC(3,1),
  status           TEXT        NOT NULL DEFAULT 'active',
  version          INTEGER     NOT NULL DEFAULT 1,
  superseded_by    BIGINT,
  source_message_ids BIGINT[],
  content_hash     TEXT        NOT NULL,
  token_count      INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  valid_from       TIMESTAMPTZ,
  valid_until      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_facts_ws_hash ON facts (workspace_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_facts_tags ON facts USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_facts_content_trgm ON facts USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_facts_ws_importance ON facts (workspace_id, importance DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_ws_created ON facts (workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_ws_status ON facts (workspace_id, status) WHERE deleted_at IS NULL;

-- ============ 3. 长期知识层：摘要/知识块（目的1&2：上下文不足时召回） ============
CREATE TABLE IF NOT EXISTS ltm_entries (
  entry_id         BIGSERIAL PRIMARY KEY,
  workspace_id     TEXT        NOT NULL,
  session_id       TEXT,
  agent_id         TEXT,
  summary_type     TEXT        NOT NULL,
  title            TEXT,
  content          TEXT        NOT NULL,
  tags             TEXT[]      DEFAULT '{}',
  source_message_ids BIGINT[],
  source_fact_ids  BIGINT[],
  is_summary       BOOLEAN     NOT NULL DEFAULT TRUE,
  summary_of       TEXT,
  importance       NUMERIC(3,1),
  confidence       NUMERIC(3,1),
  status           TEXT        NOT NULL DEFAULT 'active',
  version          INTEGER     NOT NULL DEFAULT 1,
  superseded_by    BIGINT,
  content_hash     TEXT        NOT NULL,
  token_count      INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  valid_from       TIMESTAMPTZ,
  valid_until      TIMESTAMPTZ,
  retention_until  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ltm_ws_created ON ltm_entries (workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ltm_tags ON ltm_entries USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_ltm_content_trgm ON ltm_entries USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ltm_ws_status ON ltm_entries (workspace_id, status) WHERE deleted_at IS NULL;

-- ============ 4. 向量索引层：内容-向量分离绑定（目的2：语义召回） ============
CREATE TABLE IF NOT EXISTS embeddings (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  ref_table       TEXT        NOT NULL,
  ref_id          BIGINT      NOT NULL,
  content_hash    TEXT        NOT NULL,
  embedding       VECTOR(1024) NOT NULL,
  embedding_model TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ref_table, ref_id, embedding_model)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw ON embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_embeddings_ws ON embeddings (workspace_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings (content_hash);
