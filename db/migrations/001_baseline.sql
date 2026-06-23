-- Durable Agent Runtime Lite development baseline schema.
-- This migration intentionally resets the public schema; development data is not preserved.
drop extension if exists vector cascade;

drop schema if exists public cascade;
create schema public;
grant all on schema public to public;
create extension if not exists vector with schema public;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10 (Debian 17.10-1.pgdg12+1)
-- Dumped by pg_dump version 17.10 (Debian 17.10-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--



--
-- Name: prevent_agent_context_snapshot_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_agent_context_snapshot_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'agent_context_snapshot is immutable';
end;
$$;


--
-- Name: prevent_agent_execution_plan_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_agent_execution_plan_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.execution_plan_hash <> new.execution_plan_hash
    or old.plan_json <> new.plan_json
    or old.execution_plan_ref <> new.execution_plan_ref then
    raise exception 'agent_execution_plan is immutable';
  end if;
  return new;
end;
$$;


--
-- Name: prevent_evaluation_execution_plan_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_evaluation_execution_plan_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'evaluation_execution_plan is immutable';
end;
$$;


--
-- Name: prevent_evaluation_gate_decision_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_evaluation_gate_decision_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'evaluation_gate_decision is immutable';
end;
$$;


--
-- Name: prevent_evaluation_subject_snapshot_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_evaluation_subject_snapshot_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'evaluation_subject_snapshot is immutable';
end;
$$;


--
-- Name: prevent_published_evaluation_case_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_published_evaluation_case_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  dataset_status text;
begin
  select status into dataset_status
  from evaluation_dataset
  where dataset_id = old.dataset_id and version = old.dataset_version;

  if dataset_status = 'published' then
    raise exception 'published evaluation dataset cases are immutable';
  end if;
  return new;
end;
$$;


--
-- Name: prevent_published_model_definition_content_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_published_model_definition_content_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.status in ('published', 'disabled', 'deprecated')
    and (
      old.display_name <> new.display_name
      or old.gateway_profile_id <> new.gateway_profile_id
      or old.gateway_profile_config_hash <> new.gateway_profile_config_hash
      or old.upstream_model_id <> new.upstream_model_id
      or old.provider <> new.provider
      or old.capabilities_json <> new.capabilities_json
      or old.context_window <> new.context_window
      or old.max_output_tokens <> new.max_output_tokens
      or old.embedding_dimensions is distinct from new.embedding_dimensions
      or old.input_cost_per_million <> new.input_cost_per_million
      or old.output_cost_per_million <> new.output_cost_per_million
      or old.currency <> new.currency
      or old.tags_json <> new.tags_json
      or old.model_hash <> new.model_hash
    ) then
    raise exception 'model_definition published content is immutable';
  end if;
  return new;
end;
$$;


--
-- Name: prevent_published_model_gateway_profile_public_config_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_published_model_gateway_profile_public_config_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.status = 'published'
    and (
      old.display_name <> new.display_name
      or old.protocol <> new.protocol
      or old.base_url <> new.base_url
      or old.auth_type <> new.auth_type
      or old.config_hash <> new.config_hash
    ) then
    raise exception 'model_gateway_profile published public config is immutable';
  end if;
  return new;
end;
$$;


--
-- Name: prevent_published_model_policy_content_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_published_model_policy_content_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.status in ('published', 'gray', 'deprecated', 'disabled')
    and (
      old.protocol <> new.protocol
      or old.targets_json <> new.targets_json
      or old.retry_policy_json <> new.retry_policy_json
      or old.fallback_policy_json <> new.fallback_policy_json
      or old.request_policy_json <> new.request_policy_json
    ) then
    raise exception 'model_policy published content is immutable';
  end if;
  return new;
end;
$$;


--
-- Name: prevent_published_tenant_runtime_policy_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_published_tenant_runtime_policy_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.status in ('published', 'deprecated', 'disabled') then
    if old.allowed_tools_json <> new.allowed_tools_json
      or old.denied_tools_json <> new.denied_tools_json
      or old.allowed_models_json <> new.allowed_models_json
      or old.denied_models_json <> new.denied_models_json
      or old.allowed_handoffs_json <> new.allowed_handoffs_json
      or old.denied_handoffs_json <> new.denied_handoffs_json
      or old.budget_cap_json <> new.budget_cap_json
      or old.max_concurrent_agent_runs <> new.max_concurrent_agent_runs then
      raise exception 'published tenant_runtime_policy content is immutable';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: prevent_tenant_runtime_policy_snapshot_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_tenant_runtime_policy_snapshot_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'tenant_runtime_policy_snapshot is immutable';
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_context_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_context_snapshot (
    snapshot_id text NOT NULL,
    agent_run_id text NOT NULL,
    previous_snapshot_id text,
    schema_version text NOT NULL,
    sanitized_messages_json jsonb NOT NULL,
    snapshot_hash text NOT NULL,
    message_count integer NOT NULL,
    byte_size integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_execution_plan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_execution_plan (
    execution_plan_id text NOT NULL,
    execution_plan_ref text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    agent_id text NOT NULL,
    agent_version integer NOT NULL,
    agent_sha256 text NOT NULL,
    prompt_id text NOT NULL,
    prompt_version integer NOT NULL,
    prompt_sha256 text NOT NULL,
    model_policy_json jsonb NOT NULL,
    allowed_tools_json jsonb NOT NULL,
    allowed_handoffs_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    output_schema_json jsonb,
    budget_json jsonb NOT NULL,
    plan_json jsonb NOT NULL,
    execution_plan_hash text NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    model_policy_id text,
    model_policy_version integer,
    model_policy_hash text,
    resolved_model_policy_json jsonb
);


--
-- Name: agent_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_run (
    agent_run_id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    task_run_id text NOT NULL,
    workflow_id text NOT NULL,
    parent_workflow_id text,
    execution_plan_ref text NOT NULL,
    execution_plan_hash text NOT NULL,
    agent_id text NOT NULL,
    agent_version integer NOT NULL,
    prompt_id text NOT NULL,
    prompt_version integer NOT NULL,
    model text NOT NULL,
    execution_mode text NOT NULL,
    status text NOT NULL,
    current_segment_index integer DEFAULT 0 NOT NULL,
    model_turn_count integer DEFAULT 0 NOT NULL,
    tool_call_count integer DEFAULT 0 NOT NULL,
    handoff_count integer DEFAULT 0 NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    total_tokens integer DEFAULT 0 NOT NULL,
    estimated_cost numeric,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workflow_run_id text,
    tenant_policy_snapshot_ref text,
    tenant_policy_version integer,
    tenant_policy_hash text,
    tenant_admission_id text,
    model_policy_id text,
    model_policy_version integer,
    model_policy_hash text,
    selected_model_id text,
    selected_provider text,
    fallback_count integer DEFAULT 0 NOT NULL,
    model_call_count integer DEFAULT 0 NOT NULL
);


--
-- Name: agent_spec; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_spec (
    id bigint NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    spec_id text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    spec_json jsonb NOT NULL,
    sha256 text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    updated_by text,
    published_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    gray_policy_json jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: agent_spec_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_spec_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_spec_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_spec_id_seq OWNED BY public.agent_spec.id;


--
-- Name: agent_step; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_step (
    agent_step_id text NOT NULL,
    agent_run_id text NOT NULL,
    segment_index integer NOT NULL,
    stable_step_key text NOT NULL,
    segment_status text NOT NULL,
    decision_summary text,
    proposed_tool_calls_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    tool_result_refs_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    context_snapshot_ref jsonb,
    output_ref text,
    usage_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    authoritative_tool_result_refs_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    human_task_ids_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    context_snapshot_before_ref jsonb,
    context_snapshot_after_ref jsonb,
    handoff_refs_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT chk_agent_step_decision_summary_len CHECK (((decision_summary IS NULL) OR (char_length(decision_summary) <= 2000)))
);


--
-- Name: audit_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_event (
    event_id text NOT NULL,
    tenant_id text NOT NULL,
    actor_id text,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    result text NOT NULL,
    reason text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    trace_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    event_key text
);


--
-- Name: capability_release; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capability_release (
    release_id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    resource_version integer NOT NULL,
    action text NOT NULL,
    previous_version integer,
    target_status text NOT NULL,
    operator_id text NOT NULL,
    validation_result jsonb,
    release_note text,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    evaluation_gate_decision_id text,
    evaluation_gate_override_id text
);


--
-- Name: evaluation_case; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_case (
    case_id text NOT NULL,
    dataset_id text NOT NULL,
    dataset_version integer NOT NULL,
    name text NOT NULL,
    description text,
    input_json jsonb NOT NULL,
    context_refs_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    expected_status text,
    expected_tool_calls_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    forbidden_tools_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    final_assertions_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    policy_assertions_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    latency_budget_ms integer,
    input_token_budget integer,
    output_token_budget integer,
    total_token_budget integer,
    cost_budget numeric,
    weight numeric DEFAULT 1 NOT NULL,
    tags_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    minimum_case_score numeric,
    CONSTRAINT chk_evaluation_case_budgets CHECK ((((latency_budget_ms IS NULL) OR (latency_budget_ms > 0)) AND ((input_token_budget IS NULL) OR (input_token_budget > 0)) AND ((output_token_budget IS NULL) OR (output_token_budget > 0)) AND ((total_token_budget IS NULL) OR (total_token_budget > 0)) AND ((cost_budget IS NULL) OR (cost_budget >= (0)::numeric)))),
    CONSTRAINT chk_evaluation_case_minimum_case_score CHECK (((minimum_case_score IS NULL) OR ((minimum_case_score >= (0)::numeric) AND (minimum_case_score <= (1)::numeric)))),
    CONSTRAINT chk_evaluation_case_weight CHECK ((weight > (0)::numeric))
);


--
-- Name: evaluation_case_result; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_case_result (
    evaluation_case_result_id text NOT NULL,
    evaluation_run_id text NOT NULL,
    case_id text NOT NULL,
    status text NOT NULL,
    score numeric,
    metric_results_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    actual_status text,
    task_run_id text,
    agent_run_id text,
    model_call_ids_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    tool_call_ids_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    final_output_ref text,
    safe_output_json jsonb,
    latency_ms integer,
    input_tokens integer,
    output_tokens integer,
    total_tokens integer,
    estimated_cost numeric,
    error_code text,
    error_message text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workflow_id text,
    workflow_run_id text,
    evidence_snapshot_json jsonb,
    evidence_hash text,
    candidate_fidelity_verified boolean DEFAULT false NOT NULL,
    assertion_failure_count integer DEFAULT 0 NOT NULL,
    hard_gate_failure_count integer DEFAULT 0 NOT NULL,
    system_error_class text,
    CONSTRAINT chk_evaluation_case_result_evidence_hash CHECK (((evidence_hash IS NULL) OR (evidence_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT chk_evaluation_case_result_failure_counts CHECK (((assertion_failure_count >= 0) AND (hard_gate_failure_count >= 0))),
    CONSTRAINT chk_evaluation_case_result_score CHECK (((score IS NULL) OR ((score >= (0)::numeric) AND (score <= (1)::numeric)))),
    CONSTRAINT chk_evaluation_case_result_status CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'passed'::text, 'failed'::text, 'skipped'::text, 'system_error'::text, 'cancelled'::text]))),
    CONSTRAINT chk_evaluation_case_safe_output_size CHECK (((safe_output_json IS NULL) OR (pg_column_size(safe_output_json) <= 1048576)))
);


--
-- Name: evaluation_comparison; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_comparison (
    comparison_id text NOT NULL,
    candidate_run_id text NOT NULL,
    baseline_run_id text NOT NULL,
    dataset_id text NOT NULL,
    dataset_version integer NOT NULL,
    dataset_hash text NOT NULL,
    comparable boolean NOT NULL,
    result_json jsonb NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_evaluation_comparison_dataset_hash CHECK ((dataset_hash ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: evaluation_dataset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_dataset (
    dataset_id text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    name text NOT NULL,
    description text,
    domain text,
    tags_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    default_weight numeric DEFAULT 1 NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    dataset_hash text NOT NULL,
    created_by text,
    updated_by text,
    published_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT chk_evaluation_dataset_hash CHECK ((dataset_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT chk_evaluation_dataset_revision CHECK ((revision > 0)),
    CONSTRAINT chk_evaluation_dataset_status CHECK ((status = ANY (ARRAY['draft'::text, 'validated'::text, 'published'::text, 'deprecated'::text, 'disabled'::text]))),
    CONSTRAINT chk_evaluation_dataset_weight CHECK ((default_weight > (0)::numeric))
);


--
-- Name: evaluation_execution_plan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_execution_plan (
    evaluation_execution_plan_id text NOT NULL,
    evaluation_execution_plan_ref text NOT NULL,
    subject_snapshot_ref text NOT NULL,
    subject_snapshot_hash text NOT NULL,
    tenant_id text NOT NULL,
    dataset_id text NOT NULL,
    dataset_version integer NOT NULL,
    dataset_hash text NOT NULL,
    candidate_bundle_hash text NOT NULL,
    plan_json jsonb NOT NULL,
    plan_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_evaluation_plan_hash CHECK (((subject_snapshot_hash ~ '^[a-f0-9]{64}$'::text) AND (dataset_hash ~ '^[a-f0-9]{64}$'::text) AND (candidate_bundle_hash ~ '^[a-f0-9]{64}$'::text) AND (plan_hash ~ '^[a-f0-9]{64}$'::text)))
);


--
-- Name: evaluation_gate_decision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_gate_decision (
    gate_decision_id text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    resource_version integer NOT NULL,
    resource_hash text NOT NULL,
    candidate_bundle_hash text NOT NULL,
    gate_policy_id text NOT NULL,
    gate_policy_version integer NOT NULL,
    gate_policy_hash text NOT NULL,
    evaluation_run_ids_json jsonb NOT NULL,
    decision text NOT NULL,
    reasons_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    decided_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_evaluation_gate_decision_hash CHECK (((resource_hash ~ '^[a-f0-9]{64}$'::text) AND (candidate_bundle_hash ~ '^[a-f0-9]{64}$'::text) AND (gate_policy_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT chk_evaluation_gate_decision_status CHECK ((decision = ANY (ARRAY['passed'::text, 'failed'::text, 'stale'::text, 'overridden'::text, 'advisory_failed'::text]))),
    CONSTRAINT chk_evaluation_gate_decision_type CHECK ((resource_type = ANY (ARRAY['prompt'::text, 'agent'::text, 'model_policy'::text])))
);


--
-- Name: evaluation_gate_override; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_gate_override (
    override_id text NOT NULL,
    gate_decision_id text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    resource_version integer NOT NULL,
    resource_hash text NOT NULL,
    operator_id text NOT NULL,
    reason text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_evaluation_gate_override_hash CHECK ((resource_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT chk_evaluation_gate_override_reason CHECK ((char_length(reason) >= 12)),
    CONSTRAINT chk_evaluation_gate_override_type CHECK ((resource_type = ANY (ARRAY['prompt'::text, 'agent'::text, 'model_policy'::text])))
);


--
-- Name: evaluation_gate_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_gate_policy (
    gate_policy_id text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    resource_types_json jsonb NOT NULL,
    required_dataset_refs_json jsonb NOT NULL,
    thresholds_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    regression_rules_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    required_case_tags_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    allow_override boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    gate_policy_hash text NOT NULL,
    created_by text,
    updated_by text,
    published_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT chk_evaluation_gate_policy_hash CHECK ((gate_policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT chk_evaluation_gate_policy_revision CHECK ((revision > 0)),
    CONSTRAINT chk_evaluation_gate_policy_status CHECK ((status = ANY (ARRAY['draft'::text, 'validated'::text, 'published'::text, 'deprecated'::text, 'disabled'::text])))
);


--
-- Name: evaluation_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_run (
    evaluation_run_id text NOT NULL,
    tenant_id text NOT NULL,
    dataset_id text NOT NULL,
    dataset_version integer NOT NULL,
    dataset_hash text NOT NULL,
    subject_snapshot_ref text NOT NULL,
    subject_snapshot_hash text NOT NULL,
    evaluation_execution_plan_ref text NOT NULL,
    evaluation_execution_plan_hash text NOT NULL,
    baseline_run_id text,
    trigger_type text NOT NULL,
    status text NOT NULL,
    total_cases integer DEFAULT 0 NOT NULL,
    completed_cases integer DEFAULT 0 NOT NULL,
    passed_cases integer DEFAULT 0 NOT NULL,
    failed_cases integer DEFAULT 0 NOT NULL,
    skipped_cases integer DEFAULT 0 NOT NULL,
    aggregate_score numeric,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error_code text,
    error_message text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workflow_id text,
    workflow_run_id text,
    cancellation_requested_at timestamp with time zone,
    system_error_cases integer DEFAULT 0 NOT NULL,
    execution_started_at timestamp with time zone,
    evidence_collection_status text DEFAULT 'not_started'::text NOT NULL,
    CONSTRAINT chk_evaluation_run_evidence_collection_status CHECK ((evidence_collection_status = ANY (ARRAY['not_started'::text, 'partial'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT chk_evaluation_run_hash CHECK (((dataset_hash ~ '^[a-f0-9]{64}$'::text) AND (subject_snapshot_hash ~ '^[a-f0-9]{64}$'::text) AND (evaluation_execution_plan_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT chk_evaluation_run_status CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'cancelling'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT chk_evaluation_run_system_error_cases CHECK ((system_error_cases >= 0)),
    CONSTRAINT chk_evaluation_run_trigger CHECK ((trigger_type = ANY (ARRAY['manual'::text, 'publish_gate'::text, 'regression'::text, 'ci'::text])))
);


--
-- Name: evaluation_subject_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_subject_snapshot (
    subject_snapshot_id text NOT NULL,
    subject_snapshot_ref text NOT NULL,
    primary_subject_type text NOT NULL,
    primary_subject_id text NOT NULL,
    primary_subject_version integer NOT NULL,
    primary_subject_hash text NOT NULL,
    candidate_bundle_json jsonb NOT NULL,
    candidate_bundle_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_evaluation_subject_hash CHECK (((primary_subject_hash ~ '^[a-f0-9]{64}$'::text) AND (candidate_bundle_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT chk_evaluation_subject_type CHECK ((primary_subject_type = ANY (ARRAY['prompt'::text, 'agent'::text, 'model_policy'::text])))
);


--
-- Name: evaluation_tool_call_reservation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_tool_call_reservation (
    tenant_id text NOT NULL,
    evaluation_run_id text NOT NULL,
    evaluation_case_id text NOT NULL,
    tool_name text NOT NULL,
    logical_tool_call_id text NOT NULL,
    tool_version text NOT NULL,
    operation text NOT NULL,
    idempotency_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT evaluation_tool_call_reservation_operation_chk CHECK ((operation = ANY (ARRAY['invoke'::text, 'preview'::text, 'commit'::text])))
);


--
-- Name: flow_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_definition (
    id bigint NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    flow_id text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    spec_json jsonb NOT NULL,
    sha256 text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    updated_by text,
    published_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    gray_policy_json jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: flow_definition_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.flow_definition_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: flow_definition_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.flow_definition_id_seq OWNED BY public.flow_definition.id;


--
-- Name: flow_execution_plan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_execution_plan (
    execution_plan_id text NOT NULL,
    execution_plan_ref text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    flow_id text NOT NULL,
    flow_version integer NOT NULL,
    flow_sha256 text NOT NULL,
    plan_json jsonb NOT NULL,
    execution_plan_hash text NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: flow_route_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_route_config (
    id bigint NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    route_id text NOT NULL,
    flow_id text NOT NULL,
    flow_version integer NOT NULL,
    status text NOT NULL,
    route_spec_json jsonb NOT NULL,
    priority integer DEFAULT 50 NOT NULL,
    sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    updated_by text,
    published_by text,
    published_at timestamp with time zone,
    revision integer DEFAULT 1 NOT NULL,
    gray_policy_json jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: flow_route_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.flow_route_config_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: flow_route_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.flow_route_config_id_seq OWNED BY public.flow_route_config.id;


--
-- Name: flow_route_embedding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_route_embedding (
    id bigint NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    route_id text NOT NULL,
    flow_id text NOT NULL,
    flow_version integer NOT NULL,
    embedding public.vector(1536) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    route_config_sha256 text NOT NULL,
    source_type text NOT NULL,
    source_index integer NOT NULL,
    source_text text NOT NULL,
    source_text_hash text NOT NULL,
    embedding_model_id text NOT NULL,
    embedding_model_version integer NOT NULL,
    embedding_model_hash text NOT NULL,
    embedding_dimensions integer NOT NULL,
    embedding_hash text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_flow_route_embedding_dimensions CHECK (((embedding_dimensions = 1536) AND (public.vector_dims(embedding) = 1536))),
    CONSTRAINT chk_flow_route_embedding_source_text_length CHECK (((char_length(source_text) >= 1) AND (char_length(source_text) <= 2000))),
    CONSTRAINT chk_flow_route_embedding_source_type CHECK ((source_type = ANY (ARRAY['keyword'::text, 'example'::text])))
);


--
-- Name: flow_route_embedding_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.flow_route_embedding_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: flow_route_embedding_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.flow_route_embedding_id_seq OWNED BY public.flow_route_embedding.id;


--
-- Name: human_task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.human_task (
    human_task_id text NOT NULL,
    tenant_id text NOT NULL,
    task_run_id text NOT NULL,
    workflow_id text,
    status text NOT NULL,
    assignee text,
    candidate_groups jsonb DEFAULT '[]'::jsonb NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    decision jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    decided_by text,
    decided_at timestamp with time zone,
    decision_reason text,
    kind text DEFAULT 'approval'::text NOT NULL,
    requested_schema_json jsonb,
    response_json jsonb,
    responded_by text,
    responded_at timestamp with time zone,
    response_idempotency_key text
);


--
-- Name: idempotency_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_record (
    idempotency_key text NOT NULL,
    tenant_id text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    request_hash text NOT NULL,
    response_json jsonb,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: model_call_attempt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_call_attempt (
    attempt_id text NOT NULL,
    model_call_id text NOT NULL,
    attempt_index integer NOT NULL,
    target_id text NOT NULL,
    provider text,
    model_id text NOT NULL,
    status text NOT NULL,
    http_status integer,
    error_class text,
    error_code text,
    latency_ms integer,
    response_id text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    global_attempt_index integer NOT NULL,
    target_attempt_index integer NOT NULL,
    fallback_index integer NOT NULL,
    model_version integer,
    model_hash text,
    gateway_profile_id text,
    gateway_profile_config_hash text,
    credential_fingerprint text,
    credential_revision integer,
    upstream_model_id text
);


--
-- Name: model_call_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_call_log (
    model_call_id text NOT NULL,
    model_request_key text NOT NULL,
    tenant_id text NOT NULL,
    user_id text,
    task_run_id text,
    workflow_id text,
    workflow_run_id text,
    agent_run_id text,
    segment_index integer,
    model_turn_index integer,
    model_policy_id text NOT NULL,
    model_policy_version integer NOT NULL,
    model_policy_hash text NOT NULL,
    target_id text,
    provider text,
    model_id text,
    protocol text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    fallback_index integer DEFAULT 0 NOT NULL,
    status text NOT NULL,
    finish_reason text,
    response_id text,
    input_tokens integer,
    output_tokens integer,
    total_tokens integer,
    estimated_cost numeric,
    latency_ms integer,
    error_class text,
    error_code text,
    request_hash text NOT NULL,
    response_hash text,
    safe_response_json jsonb,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    model_version integer,
    model_hash text,
    gateway_profile_id text,
    gateway_profile_config_hash text,
    credential_fingerprint text,
    credential_revision integer,
    upstream_model_id text,
    CONSTRAINT chk_model_call_safe_response_size CHECK (((safe_response_json IS NULL) OR (pg_column_size(safe_response_json) <= 1048576)))
);


--
-- Name: model_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_definition (
    model_id text NOT NULL,
    version integer NOT NULL,
    display_name text NOT NULL,
    gateway_profile_id text NOT NULL,
    gateway_profile_config_hash text NOT NULL,
    upstream_model_id text NOT NULL,
    provider text NOT NULL,
    capabilities_json jsonb NOT NULL,
    context_window integer NOT NULL,
    max_output_tokens integer NOT NULL,
    input_cost_per_million numeric DEFAULT 0 NOT NULL,
    output_cost_per_million numeric DEFAULT 0 NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    tags_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    model_hash text NOT NULL,
    created_by text,
    updated_by text,
    published_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    disabled_at timestamp with time zone,
    embedding_dimensions integer,
    CONSTRAINT chk_model_definition_context_window CHECK ((context_window > 0)),
    CONSTRAINT chk_model_definition_costs CHECK (((input_cost_per_million >= (0)::numeric) AND (output_cost_per_million >= (0)::numeric))),
    CONSTRAINT chk_model_definition_embedding_dimensions CHECK (((embedding_dimensions IS NULL) OR (embedding_dimensions = 1536))),
    CONSTRAINT chk_model_definition_max_output_tokens CHECK ((max_output_tokens > 0)),
    CONSTRAINT chk_model_definition_status CHECK ((status = ANY (ARRAY['draft'::text, 'validated'::text, 'published'::text, 'disabled'::text, 'deprecated'::text])))
);


--
-- Name: model_gateway_profile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_gateway_profile (
    profile_id text NOT NULL,
    display_name text NOT NULL,
    protocol text NOT NULL,
    base_url text NOT NULL,
    auth_type text NOT NULL,
    status text NOT NULL,
    config_hash text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    credential_ciphertext text,
    credential_iv text,
    credential_auth_tag text,
    credential_fingerprint text,
    credential_revision integer DEFAULT 0 NOT NULL,
    created_by text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    disabled_at timestamp with time zone,
    CONSTRAINT chk_model_gateway_profile_auth_type CHECK ((auth_type = ANY (ARRAY['none'::text, 'bearer'::text]))),
    CONSTRAINT chk_model_gateway_profile_bearer_credential CHECK ((((auth_type = 'bearer'::text) AND (credential_ciphertext IS NOT NULL) AND (credential_iv IS NOT NULL) AND (credential_auth_tag IS NOT NULL) AND (credential_fingerprint IS NOT NULL)) OR ((auth_type = 'none'::text) AND (credential_ciphertext IS NULL) AND (credential_iv IS NULL) AND (credential_auth_tag IS NULL) AND (credential_fingerprint IS NULL)))),
    CONSTRAINT chk_model_gateway_profile_protocol CHECK ((protocol = 'openai_chat_completions'::text)),
    CONSTRAINT chk_model_gateway_profile_status CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'disabled'::text])))
);


--
-- Name: model_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_policy (
    id bigint NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    model_policy_id text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    protocol text NOT NULL,
    targets_json jsonb NOT NULL,
    retry_policy_json jsonb NOT NULL,
    fallback_policy_json jsonb NOT NULL,
    request_policy_json jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by text,
    updated_by text,
    published_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone
);


--
-- Name: model_policy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.model_policy_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: model_policy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.model_policy_id_seq OWNED BY public.model_policy.id;


--
-- Name: prompt_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_definition (
    id bigint NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    spec_id text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    spec_json jsonb NOT NULL,
    sha256 text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    updated_by text,
    published_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    gray_policy_json jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: prompt_definition_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prompt_definition_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prompt_definition_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prompt_definition_id_seq OWNED BY public.prompt_definition.id;


--
-- Name: schema_migration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migration (
    version text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_run (
    task_run_id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    route_type text NOT NULL,
    flow_id text,
    flow_version integer,
    workflow_id text,
    status text NOT NULL,
    input_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    route_result_json jsonb,
    workflow_start_json jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    error_code text,
    error_message text,
    execution_plan_ref text,
    tenant_policy_snapshot_ref text,
    tenant_policy_hash text,
    tenant_admission_id text
);


--
-- Name: tenant_agent_admission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_agent_admission (
    admission_id text NOT NULL,
    tenant_id text NOT NULL,
    task_run_id text NOT NULL,
    agent_run_id text,
    workflow_id text,
    workflow_run_id text,
    policy_snapshot_ref text NOT NULL,
    status text NOT NULL,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    released_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    release_reason text,
    revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT chk_tenant_agent_admission_revision CHECK ((revision > 0)),
    CONSTRAINT chk_tenant_agent_admission_status CHECK ((status = ANY (ARRAY['reserved'::text, 'active'::text, 'released'::text, 'rejected'::text, 'orphaned'::text, 'reconciled'::text])))
);


--
-- Name: tenant_runtime_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_runtime_policy (
    id bigint NOT NULL,
    tenant_id text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    allowed_tools_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    denied_tools_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    allowed_models_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    denied_models_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    allowed_handoffs_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    denied_handoffs_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    budget_cap_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    max_concurrent_agent_runs integer NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by text,
    updated_by text,
    published_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT chk_tenant_runtime_policy_concurrency CHECK ((max_concurrent_agent_runs > 0)),
    CONSTRAINT chk_tenant_runtime_policy_revision CHECK ((revision > 0)),
    CONSTRAINT chk_tenant_runtime_policy_status CHECK ((status = ANY (ARRAY['draft'::text, 'validated'::text, 'published'::text, 'deprecated'::text, 'disabled'::text])))
);


--
-- Name: tenant_runtime_policy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tenant_runtime_policy_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tenant_runtime_policy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tenant_runtime_policy_id_seq OWNED BY public.tenant_runtime_policy.id;


--
-- Name: tenant_runtime_policy_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_runtime_policy_snapshot (
    snapshot_id text NOT NULL,
    snapshot_ref text NOT NULL,
    tenant_id text NOT NULL,
    source_policy_version integer NOT NULL,
    source_policy_hash text NOT NULL,
    execution_plan_ref text NOT NULL,
    execution_plan_hash text NOT NULL,
    execution_plan_type text NOT NULL,
    policy_json jsonb NOT NULL,
    resolved_policy_json jsonb NOT NULL,
    snapshot_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    root_snapshot_ref text NOT NULL,
    parent_snapshot_ref text,
    derivation_type text NOT NULL,
    lineage_depth integer NOT NULL,
    CONSTRAINT chk_tenant_runtime_policy_snapshot_derivation_type CHECK ((derivation_type = ANY (ARRAY['root'::text, 'flow_agent_child'::text, 'workflow_handoff'::text, 'nested_handoff'::text]))),
    CONSTRAINT chk_tenant_runtime_policy_snapshot_lineage_depth CHECK (((lineage_depth >= 0) AND (lineage_depth <= 8))),
    CONSTRAINT chk_tenant_runtime_policy_snapshot_root_shape CHECK ((((derivation_type = 'root'::text) AND (parent_snapshot_ref IS NULL) AND (root_snapshot_ref = snapshot_ref) AND (lineage_depth = 0)) OR ((derivation_type <> 'root'::text) AND (parent_snapshot_ref IS NOT NULL) AND (root_snapshot_ref <> snapshot_ref) AND (lineage_depth > 0)))),
    CONSTRAINT chk_tenant_runtime_policy_snapshot_type CHECK ((execution_plan_type = ANY (ARRAY['flow'::text, 'agent'::text])))
);


--
-- Name: tool_call_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_call_log (
    id bigint NOT NULL,
    task_run_id text,
    workflow_id text,
    tenant_id text NOT NULL,
    user_id text,
    tool_name text NOT NULL,
    tool_version text NOT NULL,
    risk_level text NOT NULL,
    policy_decision text NOT NULL,
    status text NOT NULL,
    duration_ms integer,
    idempotency_key text,
    input_hash text,
    output_hash text,
    error_code text,
    adapter_type text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tool_call_id text NOT NULL,
    mode text,
    preview_json jsonb,
    result_json jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_policy_snapshot_ref text,
    policy_decision_code text,
    execution_context_type text,
    evaluation_run_id text,
    evaluation_case_id text,
    evaluation_execution_plan_ref text,
    evaluation_execution_plan_hash text,
    CONSTRAINT chk_tool_call_log_evaluation_plan_hash CHECK (((evaluation_execution_plan_hash IS NULL) OR (evaluation_execution_plan_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT chk_tool_call_log_execution_context_type CHECK (((execution_context_type IS NULL) OR (execution_context_type = ANY (ARRAY['runtime'::text, 'evaluation'::text]))))
);


--
-- Name: tool_call_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tool_call_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tool_call_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tool_call_log_id_seq OWNED BY public.tool_call_log.id;


--
-- Name: tool_manifest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_manifest (
    id bigint NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    spec_id text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    spec_json jsonb NOT NULL,
    sha256 text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    updated_by text,
    published_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    gray_policy_json jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: tool_manifest_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tool_manifest_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tool_manifest_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tool_manifest_id_seq OWNED BY public.tool_manifest.id;


--
-- Name: agent_spec id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_spec ALTER COLUMN id SET DEFAULT nextval('public.agent_spec_id_seq'::regclass);


--
-- Name: flow_definition id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_definition ALTER COLUMN id SET DEFAULT nextval('public.flow_definition_id_seq'::regclass);


--
-- Name: flow_route_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_route_config ALTER COLUMN id SET DEFAULT nextval('public.flow_route_config_id_seq'::regclass);


--
-- Name: flow_route_embedding id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_route_embedding ALTER COLUMN id SET DEFAULT nextval('public.flow_route_embedding_id_seq'::regclass);


--
-- Name: model_policy id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_policy ALTER COLUMN id SET DEFAULT nextval('public.model_policy_id_seq'::regclass);


--
-- Name: prompt_definition id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_definition ALTER COLUMN id SET DEFAULT nextval('public.prompt_definition_id_seq'::regclass);


--
-- Name: tenant_runtime_policy id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_runtime_policy ALTER COLUMN id SET DEFAULT nextval('public.tenant_runtime_policy_id_seq'::regclass);


--
-- Name: tool_call_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_call_log ALTER COLUMN id SET DEFAULT nextval('public.tool_call_log_id_seq'::regclass);


--
-- Name: tool_manifest id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_manifest ALTER COLUMN id SET DEFAULT nextval('public.tool_manifest_id_seq'::regclass);


--
-- Name: agent_context_snapshot agent_context_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_context_snapshot
    ADD CONSTRAINT agent_context_snapshot_pkey PRIMARY KEY (snapshot_id);


--
-- Name: agent_context_snapshot agent_context_snapshot_snapshot_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_context_snapshot
    ADD CONSTRAINT agent_context_snapshot_snapshot_hash_key UNIQUE (snapshot_hash);


--
-- Name: agent_execution_plan agent_execution_plan_execution_plan_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_execution_plan
    ADD CONSTRAINT agent_execution_plan_execution_plan_hash_key UNIQUE (execution_plan_hash);


--
-- Name: agent_execution_plan agent_execution_plan_execution_plan_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_execution_plan
    ADD CONSTRAINT agent_execution_plan_execution_plan_ref_key UNIQUE (execution_plan_ref);


--
-- Name: agent_execution_plan agent_execution_plan_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_execution_plan
    ADD CONSTRAINT agent_execution_plan_pkey PRIMARY KEY (execution_plan_id);


--
-- Name: agent_execution_plan agent_execution_plan_tenant_id_agent_id_agent_version_execu_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_execution_plan
    ADD CONSTRAINT agent_execution_plan_tenant_id_agent_id_agent_version_execu_key UNIQUE (tenant_id, agent_id, agent_version, execution_plan_hash);


--
-- Name: agent_run agent_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run
    ADD CONSTRAINT agent_run_pkey PRIMARY KEY (agent_run_id);


--
-- Name: agent_spec agent_spec_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_spec
    ADD CONSTRAINT agent_spec_pkey PRIMARY KEY (id);


--
-- Name: agent_spec agent_spec_tenant_id_spec_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_spec
    ADD CONSTRAINT agent_spec_tenant_id_spec_id_version_key UNIQUE (tenant_id, spec_id, version);


--
-- Name: agent_step agent_step_agent_run_id_segment_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_step
    ADD CONSTRAINT agent_step_agent_run_id_segment_index_key UNIQUE (agent_run_id, segment_index);


--
-- Name: agent_step agent_step_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_step
    ADD CONSTRAINT agent_step_pkey PRIMARY KEY (agent_step_id);


--
-- Name: agent_step agent_step_stable_step_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_step
    ADD CONSTRAINT agent_step_stable_step_key_key UNIQUE (stable_step_key);


--
-- Name: audit_event audit_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_event
    ADD CONSTRAINT audit_event_pkey PRIMARY KEY (event_id);


--
-- Name: capability_release capability_release_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_release
    ADD CONSTRAINT capability_release_pkey PRIMARY KEY (release_id);


--
-- Name: evaluation_case evaluation_case_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_case
    ADD CONSTRAINT evaluation_case_pkey PRIMARY KEY (dataset_id, dataset_version, case_id);


--
-- Name: evaluation_case_result evaluation_case_result_evaluation_run_id_case_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_case_result
    ADD CONSTRAINT evaluation_case_result_evaluation_run_id_case_id_key UNIQUE (evaluation_run_id, case_id);


--
-- Name: evaluation_case_result evaluation_case_result_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_case_result
    ADD CONSTRAINT evaluation_case_result_pkey PRIMARY KEY (evaluation_case_result_id);


--
-- Name: evaluation_comparison evaluation_comparison_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_comparison
    ADD CONSTRAINT evaluation_comparison_pkey PRIMARY KEY (comparison_id);


--
-- Name: evaluation_dataset evaluation_dataset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_dataset
    ADD CONSTRAINT evaluation_dataset_pkey PRIMARY KEY (dataset_id, version);


--
-- Name: evaluation_execution_plan evaluation_execution_plan_evaluation_execution_plan_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_execution_plan
    ADD CONSTRAINT evaluation_execution_plan_evaluation_execution_plan_ref_key UNIQUE (evaluation_execution_plan_ref);


--
-- Name: evaluation_execution_plan evaluation_execution_plan_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_execution_plan
    ADD CONSTRAINT evaluation_execution_plan_pkey PRIMARY KEY (evaluation_execution_plan_id);


--
-- Name: evaluation_execution_plan evaluation_execution_plan_plan_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_execution_plan
    ADD CONSTRAINT evaluation_execution_plan_plan_hash_key UNIQUE (plan_hash);


--
-- Name: evaluation_gate_decision evaluation_gate_decision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_gate_decision
    ADD CONSTRAINT evaluation_gate_decision_pkey PRIMARY KEY (gate_decision_id);


--
-- Name: evaluation_gate_override evaluation_gate_override_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_gate_override
    ADD CONSTRAINT evaluation_gate_override_pkey PRIMARY KEY (override_id);


--
-- Name: evaluation_gate_policy evaluation_gate_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_gate_policy
    ADD CONSTRAINT evaluation_gate_policy_pkey PRIMARY KEY (gate_policy_id, version);


--
-- Name: evaluation_run evaluation_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_run
    ADD CONSTRAINT evaluation_run_pkey PRIMARY KEY (evaluation_run_id);


--
-- Name: evaluation_subject_snapshot evaluation_subject_snapshot_candidate_bundle_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_subject_snapshot
    ADD CONSTRAINT evaluation_subject_snapshot_candidate_bundle_hash_key UNIQUE (candidate_bundle_hash);


--
-- Name: evaluation_subject_snapshot evaluation_subject_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_subject_snapshot
    ADD CONSTRAINT evaluation_subject_snapshot_pkey PRIMARY KEY (subject_snapshot_id);


--
-- Name: evaluation_subject_snapshot evaluation_subject_snapshot_subject_snapshot_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_subject_snapshot
    ADD CONSTRAINT evaluation_subject_snapshot_subject_snapshot_ref_key UNIQUE (subject_snapshot_ref);


--
-- Name: evaluation_tool_call_reservation evaluation_tool_call_reservation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_tool_call_reservation
    ADD CONSTRAINT evaluation_tool_call_reservation_pkey PRIMARY KEY (tenant_id, evaluation_run_id, evaluation_case_id, tool_name, logical_tool_call_id);


--
-- Name: flow_definition flow_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_definition
    ADD CONSTRAINT flow_definition_pkey PRIMARY KEY (id);


--
-- Name: flow_definition flow_definition_tenant_id_flow_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_definition
    ADD CONSTRAINT flow_definition_tenant_id_flow_id_version_key UNIQUE (tenant_id, flow_id, version);


--
-- Name: flow_execution_plan flow_execution_plan_execution_plan_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_execution_plan
    ADD CONSTRAINT flow_execution_plan_execution_plan_hash_key UNIQUE (execution_plan_hash);


--
-- Name: flow_execution_plan flow_execution_plan_execution_plan_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_execution_plan
    ADD CONSTRAINT flow_execution_plan_execution_plan_ref_key UNIQUE (execution_plan_ref);


--
-- Name: flow_execution_plan flow_execution_plan_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_execution_plan
    ADD CONSTRAINT flow_execution_plan_pkey PRIMARY KEY (execution_plan_id);


--
-- Name: flow_execution_plan flow_execution_plan_tenant_id_flow_id_flow_version_executio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_execution_plan
    ADD CONSTRAINT flow_execution_plan_tenant_id_flow_id_flow_version_executio_key UNIQUE (tenant_id, flow_id, flow_version, execution_plan_hash);


--
-- Name: flow_route_config flow_route_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_route_config
    ADD CONSTRAINT flow_route_config_pkey PRIMARY KEY (id);


--
-- Name: flow_route_config flow_route_config_tenant_id_route_id_flow_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_route_config
    ADD CONSTRAINT flow_route_config_tenant_id_route_id_flow_version_key UNIQUE (tenant_id, route_id, flow_version);


--
-- Name: flow_route_embedding flow_route_embedding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_route_embedding
    ADD CONSTRAINT flow_route_embedding_pkey PRIMARY KEY (id);


--
-- Name: human_task human_task_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.human_task
    ADD CONSTRAINT human_task_pkey PRIMARY KEY (human_task_id);


--
-- Name: idempotency_record idempotency_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_record
    ADD CONSTRAINT idempotency_record_pkey PRIMARY KEY (idempotency_key);


--
-- Name: model_call_attempt model_call_attempt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_call_attempt
    ADD CONSTRAINT model_call_attempt_pkey PRIMARY KEY (attempt_id);


--
-- Name: model_call_log model_call_log_model_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_call_log
    ADD CONSTRAINT model_call_log_model_request_key_key UNIQUE (model_request_key);


--
-- Name: model_call_log model_call_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_call_log
    ADD CONSTRAINT model_call_log_pkey PRIMARY KEY (model_call_id);


--
-- Name: model_definition model_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_definition
    ADD CONSTRAINT model_definition_pkey PRIMARY KEY (model_id, version);


--
-- Name: model_gateway_profile model_gateway_profile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_gateway_profile
    ADD CONSTRAINT model_gateway_profile_pkey PRIMARY KEY (profile_id);


--
-- Name: model_policy model_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_policy
    ADD CONSTRAINT model_policy_pkey PRIMARY KEY (id);


--
-- Name: model_policy model_policy_tenant_id_model_policy_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_policy
    ADD CONSTRAINT model_policy_tenant_id_model_policy_id_version_key UNIQUE (tenant_id, model_policy_id, version);


--
-- Name: prompt_definition prompt_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_definition
    ADD CONSTRAINT prompt_definition_pkey PRIMARY KEY (id);


--
-- Name: prompt_definition prompt_definition_tenant_id_spec_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_definition
    ADD CONSTRAINT prompt_definition_tenant_id_spec_id_version_key UNIQUE (tenant_id, spec_id, version);


--
-- Name: schema_migration schema_migration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migration
    ADD CONSTRAINT schema_migration_pkey PRIMARY KEY (version);


--
-- Name: task_run task_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_run
    ADD CONSTRAINT task_run_pkey PRIMARY KEY (task_run_id);


--
-- Name: tenant_agent_admission tenant_agent_admission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_agent_admission
    ADD CONSTRAINT tenant_agent_admission_pkey PRIMARY KEY (admission_id);


--
-- Name: tenant_agent_admission tenant_agent_admission_task_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_agent_admission
    ADD CONSTRAINT tenant_agent_admission_task_run_id_key UNIQUE (task_run_id);


--
-- Name: tenant_runtime_policy tenant_runtime_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_runtime_policy
    ADD CONSTRAINT tenant_runtime_policy_pkey PRIMARY KEY (id);


--
-- Name: tenant_runtime_policy_snapshot tenant_runtime_policy_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_runtime_policy_snapshot
    ADD CONSTRAINT tenant_runtime_policy_snapshot_pkey PRIMARY KEY (snapshot_id);


--
-- Name: tenant_runtime_policy_snapshot tenant_runtime_policy_snapshot_snapshot_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_runtime_policy_snapshot
    ADD CONSTRAINT tenant_runtime_policy_snapshot_snapshot_ref_key UNIQUE (snapshot_ref);


--
-- Name: tenant_runtime_policy tenant_runtime_policy_tenant_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_runtime_policy
    ADD CONSTRAINT tenant_runtime_policy_tenant_id_version_key UNIQUE (tenant_id, version);


--
-- Name: tool_call_log tool_call_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_call_log
    ADD CONSTRAINT tool_call_log_pkey PRIMARY KEY (id);


--
-- Name: tool_manifest tool_manifest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_manifest
    ADD CONSTRAINT tool_manifest_pkey PRIMARY KEY (id);


--
-- Name: tool_manifest tool_manifest_tenant_id_spec_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_manifest
    ADD CONSTRAINT tool_manifest_tenant_id_spec_id_version_key UNIQUE (tenant_id, spec_id, version);


--
-- Name: idx_agent_context_snapshot_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_context_snapshot_run ON public.agent_context_snapshot USING btree (agent_run_id, created_at DESC);


--
-- Name: idx_agent_execution_plan_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_execution_plan_agent ON public.agent_execution_plan USING btree (tenant_id, agent_id, agent_version, generated_at DESC);


--
-- Name: idx_agent_run_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_run_task ON public.agent_run USING btree (tenant_id, task_run_id, created_at DESC);


--
-- Name: idx_agent_run_tenant_policy_snapshot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_run_tenant_policy_snapshot ON public.agent_run USING btree (tenant_id, tenant_policy_snapshot_ref);


--
-- Name: idx_agent_run_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_run_tenant_status ON public.agent_run USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_agent_spec_lifecycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_spec_lifecycle ON public.agent_spec USING btree (tenant_id, spec_id, status, version DESC);


--
-- Name: idx_agent_step_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_step_run ON public.agent_step USING btree (agent_run_id, segment_index);


--
-- Name: idx_audit_event_event_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_audit_event_event_key ON public.audit_event USING btree (event_key) WHERE (event_key IS NOT NULL);


--
-- Name: idx_audit_event_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_event_target ON public.audit_event USING btree (tenant_id, target_type, target_id, occurred_at DESC);


--
-- Name: idx_audit_event_tenant_action_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_event_tenant_action_time ON public.audit_event USING btree (tenant_id, action, occurred_at DESC);


--
-- Name: idx_capability_release_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_capability_release_action ON public.capability_release USING btree (tenant_id, action, created_at DESC);


--
-- Name: idx_capability_release_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_capability_release_resource ON public.capability_release USING btree (tenant_id, resource_type, resource_id, created_at DESC);


--
-- Name: idx_eval_tool_call_reservation_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eval_tool_call_reservation_scope ON public.evaluation_tool_call_reservation USING btree (tenant_id, evaluation_run_id, evaluation_case_id, tool_name, created_at);


--
-- Name: idx_evaluation_case_case_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_evaluation_case_case_id_unique ON public.evaluation_case USING btree (case_id);


--
-- Name: idx_evaluation_case_dataset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_case_dataset ON public.evaluation_case USING btree (dataset_id, dataset_version, enabled, case_id);


--
-- Name: idx_evaluation_case_result_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_case_result_run ON public.evaluation_case_result USING btree (evaluation_run_id, status, case_id);


--
-- Name: idx_evaluation_case_result_workflow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_case_result_workflow ON public.evaluation_case_result USING btree (workflow_id);


--
-- Name: idx_evaluation_comparison_runs; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_evaluation_comparison_runs ON public.evaluation_comparison USING btree (candidate_run_id, baseline_run_id);


--
-- Name: idx_evaluation_dataset_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_dataset_status ON public.evaluation_dataset USING btree (status, updated_at DESC);


--
-- Name: idx_evaluation_execution_plan_dataset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_execution_plan_dataset ON public.evaluation_execution_plan USING btree (tenant_id, dataset_id, dataset_version, created_at DESC);


--
-- Name: idx_evaluation_execution_plan_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_execution_plan_subject ON public.evaluation_execution_plan USING btree (subject_snapshot_ref, created_at DESC);


--
-- Name: idx_evaluation_gate_decision_exact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_evaluation_gate_decision_exact ON public.evaluation_gate_decision USING btree (resource_type, resource_id, resource_version, resource_hash, candidate_bundle_hash, gate_policy_id, gate_policy_version, gate_policy_hash);


--
-- Name: idx_evaluation_gate_decision_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_gate_decision_resource ON public.evaluation_gate_decision USING btree (resource_type, resource_id, resource_version, decided_at DESC);


--
-- Name: idx_evaluation_gate_override_decision; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_gate_override_decision ON public.evaluation_gate_override USING btree (gate_decision_id, created_at DESC);


--
-- Name: idx_evaluation_gate_override_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_gate_override_resource ON public.evaluation_gate_override USING btree (resource_type, resource_id, resource_version, resource_hash, created_at DESC);


--
-- Name: idx_evaluation_gate_policy_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_gate_policy_status ON public.evaluation_gate_policy USING btree (status, updated_at DESC);


--
-- Name: idx_evaluation_run_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_run_subject ON public.evaluation_run USING btree (tenant_id, subject_snapshot_ref, created_at DESC);


--
-- Name: idx_evaluation_run_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_run_tenant_status ON public.evaluation_run USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_evaluation_run_workflow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_run_workflow ON public.evaluation_run USING btree (workflow_id);


--
-- Name: idx_evaluation_subject_snapshot_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evaluation_subject_snapshot_resource ON public.evaluation_subject_snapshot USING btree (primary_subject_type, primary_subject_id, primary_subject_version, primary_subject_hash);


--
-- Name: idx_flow_definition_lifecycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_definition_lifecycle ON public.flow_definition USING btree (tenant_id, flow_id, status, version DESC);


--
-- Name: idx_flow_definition_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_definition_status ON public.flow_definition USING btree (tenant_id, status, flow_id, version);


--
-- Name: idx_flow_execution_plan_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_execution_plan_flow ON public.flow_execution_plan USING btree (tenant_id, flow_id, flow_version, generated_at DESC);


--
-- Name: idx_flow_route_config_lifecycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_route_config_lifecycle ON public.flow_route_config USING btree (tenant_id, route_id, status, flow_version DESC);


--
-- Name: idx_flow_route_config_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_route_config_lookup ON public.flow_route_config USING btree (tenant_id, status, priority DESC);


--
-- Name: idx_flow_route_embedding_cosine; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_route_embedding_cosine ON public.flow_route_embedding USING ivfflat (embedding public.vector_cosine_ops) WITH (lists='100');


--
-- Name: idx_flow_route_embedding_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_route_embedding_flow ON public.flow_route_embedding USING btree (tenant_id, flow_id, flow_version);


--
-- Name: idx_flow_route_embedding_route_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_route_embedding_route_model ON public.flow_route_embedding USING btree (tenant_id, route_id, flow_version, embedding_model_id, embedding_model_version, embedding_model_hash);


--
-- Name: idx_human_task_payload_tool_call_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_human_task_payload_tool_call_id ON public.human_task USING btree (((payload ->> 'tool_call_id'::text)));


--
-- Name: idx_human_task_response_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_human_task_response_idempotency ON public.human_task USING btree (tenant_id, human_task_id, response_idempotency_key) WHERE (response_idempotency_key IS NOT NULL);


--
-- Name: idx_human_task_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_human_task_status ON public.human_task USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_human_task_task_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_human_task_task_run ON public.human_task USING btree (tenant_id, task_run_id, created_at DESC);


--
-- Name: idx_model_call_attempt_call; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_call_attempt_call ON public.model_call_attempt USING btree (model_call_id, global_attempt_index);


--
-- Name: idx_model_call_attempt_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_model_call_attempt_global ON public.model_call_attempt USING btree (model_call_id, global_attempt_index);


--
-- Name: idx_model_call_attempt_global_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_model_call_attempt_global_unique ON public.model_call_attempt USING btree (model_call_id, global_attempt_index);


--
-- Name: idx_model_call_log_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_call_log_agent ON public.model_call_log USING btree (tenant_id, agent_run_id, segment_index, model_turn_index);


--
-- Name: idx_model_call_log_gateway_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_call_log_gateway_model ON public.model_call_log USING btree (tenant_id, gateway_profile_id, model_id, model_version, status, created_at DESC);


--
-- Name: idx_model_call_log_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_call_log_model ON public.model_call_log USING btree (tenant_id, provider, model_id, status, created_at DESC);


--
-- Name: idx_model_call_log_policy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_call_log_policy ON public.model_call_log USING btree (tenant_id, model_policy_id, model_policy_version, created_at DESC);


--
-- Name: idx_model_call_log_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_call_log_task ON public.model_call_log USING btree (tenant_id, task_run_id, created_at DESC);


--
-- Name: idx_model_definition_gateway; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_definition_gateway ON public.model_definition USING btree (gateway_profile_id, status, updated_at DESC);


--
-- Name: idx_model_definition_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_definition_status ON public.model_definition USING btree (status, updated_at DESC);


--
-- Name: idx_model_gateway_profile_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_gateway_profile_status ON public.model_gateway_profile USING btree (status, updated_at DESC);


--
-- Name: idx_model_policy_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_policy_id ON public.model_policy USING btree (tenant_id, model_policy_id, version DESC);


--
-- Name: idx_model_policy_one_published; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_model_policy_one_published ON public.model_policy USING btree (tenant_id, model_policy_id) WHERE (status = 'published'::text);


--
-- Name: idx_model_policy_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_policy_status ON public.model_policy USING btree (tenant_id, status, updated_at DESC);


--
-- Name: idx_prompt_definition_lifecycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prompt_definition_lifecycle ON public.prompt_definition USING btree (tenant_id, spec_id, status, version DESC);


--
-- Name: idx_task_run_execution_plan_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_run_execution_plan_ref ON public.task_run USING btree (tenant_id, execution_plan_ref);


--
-- Name: idx_task_run_tenant_policy_snapshot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_run_tenant_policy_snapshot ON public.task_run USING btree (tenant_id, tenant_policy_snapshot_ref);


--
-- Name: idx_task_run_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_run_tenant_status ON public.task_run USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_tenant_agent_admission_acquired; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_agent_admission_acquired ON public.tenant_agent_admission USING btree (tenant_id, acquired_at DESC);


--
-- Name: idx_tenant_agent_admission_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_agent_admission_active ON public.tenant_agent_admission USING btree (tenant_id, status, updated_at DESC) WHERE (status = ANY (ARRAY['reserved'::text, 'active'::text]));


--
-- Name: idx_tenant_agent_admission_snapshot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_agent_admission_snapshot ON public.tenant_agent_admission USING btree (tenant_id, policy_snapshot_ref);


--
-- Name: idx_tenant_agent_admission_workflow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_agent_admission_workflow ON public.tenant_agent_admission USING btree (tenant_id, workflow_id);


--
-- Name: idx_tenant_runtime_policy_one_published; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenant_runtime_policy_one_published ON public.tenant_runtime_policy USING btree (tenant_id) WHERE (status = 'published'::text);


--
-- Name: idx_tenant_runtime_policy_snapshot_derivation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_runtime_policy_snapshot_derivation ON public.tenant_runtime_policy_snapshot USING btree (tenant_id, derivation_type, created_at DESC);


--
-- Name: idx_tenant_runtime_policy_snapshot_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenant_runtime_policy_snapshot_hash ON public.tenant_runtime_policy_snapshot USING btree (tenant_id, snapshot_hash);


--
-- Name: idx_tenant_runtime_policy_snapshot_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_runtime_policy_snapshot_parent ON public.tenant_runtime_policy_snapshot USING btree (tenant_id, parent_snapshot_ref);


--
-- Name: idx_tenant_runtime_policy_snapshot_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_runtime_policy_snapshot_plan ON public.tenant_runtime_policy_snapshot USING btree (tenant_id, execution_plan_ref);


--
-- Name: idx_tenant_runtime_policy_snapshot_root; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_runtime_policy_snapshot_root ON public.tenant_runtime_policy_snapshot USING btree (tenant_id, root_snapshot_ref, lineage_depth);


--
-- Name: idx_tenant_runtime_policy_snapshot_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_runtime_policy_snapshot_tenant ON public.tenant_runtime_policy_snapshot USING btree (tenant_id, created_at DESC);


--
-- Name: idx_tenant_runtime_policy_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_runtime_policy_status ON public.tenant_runtime_policy USING btree (tenant_id, status, version DESC);


--
-- Name: idx_tool_call_log_evaluation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_call_log_evaluation ON public.tool_call_log USING btree (evaluation_run_id, evaluation_case_id, created_at);


--
-- Name: idx_tool_call_log_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_call_log_task ON public.tool_call_log USING btree (tenant_id, task_run_id, created_at DESC);


--
-- Name: idx_tool_call_log_tenant_policy_snapshot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_call_log_tenant_policy_snapshot ON public.tool_call_log USING btree (tenant_id, tenant_policy_snapshot_ref);


--
-- Name: idx_tool_call_log_tool_call_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tool_call_log_tool_call_id ON public.tool_call_log USING btree (tool_call_id);


--
-- Name: idx_tool_manifest_lifecycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_manifest_lifecycle ON public.tool_manifest USING btree (tenant_id, spec_id, status, version DESC);


--
-- Name: uq_flow_route_embedding_exact_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_flow_route_embedding_exact_source ON public.flow_route_embedding USING btree (tenant_id, route_id, flow_version, route_config_sha256, embedding_model_id, embedding_model_version, embedding_model_hash, source_type, source_index);


--
-- Name: agent_context_snapshot trg_agent_context_snapshot_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_agent_context_snapshot_immutable BEFORE UPDATE ON public.agent_context_snapshot FOR EACH ROW EXECUTE FUNCTION public.prevent_agent_context_snapshot_mutation();


--
-- Name: agent_execution_plan trg_agent_execution_plan_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_agent_execution_plan_immutable BEFORE UPDATE ON public.agent_execution_plan FOR EACH ROW EXECUTE FUNCTION public.prevent_agent_execution_plan_mutation();


--
-- Name: evaluation_case trg_evaluation_case_published_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_evaluation_case_published_immutable BEFORE DELETE OR UPDATE ON public.evaluation_case FOR EACH ROW EXECUTE FUNCTION public.prevent_published_evaluation_case_mutation();


--
-- Name: evaluation_execution_plan trg_evaluation_execution_plan_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_evaluation_execution_plan_immutable BEFORE DELETE OR UPDATE ON public.evaluation_execution_plan FOR EACH ROW EXECUTE FUNCTION public.prevent_evaluation_execution_plan_mutation();


--
-- Name: evaluation_gate_decision trg_evaluation_gate_decision_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_evaluation_gate_decision_immutable BEFORE DELETE OR UPDATE ON public.evaluation_gate_decision FOR EACH ROW EXECUTE FUNCTION public.prevent_evaluation_gate_decision_mutation();


--
-- Name: evaluation_subject_snapshot trg_evaluation_subject_snapshot_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_evaluation_subject_snapshot_immutable BEFORE DELETE OR UPDATE ON public.evaluation_subject_snapshot FOR EACH ROW EXECUTE FUNCTION public.prevent_evaluation_subject_snapshot_mutation();


--
-- Name: model_definition trg_model_definition_published_content_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_model_definition_published_content_immutable BEFORE UPDATE ON public.model_definition FOR EACH ROW EXECUTE FUNCTION public.prevent_published_model_definition_content_mutation();


--
-- Name: model_gateway_profile trg_model_gateway_profile_published_public_config_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_model_gateway_profile_published_public_config_immutable BEFORE UPDATE ON public.model_gateway_profile FOR EACH ROW EXECUTE FUNCTION public.prevent_published_model_gateway_profile_public_config_mutation();


--
-- Name: model_policy trg_model_policy_published_content_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_model_policy_published_content_immutable BEFORE UPDATE ON public.model_policy FOR EACH ROW EXECUTE FUNCTION public.prevent_published_model_policy_content_mutation();


--
-- Name: tenant_runtime_policy trg_tenant_runtime_policy_immutable_content; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tenant_runtime_policy_immutable_content BEFORE UPDATE ON public.tenant_runtime_policy FOR EACH ROW EXECUTE FUNCTION public.prevent_published_tenant_runtime_policy_mutation();


--
-- Name: tenant_runtime_policy_snapshot trg_tenant_runtime_policy_snapshot_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tenant_runtime_policy_snapshot_immutable BEFORE UPDATE ON public.tenant_runtime_policy_snapshot FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_runtime_policy_snapshot_mutation();


--
-- Name: agent_context_snapshot agent_context_snapshot_agent_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_context_snapshot
    ADD CONSTRAINT agent_context_snapshot_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES public.agent_run(agent_run_id) ON DELETE CASCADE;


--
-- Name: agent_context_snapshot agent_context_snapshot_previous_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_context_snapshot
    ADD CONSTRAINT agent_context_snapshot_previous_snapshot_id_fkey FOREIGN KEY (previous_snapshot_id) REFERENCES public.agent_context_snapshot(snapshot_id);


--
-- Name: agent_step agent_step_agent_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_step
    ADD CONSTRAINT agent_step_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES public.agent_run(agent_run_id) ON DELETE CASCADE;


--
-- Name: evaluation_case_result evaluation_case_result_evaluation_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_case_result
    ADD CONSTRAINT evaluation_case_result_evaluation_run_id_fkey FOREIGN KEY (evaluation_run_id) REFERENCES public.evaluation_run(evaluation_run_id) ON DELETE CASCADE;


--
-- Name: evaluation_comparison evaluation_comparison_baseline_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_comparison
    ADD CONSTRAINT evaluation_comparison_baseline_run_id_fkey FOREIGN KEY (baseline_run_id) REFERENCES public.evaluation_run(evaluation_run_id) ON DELETE CASCADE;


--
-- Name: evaluation_comparison evaluation_comparison_candidate_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_comparison
    ADD CONSTRAINT evaluation_comparison_candidate_run_id_fkey FOREIGN KEY (candidate_run_id) REFERENCES public.evaluation_run(evaluation_run_id) ON DELETE CASCADE;


--
-- Name: evaluation_gate_override evaluation_gate_override_gate_decision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_gate_override
    ADD CONSTRAINT evaluation_gate_override_gate_decision_id_fkey FOREIGN KEY (gate_decision_id) REFERENCES public.evaluation_gate_decision(gate_decision_id);


--
-- Name: evaluation_case fk_evaluation_case_dataset; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_case
    ADD CONSTRAINT fk_evaluation_case_dataset FOREIGN KEY (dataset_id, dataset_version) REFERENCES public.evaluation_dataset(dataset_id, version) ON DELETE CASCADE;


--
-- Name: evaluation_gate_decision fk_evaluation_gate_decision_policy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_gate_decision
    ADD CONSTRAINT fk_evaluation_gate_decision_policy FOREIGN KEY (gate_policy_id, gate_policy_version) REFERENCES public.evaluation_gate_policy(gate_policy_id, version);


--
-- Name: evaluation_execution_plan fk_evaluation_plan_dataset; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_execution_plan
    ADD CONSTRAINT fk_evaluation_plan_dataset FOREIGN KEY (dataset_id, dataset_version) REFERENCES public.evaluation_dataset(dataset_id, version);


--
-- Name: evaluation_run fk_evaluation_run_plan; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_run
    ADD CONSTRAINT fk_evaluation_run_plan FOREIGN KEY (evaluation_execution_plan_ref) REFERENCES public.evaluation_execution_plan(evaluation_execution_plan_ref);


--
-- Name: model_call_attempt model_call_attempt_model_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_call_attempt
    ADD CONSTRAINT model_call_attempt_model_call_id_fkey FOREIGN KEY (model_call_id) REFERENCES public.model_call_log(model_call_id) ON DELETE CASCADE;


--
-- Name: model_definition model_definition_gateway_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_definition
    ADD CONSTRAINT model_definition_gateway_profile_id_fkey FOREIGN KEY (gateway_profile_id) REFERENCES public.model_gateway_profile(profile_id);


--
-- PostgreSQL database dump complete
--


