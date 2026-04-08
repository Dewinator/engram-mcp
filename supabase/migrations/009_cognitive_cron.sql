-- Nightly cognitive maintenance via pg_cron.
-- Tools (consolidate_memories / forget_weak_memories) remain available for manual runs;
-- this just makes the same functions run on a schedule so the system "sleeps" without help.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Remove previous schedules if re-running this migration
DO $$
DECLARE jobid BIGINT;
BEGIN
  FOR jobid IN SELECT j.jobid FROM cron.job j
               WHERE j.jobname IN ('vectormemory_consolidate', 'vectormemory_forget_weak')
  LOOP
    PERFORM cron.unschedule(jobid);
  END LOOP;
END $$;

-- Consolidation: every night at 03:00 — promote rehearsed episodic memories to semantic.
SELECT cron.schedule(
  'vectormemory_consolidate',
  '0 3 * * *',
  $$SELECT consolidate_memories(3, 1);$$
);

-- Soft forgetting: every Sunday at 03:30 — archive weak, old, unpinned traces.
SELECT cron.schedule(
  'vectormemory_forget_weak',
  '30 3 * * 0',
  $$SELECT forget_weak_memories(0.05, 7);$$
);
