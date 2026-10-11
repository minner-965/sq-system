-- 企业发现：离中心点很近的地点就在恒兆广场里面，是现有商户，不进系统。
-- 首次真实检索发现只按地址字样排除不够（如“水西福业一街3号6层”就在项目内）。
ALTER TABLE leadgen.discovery_settings
    ADD COLUMN exclude_within_m integer NOT NULL DEFAULT 150 CHECK (exclude_within_m BETWEEN 0 AND 1000);
UPDATE leadgen.discovery_settings
SET exclude_address_keywords = ARRAY['恒兆广场', '水西商业广场', '福业一街1号', '福业一街3号', '福业二街2号', '福业二街6号', '福业二街8号',
                                     '福业2街2号', '福业2街6号', '福业2街8号']
WHERE id = 1;
