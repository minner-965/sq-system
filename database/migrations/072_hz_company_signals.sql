-- 恒兆广场国内版：企业的需求信号（招聘、扩张、迁址、新设），来自公开网页搜索，每条带出处。

CREATE TABLE leadgen.company_signals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES leadgen.companies(id) ON DELETE CASCADE,
    signal_type text NOT NULL CHECK (signal_type IN ('hiring', 'expansion', 'relocation', 'new_setup')),
    evidence text NOT NULL,
    source_title text,
    source_url text NOT NULL,
    source_date date,
    found_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, signal_type, source_url)
);
CREATE INDEX idx_company_signals_company ON leadgen.company_signals (company_id);

ALTER TABLE leadgen.companies ADD COLUMN signals_checked_at timestamptz;

-- 每次检索后查多少家企业的需求信号。搜索接口每天的免费次数有限，默认 20 家。
ALTER TABLE leadgen.discovery_settings
    ADD COLUMN signal_checks_per_run integer NOT NULL DEFAULT 20 CHECK (signal_checks_per_run BETWEEN 0 AND 100);

ALTER TABLE leadgen.discovery_runs ADD COLUMN signals_checked integer NOT NULL DEFAULT 0;
ALTER TABLE leadgen.discovery_runs ADD COLUMN signals_found integer NOT NULL DEFAULT 0;
