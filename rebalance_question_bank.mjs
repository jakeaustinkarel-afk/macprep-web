// Legacy direct randomization was unsafe for the current choices-array schema.
// Answer-position changes must be reviewable, deterministic migrations so the
// correct flag, displayed label, rationale, and answer key move together.

console.error('Direct question-bank randomization is retired.');
console.error('Run `npm run audit:questions`, then use a reviewed Supabase migration for any repair.');
process.exitCode = 1;
