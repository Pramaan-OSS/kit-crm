-- Choosing an owner address releases a member who never confirmed it: the account is deleted with its records. These
-- keys had no ON DELETE rule, so that delete failed. Each is CASCADE, never SET NULL: every column here is NOT NULL, and
-- a workspace without its creator has no manager and could never be managed again.
-- owner_id: the released member's workspace goes, including other people's access to it and its shared documents.
-- Their accounts stay, and each can start or join another workspace. Only the app's owner can cause this.
-- crm_members.user_id: a released member of someone else's workspace loses only their own access.
-- crm_members.org_id: not a released member's key directly, but a deleted workspace must take its members with it.
ALTER TABLE crm_organisations
  DROP CONSTRAINT crm_organisations_owner_id_fkey,
  ADD CONSTRAINT crm_organisations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES app_users(id) ON DELETE CASCADE;
ALTER TABLE crm_members
  DROP CONSTRAINT crm_members_user_id_fkey,
  ADD CONSTRAINT crm_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
  DROP CONSTRAINT crm_members_org_id_fkey,
  ADD CONSTRAINT crm_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES crm_organisations(id) ON DELETE CASCADE;
-- Document scopes stay text (0104), so no key can reach them: a deleted workspace removes its three documents here. A
-- write in progress holds the organisation row (lib/pramaan/crm-data.ts), so none can land after this has run.
CREATE FUNCTION crm_delete_documents() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM crm_contacts WHERE scope = OLD.id::text;
  DELETE FROM crm_pipeline WHERE scope = OLD.id::text;
  DELETE FROM crm_records WHERE scope = OLD.id::text;
  RETURN NULL;
END
$$;
CREATE TRIGGER crm_organisations_documents AFTER DELETE ON crm_organisations
  FOR EACH ROW EXECUTE FUNCTION crm_delete_documents();
