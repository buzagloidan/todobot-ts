-- Drop legacy PostgreSQL job queue tables/views/functions that are replaced by Cloudflare Queues.
-- Run this ONCE after pg_dump → psql migration from Railway to Neon.

DROP VIEW IF EXISTS queue_health;
DROP VIEW IF EXISTS job_queue_stats;
DROP FUNCTION IF EXISTS cleanup_expired_jobs();
DROP TABLE IF EXISTS job_queue CASCADE;
