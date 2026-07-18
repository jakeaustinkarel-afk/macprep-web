# MACPrep Question Publication Pipeline

Clinical questions move through one controlled path:

1. Author a reviewed batch using the schema and clinical standard in `BLUEPRINT.md`.
2. Run `node seeds/ingest_authored.mjs <batch.json>` and correct every validation issue.
3. Review the dry-run report, then run the same command with `--apply`.
4. The importer writes only `status='sme_review'`; it cannot publish content.
5. A credentialed admin reviews the item in **Items to review**. The server validates the complete item again before accepting `status='published'`.

The publication gate requires:

- a complete stem and teaching explanation;
- four or five substantive choices;
- exactly one answer marked correct, matching `correct_answer`;
- a rationale for every choice;
- a blueprint domain and subtopic; and
- at least one non-placeholder source.

Do not use scripts that fabricate variants, assign placeholder citations, rebalance answer letters without rotating the complete choice objects, or write directly to published content. Answer-position balancing must move the choice text, correctness marker, and rationale together and return the item to SME review.
