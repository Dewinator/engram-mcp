-- Create the `service_role` DB role to match the Supabase JWT convention.
-- The MCP server (and openClaw config) ships a JWT signed with role=service_role.
-- PostgREST does `SET ROLE service_role` for those requests, so the role must
-- exist as an actual DB role with the right grants — otherwise every request
-- fails with "role does not exist", and supabase-js surfaces it as an empty
-- error (no .message field), which is what we hit in production.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON memories, memory_links, forgotten_memories
  TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- PostgREST connects as `postgres` (per docker-compose) and switches role on
-- each request — postgres needs membership in service_role to be allowed to.
GRANT service_role TO postgres;
