ALTER TABLE canvas_users ADD COLUMN IF NOT EXISTS oauth_credentials text;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='canvas_sessions' AND column_name='credentials') THEN
        DELETE FROM canvas_sessions;
        ALTER TABLE canvas_sessions DROP COLUMN credentials;
    END IF;
END $$;
