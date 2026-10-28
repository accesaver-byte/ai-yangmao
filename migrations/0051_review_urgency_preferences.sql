-- 仅保存人工排序偏好；不改变线索、审核或已批准权益的业务状态。
CREATE TABLE review_urgency_preferences (
  subject_key TEXT PRIMARY KEY,
  subject_version TEXT NOT NULL,
  suppressed INTEGER NOT NULL CHECK (suppressed IN (0, 1)),
  actor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX review_urgency_preferences_updated_at ON review_urgency_preferences(updated_at);
