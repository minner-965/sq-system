-- 恒兆广场国内版：移除原海外外贸业务的表（发信收信、商品品类、历史客户与 ICP、决策人、海外商机）。
-- 这些表对应的代码已删除，Simon 于 2026-10-10 确认旧海外数据不保留。
-- 可重复执行；CASCADE 会一并移除依赖这些表的视图和外键约束。
-- data_cleanup_* 三张表保留：companies 的删除保护触发器仍引用它们。

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- 发信、收信、退订、自动首封
    'company_suppressions','contact_suppressions',
    'controlled_application_activities','controlled_application_approvals','controlled_application_attempts',
    'controlled_application_contexts','controlled_application_drafts','controlled_application_imap_checkpoints',
    'controlled_application_inbound_messages','controlled_application_messages','controlled_application_suppressions',
    'email_message_events','email_webhook_inbox','gmail_ambiguous_send_events','gmail_mailbox_checkpoints',
    'imap_checkpoint_events','imap_mailbox_checkpoints','imap_message_receipts','inbound_messages',
    'marketing_context_approvals','marketing_context_versions',
    'outbound_ambiguous_send_events','outbound_message_attempts','outbound_messages',
    'outreach_approvals','outreach_draft_evidence','outreach_draft_products','outreach_drafts',
    'outreach_eligibility_snapshots','outreach_recipient_suppressions','outreach_recipients','outreach_threads',
    'phase13_first_touch_controls','phase13_first_touch_reservations','reply_classifications',
    -- 商品与品类
    'buyer_business_model_evidence','buyer_business_model_results',
    'category_procurement_match_dimensions','category_procurement_match_evidence',
    'category_procurement_match_results','category_procurement_match_scope_links',
    'commercial_product_fit_dimensions','commercial_product_fit_evidence','commercial_product_fit_results',
    'cooperation_feasibility_results','cooperation_feasibility_sources',
    'dpv_product_category_scope_aliases','dpv_product_category_scope_revisions','dpv_product_category_scopes',
    'product_master','product_master_revisions','product_master_taxonomy_assignments',
    'product_opportunity_candidates','product_opportunity_gap_evidence','product_opportunity_gaps',
    'product_opportunity_results','product_profile_catalog_snapshots',
    'product_taxonomy_aliases','product_taxonomy_nodes',
    'prospect_category_observations','prospect_category_sources',
    -- 历史客户、ICP、CRM 同步
    'crm_sync_outbox','customer_match_results',
    'historical_customer_activities','historical_customer_aliases','historical_customer_channels',
    'historical_customer_company_links','historical_customer_contacts','historical_customer_reconciliations',
    'historical_customers','historical_lead_outcomes','historical_order_lines','historical_orders',
    'icp_profile_features','icp_profiles','import_approvals','opportunity_crm_states',
    'reference_data_import_batches','reference_data_import_rows','reference_data_imports','reference_data_source_files',
    -- 决策人与联系方式
    'company_social_accounts','contact_verification_events','contact_work_queue',
    'decision_maker_contacts','decision_maker_product_relevance','decision_maker_sources','decision_makers',
    'enrichment_job_companies','enrichment_public_references',
    'human_evidence_exceptions','official_route_manual_tasks',
    -- 海外商机及其他
    'business_opportunity_decision_snapshots','business_opportunity_management_events',
    'collection_runs','lead_reviews','opportunity_activities','opportunity_pool_decisions',
    'research_job_purge_items','research_job_purge_runs','research_market_registry','sales_tasks'
  ]
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS leadgen.%I CASCADE', t);
  END LOOP;
END $$;

-- automation_controls 里的 PHASE13_AUTO_FIRST_TOUCH 一行保留为关闭状态：它有只追加的变更记录引用，
-- 且已没有任何代码读取它。
