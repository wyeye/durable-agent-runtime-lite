-- IAM Directory: tenant, user_account, tenant_membership tables.
-- This migration is additive; it does not modify 001_baseline.sql.

-- =========================================================================
-- tenant
-- =========================================================================

CREATE TABLE public.tenant (
  tenant_id    TEXT        NOT NULL PRIMARY KEY,
  display_name TEXT        NOT NULL,
  description  TEXT        NOT NULL DEFAULT '',
  status       TEXT        NOT NULL DEFAULT 'active',
  revision     INTEGER     NOT NULL DEFAULT 1,
  created_by   TEXT,
  updated_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at  TIMESTAMPTZ,

  CONSTRAINT tenant_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT tenant_revision_positive CHECK (revision > 0),
  CONSTRAINT tenant_display_name_not_empty CHECK (char_length(display_name) > 0),
  CONSTRAINT tenant_description_max_length CHECK (char_length(description) <= 2000)
);

CREATE INDEX idx_tenant_status ON public.tenant (status);

-- =========================================================================
-- user_account
-- =========================================================================

CREATE TABLE public.user_account (
  user_id         TEXT        NOT NULL PRIMARY KEY,
  display_name    TEXT        NOT NULL,
  email           TEXT,
  status          TEXT        NOT NULL DEFAULT 'active',
  platform_roles  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  revision        INTEGER     NOT NULL DEFAULT 1,
  created_by      TEXT,
  updated_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at     TIMESTAMPTZ,

  CONSTRAINT user_account_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT user_account_revision_positive CHECK (revision > 0),
  CONSTRAINT user_account_display_name_not_empty CHECK (char_length(display_name) > 0),
  CONSTRAINT user_account_platform_roles_valid CHECK (
    platform_roles <@ '["platform_admin"]'::jsonb
  )
);

-- Case-insensitive unique email index (partial: only when email is not null)
CREATE UNIQUE INDEX idx_user_account_email_unique
  ON public.user_account (lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX idx_user_account_status ON public.user_account (status);

-- =========================================================================
-- tenant_membership
-- =========================================================================

CREATE TABLE public.tenant_membership (
  tenant_id   TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  roles       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT        NOT NULL DEFAULT 'active',
  revision    INTEGER     NOT NULL DEFAULT 1,
  created_by  TEXT,
  updated_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ,

  PRIMARY KEY (tenant_id, user_id),

  CONSTRAINT tenant_membership_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT tenant_membership_revision_positive CHECK (revision > 0),
  CONSTRAINT tenant_membership_roles_valid CHECK (
    roles <@ '["capability_operator", "auditor"]'::jsonb
  ),
  CONSTRAINT fk_membership_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenant (tenant_id),
  CONSTRAINT fk_membership_user
    FOREIGN KEY (user_id) REFERENCES public.user_account (user_id)
);

CREATE INDEX idx_membership_user_status
  ON public.tenant_membership (user_id, status);

CREATE INDEX idx_membership_tenant_status
  ON public.tenant_membership (tenant_id, status);
