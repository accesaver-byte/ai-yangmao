-- 合成演示数据，不是真实活动。仅由 seed:demo:local 写入本地 D1。
INSERT OR IGNORE INTO platforms(id,name,type,status,site)
VALUES ('local-demo','本地演示平台（虚构）','tool','approved','https://example.invalid');

INSERT OR IGNORE INTO offers(id,platform_id,title,type,modalities,claim_method,requirements,audience,value_text,claim_start,claim_end,end_kind,source_tz,review_state,evidence,steps)
VALUES
('local-demo-limited','local-demo','【本地演示】七天图像体验','trial','["image"]','signup','["none"]','all','演示用：100 次生成，不可实际领取',date('now','-1 day'),date('now','+7 days'),'date','Asia/Shanghai','approved','{"url":"https://example.invalid/demo","tier":"site","capturedAt":"2026-10-15T00:00:00Z","excerpts":{"benefit":"Synthetic local demo only"}}','["这是虚构的本地测试活动，不要尝试领取。"]'),
('local-demo-standing','local-demo','【本地演示】每日编程额度','standing','["text"]','signup','["none"]','all','演示用：每日 20 次，不可实际领取',NULL,NULL,'standing','Asia/Shanghai','approved','{"url":"https://example.invalid/demo","tier":"site","capturedAt":"2026-10-15T00:00:00Z","excerpts":{"benefit":"Synthetic local demo only"}}','["仅用于验证筛选、收藏和页面展示。"]'),
('local-demo-pending','local-demo','【本地演示】待补齐的草稿','trial','["video"]','signup','["unknown"]','unclear','演示用：待确认的体验额度',NULL,NULL,'unknown','Asia/Shanghai','pending','{"url":"https://example.invalid/demo","tier":"media","capturedAt":"2026-10-15T00:00:00Z","excerpts":{}}','[]');
