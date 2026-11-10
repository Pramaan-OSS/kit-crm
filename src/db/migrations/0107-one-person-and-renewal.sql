-- One-person mode (owner only, off by default): each member sees and changes only the rows they own; the workspace
-- owner still sees all. Rows already carry owner_id (0106). And an optional renewal date on deals.
ALTER TABLE crm_organisations ADD COLUMN one_person boolean NOT NULL DEFAULT false;
ALTER TABLE crm_deals ADD COLUMN renewal_on date;
CREATE INDEX crm_contact_rows_owner ON crm_contact_rows (org_id, owner_id);
CREATE INDEX crm_deals_owner ON crm_deals (org_id, owner_id);
CREATE INDEX crm_deals_renewal ON crm_deals (org_id, renewal_on);
