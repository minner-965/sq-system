-- 083: 每条跟进记录带上记录当时的客户情况（阶段、负责人、联系人、下次跟进、需求、意向），点开记录时能看到。
-- 用触发器在写入时自动留存，所有写跟进记录的地方都生效。以前的记录没有这份留存。
ALTER TABLE leadgen.activities ADD COLUMN IF NOT EXISTS snapshot jsonb;

COMMENT ON COLUMN leadgen.activities.snapshot IS '记录当时这条跟进线的情况；不含底价';

CREATE OR REPLACE FUNCTION leadgen.snapshot_activity_track() RETURNS trigger AS $$
BEGIN
    IF NEW.snapshot IS NULL THEN
        SELECT jsonb_strip_nulls(jsonb_build_object(
            'stage', t.stage,
            'owner_name', o.display_name,
            'contact_name', t.contact_name,
            'contact_phone', t.contact_phone,
            'next_follow_up_at', t.next_follow_up_at,
            'viewing_at', t.viewing_at,
            'need_property_type', t.need_property_type,
            'need_area_min', t.need_area_min,
            'need_area_max', t.need_area_max,
            'need_budget_per_sqm', t.need_budget_per_sqm,
            'need_open_flame', t.need_open_flame,
            'intended_property_label', CASE WHEN p.id IS NOT NULL THEN p.building || ' ' || p.unit_no END,
            'intended_service', t.intended_service,
            'intended_area_sqm', t.intended_area_sqm,
            'intended_price', t.intended_price))
        INTO NEW.snapshot
        FROM leadgen.company_sector_tracks t
        LEFT JOIN leadgen.users o ON o.id = t.owner_user_id
        LEFT JOIN leadgen.properties p ON p.id = t.intended_property_id
        WHERE t.id = NEW.track_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_activity_snapshot ON leadgen.activities;
CREATE TRIGGER trg_activity_snapshot BEFORE INSERT ON leadgen.activities
    FOR EACH ROW EXECUTE FUNCTION leadgen.snapshot_activity_track();
