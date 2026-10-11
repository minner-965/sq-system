-- 恒兆广场国内版：企业发现。检索设置、检索记录、接口用量、各板块的候选企业和评分。

-- 来源方式增加地图检索和网页检索。
ALTER TABLE leadgen.companies DROP CONSTRAINT companies_data_origin_check;
ALTER TABLE leadgen.companies ADD CONSTRAINT companies_data_origin_check CHECK (data_origin IN (
    'live_discovered', 'fixed_public_candidate', 'fixed_public_profile', 'directory_live', 'osm_live',
    'legacy_public_web', 'manual', 'imported', 'seed', 'map_poi', 'web_search'));
ALTER TABLE leadgen.companies
    ADD COLUMN phone text,
    ADD COLUMN distance_m integer CHECK (distance_m >= 0);

-- 检索设置：固定一行。中心点是恒兆广场在高德地图上的坐标。
CREATE TABLE leadgen.discovery_settings (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    center_longitude numeric(10,6) NOT NULL,
    center_latitude numeric(9,6) NOT NULL,
    radius_m integer NOT NULL CHECK (radius_m BETWEEN 500 AND 50000),
    -- 高德的分类编码：170100 知名企业、170200 公司、170300 工厂。
    category_codes text[] NOT NULL,
    keywords text[] NOT NULL DEFAULT '{}',
    -- 地址里带这些字样的是项目内的现有商户，不进系统。
    exclude_address_keywords text[] NOT NULL DEFAULT '{}',
    max_calls_per_run integer NOT NULL CHECK (max_calls_per_run BETWEEN 1 AND 200),
    daily_run_enabled boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES leadgen.users(id)
);
INSERT INTO leadgen.discovery_settings
    (center_longitude, center_latitude, radius_m, category_codes, exclude_address_keywords, max_calls_per_run)
VALUES (113.489439, 23.200913, 10000, ARRAY['170100', '170200', '170300'], ARRAY['恒兆广场', '水西商业广场'], 30);

CREATE TABLE leadgen.discovery_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
    requested_by uuid REFERENCES leadgen.users(id),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    provider text NOT NULL,
    api_calls integer NOT NULL DEFAULT 0,
    results_seen integer NOT NULL DEFAULT 0,
    companies_new integer NOT NULL DEFAULT 0,
    companies_updated integer NOT NULL DEFAULT 0,
    companies_excluded integer NOT NULL DEFAULT 0,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
);
CREATE INDEX idx_discovery_runs_created ON leadgen.discovery_runs (created_at DESC);
-- 同一时间只允许一次检索在排队或进行。
CREATE UNIQUE INDEX idx_discovery_runs_one_active ON leadgen.discovery_runs ((true)) WHERE status IN ('queued', 'running');

-- 每次调用外部接口记一行，用来查用量和费用。原有的 provider_usage_events 绑定在旧的研究任务上，不适用。
CREATE TABLE leadgen.api_usage_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    endpoint text NOT NULL,
    discovery_run_id uuid REFERENCES leadgen.discovery_runs(id) ON DELETE SET NULL,
    request_summary text,
    status text NOT NULL CHECK (status IN ('ok', 'error')),
    result_count integer,
    error_code text,
    -- 免费额度内为 0；接入收费接口后按服务商的单价填。
    cost_cny numeric(10,4) NOT NULL DEFAULT 0,
    duration_ms integer,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_usage_provider_time ON leadgen.api_usage_events (provider, created_at DESC);

-- 候选企业：一个企业在每个板块各一行，带分数、理由和来源。复核通过后进入该板块的跟进。
CREATE TABLE leadgen.company_sector_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES leadgen.companies(id) ON DELETE CASCADE,
    sector_key text NOT NULL REFERENCES leadgen.sectors(key),
    score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
    -- [{ "item": "距离", "points": 32, "max": 40, "reason": "...", "source": { "label": "...", "url": "..." } }]
    score_items jsonb NOT NULL,
    notices text[] NOT NULL DEFAULT '{}',
    rule_version text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by uuid REFERENCES leadgen.users(id),
    reviewed_at timestamptz,
    reject_reason text,
    scored_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, sector_key)
);
CREATE INDEX idx_candidates_sector_status_score ON leadgen.company_sector_candidates (sector_key, status, score DESC);
