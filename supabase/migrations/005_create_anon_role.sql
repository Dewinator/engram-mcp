-- Create a restricted anonymous role for PostgREST.
-- NEVER use the postgres superuser as the anonymous role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END
$$;

-- Grant minimal permissions: read + write on memories only
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO anon;

-- Allow calling the search function
GRANT EXECUTE ON FUNCTION match_memories TO anon;

-- Allow calling the update trigger function
GRANT EXECUTE ON FUNCTION update_updated_at TO anon;
