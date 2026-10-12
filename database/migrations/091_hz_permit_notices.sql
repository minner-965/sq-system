-- 091: 政府公示的行政许可（“信用广州”双公示，黄埔区、广州开发区）。
-- 谁刚在黄埔新办了食品经营等许可：说明这个品牌或商家正在本区开店，是商铺招商和周边餐饮的线索来源。
-- 只存公示页上的经营主体名称、文书号、文书名称、日期和出处；不存法定代表人、证件号。

CREATE TABLE IF NOT EXISTS leadgen.permit_notices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 公示记录在来源网站上的编号，用来去重和拼出处链接
    source_id text NOT NULL UNIQUE,
    doc_no text,
    doc_title text,
    holder_name text NOT NULL,
    -- new 新办；change 变更；renew 延续；cancel 注销；other 其他
    kind text NOT NULL CHECK (kind IN ('new', 'change', 'renew', 'cancel', 'other')),
    -- food 食品经营；device 医疗器械；drug 药品；other 其他
    category text NOT NULL CHECK (category IN ('food', 'device', 'drug', 'other')),
    decided_on date,
    source_url text NOT NULL,
    -- 对到了哪家企业；对过但没对上时 company_id 为空、match_checked_at 有值
    company_id uuid REFERENCES leadgen.companies(id) ON DELETE SET NULL,
    match_checked_at timestamptz,
    match_note text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_permit_notices_unmatched ON leadgen.permit_notices (decided_on DESC) WHERE match_checked_at IS NULL;

-- 依据是从哪来的：web 网页搜索；name 地图上的名称；permit 政府公示的许可。重新搜网页时只换掉网页和名称两类，许可的留着。
ALTER TABLE leadgen.company_signals ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'web' CHECK (origin IN ('web', 'name', 'permit'));

ALTER TABLE leadgen.publisher_heartbeat ADD COLUMN IF NOT EXISTS permits_checked_at timestamptz;
ALTER TABLE leadgen.publisher_heartbeat ADD COLUMN IF NOT EXISTS permits_note text;
