-- Registry scopes remain text; requests derive them from crm_members, never caller input.
ALTER TABLE crm_contacts ADD CONSTRAINT contacts_size CHECK (octet_length(data::text) <= 4194304);
ALTER TABLE crm_pipeline ADD CONSTRAINT pipeline_size CHECK (octet_length(data::text) <= 4194304);
CREATE TABLE crm_records (
 scope text PRIMARY KEY, data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=4194304)
);
