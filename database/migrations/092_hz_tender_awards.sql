-- 092: 黄埔区工程建设的中标结果（广东省公共资源交易平台的公开公告）。
-- 谁刚中标了黄埔的工程：施工单位要进场设项目部，需要住宿、用餐、临时办公，是酒店公寓和餐饮的线索来源。
-- 中标单位是企业，公告是政府平台公开的；不涉及个人信息。

CREATE TABLE IF NOT EXISTS leadgen.tender_awards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    notice_id text NOT NULL UNIQUE,
    title text NOT NULL,
    -- 标段名称：做的是哪一段工程
    section_name text,
    project_type text,
    owner_name text,
    winner_name text,
    amount numeric(16, 2),
    -- construction 施工、总承包（要进场）；supervision 监理（少量人驻场）；other 设计、勘察、检测、采购等
    work_kind text NOT NULL CHECK (work_kind IN ('construction', 'supervision', 'other')),
    published_at timestamptz,
    source_url text NOT NULL,
    -- 人看过以后：转入跟进（company_id 有值）或标为不合适
    company_id uuid REFERENCES leadgen.companies(id) ON DELETE SET NULL,
    dismissed boolean NOT NULL DEFAULT false,
    handled_by uuid REFERENCES leadgen.users(id),
    handled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tender_awards_open ON leadgen.tender_awards (published_at DESC) WHERE company_id IS NULL AND NOT dismissed;

ALTER TABLE leadgen.company_signals DROP CONSTRAINT IF EXISTS company_signals_origin_check;
ALTER TABLE leadgen.company_signals ADD CONSTRAINT company_signals_origin_check CHECK (origin IN ('web', 'name', 'permit', 'tender'));

ALTER TABLE leadgen.companies DROP CONSTRAINT IF EXISTS companies_data_origin_check;
ALTER TABLE leadgen.companies ADD CONSTRAINT companies_data_origin_check
    CHECK (data_origin = ANY (ARRAY['live_discovered', 'fixed_public_candidate', 'fixed_public_profile', 'directory_live', 'osm_live',
                                    'legacy_public_web', 'manual', 'imported', 'seed', 'map_poi', 'web_search', 'social_lead', 'form_lead', 'tender_award']));

ALTER TABLE leadgen.publisher_heartbeat ADD COLUMN IF NOT EXISTS tenders_checked_at timestamptz;
ALTER TABLE leadgen.publisher_heartbeat ADD COLUMN IF NOT EXISTS tenders_note text;
