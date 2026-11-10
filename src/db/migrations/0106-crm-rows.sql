-- Stages, contacts, companies and deals become rows scoped by org_id. Every key on org_id cascades, so deleting a
-- workspace (0105) takes all of its rows with it.

-- Stages are data: each workspace has its own ordered list, seeded with New, In progress and Won.
CREATE TABLE crm_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES crm_organisations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  position integer NOT NULL,
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX crm_stages_name ON crm_stages (org_id, lower(name));
CREATE FUNCTION crm_seed_stages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO crm_stages(org_id, name, position) VALUES (NEW.id, 'New', 0), (NEW.id, 'In progress', 1), (NEW.id, 'Won', 2);
  RETURN NULL;
END
$$;
CREATE TRIGGER crm_organisations_stages AFTER INSERT ON crm_organisations
  FOR EACH ROW EXECUTE FUNCTION crm_seed_stages();
INSERT INTO crm_stages(org_id, name, position)
  SELECT o.id, s.name, s.position FROM crm_organisations o
  CROSS JOIN (VALUES ('New', 0), ('In progress', 1), ('Won', 2)) AS s(name, position);

-- People and companies share one table, as they share one list on screen. owner_id is the account that added the
-- row; it has no key to app_users, so a released member's rows are handed to the workspace owner (below), not lost.
CREATE TABLE crm_contact_rows (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES crm_organisations(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK (kind IN ('person', 'company')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  email text NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  company_id uuid CHECK (company_id IS NULL OR kind = 'person'),
  revision integer NOT NULL DEFAULT 0,
  notes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(notes) = 'array' AND jsonb_array_length(notes) <= 200),
  history jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(history) = 'array' AND jsonb_array_length(history) <= 50),
  CHECK (octet_length(notes::text) + octet_length(history::text) <= 4194304),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, company_id) REFERENCES crm_contact_rows(org_id, id) ON DELETE SET NULL (company_id)
);
CREATE INDEX crm_contact_rows_list ON crm_contact_rows (org_id, seq);
CREATE INDEX crm_contact_rows_name ON crm_contact_rows (org_id, lower(name));
CREATE INDEX crm_contact_rows_email ON crm_contact_rows (org_id, lower(email));
CREATE INDEX crm_contact_rows_company ON crm_contact_rows (org_id, company_id);

-- A deal's stage key has no ON DELETE rule: a stage that still has cards cannot be removed.
CREATE TABLE crm_deals (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES crm_organisations(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  stage_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('deal', 'task')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  value numeric(15, 2) NOT NULL CHECK (value BETWEEN 0 AND 1000000000000),
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
  company_id uuid,
  contact_id uuid,
  revision integer NOT NULL DEFAULT 0,
  FOREIGN KEY (org_id, stage_id) REFERENCES crm_stages(org_id, id),
  FOREIGN KEY (org_id, company_id) REFERENCES crm_contact_rows(org_id, id) ON DELETE SET NULL (company_id),
  FOREIGN KEY (org_id, contact_id) REFERENCES crm_contact_rows(org_id, id) ON DELETE SET NULL (contact_id)
);
CREATE INDEX crm_deals_list ON crm_deals (org_id, seq);
CREATE INDEX crm_deals_stage ON crm_deals (org_id, stage_id);
CREATE INDEX crm_deals_company ON crm_deals (org_id, company_id);
CREATE INDEX crm_deals_contact ON crm_deals (org_id, contact_id);

-- A member who leaves (removed, or released with their account) hands their rows to the workspace owner. When the
-- workspace itself is deleted its row is already gone, so this updates nothing and the cascade removes the rows.
CREATE FUNCTION crm_hand_over_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE crm_contact_rows r SET owner_id = o.owner_id FROM crm_organisations o
    WHERE o.id = OLD.org_id AND r.org_id = OLD.org_id AND r.owner_id = OLD.user_id;
  UPDATE crm_deals r SET owner_id = o.owner_id FROM crm_organisations o
    WHERE o.id = OLD.org_id AND r.org_id = OLD.org_id AND r.owner_id = OLD.user_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER crm_members_rows AFTER DELETE ON crm_members
  FOR EACH ROW EXECUTE FUNCTION crm_hand_over_rows();

-- Moves one workspace's contacts and pipeline documents into rows, keeping ids, order, revisions, notes, history and
-- stages, then empties those documents so a deleted row never lingers there. Rows go to the workspace owner. A card
-- whose stage has no row fails the migration rather than moving silently. Kept as a function so tests can run it.
CREATE FUNCTION crm_move_documents(org uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  owner uuid := (SELECT owner_id FROM crm_organisations WHERE id = org);
BEGIN
  INSERT INTO crm_contact_rows(id, org_id, owner_id, kind, name, email, revision, notes, history)
    SELECT (c->>'id')::uuid, org, owner, c->>'kind', c->>'name', coalesce(c->>'email', ''),
      coalesce((c->>'revision')::integer, 0), coalesce(c->'notes', '[]'), coalesce(c->'history', '[]')
    FROM crm_contacts d CROSS JOIN jsonb_array_elements(coalesce(d.data->'contacts', '[]')) WITH ORDINALITY AS e(c, i)
    WHERE d.scope = org::text ORDER BY e.i;
  UPDATE crm_contact_rows p SET company_id = co.id
    FROM (
      SELECT (c->>'id')::uuid AS id, nullif(c->>'companyId', '')::uuid AS company
      FROM crm_contacts d CROSS JOIN jsonb_array_elements(coalesce(d.data->'contacts', '[]')) AS e(c)
      WHERE d.scope = org::text AND c->>'kind' = 'person'
    ) AS link
    JOIN crm_contact_rows co ON co.org_id = org AND co.id = link.company AND co.kind = 'company'
    WHERE p.org_id = org AND p.id = link.id;
  INSERT INTO crm_deals(id, org_id, owner_id, stage_id, kind, title, value, owner, revision)
    SELECT (x->>'id')::uuid, org, owner, s.id, x->>'kind', x->>'title', (x->>'value')::numeric, x->>'owner',
      coalesce((x->>'revision')::integer, 0)
    FROM crm_pipeline d CROSS JOIN jsonb_array_elements(coalesce(d.data->'deals', '[]')) WITH ORDINALITY AS e(x, i)
    LEFT JOIN crm_stages s ON s.org_id = org AND s.name = x->>'stage'
    WHERE d.scope = org::text ORDER BY e.i;
  DELETE FROM crm_contacts WHERE scope = org::text;
  DELETE FROM crm_pipeline WHERE scope = org::text;
END
$$;
SELECT crm_move_documents(id) FROM crm_organisations;
