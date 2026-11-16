ALTER TABLE canvas_storage_pools ADD COLUMN IF NOT EXISTS capacity_bytes bigint CHECK (capacity_bytes > 0);
