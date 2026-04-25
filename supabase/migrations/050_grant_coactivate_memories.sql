-- 050_grant_coactivate_memories.sql — Fix the silent permission-denied that
-- killed the legacy Hebbian path.
--
-- Background: Migration 008 created `coactivate_memories(uuid[])` but never
-- granted EXECUTE to anon/service_role. The MCP server connects with the
-- anon key (see src/index.ts: SUPABASE_KEY), so every call from
-- recall.ts → service.coactivate(...) → rpc('coactivate_memories', ...)
-- failed silently with permission denied. The error was logged via
-- console.error but never surfaced — and the synchronous Hebbian path
-- has been dead in production for as long as the function existed.
--
-- The newer coactivate_pair (Migration 048) is granted correctly. This
-- migration brings the legacy function into line so both paths work and
-- Hebbian co-activation can resume from the synchronous recall hot-path
-- (every recall with ≥2 results), not only from the event-bus agent
-- (which only fires on cite=true).

GRANT EXECUTE ON FUNCTION coactivate_memories(UUID[]) TO anon, service_role;
