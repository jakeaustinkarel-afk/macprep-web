-- The auth trigger already fully qualifies its table reference; an empty search
-- path removes the remaining object-shadowing risk from its SECURITY DEFINER body.
alter function public.handle_new_user_profile_provisioning()
  set search_path = '';
