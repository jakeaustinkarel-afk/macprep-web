-- Legacy voucher claims store the Auth UUID as varchar. Cast the function input
-- explicitly so account deletion works across the current production contract.
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
