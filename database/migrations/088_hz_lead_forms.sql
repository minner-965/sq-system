-- 088: 留资表单。每条发布内容可以有一个带参数的留资链接和二维码；客人扫码填称呼、电话、需求，
-- 提交后自动进对应板块的“待联系”，并记下是从哪个平台、哪条内容来的。只接收客人主动填写的信息。

ALTER TABLE leadgen.companies DROP CONSTRAINT IF EXISTS companies_data_origin_check;
ALTER TABLE leadgen.companies ADD CONSTRAINT companies_data_origin_check
    CHECK (data_origin = ANY (ARRAY['live_discovered', 'fixed_public_candidate', 'fixed_public_profile', 'directory_live', 'osm_live',
                                    'legacy_public_web', 'manual', 'imported', 'seed', 'map_poi', 'web_search', 'social_lead', 'form_lead']));

CREATE TABLE IF NOT EXISTS leadgen.lead_forms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 链接里的短码，例如 /f/k3m9x2ab
    code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{8}$'),
    -- 对应的发布任务；为空表示不挂在某条内容上的通用表单
    publish_task_id uuid UNIQUE REFERENCES leadgen.publish_tasks(id) ON DELETE SET NULL,
    sector_key text NOT NULL REFERENCES leadgen.sectors(key),
    title text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES leadgen.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leadgen.lead_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id uuid NOT NULL REFERENCES leadgen.lead_forms(id),
    contact_name text NOT NULL,
    phone text NOT NULL,
    need text,
    sector_key text NOT NULL REFERENCES leadgen.sectors(key),
    -- 来源：平台和内容，提交时从表单对应的发布任务抄下来，之后任务变了也不受影响
    source_platform text,
    source_topic text,
    publish_task_id uuid REFERENCES leadgen.publish_tasks(id) ON DELETE SET NULL,
    company_id uuid REFERENCES leadgen.companies(id) ON DELETE SET NULL,
    track_id uuid REFERENCES leadgen.company_sector_tracks(id) ON DELETE SET NULL,
    -- 同一个电话在这个板块已经有线索时，并到原来那条，这里记 true
    merged boolean NOT NULL DEFAULT false,
    consent_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_submissions_created ON leadgen.lead_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_submissions_sector ON leadgen.lead_submissions (sector_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_submissions_phone ON leadgen.lead_submissions (phone);
