CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(50) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  avatar_url TEXT,
  bio VARCHAR(150) NOT NULL DEFAULT '',
  display_name VARCHAR(80),
  onboarding_completed BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT users_username_not_blank CHECK (char_length(btrim(username)) BETWEEN 1 AND 50),
  CONSTRAINT users_email_not_blank CHECK (char_length(btrim(email)) BETWEEN 3 AND 254)
);

CREATE UNIQUE INDEX users_username_lower_unique_idx ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_unique_idx ON users (lower(email));

CREATE TABLE user_settings (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  presence_status VARCHAR(12) NOT NULL DEFAULT 'online',
  custom_status VARCHAR(80) NOT NULL DEFAULT '',
  show_online_status BOOLEAN NOT NULL DEFAULT TRUE,
  send_read_receipts BOOLEAN NOT NULL DEFAULT TRUE,
  show_typing_indicator BOOLEAN NOT NULL DEFAULT TRUE,
  confirm_ghost_release BOOLEAN NOT NULL DEFAULT TRUE,
  enter_to_send BOOLEAN NOT NULL DEFAULT TRUE,
  message_text_size VARCHAR(10) NOT NULL DEFAULT 'default',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_settings_presence_valid CHECK (presence_status IN ('online', 'away', 'dnd', 'invisible')),
  CONSTRAINT user_settings_text_size_valid CHECK (message_text_size IN ('small', 'default', 'large')),
  CONSTRAINT user_settings_custom_status_valid CHECK (char_length(custom_status) <= 80)
);

CREATE TABLE profile_links (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(30) NOT NULL,
  label VARCHAR(60) NOT NULL,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT profile_links_platform_valid CHECK (char_length(btrim(platform)) BETWEEN 1 AND 30),
  CONSTRAINT profile_links_label_valid CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),
  CONSTRAINT profile_links_url_valid CHECK (char_length(url) BETWEEN 8 AND 2048)
);
CREATE INDEX profile_links_user_idx ON profile_links(user_id, id);

CREATE TABLE favorite_friends (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, friend_id),
  CONSTRAINT favorite_friends_not_self CHECK (user_id <> friend_id)
);

CREATE TABLE friend_requests (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(10) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT friend_requests_not_self CHECK (sender_id <> receiver_id),
  CONSTRAINT friend_requests_status_valid CHECK (status IN ('pending', 'accepted', 'rejected'))
);
CREATE UNIQUE INDEX friend_requests_user_pair_unique_idx
  ON friend_requests (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id));
CREATE INDEX friend_requests_receiver_status_idx
  ON friend_requests (receiver_id, status, created_at DESC);
CREATE INDEX friend_requests_sender_status_idx
  ON friend_requests (sender_id, status, created_at DESC);

CREATE TABLE profile_privacy (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile_visibility VARCHAR(10) NOT NULL DEFAULT 'friends',
  friend_list_visibility VARCHAR(10) NOT NULL DEFAULT 'only_me',
  mutual_friends_visibility VARCHAR(10) NOT NULL DEFAULT 'friends',
  online_status_visibility VARCHAR(10) NOT NULL DEFAULT 'friends',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT profile_privacy_profile_valid CHECK (profile_visibility IN ('public','friends','private')),
  CONSTRAINT profile_privacy_friend_list_valid CHECK (friend_list_visibility IN ('everyone','friends','only_me')),
  CONSTRAINT profile_privacy_mutual_valid CHECK (mutual_friends_visibility IN ('everyone','friends','only_me')),
  CONSTRAINT profile_privacy_online_valid CHECK (online_status_visibility IN ('everyone','friends','nobody'))
);

