CREATE TABLE IF NOT EXISTS canvas_storage_pools (
    id text PRIMARY KEY, name text NOT NULL, provider text NOT NULL CHECK (provider IN ('s3','oss')),
    endpoint text NOT NULL, public_endpoint text NOT NULL, region text NOT NULL, bucket text NOT NULL,
    prefix text NOT NULL DEFAULT '', path_style boolean NOT NULL DEFAULT true, writable boolean NOT NULL DEFAULT true,
    credentials text NOT NULL, revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS canvas_storage_policy (
    id boolean PRIMARY KEY DEFAULT true CHECK (id), mode text NOT NULL DEFAULT 'single' CHECK (mode IN ('single','round-robin')),
    default_pool_id text REFERENCES canvas_storage_pools(id), cursor bigint NOT NULL DEFAULT 0,
    initialized boolean NOT NULL DEFAULT false, revision bigint NOT NULL DEFAULT 1
);
INSERT INTO canvas_storage_policy(id) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE canvas_media ADD COLUMN IF NOT EXISTS pool_id text REFERENCES canvas_storage_pools(id);
ALTER TABLE canvas_public_media ADD COLUMN IF NOT EXISTS pool_id text REFERENCES canvas_storage_pools(id);
CREATE INDEX IF NOT EXISTS canvas_media_pool ON canvas_media(pool_id);
CREATE INDEX IF NOT EXISTS canvas_public_media_pool ON canvas_public_media(pool_id);
CREATE TABLE IF NOT EXISTS canvas_storage_backups (
    id text PRIMARY KEY, source_pool_id text NOT NULL REFERENCES canvas_storage_pools(id),
    target_pool_id text NOT NULL REFERENCES canvas_storage_pools(id), manifest jsonb NOT NULL,
    manifest_key text NOT NULL, manifest_sha256 text, manifest_bytes bigint NOT NULL DEFAULT 0, bytes bigint NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'building' CHECK (status IN ('building','ready','deleting','deleted')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS canvas_storage_tasks (
    id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('migration','backup','restore','cleanup','delete-backup')),
    source_pool_id text REFERENCES canvas_storage_pools(id), target_pool_id text REFERENCES canvas_storage_pools(id),
    backup_id text REFERENCES canvas_storage_backups(id), actor_id text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','failed','completed')),
    data jsonb NOT NULL DEFAULT '{}', error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS canvas_storage_task_items (
    id bigserial PRIMARY KEY, task_id text NOT NULL REFERENCES canvas_storage_tasks(id) ON DELETE CASCADE,
    media_kind text NOT NULL CHECK (media_kind IN ('private','public','manifest')),
    media_id text NOT NULL, source_pool_id text NOT NULL REFERENCES canvas_storage_pools(id),
    target_pool_id text NOT NULL REFERENCES canvas_storage_pools(id), source_key text NOT NULL, target_key text NOT NULL,
    bytes bigint NOT NULL, sha256 text NOT NULL, mime_type text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cleaned')),
    retire_after timestamptz, UNIQUE(task_id,media_kind,media_id)
);
CREATE TABLE IF NOT EXISTS canvas_storage_restore_previews (
    id text PRIMARY KEY, backup_id text NOT NULL REFERENCES canvas_storage_backups(id),
    manifest_sha256 text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
