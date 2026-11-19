-- SNAO 线：最小数据模型（P1）
-- 口径：单租户部署，但 tenant_id 照常存在（D-08；V1.1 §2.5）
-- 依据：SNAO_实现方案与路线图_v2.0.md 第二部分 §7

create table if not exists subject_scope (
  id            bigserial primary key,
  tenant_id     text not null,
  subject_id    text not null,
  action        text not null,
  resource      text not null,
  granted_by    text not null,
  granted_at    timestamptz not null default now(),
  expires_at    timestamptz,
  revoked_at    timestamptz
);
create index if not exists idx_scope_lookup on subject_scope (tenant_id, subject_id, action);

-- 谁能进门：token → subject。token 只存 sha256，不存明文
create table if not exists subject_token (
  id            bigserial primary key,
  tenant_id     text not null,
  subject_id    text not null,
  token_hash    text not null unique,
  note          text,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);

create table if not exists decision (
  id            bigserial primary key,
  tenant_id     text not null,
  run_id        text not null,
  reason        text not null,
  payload       jsonb not null,
  status        text not null default 'pending',
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,
  sla_deadline  timestamptz
);
create index if not exists idx_decision_pending on decision (tenant_id, status) where status = 'pending';

create table if not exists journal (
  seq           bigserial primary key,
  tenant_id     text not null,
  run_id        text,
  subject_id    text not null,
  action        text not null,
  target        text,
  outcome       text not null,
  detail        jsonb,
  occurred_at   timestamptz not null default now()
);
create index if not exists idx_journal_recent on journal (tenant_id, occurred_at desc);

-- journal 只许追加：撤销 update/delete 权限（表所有者除外时用触发器兜底）
create or replace function journal_append_only() returns trigger as $$
begin
  raise exception 'journal is append-only';
end;
$$ language plpgsql;

drop trigger if exists trg_journal_no_update on journal;
create trigger trg_journal_no_update before update or delete on journal
  for each row execute function journal_append_only();