CREATE TABLE sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE chat_attachments (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL,
  storage_key VARCHAR(80) UNIQUE,
  original_name VARCHAR(180),
  mime_type VARCHAR(100),
  size_bytes BIGINT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_attachments_kind_valid CHECK (kind IN ('image','file','location')),
  CONSTRAINT chat_attachments_payload_valid CHECK (
    (kind IN ('image','file') AND storage_key IS NOT NULL AND original_name IS NOT NULL
      AND mime_type IS NOT NULL AND size_bytes > 0 AND latitude IS NULL AND longitude IS NULL)
    OR
    (kind = 'location' AND storage_key IS NULL AND original_name IS NULL
      AND mime_type IS NULL AND size_bytes IS NULL
      AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
  )
);
CREATE INDEX chat_attachments_owner_idx ON chat_attachments(owner_id, id DESC);

CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY,
  sender_name VARCHAR(50) NOT NULL,
  message_text VARCHAR(1000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sender_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  receiver_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  reply_to_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  message_status VARCHAR(10) NOT NULL DEFAULT 'sent',
  scheduled_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  state_updated_at TIMESTAMPTZ,
  delivery_id BIGINT,
  ghost_publish_pending BOOLEAN NOT NULL DEFAULT FALSE,
  attachment_id BIGINT REFERENCES chat_attachments(id) ON DELETE SET NULL,
  CONSTRAINT messages_sender_name_not_blank CHECK (char_length(btrim(sender_name)) BETWEEN 1 AND 50),
  CONSTRAINT messages_message_text_not_blank CHECK (
    deleted_at IS NOT NULL OR attachment_id IS NOT NULL
      OR char_length(btrim(message_text)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT messages_status_valid CHECK (
    message_status IN ('ghost', 'scheduled', 'sent', 'cancelled')
    AND (message_status = 'sent' OR (
      sender_id IS NOT NULL AND receiver_id IS NOT NULL AND sender_id <> receiver_id
      AND read_at IS NULL AND released_at IS NULL
    ))
    AND (message_status <> 'scheduled' OR scheduled_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX messages_attachment_unique_idx
  ON messages(attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX messages_pending_ghost_publish_idx
  ON messages(id) WHERE ghost_publish_pending = TRUE;
CREATE INDEX messages_due_ghost_idx
  ON messages(scheduled_at, id) WHERE message_status = 'scheduled' AND deleted_at IS NULL;
CREATE INDEX messages_unread_receiver_sender_idx
  ON messages(receiver_id, sender_id, id) WHERE read_at IS NULL AND receiver_id IS NOT NULL;
CREATE INDEX messages_created_at_id_idx ON messages(created_at DESC, id DESC);
CREATE INDEX messages_private_conversation_idx
  ON messages(sender_id, receiver_id, created_at DESC, id DESC)
  WHERE sender_id IS NOT NULL AND receiver_id IS NOT NULL;

CREATE TABLE groups (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT groups_name_not_blank CHECK (char_length(btrim(name)) BETWEEN 1 AND 80)
);

CREATE TABLE group_members (
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(group_id, user_id),
  CONSTRAINT group_members_role_valid CHECK (role IN ('owner','member'))
);
CREATE UNIQUE INDEX group_single_owner_idx ON group_members(group_id) WHERE role='owner';
CREATE INDEX group_members_user_idx ON group_members(user_id, group_id);

CREATE TABLE group_messages (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_text VARCHAR(1000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  reply_to_message_id BIGINT REFERENCES group_messages(id) ON DELETE SET NULL,
  attachment_id BIGINT REFERENCES chat_attachments(id) ON DELETE SET NULL,
  CONSTRAINT group_messages_text_valid CHECK (
    deleted_at IS NOT NULL OR attachment_id IS NOT NULL
      OR char_length(btrim(message_text)) BETWEEN 1 AND 1000
  )
);
CREATE UNIQUE INDEX group_messages_attachment_unique_idx
  ON group_messages(attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX group_messages_history_idx ON group_messages(group_id, id DESC);

CREATE TABLE group_reads (
  group_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  last_read_message_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(group_id, user_id),
  FOREIGN KEY(group_id, user_id) REFERENCES group_members(group_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY(last_read_message_id) REFERENCES group_messages(id) ON DELETE SET NULL
);
