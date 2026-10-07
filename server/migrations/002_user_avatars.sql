-- ===========================================================================
-- Profile pictures
--
-- Stored in the database rather than on disk because the deployment target is
-- Cloud Run, where the filesystem is ephemeral and per-instance: a file
-- written during an upload is gone on the next deploy and invisible to every
-- other instance. Here they survive deploys and are covered by the existing
-- backup.
--
-- Its own table, not a column on `users`: that row is read on every
-- authenticated request, and a bytea alongside it would be loaded or at least
-- TOAST-checked each time for data almost no request needs.
--
-- The limits below are constraints rather than application checks because they
-- are what stops this table becoming a file dump. The client resizes before
-- uploading and the server re-derives type and dimensions from the file header,
-- so by the time a row is written all three have agreed independently.
-- ===========================================================================

CREATE TABLE user_avatars (
    user_id      BIGINT      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

    image_bytes  BYTEA       NOT NULL,
    content_type TEXT        NOT NULL,
    byte_size    INTEGER     NOT NULL,
    width        INTEGER     NOT NULL,
    height       INTEGER     NOT NULL,

    -- Who uploaded it. Only an administrator can, and the audit log records it
    -- too; this keeps the fact on the row itself. SET NULL rather than CASCADE:
    -- deleting the administrator who uploaded a picture must not delete the
    -- picture.
    uploaded_by  BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Formats a browser renders without a plugin and that the server can read
    -- dimensions out of. Anything else is rejected before it reaches here.
    CONSTRAINT user_avatars_type_ck
        CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),

    -- 256 KiB. A 512x512 JPEG at the quality the client encodes with lands
    -- around 40-70 KiB, so this is generous and still bounds the table.
    CONSTRAINT user_avatars_size_ck
        CHECK (byte_size > 0 AND byte_size <= 262144),

    -- Belt and braces: the recorded size must be the size actually stored, so
    -- a wrong byte_size cannot slip past the limit above.
    CONSTRAINT user_avatars_bytes_ck
        CHECK (octet_length(image_bytes) = byte_size),

    CONSTRAINT user_avatars_dimensions_ck
        CHECK (width BETWEEN 16 AND 1024 AND height BETWEEN 16 AND 1024)
);

COMMENT ON TABLE user_avatars IS
    'Profile pictures. One per account, uploaded by an administrator only.';
