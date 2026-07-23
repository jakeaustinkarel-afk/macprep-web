begin;

-- Authentication has moved to Supabase Auth. Keeping an obsolete plaintext
-- password value in the deprecated profile table creates needless breach
-- impact even though the table is blocked from client roles.
alter table if exists public.macprep_profiles_deprecated
    drop column if exists password;

commit;
