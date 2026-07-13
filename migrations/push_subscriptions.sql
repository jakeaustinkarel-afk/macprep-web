-- =========================================================================
-- push_subscriptions — Web Push (VAPID) subscription store
-- =========================================================================
-- One row per browser PushSubscription. Written ONLY by the server's Supabase
-- service_role client (RLS is on with zero policies => anon/authenticated are
-- fail-closed; the service role bypasses RLS).
--
-- This table already exists in the live Supabase project; this file exists so
-- the schema is reproducible from source (a fresh project can be rebuilt) and
-- code-reviewed. It is idempotent — safe to re-run.
--
-- Consumed by src/server.mjs:
--   subscribe    -> upsert on endpoint             (POST /api/push/subscribe)
--   unsubscribe  -> delete by endpoint / user      (POST /api/push/unsubscribe)
--   send         -> select by user, stamp last_pushed_at, prune 404/410 dead subs
-- =========================================================================

create table if not exists public.push_subscriptions (
    id             bigint generated always as identity primary key,
    user_id        uuid        not null,
    endpoint       text        not null,
    subscription   jsonb       not null,   -- full W3C PushSubscription (endpoint + p256dh/auth keys)
    last_pushed_at timestamptz,            -- stamped on a successful send; drives the ~20h throttle
    created_at     timestamptz not null default now()
);

-- Dedupe re-subscribes: the server upserts with onConflict:'endpoint'.
create unique index if not exists push_subscriptions_endpoint_key
    on public.push_subscriptions (endpoint);

-- Per-user fan-out (server selects .eq('user_id', ...) when sending).
create index if not exists idx_push_subscriptions_user
    on public.push_subscriptions (user_id);

-- Referential integrity: a deleted account takes its push rows with it, so we
-- never sign pushes for a user who no longer exists. Guarded so re-runs are safe.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'push_subscriptions_user_id_fkey'
          and conrelid = 'public.push_subscriptions'::regclass
    ) then
        alter table public.push_subscriptions
            add constraint push_subscriptions_user_id_fkey
            foreign key (user_id) references auth.users (id) on delete cascade;
    end if;
end $$;

-- Lock the table down: RLS on, no policies (only the service_role server touches it).
alter table public.push_subscriptions enable row level security;
