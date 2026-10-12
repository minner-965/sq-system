-- 089: 把“为什么认为这家企业有需求”做实。
-- 1) 需求依据多两类更直接的：在找场地（选址、求租、看场地）、本地项目进场（中标或进驻本地工程，需要驻地办公、住宿、用餐）。
-- 2) 招聘类依据记下在招多少个岗位，用来分强弱。
-- 3) 打过电话以后，把“对方到底有没有需求”记在跟进线上，用来回头看哪类依据准。
-- 4) 每次检索多查一些企业的依据（原来每次 20 家，300 多家要半个月才查完一遍）。

ALTER TABLE leadgen.company_signals DROP CONSTRAINT IF EXISTS company_signals_signal_type_check;
ALTER TABLE leadgen.company_signals ADD CONSTRAINT company_signals_signal_type_check
    CHECK (signal_type IN ('hiring', 'expansion', 'new_setup', 'relocation', 'seeking_space', 'project_site'));
ALTER TABLE leadgen.company_signals ADD COLUMN IF NOT EXISTS openings integer CHECK (openings IS NULL OR openings >= 0);
COMMENT ON COLUMN leadgen.company_signals.openings IS '招聘类依据：搜索结果里写明的在招岗位或人数；没写明为空';

ALTER TABLE leadgen.company_sector_tracks
    ADD COLUMN IF NOT EXISTS demand_check text CHECK (demand_check IN ('confirmed', 'later', 'none', 'unreachable')),
    ADD COLUMN IF NOT EXISTS demand_check_note text,
    ADD COLUMN IF NOT EXISTS demand_checked_at timestamptz,
    ADD COLUMN IF NOT EXISTS demand_checked_by uuid REFERENCES leadgen.users(id);
COMMENT ON COLUMN leadgen.company_sector_tracks.demand_check IS '联系后核实的结果：confirmed 确有需求；later 以后可能有；none 没有需求；unreachable 没联系上';

UPDATE leadgen.discovery_settings SET signal_checks_per_run = 40 WHERE signal_checks_per_run < 40;
