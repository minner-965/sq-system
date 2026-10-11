-- 恒兆广场国内版：招商客户跟进。需求条件（用于房源匹配）、看场预约、放弃原因分类、底价提示、通知。

ALTER TABLE leadgen.company_sector_tracks
    -- 需求条件：面积区间、业态、预算（元/㎡·月，含管理费）、是否要明火。
    ADD COLUMN need_area_min numeric(8,2) CHECK (need_area_min > 0),
    ADD COLUMN need_area_max numeric(8,2) CHECK (need_area_max > 0),
    ADD COLUMN need_property_type text CHECK (need_property_type IN ('office', 'retail')),
    ADD COLUMN need_budget_per_sqm numeric(8,2) CHECK (need_budget_per_sqm > 0),
    ADD COLUMN need_open_flame boolean NOT NULL DEFAULT false,
    ADD COLUMN contact_name text,
    ADD COLUMN contact_phone text,
    ADD COLUMN viewing_at timestamptz,
    -- 意向价低于公司可接受的最低条件。只存是否，不存差多少。
    ADD COLUMN below_floor_price boolean NOT NULL DEFAULT false,
    ADD COLUMN lost_reason_category text CHECK (lost_reason_category IN ('price', 'location', 'layout', 'other')),
    ADD COLUMN stage_changed_at timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT tracks_need_area_range CHECK (need_area_min IS NULL OR need_area_max IS NULL OR need_area_min <= need_area_max),
    ADD CONSTRAINT tracks_lost_needs_reason CHECK (stage <> 'lost' OR lost_reason_category IS NOT NULL);

-- 阶段变化也记进跟进记录。
ALTER TABLE leadgen.activities DROP CONSTRAINT activities_activity_type_check;
ALTER TABLE leadgen.activities ADD CONSTRAINT activities_activity_type_check
    CHECK (activity_type IN ('call', 'visit', 'viewing', 'wechat', 'note', 'stage'));

-- 站内通知。发给某个人，或发给某个角色的所有人。以后加企业微信等渠道时，从这张表往外发。
CREATE TABLE leadgen.notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id uuid REFERENCES leadgen.users(id) ON DELETE CASCADE,
    recipient_role text REFERENCES leadgen.roles(key),
    kind text NOT NULL,
    title text NOT NULL,
    body text,
    link text,
    created_by uuid REFERENCES leadgen.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (recipient_user_id IS NOT NULL OR recipient_role IS NOT NULL)
);
CREATE INDEX idx_notifications_recipient ON leadgen.notifications (recipient_user_id, created_at DESC);
CREATE INDEX idx_notifications_role ON leadgen.notifications (recipient_role, created_at DESC);

CREATE TABLE leadgen.notification_reads (
    notification_id uuid NOT NULL REFERENCES leadgen.notifications(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES leadgen.users(id) ON DELETE CASCADE,
    read_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (notification_id, user_id)
);
