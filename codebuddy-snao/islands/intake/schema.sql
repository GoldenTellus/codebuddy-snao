-- 岛 03（接入）自己的库：snao_intake
-- 事实：有哪些源、源里有什么文档、谁拥有、可见范围是什么、删了没有
-- 判定：一条都不写（谁能看由线算）

create table if not exists source (
  id          bigserial primary key,
  tenant_id   text not null,
  kind        text not null,              -- wecom-aibot / wecom-wedrive（未来）/ local-dir
  name        text not null,
  config      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create table if not exists doc (
  id             bigserial primary key,
  tenant_id      text not null,
  source_kind    text not null,
  source_doc_id  text not null,           -- 源里的唯一 id（企微 msgid）
  space_id       text not null,           -- 会话/空间：单聊=userid，群=chatid
  space_kind     text not null default 'single',   -- single | group
  owner_subject  text not null,           -- 谁放进来的
  name           text not null,
  mime           text,
  size           bigint,
  sha256         text,
  path           text,
  received_at    timestamptz not null default now(),
  status         text not null default 'active',   -- active | deleted
  deleted_at     timestamptz,
  unique (tenant_id, source_kind, source_doc_id)
);
create index if not exists idx_doc_space on doc (tenant_id, space_id);
create index if not exists idx_doc_owner on doc (tenant_id, owner_subject);
