-- These policies predate server-mediated profile access. Resolve the names from
-- pg_policies to remove catalog variants left by older Supabase migrations.
do $$
declare
  legacy_policy_name text;
begin
  for legacy_policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_profiles'
      and policyname in (
        'Users can only overwrite or update their own tracking rows.',
        'Users can only retrieve their own private profile records.',
        'Users can read their own profile tier metadata.'
      )
  loop
    execute format('drop policy %I on public.user_profiles', legacy_policy_name);
  end loop;
end;
$$;
