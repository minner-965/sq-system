-- 恒兆广场国内版：统一企业档案补国内字段；企业在各板块的跟进；跟进记录。
-- 一个企业一份档案（leadgen.companies），三个板块各自一条跟进。

-- 国内企业多数没有官网，域名不再必填；国家默认中国。
ALTER TABLE leadgen.companies
    ALTER COLUMN normalized_domain DROP NOT NULL,
    ALTER COLUMN country_code SET DEFAULT 'CN',
    ADD COLUMN unified_social_credit_code text
        CHECK (unified_social_credit_code ~ '^[0-9A-Z]{18}$'),
    ADD COLUMN address text,
    ADD COLUMN longitude numeric(10,6) CHECK (longitude BETWEEN -180 AND 180),
    ADD COLUMN latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
    ADD COLUMN industry text,
    ADD COLUMN employee_scale text,
    ADD COLUMN established_on date,
    -- 来源渠道（如 amap、baidu_search、manual）和该渠道里的编号。
    ADD COLUMN source text,
    ADD COLUMN source_ref text;

CREATE UNIQUE INDEX idx_companies_credit_code ON leadgen.companies (unified_social_credit_code)
    WHERE unified_social_credit_code IS NOT NULL;
CREATE UNIQUE INDEX idx_companies_source_ref ON leadgen.companies (source, source_ref)
    WHERE source_ref IS NOT NULL;

CREATE TABLE leadgen.company_sector_tracks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES leadgen.companies(id) ON DELETE CASCADE,
    sector_key text NOT NULL REFERENCES leadgen.sectors(key),
    stage text NOT NULL DEFAULT 'new'
        CHECK (stage IN ('new', 'contacted', 'viewing', 'negotiating', 'signed', 'lost')),
    owner_user_id uuid REFERENCES leadgen.users(id),
    intended_property_id uuid REFERENCES leadgen.properties(id) ON DELETE SET NULL,
    intended_service text,
    intended_area_sqm numeric(8,2),
    -- 写字楼和商铺为 元/㎡·月（含管理费）；酒店、餐饮为协议价。
    intended_price numeric(10,2),
    next_follow_up_at timestamptz,
    lost_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, sector_key)
);
CREATE INDEX idx_tracks_sector_stage ON leadgen.company_sector_tracks (sector_key, stage);
CREATE INDEX idx_tracks_owner_follow_up ON leadgen.company_sector_tracks (owner_user_id, next_follow_up_at);

CREATE TABLE leadgen.activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    track_id uuid NOT NULL REFERENCES leadgen.company_sector_tracks(id) ON DELETE CASCADE,
    activity_type text NOT NULL CHECK (activity_type IN ('call', 'visit', 'viewing', 'wechat', 'note')),
    content text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES leadgen.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_activities_track_time ON leadgen.activities (track_id, occurred_at DESC);
