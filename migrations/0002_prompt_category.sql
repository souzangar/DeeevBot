-- @critical-path
-- The admin's confirmed category on a review prompt (unit U4; critical
-- invariants 1, 7 and 8; doc/architecture/adr-0006-data-model-and-module-layout.md).
-- Approve runs category confirmation, then (when the report has no
-- account link) the account-link prompt, then the link mode, then the
-- recommended-comment prompt; the force-reply prompt is answered in a later
-- update, so the category the admin confirmed must travel with the prompt
-- until the reply completes the approval. It is kept here, on the prompt,
-- and never written to `reports.category` before the approval itself: the
-- report keeps the reporter's label, the hint the other admin reviews by
-- (a "sexual content involving a minor" label among them), until a
-- decision. The value is one of the categories of src/review/categories.ts,
-- checked by the code that writes and reads it (as `kind` and `link_mode`
-- are); NULL for a prompt that carries none (a retraction's). A category is
-- no person's data: the column is state, deleted with its row on every
-- deletion path of the table (doc/product/retention-and-minimisation.md).
ALTER TABLE admin_prompts ADD COLUMN category TEXT;

UPDATE meta SET value = 2 WHERE key = 'schema_version';
