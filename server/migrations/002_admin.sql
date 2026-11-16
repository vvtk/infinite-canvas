ALTER TABLE canvas_users ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE canvas_users ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE canvas_users ADD COLUMN IF NOT EXISTS storage_bytes bigint CHECK (storage_bytes > 0);
ALTER TABLE canvas_users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE canvas_users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE canvas_users ADD COLUMN IF NOT EXISTS profile_updated_at timestamptz;
CREATE TABLE IF NOT EXISTS canvas_site_settings (id boolean PRIMARY KEY DEFAULT true CHECK (id), data jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS canvas_prompt_sources (
    id text PRIMARY KEY, name text NOT NULL, url text NOT NULL, homepage text NOT NULL DEFAULT '',
    enabled boolean NOT NULL DEFAULT true, deleted boolean NOT NULL DEFAULT false,
    last_success_at timestamptz, last_attempt_at timestamptz, last_error text NOT NULL DEFAULT '',
    revision bigint NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS canvas_library (
    id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('prompts','tutorials','skills','assets')),
    data jsonb NOT NULL DEFAULT '{}', published boolean NOT NULL DEFAULT false, position double precision NOT NULL DEFAULT 0,
    source_id text REFERENCES canvas_prompt_sources(id), remote_id text, remote_data jsonb NOT NULL DEFAULT '{}',
    remote_present boolean NOT NULL DEFAULT true, deleted boolean NOT NULL DEFAULT false,
    revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(source_id, remote_id)
);
CREATE INDEX IF NOT EXISTS canvas_library_kind ON canvas_library(kind, deleted, published);
CREATE TABLE IF NOT EXISTS canvas_public_media (
    id text PRIMARY KEY, object_key text NOT NULL UNIQUE, bytes bigint NOT NULL CHECK (bytes > 0),
    mime_type text NOT NULL, sha256 text NOT NULL, ready boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS canvas_ai_requests (
    user_id text NOT NULL REFERENCES canvas_users(id), id text NOT NULL, data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,id)
);
CREATE INDEX IF NOT EXISTS canvas_ai_request_time ON canvas_ai_requests(created_at DESC);
CREATE TABLE IF NOT EXISTS canvas_admin_audit (
    id bigserial PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL, target text NOT NULL,
    summary jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
