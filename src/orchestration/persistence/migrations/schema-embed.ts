// Auto-generated from schema-v0.2.6.sql — DO NOT EDIT
// Regenerate: node scripts/generate-schema-embed.mjs
// Canonical checksum: dcda41acdffaeae3a58020a019636002ac263ab5ec59434db3d9b97a2916d66c

export const SCHEMA_V_0_2_6 = `CREATE TABLE contract_families (
    family_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE task_contracts (
    contract_id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    in_scope TEXT NOT NULL DEFAULT '[]',
    out_of_scope TEXT NOT NULL DEFAULT '[]',
    payload_hash TEXT,
    repo_url TEXT NOT NULL,
    repo_sha TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(family_id, version),
    UNIQUE(contract_id, family_id),
    FOREIGN KEY (family_id) REFERENCES contract_families(family_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE contract_lifecycle (
    contract_id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft', 'active', 'superseded', 'archived')),
    activated_at TEXT,
    superseded_at TEXT,
    archived_at TEXT,
    superseded_by TEXT,
    updated_ts INTEGER NOT NULL,
    FOREIGN KEY (contract_id, family_id) REFERENCES task_contracts(contract_id, family_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (superseded_by) REFERENCES task_contracts(contract_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX uq_contract_family_active
ON contract_lifecycle(family_id)
WHERE status = 'active';
CREATE TRIGGER tr_contract_lifecycle_family_sync
BEFORE INSERT ON contract_lifecycle
BEGIN
    SELECT RAISE(ABORT, 'family_id must match task_contracts.family_id')
    WHERE NEW.family_id != (SELECT family_id FROM task_contracts WHERE contract_id = NEW.contract_id);
END;
CREATE TABLE objectives (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    description TEXT NOT NULL,
    FOREIGN KEY (contract_id) REFERENCES task_contracts(contract_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_objectives_contract ON objectives(contract_id);
CREATE TABLE constraints (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'must'
        CHECK(severity IN ('must', 'should', 'nice-to-have')),
    description TEXT NOT NULL,
    FOREIGN KEY (contract_id) REFERENCES task_contracts(contract_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_constraints_contract ON constraints(contract_id);
CREATE TABLE requirements (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('critical', 'high', 'medium', 'low')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (contract_id) REFERENCES task_contracts(contract_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_requirements_contract ON requirements(contract_id);
CREATE TABLE acceptance_criteria (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    verification_method TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('critical', 'high', 'medium')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (contract_id) REFERENCES task_contracts(contract_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (requirement_id) REFERENCES requirements(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_ac_contract ON acceptance_criteria(contract_id);
CREATE INDEX idx_ac_requirement ON acceptance_criteria(requirement_id);
CREATE TABLE verification_rules (
    id TEXT PRIMARY KEY,
    criterion_id TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    rule_config TEXT NOT NULL DEFAULT '{}',
    is_required INTEGER NOT NULL DEFAULT 1
        CHECK(is_required IN (0, 1)),
    verification_scope TEXT NOT NULL DEFAULT 'file'
        CHECK(verification_scope IN ('file', 'repository')),
    failure_class TEXT NOT NULL DEFAULT 'standard'
        CHECK(failure_class IN ('standard', 'security', 'test', 'integrity', 'migration')),
    is_overridable INTEGER NOT NULL DEFAULT 0
        CHECK(is_overridable IN (0, 1)),
    evidence_requirement TEXT NOT NULL DEFAULT 'recommended'
        CHECK(evidence_requirement IN ('required', 'recommended', 'optional')),
    FOREIGN KEY (criterion_id) REFERENCES acceptance_criteria(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_vr_criterion ON verification_rules(criterion_id);
CREATE TABLE task_runs (
    run_id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    strategy TEXT NOT NULL DEFAULT 'simple'
        CHECK(strategy IN ('simple', 'planned', 'delegated', 'audit', 'recovery')),
    state TEXT NOT NULL DEFAULT 'created'
        CHECK(state IN ('created', 'planning', 'analysing', 'delegating', 'executing',
                         'verifying', 'recovering', 'completed', 'failed', 'cancelled')),
    aggregate_version INTEGER NOT NULL DEFAULT 1,
    baseline_sha TEXT NOT NULL,
    current_sha TEXT,
    verification_sha TEXT,
    completion_sha TEXT,
    repo_branch TEXT NOT NULL,
    working_tree_clean INTEGER NOT NULL DEFAULT 1,
    previous_run_id TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    created_ts INTEGER NOT NULL,
    FOREIGN KEY (contract_id) REFERENCES task_contracts(contract_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (previous_run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_tr_contract ON task_runs(contract_id);
CREATE INDEX idx_tr_state ON task_runs(state);
CREATE INDEX idx_tr_strategy ON task_runs(strategy);
CREATE INDEX idx_tr_sha ON task_runs(verification_sha);
CREATE TABLE run_requirements (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'in_progress', 'implemented', 'verified', 'rejected', 'failed')),
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(run_id, requirement_id),
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (requirement_id) REFERENCES requirements(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_rr_run ON run_requirements(run_id);
CREATE TABLE run_acceptance_criteria (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    criterion_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'in_progress', 'passed', 'failed', 'blocked')),
    verified_at TEXT,
    verified_by TEXT,
    failure_reason TEXT,
    UNIQUE(run_id, criterion_id),
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (criterion_id) REFERENCES acceptance_criteria(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_rac_run ON run_acceptance_criteria(run_id);
CREATE TABLE assignments (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
    is_required INTEGER NOT NULL DEFAULT 1
        CHECK(is_required IN (0, 1)),
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    created_by TEXT NOT NULL,
    attempt_number INTEGER NOT NULL DEFAULT 1,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    error_message TEXT,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_assign_run ON assignments(run_id);
CREATE INDEX idx_assign_status ON assignments(status);
CREATE TABLE assignment_requirements (
    assignment_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    PRIMARY KEY (assignment_id, requirement_id),
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (requirement_id) REFERENCES requirements(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE assignment_dependencies (
    assignment_id TEXT NOT NULL,
    depends_on_id TEXT NOT NULL,
    PRIMARY KEY (assignment_id, depends_on_id),
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (depends_on_id) REFERENCES assignments(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE assignment_files (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    change_type TEXT NOT NULL
        CHECK(change_type IN ('modify', 'create', 'delete')),
    content_hash TEXT,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_af_assignment ON assignment_files(assignment_id);
CREATE TABLE assignment_results (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    tests_passed INTEGER,
    tests_failed INTEGER,
    coverage_pct REAL,
    output_summary TEXT,
    error_output TEXT,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_ar_assignment ON assignment_results(assignment_id);
CREATE TABLE verification_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    assignment_id TEXT,
    run_acceptance_criterion_id TEXT,
    verification_rule_id TEXT,
    verification_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'running', 'passed', 'failed', 'skipped')),
    target_sha TEXT NOT NULL,
    command TEXT,
    exit_code INTEGER,
    output_summary TEXT,
    error_output TEXT,
    is_stale INTEGER NOT NULL DEFAULT 0
        CHECK(is_stale IN (0, 1)),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (run_acceptance_criterion_id) REFERENCES run_acceptance_criteria(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (verification_rule_id) REFERENCES verification_rules(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_vr_run ON verification_results(run_id);
CREATE INDEX idx_vr_assignment ON verification_results(assignment_id);
CREATE INDEX idx_vr_result_criterion ON verification_results(run_acceptance_criterion_id);
CREATE INDEX idx_vr_sha ON verification_results(target_sha);
CREATE INDEX idx_vr_status ON verification_results(status);
CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    assignment_id TEXT,
    agent_id TEXT NOT NULL,
    parent_session_id TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'created',
    tool_calls INTEGER DEFAULT 0,
    delegations INTEGER DEFAULT 0,
    duration_ms INTEGER,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error_message TEXT,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (parent_session_id) REFERENCES agent_sessions(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_as_run ON agent_sessions(run_id);
CREATE INDEX idx_as_agent ON agent_sessions(agent_id);
CREATE TABLE session_metrics (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    tool_calls INTEGER DEFAULT 0,
    delegations INTEGER DEFAULT 0,
    retries INTEGER DEFAULT 0,
    blocks INTEGER DEFAULT 0,
    warnings INTEGER DEFAULT 0,
    files_changed INTEGER DEFAULT 0,
    tokens_used INTEGER,
    estimated_cost_usd REAL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_sm_session ON session_metrics(session_id);
CREATE TABLE override_policy (
    override_type TEXT PRIMARY KEY,
    is_allowed INTEGER NOT NULL DEFAULT 1
        CHECK(is_allowed IN (0, 1)),
    required_approval TEXT NOT NULL DEFAULT 'orchestrator'
        CHECK(required_approval IN ('none', 'orchestrator', 'human', 'emergency')),
    target_type TEXT NOT NULL
        CHECK(target_type IN ('verification_result', 'run_acceptance_criterion',
                              'run_requirement', 'assignment'))
);
CREATE TABLE completion_overrides (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    override_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    approval_type TEXT NOT NULL
        CHECK(approval_type IN ('auto_policy', 'orchestrator', 'human', 'emergency')),
    overridden_findings TEXT NOT NULL,
    is_consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (override_type) REFERENCES override_policy(override_type)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_co_run ON completion_overrides(run_id);
CREATE TABLE completion_decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    decision TEXT NOT NULL
        CHECK(decision IN ('pass', 'fail')),
    sha TEXT NOT NULL,
    checks TEXT NOT NULL,
    override_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    decided_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (override_id) REFERENCES completion_overrides(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_cd_run ON completion_decisions(run_id);
CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    source TEXT NOT NULL,
    source_id TEXT,
    content_hash TEXT NOT NULL,
    file_path TEXT,
    format TEXT NOT NULL DEFAULT 'json',
    size INTEGER,
    sha TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_evidence_run ON evidence(run_id);
CREATE INDEX idx_evidence_sha ON evidence(sha);
CREATE TABLE evidence_lifecycle (
    evidence_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'current'
        CHECK(status IN ('current', 'stale', 'superseded', 'archived')),
    superseded_at TEXT,
    expires_at TEXT,
    FOREIGN KEY (evidence_id) REFERENCES evidence(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE run_criterion_evidence (
    run_acceptance_criterion_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    relationship TEXT NOT NULL DEFAULT 'verifies',
    linked_at TEXT NOT NULL,
    PRIMARY KEY (run_acceptance_criterion_id, evidence_id),
    FOREIGN KEY (run_acceptance_criterion_id) REFERENCES run_acceptance_criteria(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (evidence_id) REFERENCES evidence(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_rce_evidence ON run_criterion_evidence(evidence_id);
CREATE TABLE events (
    global_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    causation_id TEXT,
    correlation_id TEXT,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    aggregate_version INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    data TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_ts INTEGER NOT NULL,
    UNIQUE(aggregate_type, aggregate_id, aggregate_version)
);
CREATE INDEX idx_evt_type ON events(event_type);
CREATE INDEX idx_evt_aggregate ON events(aggregate_type, aggregate_id);
CREATE INDEX idx_evt_agg_version ON events(aggregate_type, aggregate_id, aggregate_version);
CREATE INDEX idx_evt_correlation ON events(correlation_id);
CREATE INDEX idx_evt_ts ON events(created_ts);
CREATE TABLE event_subscribers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    subscription_type TEXT NOT NULL
        CHECK(subscription_type IN ('transactional', 'durable_async', 'best_effort')),
    event_types TEXT NOT NULL,
    is_required INTEGER NOT NULL DEFAULT 1
        CHECK(is_required IN (0, 1)),
    created_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE consumer_offsets (
    subscriber_id TEXT NOT NULL,
    last_processed_sequence INTEGER NOT NULL,
    last_processed_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'paused', 'blocked')),
    paused_until TEXT,
    blocked_by_event_id TEXT,
    PRIMARY KEY (subscriber_id),
    FOREIGN KEY (subscriber_id) REFERENCES event_subscribers(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE event_outbox (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    data TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'delivering', 'delivered', 'failed', 'dead_letter', 'partially_delivered')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_ts INTEGER,
    created_ts INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    source_component TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(event_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_outbox_status ON event_outbox(status);
CREATE INDEX idx_outbox_next_retry ON event_outbox(next_retry_ts);
CREATE TABLE event_deliveries (
    id TEXT PRIMARY KEY,
    outbox_id TEXT NOT NULL,
    subscriber_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'delivering', 'delivered', 'failed', 'dead_letter')),
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_ts INTEGER,
    last_error TEXT,
    last_error_ts TEXT,
    delivered_at TEXT,
    claimed_by TEXT,
    claimed_at TEXT,
    lease_expiry TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_ts INTEGER NOT NULL,
    UNIQUE(outbox_id, subscriber_id),
    FOREIGN KEY (outbox_id) REFERENCES event_outbox(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (subscriber_id) REFERENCES event_subscribers(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_deliveries_outbox ON event_deliveries(outbox_id);
CREATE INDEX idx_deliveries_subscriber ON event_deliveries(subscriber_id);
CREATE INDEX idx_deliveries_status ON event_deliveries(status);
CREATE INDEX idx_deliveries_lease ON event_deliveries(claimed_by, lease_expiry);
CREATE TABLE dead_letter_events (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    subscriber_id TEXT NOT NULL,
    event_payload TEXT NOT NULL,
    error_history TEXT NOT NULL DEFAULT '[]',
    final_error TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unresolved'
        CHECK(status IN ('unresolved', 'resolved', 'replayed', 'discarded')),
    resolved_at TEXT,
    resolution_notes TEXT,
    created_ts INTEGER NOT NULL,
    FOREIGN KEY (delivery_id) REFERENCES event_deliveries(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (event_id) REFERENCES events(event_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_dlq_status ON dead_letter_events(status);
CREATE TABLE command_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    command_type TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'executing'
        CHECK(status IN ('executing', 'completed', 'failed')),
    owner TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    event_id TEXT,
    completion_decision_id TEXT,
    error TEXT,
    created_ts INTEGER NOT NULL
);
CREATE INDEX idx_ci_aggregate ON command_idempotency(aggregate_type, aggregate_id);
CREATE TABLE repositories (
    repository_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(url)
);
CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    assignment_id TEXT,
    repository_id TEXT NOT NULL,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    phase INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'merged', 'conflict', 'cleaned')),
    created_at TEXT NOT NULL,
    merged_at TEXT,
    conflict_details TEXT,
    UNIQUE(repository_id, path),
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (repository_id) REFERENCES repositories(repository_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_wt_run ON worktrees(run_id);
CREATE TABLE run_path_ownership (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    ownership_type TEXT NOT NULL DEFAULT 'owned'
        CHECK(ownership_type IN ('owned', 'created', 'modified')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'released', 'conflicted')),
    claimed_at TEXT NOT NULL,
    released_at TEXT,
    UNIQUE(repository_id, worktree_path, path),
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (repository_id) REFERENCES repositories(repository_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_rpo_run ON run_path_ownership(run_id);
CREATE INDEX idx_rpo_path ON run_path_ownership(repository_id, path);
CREATE TABLE path_ownership_conflicts (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    primary_run_id TEXT NOT NULL,
    primary_assignment_id TEXT NOT NULL,
    conflicting_run_id TEXT NOT NULL,
    conflicting_assignment_id TEXT NOT NULL,
    resolution TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_poc_path ON path_ownership_conflicts(repository_id, path);
CREATE TABLE path_renames (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'applied',
    applied_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_pr_run ON path_renames(run_id);
CREATE TABLE path_deletions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    path TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_pd_run ON path_deletions(run_id);
CREATE TABLE tool_invocations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT,
    tool_name TEXT NOT NULL,
    input_hash TEXT,
    output_hash TEXT,
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'success',
    error_message TEXT,
    executed_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_ti_run ON tool_invocations(run_id);
CREATE TABLE model_selections (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT,
    agent_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    provider TEXT,
    prompted_tokens INTEGER,
    generated_tokens INTEGER,
    duration_ms INTEGER,
    estimated_cost_usd REAL,
    selected_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_ms_run ON model_selections(run_id);
CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT,
    state TEXT NOT NULL,
    event_sequence INTEGER,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_cp_run ON checkpoints(run_id);
CREATE TABLE cancellation_tokens (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    consumed_at TEXT,
    UNIQUE(run_id, target_type, target_id),
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_ct_run ON cancellation_tokens(run_id);
CREATE TABLE cancellation_acknowledgements (
    id TEXT PRIMARY KEY,
    token_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    acknowledged_by TEXT NOT NULL,
    acknowledged_at TEXT NOT NULL,
    result TEXT NOT NULL
        CHECK(result IN ('accepted', 'rejected', 'ignored')),
    FOREIGN KEY (token_id) REFERENCES cancellation_tokens(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_ca_token ON cancellation_acknowledgements(token_id);
CREATE TABLE heartbeats (
    id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL DEFAULT 30
);
CREATE INDEX idx_hb_holder ON heartbeats(holder);
CREATE INDEX idx_hb_expiry ON heartbeats(heartbeat_at);
CREATE TABLE execution_metadata (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, key),
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE command_history (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT,
    command TEXT NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER,
    output_hash TEXT,
    executed_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_ch_run ON command_history(run_id);
CREATE TABLE active_locks (
    lock_id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    holder TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL DEFAULT 30,
    UNIQUE(resource_type, resource_id),
    FOREIGN KEY (holder) REFERENCES agent_sessions(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_al_holder ON active_locks(holder);
CREATE INDEX idx_al_heartbeat ON active_locks(heartbeat_at);
CREATE TABLE recovery_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    previous_state TEXT NOT NULL,
    failure_reason TEXT NOT NULL,
    error_key TEXT NOT NULL,
    action TEXT NOT NULL,
    action_details TEXT,
    result TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    duration_ms INTEGER,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_ra_run ON recovery_attempts(run_id);
CREATE TABLE context_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT,
    source TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0
        CHECK(priority >= 0),
    category TEXT NOT NULL,
    content_type TEXT NOT NULL
        CHECK(content_type IN ('inline_text', 'inline_json', 'reference')),
    content TEXT,
    immutable_ref TEXT,
    ref_type TEXT
        CHECK(ref_type IS NULL OR ref_type IN (
            'evidence', 'completion_decision', 'verification_result',
            'assignment_result', 'event', 'session_summary'
        )),
    content_hash TEXT NOT NULL,
    token_estimate INTEGER NOT NULL
        CHECK(token_estimate > 0),
    is_summarised INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    CHECK(
        (content_type IN ('inline_text', 'inline_json') AND content IS NOT NULL AND immutable_ref IS NULL)
        OR
        (content_type = 'reference' AND content IS NULL AND immutable_ref IS NOT NULL AND ref_type IS NOT NULL)
    ),
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_ci_run ON context_items(run_id);
CREATE INDEX idx_ci_priority ON context_items(run_id, priority);
CREATE INDEX idx_ci_expires ON context_items(expires_at);
CREATE TABLE context_snapshots (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT,
    event_sequence INTEGER,
    snapshot_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_cs_run ON context_snapshots(run_id);
CREATE TABLE session_summaries (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_sequence INTEGER,
    summary_text TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_ss_session ON session_summaries(session_id);
CREATE TABLE compaction_records (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    event_sequence INTEGER NOT NULL,
    compaction_type TEXT NOT NULL,
    removed_events INTEGER DEFAULT 0,
    removed_bytes INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_cr_run ON compaction_records(run_id);
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL,
    duration_ms INTEGER
);
CREATE TRIGGER tr_task_contracts_immutable_update
BEFORE UPDATE ON task_contracts
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = OLD.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot modify a non-draft contract');
END;
CREATE TRIGGER tr_task_contracts_immutable_delete
BEFORE DELETE ON task_contracts
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = OLD.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot delete a non-draft contract');
END;
CREATE TRIGGER tr_requirements_immutable_insert
BEFORE INSERT ON requirements
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = NEW.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot add requirements to a non-draft contract');
END;
CREATE TRIGGER tr_requirements_immutable_update
BEFORE UPDATE ON requirements
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = OLD.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot modify requirements of a non-draft contract');
END;
CREATE TRIGGER tr_requirements_immutable_delete
BEFORE DELETE ON requirements
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = OLD.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot delete requirements from a non-draft contract');
END;
CREATE TRIGGER tr_acceptance_criteria_immutable_insert
BEFORE INSERT ON acceptance_criteria
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = NEW.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot add acceptance criteria to a non-draft contract');
END;
CREATE TRIGGER tr_acceptance_criteria_immutable_update
BEFORE UPDATE ON acceptance_criteria
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = OLD.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot modify acceptance criteria of a non-draft contract');
END;
CREATE TRIGGER tr_acceptance_criteria_immutable_delete
BEFORE DELETE ON acceptance_criteria
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = OLD.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot delete acceptance criteria from a non-draft contract');
END;
CREATE TRIGGER tr_verification_rules_immutable_insert
BEFORE INSERT ON verification_rules
WHEN EXISTS (
    SELECT 1 FROM acceptance_criteria ac
    JOIN contract_lifecycle cl ON cl.contract_id = ac.contract_id
    WHERE ac.id = NEW.criterion_id AND cl.status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot add verification rules to a non-draft contract');
END;
CREATE TRIGGER tr_verification_rules_immutable_update
BEFORE UPDATE ON verification_rules
WHEN EXISTS (
    SELECT 1 FROM acceptance_criteria ac
    JOIN contract_lifecycle cl ON cl.contract_id = ac.contract_id
    WHERE ac.id = OLD.criterion_id AND cl.status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot modify verification rules of a non-draft contract');
END;
CREATE TRIGGER tr_verification_rules_immutable_delete
BEFORE DELETE ON verification_rules
WHEN EXISTS (
    SELECT 1 FROM acceptance_criteria ac
    JOIN contract_lifecycle cl ON cl.contract_id = ac.contract_id
    WHERE ac.id = OLD.criterion_id AND cl.status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot delete verification rules from a non-draft contract');
END;
CREATE TRIGGER tr_objectives_immutable_insert
BEFORE INSERT ON objectives
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = NEW.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot add objectives to a non-draft contract');
END;
CREATE TRIGGER tr_objectives_immutable_update
BEFORE UPDATE ON objectives
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = OLD.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot modify objectives of a non-draft contract');
END;
CREATE TRIGGER tr_objectives_immutable_delete
BEFORE DELETE ON objectives
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = OLD.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot delete objectives from a non-draft contract');
END;
CREATE TRIGGER tr_constraints_immutable_insert
BEFORE INSERT ON constraints
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = NEW.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot add constraints to a non-draft contract');
END;
CREATE TRIGGER tr_constraints_immutable_update
BEFORE UPDATE ON constraints
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = OLD.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot modify constraints of a non-draft contract');
END;
CREATE TRIGGER tr_constraints_immutable_delete
BEFORE DELETE ON constraints
WHEN EXISTS (SELECT 1 FROM contract_lifecycle
             WHERE contract_id = OLD.contract_id AND status != 'draft')
BEGIN
    SELECT RAISE(ABORT, 'Cannot delete constraints from a non-draft contract');
END;
CREATE TRIGGER tr_completion_override_allowed_insert
BEFORE INSERT ON completion_overrides
BEGIN
    SELECT RAISE(ABORT, 'Override type is not permitted')
    WHERE NOT EXISTS (
        SELECT 1 FROM override_policy
        WHERE override_type = NEW.override_type AND is_allowed = 1
    );
    SELECT RAISE(ABORT, 'Override approval does not meet policy requirement')
    WHERE EXISTS (
        SELECT 1 FROM override_policy
        WHERE override_type = NEW.override_type
          AND (
              (required_approval = 'human' AND NEW.approval_type NOT IN ('human', 'emergency'))
              OR (required_approval = 'orchestrator' AND NEW.approval_type = 'none')
          )
    );
    SELECT RAISE(ABORT, 'Override target does not exist')
    WHERE (
        (SELECT target_type FROM override_policy WHERE override_type = NEW.override_type) = 'verification_result'
        AND NOT EXISTS (SELECT 1 FROM verification_results WHERE id = NEW.target_id)
    ) OR (
        (SELECT target_type FROM override_policy WHERE override_type = NEW.override_type) = 'run_acceptance_criterion'
        AND NOT EXISTS (SELECT 1 FROM run_acceptance_criteria WHERE id = NEW.target_id)
    ) OR (
        (SELECT target_type FROM override_policy WHERE override_type = NEW.override_type) = 'assignment'
        AND NOT EXISTS (SELECT 1 FROM assignments WHERE id = NEW.target_id)
    );
    SELECT RAISE(ABORT, 'Override target belongs to a different run')
    WHERE (
        (SELECT target_type FROM override_policy WHERE override_type = NEW.override_type) = 'verification_result'
        AND (SELECT run_id FROM verification_results WHERE id = NEW.target_id) != NEW.run_id
    ) OR (
        (SELECT target_type FROM override_policy WHERE override_type = NEW.override_type) = 'run_acceptance_criterion'
        AND (SELECT run_id FROM run_acceptance_criteria WHERE id = NEW.target_id) != NEW.run_id
    ) OR (
        (SELECT target_type FROM override_policy WHERE override_type = NEW.override_type) = 'assignment'
        AND (SELECT run_id FROM assignments WHERE id = NEW.target_id) != NEW.run_id
    );
    SELECT RAISE(ABORT, 'Override target has already been used in an unconsumed override')
    WHERE EXISTS (
        SELECT 1 FROM completion_overrides existing
        WHERE existing.target_id = NEW.target_id
          AND existing.run_id = NEW.run_id
          AND existing.is_consumed = 0
          AND existing.id != NEW.id
    );
END;
CREATE TRIGGER tr_completion_override_allowed_update
BEFORE UPDATE ON completion_overrides
BEGIN
    SELECT RAISE(ABORT, 'Cannot change run_id of an override')
    WHERE NEW.run_id != OLD.run_id;
    SELECT RAISE(ABORT, 'Cannot change target_id of an override')
    WHERE NEW.target_id != OLD.target_id;
    SELECT RAISE(ABORT, 'Cannot change override_type of an override')
    WHERE NEW.override_type != OLD.override_type;
    SELECT RAISE(ABORT, 'Approval change does not meet policy requirement')
    WHERE NEW.approval_type != OLD.approval_type
      AND EXISTS (
          SELECT 1 FROM override_policy
          WHERE override_type = NEW.override_type
            AND (
                (required_approval = 'human' AND NEW.approval_type NOT IN ('human', 'emergency'))
                OR (required_approval = 'orchestrator' AND NEW.approval_type = 'none')
            )
      );
END;
CREATE TRIGGER tr_run_requirements_contract_consistency
BEFORE INSERT ON run_requirements
BEGIN
    SELECT RAISE(ABORT, 'Requirement must belong to same contract as task_run')
    WHERE (
        SELECT contract_id FROM task_runs WHERE run_id = NEW.run_id
    ) != (
        SELECT contract_id FROM requirements WHERE id = NEW.requirement_id
    );
END;
CREATE TRIGGER tr_run_acceptance_criteria_contract_consistency
BEFORE INSERT ON run_acceptance_criteria
BEGIN
    SELECT RAISE(ABORT, 'Criterion must belong to same contract as task_run')
    WHERE (
        SELECT contract_id FROM task_runs WHERE run_id = NEW.run_id
    ) != (
        SELECT contract_id FROM acceptance_criteria WHERE id = NEW.criterion_id
    );
END;
CREATE TRIGGER tr_assignment_requirements_contract_consistency
BEFORE INSERT ON assignment_requirements
BEGIN
    SELECT RAISE(ABORT, 'Assignment and requirement must belong to same contract')
    WHERE (
        SELECT contract_id FROM task_runs
        WHERE run_id = (SELECT run_id FROM assignments WHERE id = NEW.assignment_id)
    ) != (
        SELECT contract_id FROM requirements WHERE id = NEW.requirement_id
    );
END;
CREATE TRIGGER tr_run_criterion_evidence_same_run
BEFORE INSERT ON run_criterion_evidence
BEGIN
    SELECT RAISE(ABORT, 'run_acceptance_criterion and evidence must belong to the same run')
    WHERE NOT EXISTS (
        SELECT 1 FROM run_acceptance_criteria rac
        JOIN evidence e ON e.id = NEW.evidence_id
        WHERE rac.id = NEW.run_acceptance_criterion_id
          AND rac.run_id = e.run_id
    );
END;
CREATE TRIGGER tr_evidence_immutable_update
BEFORE UPDATE ON evidence
BEGIN
    SELECT RAISE(ABORT, 'Cannot modify evidence content after creation');
END;
CREATE TRIGGER tr_evidence_immutable_delete
BEFORE DELETE ON evidence
BEGIN
    SELECT RAISE(ABORT, 'Evidence is permanently preserved and cannot be deleted');
END;
CREATE TRIGGER tr_session_metrics_run_consistency
BEFORE INSERT ON session_metrics
WHEN (
    SELECT run_id FROM agent_sessions WHERE id = NEW.session_id
) != NEW.run_id
BEGIN
    SELECT RAISE(ABORT, 'session and run must be consistent');
END;
CREATE TRIGGER tr_tool_invocations_run_consistency
BEFORE INSERT ON tool_invocations
WHEN NEW.session_id IS NOT NULL AND (
    SELECT run_id FROM agent_sessions WHERE id = NEW.session_id
) != NEW.run_id
BEGIN
    SELECT RAISE(ABORT, 'session and run must be consistent');
END;
CREATE TRIGGER tr_model_selections_run_consistency
BEFORE INSERT ON model_selections
WHEN NEW.session_id IS NOT NULL AND (
    SELECT run_id FROM agent_sessions WHERE id = NEW.session_id
) != NEW.run_id
BEGIN
    SELECT RAISE(ABORT, 'session and run must be consistent');
END;
CREATE TRIGGER tr_checkpoints_run_consistency
BEFORE INSERT ON checkpoints
WHEN NEW.session_id IS NOT NULL AND (
    SELECT run_id FROM agent_sessions WHERE id = NEW.session_id
) != NEW.run_id
BEGIN
    SELECT RAISE(ABORT, 'session and run must be consistent');
END;
CREATE TRIGGER tr_execution_metadata_run_consistency
BEFORE INSERT ON execution_metadata
WHEN NEW.session_id IS NOT NULL AND (
    SELECT run_id FROM agent_sessions WHERE id = NEW.session_id
) != NEW.run_id
BEGIN
    SELECT RAISE(ABORT, 'session and run must be consistent');
END;
CREATE TRIGGER tr_command_history_run_consistency
BEFORE INSERT ON command_history
WHEN NEW.session_id IS NOT NULL AND (
    SELECT run_id FROM agent_sessions WHERE id = NEW.session_id
) != NEW.run_id
BEGIN
    SELECT RAISE(ABORT, 'session and run must be consistent');
END;
CREATE TRIGGER tr_context_items_run_consistency
BEFORE INSERT ON context_items
WHEN NEW.session_id IS NOT NULL AND (
    SELECT run_id FROM agent_sessions WHERE id = NEW.session_id
) != NEW.run_id
BEGIN
    SELECT RAISE(ABORT, 'session and run must be consistent');
END;
CREATE TRIGGER tr_context_snapshots_run_consistency
BEFORE INSERT ON context_snapshots
WHEN NEW.session_id IS NOT NULL AND (
    SELECT run_id FROM agent_sessions WHERE id = NEW.session_id
) != NEW.run_id
BEGIN
    SELECT RAISE(ABORT, 'session and run must be consistent');
END;
CREATE TRIGGER tr_session_summaries_run_consistency
BEFORE INSERT ON session_summaries
WHEN NEW.session_id IS NOT NULL AND (
    SELECT run_id FROM agent_sessions WHERE id = NEW.session_id
) != NEW.run_id
BEGIN
    SELECT RAISE(ABORT, 'session and run must be consistent');
END;
CREATE TRIGGER tr_verification_results_run_consistency
BEFORE INSERT ON verification_results
WHEN NEW.assignment_id IS NOT NULL AND (
    SELECT run_id FROM assignments WHERE id = NEW.assignment_id
) != NEW.run_id
BEGIN
    SELECT RAISE(ABORT, 'verification result must belong to the same run as its assignment');
END;
`;
export const SCHEMA_CHECKSUM = "dcda41acdffaeae3a58020a019636002ac263ab5ec59434db3d9b97a2916d66c";
