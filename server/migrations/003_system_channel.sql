CREATE TABLE IF NOT EXISTS canvas_system_channel (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    data jsonb NOT NULL,
    revision bigint NOT NULL DEFAULT 1
);
