-- MACPrep's server is the only supported path to application data. These legacy
-- policies exposed answer keys and reviewer email addresses through the Data API.
begin;

drop policy if exists "Allow public read access to questions"
  on public.macprep_questions_deprecated;

drop policy if exists "Allow open review readings"
  on public.user_reviews;

drop policy if exists "Users can only overwrite or update their own tracking rows"
  on public.user_profiles;

drop policy if exists "Users can only retrieve their own private profile records"
  on public.user_profiles;

drop policy if exists "Users can read their own profile tier metadata"
  on public.user_profiles;

revoke all on table public.macprep_questions_deprecated from anon, authenticated;
revoke all on table public.user_reviews from anon, authenticated;
revoke all on table public.user_profiles from anon, authenticated;

commit;
