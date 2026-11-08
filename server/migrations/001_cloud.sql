CREATE TABLE IF NOT EXISTS canvas_users (
    id text PRIMARY KEY, profile jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS canvas_oauth_flows (
    state_hash text PRIMARY KEY, verifier text NOT NULL, return_path text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS canvas_sessions (
    id_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES canvas_users(id), credentials text NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS canvas_records (
    user_id text NOT NULL REFERENCES canvas_users(id), domain text NOT NULL, id text NOT NULL,
    revision bigint NOT NULL, deleted boolean NOT NULL, data jsonb, media jsonb NOT NULL,
    PRIMARY KEY (user_id, domain, id)
);
CREATE INDEX IF NOT EXISTS canvas_record_changes ON canvas_records(user_id, revision);
CREATE TABLE IF NOT EXISTS canvas_media (
    id text PRIMARY KEY, user_id text NOT NULL REFERENCES canvas_users(id), storage_key text NOT NULL,
    object_key text NOT NULL UNIQUE, bytes bigint NOT NULL CHECK (bytes > 0), mime_type text NOT NULL,
    sha256 text NOT NULL, ready boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL,
    UNIQUE(user_id, storage_key)
);
