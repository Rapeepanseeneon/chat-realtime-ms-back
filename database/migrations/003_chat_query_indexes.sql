CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX messages_private_effective_history_idx
  ON messages (
    LEAST(sender_id, receiver_id),
    GREATEST(sender_id, receiver_id),
    (COALESCE(released_at, created_at)) DESC,
    id DESC
  )
  WHERE sender_id IS NOT NULL AND receiver_id IS NOT NULL;

DROP INDEX friend_requests_receiver_status_idx;
CREATE INDEX friend_requests_receiver_status_idx
  ON friend_requests (receiver_id, status, created_at DESC, id DESC);

DROP INDEX friend_requests_sender_status_idx;
CREATE INDEX friend_requests_sender_status_idx
  ON friend_requests (sender_id, status, created_at DESC, id DESC);

CREATE INDEX users_username_lower_trgm_idx
  ON users USING GIN (lower(username) public.gin_trgm_ops);

DROP INDEX group_messages_history_idx;
