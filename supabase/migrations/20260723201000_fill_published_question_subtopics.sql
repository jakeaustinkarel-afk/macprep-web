begin;

with subtopics(id, subtopic) as (
    values
        ('authored-batch-live-001', 'Trauma-induced coagulopathy and fibrinogen replacement'),
        ('authored-batch-live-002', 'Carbon monoxide poisoning and pulse oximetry'),
        ('authored-batch-live-003', 'Hemodynamic effects of aortic cross-clamping'),
        ('authored-batch-live-004', 'Local anesthetic systemic toxicity treatment'),
        ('authored-batch-live-005', 'Malignant hyperthermia treatment'),
        ('authored-batch-live-006', 'Pediatric laryngospasm without intravenous access'),
        ('authored-batch-live-007', 'Post-tonsillectomy hemorrhage airway management'),
        ('authored-batch-live-008', 'Pheochromocytoma hypertensive crisis'),
        ('authored-batch-live-009', 'Diabetic ketoacidosis with hypokalemia'),
        ('authored-batch-live-010', 'Oculocardiac reflex'),
        ('authored-batch-live-011', 'Intraocular gas and nitrous oxide'),
        ('authored-batch-live-012', 'Pediatric laryngospasm without intravenous access'),
        ('authored-batch-live-013', 'Negative-pressure pulmonary edema'),
        ('authored-batch-live-014', 'Preoperative fasting guidelines'),
        ('authored-batch-live-015', 'Autonomic dysreflexia'),
        ('authored-batch-live-016', 'Local anesthetic systemic toxicity treatment'),
        ('authored-batch-live-017', 'Malignant hyperthermia susceptibility'),
        ('authored-batch-live-018', 'Bier block tourniquet management'),
        ('authored-batch-live-019', 'TURP syndrome recognition'),
        ('authored-batch-live-020', 'Severe aortic stenosis hemodynamic management'),
        ('authored-batch-live-021', 'Protamine-induced pulmonary hypertension'),
        ('authored-batch-live-022', 'Bronchospasm capnography and ventilation'),
        ('authored-batch-live-023', 'Carbon monoxide poisoning and pulse oximetry'),
        ('authored-batch-live-024', 'Geriatric anesthetic induction dosing'),
        ('authored-batch-live-025', 'Postoperative delirium prevention')
)
update public.questions as question
set subtopic = subtopics.subtopic
from subtopics
where question.id = subtopics.id
  and question.status = 'published'
  and trim(coalesce(question.subtopic, '')) = '';

do $$
declare
    tagged_count integer;
begin
    select count(*)
    into tagged_count
    from public.questions
    where status = 'published'
      and id like 'authored-batch-live-%'
      and trim(coalesce(subtopic, '')) <> '';

    if tagged_count <> 25 then
        raise exception 'Expected 25 tagged authored-batch-live questions, found %', tagged_count;
    end if;
end
$$;

commit;
