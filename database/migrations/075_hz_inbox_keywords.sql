-- 互动收件箱：补充初筛关键词。
-- 实测发现“周六可以过去看看吗，想找个 80 平左右的办公室”没有命中原来的关键词，被当成了普通互动。
UPDATE leadgen.inbox_settings
SET intent_keywords = (
        SELECT array_agg(DISTINCT keyword) FROM unnest(intent_keywords || ARRAY[
            '看看', '参观', '过去看', '办公室', '写字楼', '商铺', '铺面', '铺位', '门面', '平米', '平方', '多少平', '平左右',
            '想找', '在找', '求推荐', '咨询', '怎么联系', '有没有', '空房', '房间', '住宿', '会议室', '包场', '档期', '开店', '选址'
        ]) AS keyword),
    updated_at = now()
WHERE id = 1;
