-- One account-level entitlement authority for web, native stores, vouchers,
-- program grants, and legacy premium accounts. Provider events update this
-- ledger; user_profiles.account_tier is the derived compatibility field used by
-- the existing application.

create table if not exists public.account_entitlements (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    source text not null check (source in ('stripe', 'apple', 'google_play', 'voucher', 'program', 'admin', 'legacy')),
    source_reference text not null,
    external_payment_id text,
    product_id text,
    status text not null default 'active' check (status in ('active', 'refunded', 'revoked', 'disputed', 'superseded')),
    amount_total bigint,
    currency text,
    metadata jsonb not null default '{}'::jsonb,
    granted_at timestamptz not null default now(),
    status_updated_at timestamptz not null default now(),
    unique (source, source_reference)
);

create index if not exists idx_account_entitlements_user_status
    on public.account_entitlements (user_id, status);
create index if not exists idx_account_entitlements_external_payment
    on public.account_entitlements (external_payment_id)
    where external_payment_id is not null;
create unique index if not exists idx_account_entitlements_source_external_payment
    on public.account_entitlements (source, external_payment_id)
    where external_payment_id is not null;

alter table public.account_entitlements enable row level security;
revoke all on table public.account_entitlements from public, anon, authenticated;
grant all on table public.account_entitlements to service_role;

create or replace function public.recompute_macprep_entitlement(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    has_access boolean;
begin
    select exists (
        select 1 from public.account_entitlements
        where user_id = p_user and status = 'active'
    ) into has_access;

    update public.user_profiles
    set account_tier = case when has_access then 'premium' else 'free' end,
        premium_unlocked_at = case
            when has_access then coalesce(premium_unlocked_at, now())
            else null
        end
    where user_id = p_user;
    return has_access;
end;
$$;

create or replace function public.grant_macprep_entitlement(
    p_user uuid,
    p_email text,
    p_source text,
    p_source_reference text,
    p_external_payment_id text default null,
    p_product_id text default null,
    p_amount_total bigint default null,
    p_currency text default null,
    p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    existing_user uuid;
begin
    if p_user is null or p_source_reference is null or btrim(p_source_reference) = '' then
        raise exception 'A user and source reference are required.';
    end if;
    if p_source not in ('stripe', 'apple', 'google_play', 'voucher', 'program', 'admin', 'legacy') then
        raise exception 'Unsupported entitlement source.';
    end if;

    select user_id into existing_user
    from public.account_entitlements
    where source = p_source and source_reference = p_source_reference
    for update;
    if existing_user is not null and existing_user <> p_user then
        raise exception 'This entitlement is already linked to another account.';
    end if;

    insert into public.account_entitlements (
        user_id, source, source_reference, external_payment_id, product_id,
        status, amount_total, currency, metadata, status_updated_at
    ) values (
        p_user, p_source, p_source_reference, p_external_payment_id, p_product_id,
        'active', p_amount_total, lower(p_currency), coalesce(p_metadata, '{}'::jsonb), now()
    )
    on conflict (source, source_reference) do update set
        external_payment_id = coalesce(excluded.external_payment_id, public.account_entitlements.external_payment_id),
        product_id = coalesce(excluded.product_id, public.account_entitlements.product_id),
        amount_total = coalesce(excluded.amount_total, public.account_entitlements.amount_total),
        currency = coalesce(excluded.currency, public.account_entitlements.currency),
        metadata = public.account_entitlements.metadata || excluded.metadata,
        status = 'active',
        status_updated_at = now();

    -- A verified provider record replaces the migration-only legacy placeholder.
    if p_source <> 'legacy' then
        update public.account_entitlements
        set status = 'superseded', status_updated_at = now()
        where user_id = p_user and source = 'legacy' and status = 'active';
    end if;

    insert into public.user_profiles (user_id, email, account_tier, premium_unlocked_at)
    values (p_user, nullif(lower(btrim(p_email)), ''), 'premium', now())
    on conflict (user_id) do update set
        email = coalesce(public.user_profiles.email, excluded.email),
        account_tier = 'premium',
        premium_unlocked_at = coalesce(public.user_profiles.premium_unlocked_at, now());
    return true;
end;
$$;

create or replace function public.set_macprep_entitlement_status(
    p_source text,
    p_source_reference text,
    p_external_payment_id text,
    p_status text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_user uuid;
begin
    if p_status not in ('active', 'refunded', 'revoked', 'disputed', 'superseded') then
        raise exception 'Unsupported entitlement status.';
    end if;
    update public.account_entitlements
    set status = p_status, status_updated_at = now()
    where source = p_source
      and (
        (p_source_reference is not null and source_reference = p_source_reference)
        or (p_external_payment_id is not null and external_payment_id = p_external_payment_id)
      )
    returning user_id into target_user;
    if target_user is not null then
        perform public.recompute_macprep_entitlement(target_user);
    end if;
    return target_user;
end;
$$;

create or replace function public.claim_macprep_voucher(p_user uuid, p_email text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    voucher public.program_vouchers%rowtype;
begin
    select * into voucher
    from public.program_vouchers
    where upper(voucher_key) = upper(btrim(p_code))
    for update;
    if not found then raise exception 'voucher_not_found'; end if;
    if voucher.is_claimed then raise exception 'voucher_already_claimed'; end if;

    update public.program_vouchers
    set is_claimed = true,
        claimed_by_id = p_user::text,
        claimed_by_email = lower(btrim(p_email)),
        claimed_at = now()
    where id = voucher.id;

    perform public.grant_macprep_entitlement(
        p_user, p_email, 'voucher', voucher.voucher_key, null, null, null, null,
        jsonb_build_object('voucher_id', voucher.id)
    );
    return true;
end;
$$;

revoke all on function public.recompute_macprep_entitlement(uuid) from public, anon, authenticated;
revoke all on function public.grant_macprep_entitlement(uuid, text, text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.set_macprep_entitlement_status(text, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_macprep_voucher(uuid, text, text) from public, anon, authenticated;
grant execute on function public.recompute_macprep_entitlement(uuid) to service_role;
grant execute on function public.grant_macprep_entitlement(uuid, text, text, text, text, text, bigint, text, jsonb) to service_role;
grant execute on function public.set_macprep_entitlement_status(text, text, text, text) to service_role;
grant execute on function public.claim_macprep_voucher(uuid, text, text) to service_role;

-- Preserve current access while recording provider sources we can prove locally.
insert into public.account_entitlements (user_id, source, source_reference, product_id, status, granted_at)
select user_id, store, store_transaction_id, product_id, 'active', coalesce(purchased_at, verified_at, created_at)
from public.mobile_purchase_entitlements
on conflict (source, source_reference) do nothing;

insert into public.account_entitlements (user_id, source, source_reference, status, granted_at)
select claimed_by_id::uuid, 'voucher', voucher_key, 'active', coalesce(claimed_at, created_at)
from public.program_vouchers
where is_claimed
  and claimed_by_id is not null
  and claimed_by_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
on conflict (source, source_reference) do nothing;

insert into public.account_entitlements (user_id, source, source_reference, status, granted_at)
select p.user_id, 'legacy', p.user_id::text, 'active', coalesce(p.premium_unlocked_at, now())
from public.user_profiles p
where p.account_tier = 'premium'
  and not exists (select 1 from public.account_entitlements e where e.user_id = p.user_id and e.status = 'active')
on conflict (source, source_reference) do nothing;
