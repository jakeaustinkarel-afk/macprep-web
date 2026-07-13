-- =========================================================================
-- native_device_tokens — FCM device-token store for the native store apps
-- =========================================================================
-- The Capacitor iOS/Android apps register an FCM token (via
-- @capacitor-firebase/messaging) and POST it to /api/push/register-native.
-- The server sends to these tokens through firebase-admin (one send path for
-- both platforms — iOS is routed through FCM, APNs key uploaded to Firebase).
--
-- This is the NATIVE analog of push_subscriptions (which stays Web-Push only,
-- for installed PWAs + browsers). A user can have several rows (phone, tablet).
-- Written only by the server's Supabase service_role client (RLS on, no policies).
-- Idempotent — safe to re-run.
-- =========================================================================

create table if not exists public.native_device_tokens (
    id             bigint generated always as identity primary key,
    user_id        uuid        not null,
    token          text        not null,        -- FCM registration token
    platform       text,                         -- 'ios' | 'android'
    last_pushed_at timestamptz,                   -- stamped on a successful send
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

-- One row per device token; the server upserts with onConflict:'token'.
create unique index if not exists native_device_tokens_token_key
    on public.native_device_tokens (token);

-- Per-user fan-out when sending.
create index if not exists idx_native_device_tokens_user
    on public.native_device_tokens (user_id);

-- Deleting an account takes its device tokens with it.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'native_device_tokens_user_id_fkey'
          and conrelid = 'public.native_device_tokens'::regclass
    ) then
        alter table public.native_device_tokens
            add constraint native_device_tokens_user_id_fkey
            foreign key (user_id) references auth.users (id) on delete cascade;
    end if;
end $$;

alter table public.native_device_tokens enable row level security;
