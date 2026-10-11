-- 082: 评论下面的追评（对方在我们回复之后又说的话）也收进互动收件箱。
-- 追评在评论管理页上不单独显示，回复时要落在它所在的那条一级评论下面，所以记下那条评论的原文和发评论的人。
ALTER TABLE leadgen.interaction_messages
    ADD COLUMN IF NOT EXISTS thread_comment_text text,
    ADD COLUMN IF NOT EXISTS thread_sender_name text;

COMMENT ON COLUMN leadgen.interaction_messages.thread_comment_text IS '追评所在的一级评论原文；一级评论本身为空';
COMMENT ON COLUMN leadgen.interaction_messages.thread_sender_name IS '追评所在的一级评论的发评论人';
