-- 酒店对外房价：可以告诉客户的价格，在“酒店资料”页面录入，写文案和起草回复时引用。
-- 066 建表时 hotel_room_types 已有 rack_rate（门市价，每晚）和 corporate_rate（企业协议价，每晚）两列，一直空着；
-- 这里补上周末价、价格说明，以及酒店的长住价和会议室价格说明。填了的价格就是可以对外说的，空着的不提。

ALTER TABLE leadgen.hotel_room_types
    ADD COLUMN IF NOT EXISTS weekend_rate numeric(8,2),
    ADD COLUMN IF NOT EXISTS price_note text;

ALTER TABLE leadgen.hotels
    ADD COLUMN IF NOT EXISTS long_stay_price_note text,
    ADD COLUMN IF NOT EXISTS meeting_room_price_note text,
    ADD COLUMN IF NOT EXISTS prices_updated_at timestamptz,
    ADD COLUMN IF NOT EXISTS prices_updated_by uuid REFERENCES leadgen.users(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hotel_room_types_prices_positive') THEN
        ALTER TABLE leadgen.hotel_room_types ADD CONSTRAINT hotel_room_types_prices_positive
            CHECK ((rack_rate IS NULL OR rack_rate > 0) AND (weekend_rate IS NULL OR weekend_rate > 0) AND (corporate_rate IS NULL OR corporate_rate > 0));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hotel_room_types_price_note_length') THEN
        ALTER TABLE leadgen.hotel_room_types ADD CONSTRAINT hotel_room_types_price_note_length CHECK (char_length(price_note) <= 60);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hotels_price_notes_length') THEN
        ALTER TABLE leadgen.hotels ADD CONSTRAINT hotels_price_notes_length
            CHECK (char_length(long_stay_price_note) <= 200 AND char_length(meeting_room_price_note) <= 200);
    END IF;
END $$;
