-- 恒兆广场国内版：酒店、公寓、餐饮的服务目录。价格类字段可空，资料到了再补。
-- 种子数据取自《酒店基本信息》《鱼仔店基本信息》和公司介绍；科晟公寓暂无资料，表先建好。

CREATE TABLE leadgen.hotels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key text NOT NULL UNIQUE,
    name text NOT NULL,
    brand_note text,
    address text,
    phone text,
    room_count integer,
    opened_year integer,
    check_in_time text,
    check_out_time text,
    location_notes text[] NOT NULL DEFAULT '{}',
    room_highlights text[] NOT NULL DEFAULT '{}',
    facilities text[] NOT NULL DEFAULT '{}',
    meeting_room_area_sqm numeric(8,2),
    meeting_room_capacity_min integer,
    meeting_room_capacity_max integer,
    target_guests text[] NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leadgen.hotel_room_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id uuid NOT NULL REFERENCES leadgen.hotels(id) ON DELETE CASCADE,
    name text NOT NULL,
    area_sqm numeric(6,2),
    rack_rate numeric(8,2),
    corporate_rate numeric(8,2),
    features text,
    sort_order integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (hotel_id, name)
);

CREATE TABLE leadgen.apartment_units (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    apartment_name text NOT NULL DEFAULT '科晟公寓',
    unit_type text NOT NULL,
    area_sqm numeric(6,2),
    monthly_rent numeric(8,2),
    min_lease_months integer,
    features text,
    is_active boolean NOT NULL DEFAULT true,
    remark text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (apartment_name, unit_type)
);

CREATE TABLE leadgen.dining_outlets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key text NOT NULL UNIQUE,
    name text NOT NULL,
    positioning text,
    address text,
    area_sqm numeric(8,2),
    area_note text,
    private_rooms integer,
    seats integer,
    avg_spend numeric(8,2),
    opening_hours text,
    phone text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leadgen.dining_packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_id uuid NOT NULL REFERENCES leadgen.dining_outlets(id) ON DELETE CASCADE,
    name text NOT NULL,
    package_type text NOT NULL CHECK (package_type IN ('group_meal', 'banquet', 'meeting_meal')),
    price_per_person numeric(8,2),
    price_per_table numeric(8,2),
    min_people integer,
    description text,
    is_active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (outlet_id, name)
);

INSERT INTO leadgen.hotels
    (key, name, brand_note, address, phone, room_count, opened_year, check_in_time, check_out_time,
     location_notes, room_highlights, facilities,
     meeting_room_area_sqm, meeting_room_capacity_min, meeting_room_capacity_max, target_guests)
VALUES (
    'echarm', '宜尚酒店（广州黄埔宝能演艺中心店）',
    '东呈集团旗下中端北欧风酒店，宜尚 3.5 系列旗舰店',
    '广州市黄埔区长岭街道长贝二路水西敏街广场 3 栋（恒兆广场）', '020-82003061', 114, 2025,
    '14:00 后', '次日 12:00 前',
    ARRAY['距宝能广州国际体育演艺中心约 4.3 公里，车程约 10 分钟',
          '地铁 21 号线长平站约 1.6 公里',
          '周边有敏捷广场、奥园广场',
          '车程约 15 分钟到科学城，30 分钟到天河 CBD'],
    ARRAY['全屋语音控制灯光、空调、电视',
          '全景落地窗，部分房型山景',
          '零压床垫、星级床品'],
    ARRAY['中西自助早餐', '24 小时自助洗衣房', '健身房', '三楼恒温泳池', '免费停车场和充电桩',
          '商务中心', '24 小时大堂热饮站', '行李寄存', '全店 WiFi'],
    200, 75, 110,
    ARRAY['宝能演艺中心演唱会和赛事观众', '科学城商务出差', '家庭短途出游']
);

-- 资料写明共 7 种房型，只列出了下面 6 个名称；面积只给了标准大床房。
INSERT INTO leadgen.hotel_room_types (hotel_id, name, area_sqm, features, sort_order)
SELECT h.id, v.name, v.area_sqm, v.features, v.sort_order
FROM leadgen.hotels h,
     (VALUES ('智能标准大床房', 35::numeric, NULL, 1),
             ('山景大床房', NULL, '山景', 2),
             ('山景双床房', NULL, '山景', 3),
             ('臻享浴缸房', NULL, '带浴缸', 4),
             ('影音房', NULL, NULL, 5),
             ('豪华房', NULL, '带休闲躺椅', 6)) AS v(name, area_sqm, features, sort_order)
WHERE h.key = 'echarm';

INSERT INTO leadgen.dining_outlets (key, name, positioning, address, area_sqm, area_note) VALUES
    ('yuzai', '恒兆鱼仔店', '传统地道潮汕菜', '广州市黄埔区水西福业一街 1 号 B 栋', 1500, '资料原文：1500多平方'),
    ('niuzhuang', '恒兆牛庄', '地方特色餐饮', NULL, NULL, NULL),
    ('xiangyun', '乡韵小筑', NULL, NULL, NULL, NULL);
