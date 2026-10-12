-- 094: 主动发现需求。搜索专用小号在小红书、抖音上按关键词搜公开帖子和帖子下的评论，
-- 筛出正在找铺位、找写字楼、找酒店长住或会场、找餐饮合作的人，给招商人员看，由人决定转成线索。
-- 只存公开帖子的文字、链接和时间；发帖人只存搜索组件给的匿名编号和打了码的昵称，不存个人资料。

CREATE TABLE IF NOT EXISTS leadgen.demand_settings (
    id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled boolean NOT NULL DEFAULT true,
    -- 搜索用的关键词：地域词加需求词
    keywords text[] NOT NULL DEFAULT ARRAY['黄埔 找铺面', '黄埔 写字楼 租', '广州黄埔 办公室 求租', '科学城 办公室 求租', '黄埔 开店 选址',
                                          '黄埔 酒店 长住', '黄埔 公寓 求租', '宝能演艺中心 住宿', '黄埔 团建 餐厅', '黄埔 公司聚餐 包间'],
    platforms text[] NOT NULL DEFAULT ARRAY['xiaohongshu', 'douyin'] CHECK (platforms <@ ARRAY['xiaohongshu', 'douyin']),
    runs_per_day integer NOT NULL DEFAULT 2 CHECK (runs_per_day BETWEEN 1 AND 4),
    posts_per_keyword integer NOT NULL DEFAULT 20 CHECK (posts_per_keyword BETWEEN 5 AND 20),
    max_age_days integer NOT NULL DEFAULT 30 CHECK (max_age_days BETWEEN 1 AND 90),
    -- 每个发布账号每天最多主动联系多少人
    contact_daily_limit integer NOT NULL DEFAULT 10 CHECK (contact_daily_limit BETWEEN 1 AND 10),
    next_run_at timestamptz,
    last_run_at timestamptz,
    last_run_note text,
    updated_by uuid REFERENCES leadgen.users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO leadgen.demand_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS leadgen.demand_posts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform text NOT NULL CHECK (platform IN ('xiaohongshu', 'douyin')),
    kind text NOT NULL CHECK (kind IN ('post', 'comment')),
    platform_item_id text NOT NULL,
    -- 评论所在的帖子
    parent_item_id text,
    parent_title text,
    author_key text,
    author_name text,
    title text,
    content text NOT NULL,
    post_url text,
    posted_at timestamptz,
    keyword text,
    -- pending 还没看；need 有需求；agency 中介或同行的广告；irrelevant 无关
    verdict text NOT NULL DEFAULT 'pending' CHECK (verdict IN ('pending', 'need', 'agency', 'irrelevant')),
    sector_key text REFERENCES leadgen.sectors(key),
    -- 帖子里能看出来的面积、预算、区域、行业
    facts jsonb NOT NULL DEFAULT '{}'::jsonb,
    reason text,
    screened_at timestamptz,
    -- new 待处理；converted 已转线索；dismissed 不合适；not_interested 对方不感兴趣（这个人以后不再出现）
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'converted', 'dismissed', 'not_interested')),
    company_id uuid REFERENCES leadgen.companies(id) ON DELETE SET NULL,
    -- 主动联系：模型起草，人确认后自己发出，这里记下发了什么、谁发的
    contact_draft text,
    contact_text text,
    contact_account_id uuid REFERENCES leadgen.publish_accounts(id),
    contacted_by uuid REFERENCES leadgen.users(id),
    contacted_at timestamptz,
    handled_by uuid REFERENCES leadgen.users(id),
    handled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (platform, kind, platform_item_id)
);
CREATE INDEX IF NOT EXISTS idx_demand_posts_open ON leadgen.demand_posts (posted_at DESC NULLS LAST) WHERE verdict = 'need' AND status = 'new';
CREATE INDEX IF NOT EXISTS idx_demand_posts_pending ON leadgen.demand_posts (created_at) WHERE verdict = 'pending';
CREATE INDEX IF NOT EXISTS idx_demand_posts_author ON leadgen.demand_posts (platform, author_key);

CREATE TABLE IF NOT EXISTS leadgen.demand_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform text NOT NULL,
    account_id uuid REFERENCES leadgen.publish_accounts(id) ON DELETE SET NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    keyword_count integer NOT NULL DEFAULT 0,
    found_count integer NOT NULL DEFAULT 0,
    new_count integer NOT NULL DEFAULT 0,
    ok boolean,
    note text
);

ALTER TABLE leadgen.companies DROP CONSTRAINT IF EXISTS companies_data_origin_check;
ALTER TABLE leadgen.companies ADD CONSTRAINT companies_data_origin_check
    CHECK (data_origin = ANY (ARRAY['live_discovered', 'fixed_public_candidate', 'fixed_public_profile', 'directory_live', 'osm_live',
                                    'legacy_public_web', 'manual', 'imported', 'seed', 'map_poi', 'web_search', 'social_lead', 'form_lead', 'tender_award', 'demand_post']));
