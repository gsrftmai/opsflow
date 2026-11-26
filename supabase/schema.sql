-- OpsFlow schema. Run once in Supabase → SQL Editor.
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  department text not null default 'Front Office',
  assignee text not null default 'Unassigned',
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  status text not null default 'new' check (status in ('new','progress','done')),
  due timestamptz,
  created timestamptz not null default now(),
  completed timestamptz,
  source text not null default 'manual',      -- 'manual' | 'whatsapp'
  sender text,
  source_message text
);
create table if not exists activity (
  id bigint generated always as identity primary key,
  t timestamptz not null default now(),
  m text not null
);
-- Every inbound WhatsApp message (wamid is unique, so Meta retries can't create duplicates)
create table if not exists messages (
  wamid text primary key,
  sender text,
  body text,
  received timestamptz not null default now(),
  task_id uuid references tasks(id) on delete set null,
  result text
);

alter table tasks enable row level security;
alter table activity enable row level security;
alter table messages enable row level security;
-- Any signed-in staff member can use the app. The webhook uses the service role (bypasses RLS).
create policy "staff tasks" on tasks for all to authenticated using (true) with check (true);
create policy "staff activity" on activity for all to authenticated using (true) with check (true);
create policy "staff read messages" on messages for select to authenticated using (true);

alter publication supabase_realtime add table tasks, activity;
