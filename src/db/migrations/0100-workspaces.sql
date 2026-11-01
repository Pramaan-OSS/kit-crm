CREATE TABLE crm_organisations (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 owner_id uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crm_members (
 org_id uuid NOT NULL REFERENCES crm_organisations(id), user_id uuid NOT NULL UNIQUE REFERENCES app_users(id),
 role text NOT NULL CHECK(role IN ('manager','editor','viewer')), PRIMARY KEY(org_id,user_id)
);
CREATE INDEX crm_members_org ON crm_members(org_id);
