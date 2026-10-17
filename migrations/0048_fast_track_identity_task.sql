-- Fast-track from an identity review card (2026-10-16). The owner can fast-track at every review stage; when the
-- job publishes, the originating identity task is closed as a duplicate of the new offer instead of lingering in
-- 权益活动查重 (its candidates would otherwise ask for the same decision again).
ALTER TABLE fast_track_jobs ADD COLUMN identity_task_id TEXT;
