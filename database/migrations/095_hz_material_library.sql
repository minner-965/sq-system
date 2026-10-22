-- 095: 素材库。各板块的图片、视频先统一收进来，发内容时从库里挑（人挑，或系统按“最久没用过”挑），
-- 挑中的文件复制进一条新的发布素材，后面走原来的生成文案、人工确认、发布流程。

CREATE TABLE IF NOT EXISTS leadgen.library_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type text NOT NULL CHECK (content_type IN ('property', 'event', 'hotel', 'dining')),
    property_id uuid REFERENCES leadgen.properties(id) ON DELETE SET NULL,
    kind text NOT NULL CHECK (kind IN ('image', 'video')),
    file_path text NOT NULL,
    sha256 text NOT NULL UNIQUE,
    original_name text,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    -- 画面里是什么，写文案时会用到
    note text,
    -- 从哪来的：upload 页面上传；import 从资料文件夹导入
    origin text NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload', 'import')),
    archived boolean NOT NULL DEFAULT false,
    use_count integer NOT NULL DEFAULT 0,
    last_used_at timestamptz,
    created_by uuid REFERENCES leadgen.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_library_files_pick ON leadgen.library_files (content_type, kind, use_count, last_used_at NULLS FIRST) WHERE NOT archived;

ALTER TABLE leadgen.material_files ADD COLUMN IF NOT EXISTS library_file_id uuid REFERENCES leadgen.library_files(id) ON DELETE SET NULL;
