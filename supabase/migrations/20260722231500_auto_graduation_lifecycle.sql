-- Keep lifecycle dates current even when a member does not log in that day.
-- Premium entitlement is intentionally untouched.

create index if not exists idx_user_profiles_student_graduation
    on public.user_profiles (graduation_date, user_id)
    where lifecycle_stage = 'student';

update public.user_profiles
set lifecycle_stage = 'student',
    credential = 'SAA',
    lifecycle_updated_at = now(),
    updated_at = now()
where lifecycle_stage = 'incoming_student'
  and matriculation_date <= current_date;

update public.user_profiles
set lifecycle_stage = 'practicing',
    credential = 'CAA',
    lifecycle_updated_at = now(),
    updated_at = now()
where lifecycle_stage = 'student'
  and graduation_date <= current_date;
