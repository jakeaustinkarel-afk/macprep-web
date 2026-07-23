begin;

-- Voucher creation and inspection are server-owned operations. The Express
-- routes authenticate the site owner before using the service-role client.
-- Direct authenticated PostgREST access would otherwise let any account mint
-- a self-owned voucher and redeem it for premium access.
-- Define the legacy table contract as well so a clean recovery database does
-- not depend on schema state that existed before versioned migrations.
create table if not exists public.program_vouchers (
    id serial primary key,
    owner_director_id uuid not null,
    voucher_key varchar not null unique,
    is_claimed boolean default false,
    claimed_by_id varchar default null,
    claimed_by_email varchar default null,
    claimed_at timestamptz,
    created_at timestamptz default now(),
    label text
);

alter table public.program_vouchers enable row level security;

do $$
declare
    policy_row record;
begin
    for policy_row in
        select policyname
        from pg_policies
        where schemaname = 'public'
          and tablename = 'program_vouchers'
    loop
        execute format(
            'drop policy if exists %I on public.program_vouchers',
            policy_row.policyname
        );
    end loop;
end;
$$;

revoke all on table public.program_vouchers from public, anon, authenticated;
grant all on table public.program_vouchers to service_role;

commit;
