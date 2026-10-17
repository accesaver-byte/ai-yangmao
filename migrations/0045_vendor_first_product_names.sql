-- 0043 shortened product platform names and dropped the vendor (e.g. "海螺 AI（MiniMax）" -> "海螺 AI"), so offer cards,
-- details, the agent API and digests showed the product as if it were the vendor. Products are named vendor-first; the
-- grouped public lists show only the product under its company heading (2026-10-16 admin correction).
UPDATE platforms SET name='MiniMax 海螺 AI' WHERE id='hailuo' AND name='海螺 AI';
UPDATE platforms SET name='阿里 Qoder' WHERE id='qoder' AND name='Qoder';
UPDATE platforms SET name='阿里 千问办公' WHERE id='qwenwork' AND name='千问办公';
UPDATE platforms SET name='阿里 通义千问 Qwen' WHERE id='qwen' AND name='通义千问 Qwen';
UPDATE platforms SET name='阿里 魔搭 ModelScope' WHERE id='modelscope' AND name='魔搭 ModelScope';
UPDATE platforms SET name='字节跳动 豆包 Doubao' WHERE id='doubao' AND name='豆包 Doubao';
