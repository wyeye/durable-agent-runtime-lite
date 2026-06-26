-- Conversation MVP: persistent multi-turn chat conversations and messages.
-- This migration is additive and targets a clean rebuildable development/test schema.

-- =========================================================================
-- conversation
-- =========================================================================

CREATE TABLE public.conversation (
  conversation_id  TEXT        NOT NULL PRIMARY KEY,
  tenant_id        TEXT        NOT NULL,
  owner_user_id    TEXT        NOT NULL,
  title            TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'active',
  revision         INTEGER     NOT NULL DEFAULT 1,
  next_sequence_no INTEGER     NOT NULL DEFAULT 1,
  last_message_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at      TIMESTAMPTZ,

  CONSTRAINT fk_conversation_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenant (tenant_id),
  CONSTRAINT fk_conversation_owner
    FOREIGN KEY (owner_user_id) REFERENCES public.user_account (user_id),
  CONSTRAINT conversation_status_check
    CHECK (status IN ('active', 'archived')),
  CONSTRAINT conversation_revision_positive
    CHECK (revision > 0),
  CONSTRAINT conversation_next_sequence_positive
    CHECK (next_sequence_no > 0),
  CONSTRAINT conversation_title_not_empty
    CHECK (char_length(title) > 0),
  CONSTRAINT conversation_title_max_length
    CHECK (char_length(title) <= 100),
  CONSTRAINT conversation_archive_state_check
    CHECK (
      (status = 'archived' AND archived_at IS NOT NULL)
      OR (status = 'active' AND archived_at IS NULL)
    )
);

CREATE INDEX idx_conversation_tenant_owner_status_last_message
  ON public.conversation (tenant_id, owner_user_id, status, last_message_at DESC NULLS LAST, created_at DESC);

CREATE INDEX idx_conversation_owner_status_updated
  ON public.conversation (owner_user_id, status, updated_at DESC);

-- =========================================================================
-- conversation_message
-- =========================================================================

CREATE TABLE public.conversation_message (
  message_id                 TEXT        NOT NULL PRIMARY KEY,
  conversation_id            TEXT        NOT NULL,
  tenant_id                  TEXT        NOT NULL,
  sequence_no                INTEGER     NOT NULL,
  role                       TEXT        NOT NULL,
  status                     TEXT        NOT NULL,
  content_text               TEXT,
  client_message_id          TEXT,
  reply_to_message_id        TEXT,
  task_run_id                TEXT,
  agent_run_id               TEXT,
  context_message_ids_json   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  context_hash               TEXT,
  error_code                 TEXT,
  error_message_key          TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at               TIMESTAMPTZ,

  CONSTRAINT fk_conversation_message_conversation
    FOREIGN KEY (conversation_id) REFERENCES public.conversation (conversation_id),
  CONSTRAINT fk_conversation_message_task_run
    FOREIGN KEY (task_run_id) REFERENCES public.task_run (task_run_id),
  CONSTRAINT fk_conversation_message_agent_run
    FOREIGN KEY (agent_run_id) REFERENCES public.agent_run (agent_run_id),
  CONSTRAINT fk_conversation_message_reply
    FOREIGN KEY (reply_to_message_id) REFERENCES public.conversation_message (message_id),
  CONSTRAINT conversation_message_role_check
    CHECK (role IN ('user', 'assistant')),
  CONSTRAINT conversation_message_status_check
    CHECK (status IN ('queued', 'running', 'waiting_human', 'waiting_user', 'completed', 'failed', 'cancelled')),
  CONSTRAINT conversation_message_sequence_positive
    CHECK (sequence_no > 0),
  CONSTRAINT conversation_message_content_length
    CHECK (content_text IS NULL OR char_length(content_text) <= 16000),
  CONSTRAINT conversation_message_context_message_ids_is_array
    CHECK (jsonb_typeof(context_message_ids_json) = 'array'),
  CONSTRAINT conversation_message_user_shape_check
    CHECK (
      role <> 'user'
      OR (
        status = 'completed'
        AND client_message_id IS NOT NULL
        AND reply_to_message_id IS NULL
        AND content_text IS NOT NULL
        AND completed_at IS NOT NULL
      )
    ),
  CONSTRAINT conversation_message_assistant_shape_check
    CHECK (
      role <> 'assistant'
      OR (
        reply_to_message_id IS NOT NULL
        AND (
          (status IN ('queued', 'running', 'waiting_human', 'waiting_user') AND completed_at IS NULL)
          OR (status = 'completed' AND content_text IS NOT NULL AND completed_at IS NOT NULL)
          OR (status IN ('failed', 'cancelled') AND completed_at IS NOT NULL)
        )
      )
    )
);

CREATE UNIQUE INDEX idx_conversation_message_sequence
  ON public.conversation_message (conversation_id, sequence_no);

CREATE UNIQUE INDEX idx_conversation_user_client_message_id
  ON public.conversation_message (conversation_id, client_message_id)
  WHERE role = 'user' AND client_message_id IS NOT NULL;

CREATE UNIQUE INDEX idx_conversation_single_in_flight_turn
  ON public.conversation_message (conversation_id)
  WHERE role = 'assistant' AND status IN ('queued', 'running', 'waiting_human', 'waiting_user');

CREATE INDEX idx_conversation_message_conversation_created
  ON public.conversation_message (conversation_id, created_at ASC, sequence_no ASC);

CREATE INDEX idx_conversation_message_conversation_status
  ON public.conversation_message (conversation_id, status, sequence_no DESC);

CREATE INDEX idx_conversation_message_task_run
  ON public.conversation_message (task_run_id)
  WHERE task_run_id IS NOT NULL;

CREATE INDEX idx_conversation_message_agent_run
  ON public.conversation_message (agent_run_id)
  WHERE agent_run_id IS NOT NULL;

-- =========================================================================
-- task_run chat linkage
-- =========================================================================

ALTER TABLE public.task_run
  ADD COLUMN conversation_id TEXT,
  ADD COLUMN user_message_id TEXT,
  ADD COLUMN assistant_message_id TEXT;

ALTER TABLE public.task_run
  ADD CONSTRAINT fk_task_run_conversation
    FOREIGN KEY (conversation_id) REFERENCES public.conversation (conversation_id),
  ADD CONSTRAINT fk_task_run_user_message
    FOREIGN KEY (user_message_id) REFERENCES public.conversation_message (message_id),
  ADD CONSTRAINT fk_task_run_assistant_message
    FOREIGN KEY (assistant_message_id) REFERENCES public.conversation_message (message_id),
  ADD CONSTRAINT task_run_chat_linkage_check
    CHECK (
      (conversation_id IS NULL AND user_message_id IS NULL AND assistant_message_id IS NULL)
      OR (conversation_id IS NOT NULL AND user_message_id IS NOT NULL AND assistant_message_id IS NOT NULL)
    );

CREATE INDEX idx_task_run_tenant_conversation
  ON public.task_run (tenant_id, conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX idx_task_run_tenant_user_conversation
  ON public.task_run (tenant_id, user_id, conversation_id)
  WHERE conversation_id IS NOT NULL;
