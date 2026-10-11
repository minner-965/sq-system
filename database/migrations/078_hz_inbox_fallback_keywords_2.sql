-- 互动收件箱：自测剩下的一条兜底漏判（“在吗，想约明天上午去现场”），补上对应的词。
UPDATE leadgen.inbox_settings
SET intent_keywords = (SELECT array_agg(DISTINCT keyword) FROM unnest(intent_keywords || ARRAY['现场', '想约', '预约', '去看']) AS keyword),
    updated_at = now()
WHERE id = 1;
