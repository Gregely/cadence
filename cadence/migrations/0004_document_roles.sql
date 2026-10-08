-- A document's role within its kind (for fiction: 'scene' or 'misc').
-- Additive only: existing rows keep every value; 0005 fills the default
-- role from the kinds registry.
ALTER TABLE documents ADD COLUMN role TEXT;
CREATE INDEX documents_by_role ON documents(kind, role);
