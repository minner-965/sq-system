-- 恒兆广场国内版：互动收件箱。各平台的评论和私信、意图分类及其改动记录、回复、转线索、收件箱设置。

-- 来自社交平台的线索也进企业档案（一个对方账号一份），沿用现有的跟进流程。
ALTER TABLE leadgen.companies DROP CONSTRAINT companies_data_origin_check;
ALTER TABLE leadgen.companies ADD CONSTRAINT companies_data_origin_check CHECK (data_origin IN (
    'live_discovered', 'fixed_public_candidate', 'fixed_public_profile', 'directory_live', 'osm_live',
    'legacy_public_web', 'manual', 'imported', 'seed', 'map_poi', 'web_search', 'social_lead'));

CREATE TABLE leadgen.interaction_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform text NOT NULL CHECK (platform IN ('douyin', 'xiaohongshu', 'channels', 'moments')),
    kind text NOT NULL CHECK (kind IN ('comment', 'direct_message')),
    -- 平台上的消息编号；手工录入的由系统生成。同一平台同一编号只存一次。
    platform_message_id text NOT NULL,
    account_id uuid REFERENCES leadgen.publish_accounts(id) ON DELETE SET NULL,
    publish_task_id uuid REFERENCES leadgen.publish_tasks(id) ON DELETE SET NULL,
    post_title text,
    post_url text,
    sender_name text NOT NULL,
    sender_platform_id text,
    sender_profile_url text,
    content text NOT NULL,
    sent_at timestamptz NOT NULL,
    source text NOT NULL DEFAULT 'reader' CHECK (source IN ('reader', 'manual')),

    -- 意图：询价或租铺、看房预约、合作或入驻、酒店或餐饮预订、普通互动、广告或垃圾。为空表示还没分类。
    intent text CHECK (intent IN ('inquiry', 'viewing', 'cooperation', 'booking', 'chat', 'spam')),
    intent_reason text,
    intent_source text CHECK (intent_source IN ('keyword', 'model', 'manual')),
    classified_at timestamptz,

    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'converted', 'ignored')),
    assignee_user_id uuid REFERENCES leadgen.users(id),
    handled_by uuid REFERENCES leadgen.users(id),
    handled_at timestamptz,
    company_id uuid REFERENCES leadgen.companies(id) ON DELETE SET NULL,

    reply_text text,
    -- drafted 已起草；queued 已确认、等发布程序发出；sent 已发出；failed 没发出去，需要手动回复；manual 已在手机上手动回复。
    reply_status text NOT NULL DEFAULT 'none' CHECK (reply_status IN ('none', 'drafted', 'queued', 'sent', 'failed', 'manual')),
    reply_confirmed_by uuid REFERENCES leadgen.users(id),
    reply_confirmed_at timestamptz,
    replied_at timestamptz,
    reply_error text,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (platform, platform_message_id),
    CHECK (reply_status NOT IN ('queued', 'sent') OR (reply_text IS NOT NULL AND reply_confirmed_by IS NOT NULL))
);
CREATE INDEX idx_interaction_status ON leadgen.interaction_messages (status, sent_at DESC);
CREATE INDEX idx_interaction_unclassified ON leadgen.interaction_messages (created_at) WHERE intent IS NULL;
CREATE INDEX idx_interaction_sender ON leadgen.interaction_messages (platform, sender_platform_id);

CREATE TABLE leadgen.interaction_intent_changes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL REFERENCES leadgen.interaction_messages(id) ON DELETE CASCADE,
    from_intent text,
    to_intent text NOT NULL,
    changed_by uuid REFERENCES leadgen.users(id),
    changed_at timestamptz NOT NULL DEFAULT now()
);

-- 收件箱设置：固定一行。初筛关键词；按内容类型分配的负责人（为空则发给全体管理员）。
CREATE TABLE leadgen.inbox_settings (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    intent_keywords text[] NOT NULL,
    assignee_property uuid REFERENCES leadgen.users(id),
    assignee_event uuid REFERENCES leadgen.users(id),
    assignee_hotel uuid REFERENCES leadgen.users(id),
    assignee_dining uuid REFERENCES leadgen.users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO leadgen.inbox_settings (intent_keywords) VALUES (ARRAY[
    '租', '价格', '多少钱', '怎么收费', '费用', '面积', '多大', '看铺', '看房', '看场', '位置', '在哪', '地址', '电话', '联系',
    '微信', '合作', '入驻', '加盟', '订房', '预订', '预定', '订位', '包间', '团餐', '协议价', '还有吗', '怎么租']);

-- “立即检查”的请求。读取程序看到后去平台读一遍；同一账号两次检查至少隔 10 分钟。
CREATE TABLE leadgen.inbox_check_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES leadgen.publish_accounts(id) ON DELETE CASCADE,
    trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
    requested_by uuid REFERENCES leadgen.users(id),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    messages_found integer NOT NULL DEFAULT 0,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX idx_inbox_checks_account ON leadgen.inbox_check_requests (account_id, created_at DESC);
