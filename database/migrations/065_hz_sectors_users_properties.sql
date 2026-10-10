-- 恒兆广场国内版：板块、账号与板块权限、项目信息、招商政策、房源。
-- 由迁移执行器在一个事务内执行并登记，本文件不写 BEGIN/COMMIT。

CREATE TABLE leadgen.sectors (
    key text PRIMARY KEY CHECK (key IN ('office_retail', 'hotel_apartment', 'dining')),
    name text NOT NULL,
    sort_order integer NOT NULL
);
INSERT INTO leadgen.sectors (key, name, sort_order) VALUES
    ('office_retail', '商铺写字楼', 1),
    ('hotel_apartment', '酒店公寓', 2),
    ('dining', '自营餐饮', 3);

-- 管理员全部权限；老板只读；招商人员按板块分配。
CREATE TABLE leadgen.roles (
    key text PRIMARY KEY CHECK (key IN ('admin', 'boss', 'leasing')),
    name text NOT NULL,
    can_write boolean NOT NULL,
    all_sectors boolean NOT NULL,
    sees_floor_price boolean NOT NULL
);
INSERT INTO leadgen.roles (key, name, can_write, all_sectors, sees_floor_price) VALUES
    ('admin', '管理员', true, true, true),
    ('boss', '老板', false, true, false),
    ('leasing', '招商人员', true, false, false);

CREATE TABLE leadgen.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username text NOT NULL UNIQUE CHECK (username = lower(username) AND username ~ '^[a-z0-9_.-]{2,40}$'),
    display_name text NOT NULL,
    role_key text NOT NULL REFERENCES leadgen.roles(key),
    -- 登录在 WP03 接入；为空表示还不能登录。
    password_hash text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO leadgen.users (username, display_name, role_key) VALUES ('admin', 'Simon', 'admin');

CREATE TABLE leadgen.user_sectors (
    user_id uuid NOT NULL REFERENCES leadgen.users(id) ON DELETE CASCADE,
    sector_key text NOT NULL REFERENCES leadgen.sectors(key),
    PRIMARY KEY (user_id, sector_key)
);

-- 项目信息：只有恒兆广场一个项目，固定一行。
CREATE TABLE leadgen.project_profile (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    name text NOT NULL,
    address text,
    target_industries text[] NOT NULL DEFAULT '{}',
    electricity_fee_per_kwh numeric(6,2),
    water_fee_per_ton numeric(6,2),
    fees_include_tax boolean,
    parking_monthly_fee numeric(8,2),
    parking_hourly_fee numeric(6,2),
    parking_free_hours numeric(4,1),
    retail_delivery_standard text,
    office_delivery_standard text,
    transport_notes text[] NOT NULL DEFAULT '{}',
    source_text text,
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO leadgen.project_profile (name) VALUES ('恒兆广场');

-- 招商政策：写字楼、商铺各一行。floor_price_per_sqm 是底价（元/㎡·月，含税含管理费），只对管理员返回。
CREATE TABLE leadgen.leasing_policy (
    property_type text PRIMARY KEY CHECK (property_type IN ('office', 'retail')),
    list_rent_per_sqm numeric(8,2),
    list_management_fee_per_sqm numeric(8,2),
    floor_price_per_sqm numeric(8,2),
    min_lease_years integer NOT NULL,
    deposit_months integer NOT NULL,
    payment_cycle_months integer NOT NULL,
    annual_increase_pct numeric(5,2) NOT NULL,
    rent_free_days_min integer,
    rent_free_days_max integer,
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO leadgen.leasing_policy
    (property_type, list_rent_per_sqm, list_management_fee_per_sqm, floor_price_per_sqm,
     min_lease_years, deposit_months, payment_cycle_months, annual_increase_pct, rent_free_days_min, rent_free_days_max)
VALUES
    ('office', 30, 10, 35, 2, 2, 1, 3, 7, 15),
    -- 商铺一铺一价，没有统一挂牌价；底价未给，留空。
    ('retail', NULL, NULL, NULL, 2, 2, 1, 5, 7, 15);

CREATE TABLE leadgen.properties (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sector_key text NOT NULL DEFAULT 'office_retail' REFERENCES leadgen.sectors(key),
    building text NOT NULL,
    floor integer NOT NULL,
    unit_no text NOT NULL,
    property_type text NOT NULL CHECK (property_type IN ('office', 'retail')),
    area_sqm numeric(8,2) NOT NULL CHECK (area_sqm > 0),
    list_rent_per_sqm numeric(8,2) NOT NULL CHECK (list_rent_per_sqm >= 0),
    management_fee_per_sqm numeric(8,2) NOT NULL CHECK (management_fee_per_sqm >= 0),
    delivery_standard text,
    -- 配置原文，如“精装修3隔＋15卡”；隔间数和卡位数拆出来供匹配用。
    fit_out text,
    partition_rooms integer,
    workstations integer,
    -- 三项为空表示资料里没有写明。
    allows_open_flame boolean,
    allows_catering boolean,
    has_exhaust boolean,
    floor_plan_file text,
    status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'negotiating', 'signed')),
    remark text,
    source_file text,
    source_rows integer[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (building, unit_no)
);
CREATE INDEX idx_properties_type_status ON leadgen.properties (property_type, status);
