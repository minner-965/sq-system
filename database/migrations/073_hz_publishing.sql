-- 恒兆广场国内版：内容发布中心。发布账号（按多账号设计）、素材、每个平台一条的发布任务及其各次文案版本。

CREATE TABLE leadgen.publish_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform text NOT NULL CHECK (platform IN ('douyin', 'xiaohongshu', 'channels', 'moments')),
    account_name text NOT NULL,
    -- 个人号、企业号、专业号。升级后只换读取方式，其他功能不变。
    account_type text NOT NULL DEFAULT 'personal' CHECK (account_type IN ('personal', 'enterprise', 'professional')),
    -- 发布用，还是“需求发现”搜索专用的小号。
    purpose text NOT NULL DEFAULT 'publish' CHECK (purpose IN ('publish', 'search')),
    login_status text NOT NULL DEFAULT 'never' CHECK (login_status IN ('never', 'ok', 'expired')),
    last_login_at timestamptz,
    daily_limit integer NOT NULL DEFAULT 5 CHECK (daily_limit BETWEEN 1 AND 50),
    is_paused boolean NOT NULL DEFAULT false,
    owner_user_id uuid REFERENCES leadgen.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (platform, account_name)
);

CREATE TABLE leadgen.materials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    topic text NOT NULL CHECK (length(btrim(topic)) > 0),
    content_type text NOT NULL CHECK (content_type IN ('property', 'event', 'hotel', 'dining')),
    property_id uuid REFERENCES leadgen.properties(id) ON DELETE SET NULL,
    note text,
    target_platforms text[] NOT NULL CHECK (target_platforms <@ ARRAY['douyin', 'xiaohongshu', 'channels', 'moments']),
    created_by uuid REFERENCES leadgen.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_materials_created ON leadgen.materials (created_at DESC);

-- 文件存在本机磁盘（data/media/materials/），这里只存路径和哈希。
CREATE TABLE leadgen.material_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    material_id uuid NOT NULL REFERENCES leadgen.materials(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('image', 'video')),
    file_path text NOT NULL,
    original_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (material_id, sha256)
);
CREATE INDEX idx_material_files_sha ON leadgen.material_files (sha256);

-- 每份素材在每个目标平台一条。只有 confirmed 的任务会被发布程序取走。
CREATE TABLE leadgen.publish_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    material_id uuid NOT NULL REFERENCES leadgen.materials(id) ON DELETE CASCADE,
    platform text NOT NULL CHECK (platform IN ('douyin', 'xiaohongshu', 'channels', 'moments')),
    account_id uuid REFERENCES leadgen.publish_accounts(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'confirmed', 'publishing', 'published', 'failed', 'withdrawn')),
    title text,
    body text,
    topics text[] NOT NULL DEFAULT '{}',
    scheduled_at timestamptz,
    confirmed_by uuid REFERENCES leadgen.users(id),
    confirmed_at timestamptz,
    publish_started_at timestamptz,
    published_at timestamptz,
    post_url text,
    error_message text,
    error_screenshot text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (material_id, platform),
    CHECK (status <> 'confirmed' OR (scheduled_at IS NOT NULL AND confirmed_by IS NOT NULL AND body IS NOT NULL))
);
CREATE INDEX idx_publish_tasks_queue ON leadgen.publish_tasks (status, scheduled_at);

CREATE TABLE leadgen.publish_task_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES leadgen.publish_tasks(id) ON DELETE CASCADE,
    title text,
    body text NOT NULL,
    topics text[] NOT NULL DEFAULT '{}',
    source text NOT NULL CHECK (source IN ('model', 'manual')),
    created_by uuid REFERENCES leadgen.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_publish_task_versions_task ON leadgen.publish_task_versions (task_id, created_at DESC);
