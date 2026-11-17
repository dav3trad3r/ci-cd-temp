-- Every table gets row-level security switched on. tests/security/rls.test.ts fails
-- the build if any table in the public schema is missing it.
--
-- With RLS on and no policies, only the table's owner (this app's server) can read or
-- write rows. If the database is ever exposed through Supabase or another auto-generated
-- API, nothing leaks until someone writes a policy on purpose.

create table items (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  title text not null check (char_length(title) between 1 and 200),
  due_at timestamptz,
  created_at timestamptz not null default now()
);

alter table items enable row level security;

create index items_owner_idx on items (owner_id);
