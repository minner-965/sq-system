-- 互动收件箱：关键词漏判的自动复查。
-- 没命中关键词、被算作普通互动的评论，后台会成批交给大模型再看一遍；
-- 发现其实有意向的，改回意向消息并提醒，同时把漏掉的词自动加进初筛关键词。
ALTER TABLE leadgen.interaction_messages ADD COLUMN audited_at timestamptz;
CREATE INDEX idx_interaction_unaudited ON leadgen.interaction_messages (created_at)
    WHERE intent = 'chat' AND intent_source = 'keyword' AND audited_at IS NULL;

CREATE TABLE leadgen.inbox_keyword_additions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    keyword text NOT NULL UNIQUE,
    from_message_id uuid REFERENCES leadgen.interaction_messages(id) ON DELETE SET NULL,
    example text,
    added_at timestamptz NOT NULL DEFAULT now()
);
