-- 岛 02（沉淀）自己的库：snao_precipitate
-- 岛内怎么实现，岛外不关心；对外只有三口：ingest / candidates / export

create table if not exists candidate (
  id             bigserial primary key,
  tenant_id      text not null,
  source_seq     bigint,                 -- 线递进来的 journal seq（可追溯）
  subject_id     text not null,          -- 谁的工作记录
  content        text not null,
  kind           text not null default 'fact',
  share_scope    text not null default 'personal',   -- D-09：默认 personal
  status         text not null default 'draft',      -- draft|pending|accepted|rejected
  quality        real not null default 0,
  dedup_of       bigint,                 -- 与已有知识重复 → 指向它（不静默合并）
  conflict_with  bigint,                 -- 与已有知识矛盾 → 指向它
  decision_id    bigint,                 -- 上呈线之后拿到的 decision
  origin         jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index if not exists idx_cand_pending on candidate (tenant_id, status);
create index if not exists idx_cand_subject on candidate (tenant_id, subject_id, share_scope);

create table if not exists knowledge (
  id              bigserial primary key,
  tenant_id       text not null,
  candidate_id    bigint not null,
  subject_id      text not null,
  content         text not null,
  share_scope     text not null default 'personal',
  share_target_id text,                  -- personal→subject_id；team→team_id；enterprise→null
  version         int not null default 1,
  superseded_by   bigint,
  retired_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists idx_knowledge_scope on knowledge (tenant_id, share_scope);

-- 已消费的 journal seq，防止重复 ingest
create table if not exists applied_seq (
  seq bigint primary key
);
