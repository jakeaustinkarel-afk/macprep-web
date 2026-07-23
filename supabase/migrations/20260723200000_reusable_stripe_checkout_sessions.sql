-- Keep one reusable, unexpired Stripe Checkout Session per account/product.
-- Browser roles never receive direct table access; the server returns only the
-- authenticated account's verified Stripe URL.

create table if not exists public.stripe_checkout_sessions (
    user_id uuid not null references auth.users(id) on delete cascade,
    price_id text not null,
    session_id text not null,
    checkout_url text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (user_id, price_id),
    unique (session_id),
    constraint stripe_checkout_session_id_format
        check (session_id ~ '^cs_[A-Za-z0-9_]+$'),
    constraint stripe_checkout_url_https
        check (checkout_url ~ '^https://')
);

alter table public.stripe_checkout_sessions enable row level security;
revoke all on table public.stripe_checkout_sessions
    from public, anon, authenticated;
grant select, insert, update, delete on table public.stripe_checkout_sessions
    to service_role;

create index if not exists idx_stripe_checkout_sessions_expiry
    on public.stripe_checkout_sessions (expires_at);
