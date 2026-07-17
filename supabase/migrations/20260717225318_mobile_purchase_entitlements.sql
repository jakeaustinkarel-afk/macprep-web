-- Native in-app purchases are verified by the Express server before this ledger
-- is written. It prevents the same Store transaction from being linked to more
-- than one MACPrep account and keeps receipt tokens out of browser-visible data.

create table if not exists public.mobile_purchase_entitlements (
    id uuid primary key default gen_random_uuid(),
    store text not null check (store in ('apple', 'google_play')),
    store_transaction_id text not null,
    original_transaction_id text,
    product_id text not null,
    user_id uuid not null references auth.users(id) on delete restrict,
    environment text,
    purchased_at timestamptz,
    verified_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (store, store_transaction_id)
);

alter table public.mobile_purchase_entitlements enable row level security;
revoke all on table public.mobile_purchase_entitlements from public, anon, authenticated;
grant all on table public.mobile_purchase_entitlements to service_role;

create index if not exists idx_mobile_purchase_entitlements_user_id
    on public.mobile_purchase_entitlements (user_id);

-- Account erasure must remove the ledger before deleting auth.users because the
-- ledger deliberately uses a restrictive foreign key. Store-side account binding
-- still prevents an old Apple or Google purchase from being attached to a newly
-- created MACPrep account.
create or replace function public.delete_macprep_account(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_email text;
begin
    if p_user is null then
        raise exception 'A user id is required.';
    end if;

    select email into target_email
    from auth.users
    where id = p_user;

    if not found then
        raise exception 'Account not found.';
    end if;

    delete from public.user_progress where user_id = p_user;
    delete from public.review_state where user_id = p_user;
    delete from public.user_flags where user_id = p_user;
    delete from public.user_flashcards where user_id = p_user;
    delete from public.user_notes where user_id = p_user;
    delete from public.push_subscriptions where user_id = p_user;
    delete from public.native_device_tokens where user_id = p_user;
    delete from public.analytics_events where user_id = p_user;
    delete from public.mobile_purchase_entitlements where user_id = p_user;
    delete from public.user_suggestions
    where lower(coalesce(user_email, '')) = lower(coalesce(target_email, ''));
    delete from public.reviews where user_id = p_user;
    delete from public.program_vouchers
    where owner_director_id = p_user or claimed_by_id = p_user::text;
    delete from public.duels where creator_id = p_user or opponent_id = p_user;
    delete from public.user_profiles where user_id = p_user;
    delete from auth.users where id = p_user;
end;
$$;

revoke all on function public.delete_macprep_account(uuid) from public, anon, authenticated;
grant execute on function public.delete_macprep_account(uuid) to service_role;
