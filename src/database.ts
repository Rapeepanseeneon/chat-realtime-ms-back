import { SQL } from "bun";

export type StoredMessage = {
  id: string;
  name: string;
  text: string;
  createdAt: string;
};

export type ChatUser = {
  id: string;
  username: string;
};

export type FriendSearchResult = ChatUser & {
  relationship: "none" | "outgoing_pending" | "incoming_pending" | "friends";
};

export type FriendRequest = {
  id: string;
  sender: ChatUser;
  createdAt: string;
};

export type CreateFriendRequestResult =
  | { outcome: "created"; requestId: string }
  | { outcome: "pending" }
  | { outcome: "friends" };

export type PrivateMessage = {
  id: string;
  senderId: string;
  receiverId: string;
  messageText: string;
  createdAt: string;
  readAt: string | null;
  messageStatus: "ghost" | "scheduled" | "sent" | "cancelled";
  scheduledAt: string | null;
  releasedAt: string | null;
  stateUpdatedAt: string | null;
  deliveryId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  replyToMessageId: string | null;
  reply: {
    id: string;
    senderId: string;
    messageText: string;
    editedAt: string | null;
    deletedAt: string | null;
  } | null;
};

export type UnreadCount = { friendId: string; unreadCount: number };

export type GroupSummary = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  role: "owner" | "member";
  memberCount: number;
  unreadCount: number;
};

export type GroupMember = ChatUser & {
  role: "owner" | "member";
  joinedAt: string;
};

export type GroupInfo = GroupSummary & { members: GroupMember[] };

export type GroupMessage = {
  id: string;
  groupId: string;
  senderId: string;
  senderUsername: string;
  messageText: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  replyToMessageId: string | null;
  reply: {
    id: string;
    senderId: string;
    senderUsername: string;
    messageText: string;
    editedAt: string | null;
    deletedAt: string | null;
  } | null;
};

export type User = {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicUser = Omit<User, "passwordHash">;

type MessageRow = {
  id: string;
  name: string;
  text: string;
  createdAt: Date | string;
};

type PrivateMessageRow = {
  id: string;
  senderId: string;
  receiverId: string;
  messageText: string;
  createdAt: Date | string;
  readAt: Date | string | null;
  messageStatus: PrivateMessage["messageStatus"];
  scheduledAt: Date | string | null;
  releasedAt: Date | string | null;
  stateUpdatedAt: Date | string | null;
  deliveryId: string | null;
  editedAt: Date | string | null;
  deletedAt: Date | string | null;
  replyToMessageId: string | null;
  replySenderId: string | null;
  replyText: string | null;
  replyEditedAt: Date | string | null;
  replyDeletedAt: Date | string | null;
};

type UserRow = {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type FriendRequestRow = {
  id: string;
  senderId: string;
  senderUsername: string;
  createdAt: Date | string;
};

const databaseUrl = Bun.env.DATABASE_URL?.trim();

if (!databaseUrl) throw new Error("DATABASE_URL is required");

const databasePoolSize = Number(Bun.env.DATABASE_POOL_SIZE ?? 5);
if (!Number.isInteger(databasePoolSize) || databasePoolSize < 1) {
  throw new Error("DATABASE_POOL_SIZE must be a positive integer");
}

const databaseGlobal = globalThis as typeof globalThis & {
  pbMessengerDatabase?: SQL;
};
const database =
  databaseGlobal.pbMessengerDatabase ??
  new SQL(databaseUrl, { max: databasePoolSize });
databaseGlobal.pbMessengerDatabase = database;
const toIsoString = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const normalizeMessage = (row: MessageRow): StoredMessage => ({
  id: row.id,
  name: row.name,
  text: row.text,
  createdAt: toIsoString(row.createdAt),
});

const normalizePrivateMessage = (row: PrivateMessageRow): PrivateMessage => ({
  id: row.id,
  senderId: row.senderId,
  receiverId: row.receiverId,
  messageText: row.messageText,
  createdAt: toIsoString(row.createdAt),
  readAt: row.readAt ? toIsoString(row.readAt) : null,
  messageStatus: row.messageStatus,
  scheduledAt: row.scheduledAt ? toIsoString(row.scheduledAt) : null,
  releasedAt: row.releasedAt ? toIsoString(row.releasedAt) : null,
  stateUpdatedAt: row.stateUpdatedAt ? toIsoString(row.stateUpdatedAt) : null,
  deliveryId: row.deliveryId,
  editedAt: row.editedAt ? toIsoString(row.editedAt) : null,
  deletedAt: row.deletedAt ? toIsoString(row.deletedAt) : null,
  replyToMessageId: row.replyToMessageId,
  reply:
    row.replyToMessageId && row.replySenderId
      ? {
          id: row.replyToMessageId,
          senderId: row.replySenderId,
          messageText: row.replyDeletedAt ? "" : (row.replyText ?? ""),
          editedAt: row.replyEditedAt ? toIsoString(row.replyEditedAt) : null,
          deletedAt: row.replyDeletedAt
            ? toIsoString(row.replyDeletedAt)
            : null,
        }
      : null,
});

const normalizeUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  email: row.email,
  passwordHash: row.passwordHash,
  createdAt: toIsoString(row.createdAt),
  updatedAt: toIsoString(row.updatedAt),
});

export const toPublicUser = (user: User): PublicUser => {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
};

export const initializeDatabase = async () => {
  await database`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(254) NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT users_username_not_blank CHECK (char_length(btrim(username)) BETWEEN 1 AND 50),
      CONSTRAINT users_email_not_blank CHECK (char_length(btrim(email)) BETWEEN 3 AND 254)
    )
  `;
  await database`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique_idx ON users (lower(username))`;
  await database`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique_idx ON users (lower(email))`;
  await database`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id BIGSERIAL PRIMARY KEY,
      sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(10) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT friend_requests_not_self CHECK (sender_id <> receiver_id),
      CONSTRAINT friend_requests_status_valid CHECK (status IN ('pending', 'accepted', 'rejected'))
    )
  `;
  await database`
    CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_user_pair_unique_idx
    ON friend_requests (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id))
  `;
  await database`
    CREATE INDEX IF NOT EXISTS friend_requests_receiver_status_idx
    ON friend_requests (receiver_id, status, created_at DESC)
  `;
  await database`
    CREATE TABLE IF NOT EXISTS sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await database`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)`;
  await database`CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at)`;
  await database`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      sender_name VARCHAR(50) NOT NULL,
      message_text VARCHAR(1000) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT messages_sender_name_not_blank CHECK (char_length(btrim(sender_name)) BETWEEN 1 AND 50),
      CONSTRAINT messages_message_text_not_blank CHECK (char_length(btrim(message_text)) BETWEEN 1 AND 1000)
    )
  `;
  await database`
    ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS sender_id BIGINT REFERENCES users(id) ON DELETE CASCADE
  `;
  await database`
    ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS receiver_id BIGINT REFERENCES users(id) ON DELETE CASCADE
  `;
  await database`ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ`;
  await database`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`;
  await database`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
  await database`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL`;
  await database`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_status VARCHAR(10) NOT NULL DEFAULT 'sent'`;
  await database`ALTER TABLE messages ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ`;
  await database`ALTER TABLE messages ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ`;
  await database`ALTER TABLE messages ADD COLUMN IF NOT EXISTS state_updated_at TIMESTAMPTZ`;
  await database`ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_id BIGINT`;
  await database`ALTER TABLE messages ADD COLUMN IF NOT EXISTS ghost_publish_pending BOOLEAN NOT NULL DEFAULT FALSE`;
  await database`CREATE INDEX IF NOT EXISTS messages_pending_ghost_publish_idx ON messages (id) WHERE ghost_publish_pending = TRUE`;
  await database.begin(async (transaction) => {
    await transaction`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_valid`;
    await transaction`ALTER TABLE messages ADD CONSTRAINT messages_status_valid CHECK (
      message_status IN ('ghost', 'scheduled', 'sent', 'cancelled')
      AND (message_status = 'sent' OR (sender_id IS NOT NULL AND receiver_id IS NOT NULL AND sender_id <> receiver_id AND read_at IS NULL AND released_at IS NULL))
      AND (message_status <> 'scheduled' OR scheduled_at IS NOT NULL)
    )`;
  });
  await database`CREATE INDEX IF NOT EXISTS messages_due_ghost_idx ON messages (scheduled_at, id) WHERE message_status = 'scheduled' AND deleted_at IS NULL`;
  // Preserve the legacy nonblank rule; only tombstones may have erased content.
  await database.begin(async (transaction) => {
    await transaction`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_message_text_not_blank`;
    await transaction`ALTER TABLE messages ADD CONSTRAINT messages_message_text_not_blank CHECK (deleted_at IS NOT NULL OR char_length(btrim(message_text)) BETWEEN 1 AND 1000)`;
  });
  await database`
    CREATE INDEX IF NOT EXISTS messages_unread_receiver_sender_idx
    ON messages (receiver_id, sender_id, id)
    WHERE read_at IS NULL AND receiver_id IS NOT NULL
  `;
  await database`CREATE INDEX IF NOT EXISTS messages_created_at_id_idx ON messages (created_at DESC, id DESC)`;
  await database`
    CREATE INDEX IF NOT EXISTS messages_private_conversation_idx
    ON messages (sender_id, receiver_id, created_at DESC, id DESC)
    WHERE sender_id IS NOT NULL AND receiver_id IS NOT NULL
  `;
  await database`CREATE TABLE IF NOT EXISTS groups (
    id BIGSERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL,
    created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT groups_name_not_blank CHECK (char_length(btrim(name)) BETWEEN 1 AND 80)
  )`;
  await database`CREATE TABLE IF NOT EXISTS group_members (
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(10) NOT NULL DEFAULT 'member', joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id), CONSTRAINT group_members_role_valid CHECK (role IN ('owner','member'))
  )`;
  await database`CREATE UNIQUE INDEX IF NOT EXISTS group_single_owner_idx ON group_members(group_id) WHERE role='owner'`;
  await database`CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members(user_id, group_id)`;
  await database`CREATE TABLE IF NOT EXISTS group_messages (
    id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_text VARCHAR(1000) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
    reply_to_message_id BIGINT REFERENCES group_messages(id) ON DELETE SET NULL,
    CONSTRAINT group_messages_text_valid CHECK (deleted_at IS NOT NULL OR char_length(btrim(message_text)) BETWEEN 1 AND 1000)
  )`;
  await database`CREATE INDEX IF NOT EXISTS group_messages_history_idx ON group_messages(group_id, id DESC)`;
  await database`CREATE TABLE IF NOT EXISTS group_reads (
    group_id BIGINT NOT NULL, user_id BIGINT NOT NULL, last_read_message_id BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(group_id,user_id),
    FOREIGN KEY(group_id,user_id) REFERENCES group_members(group_id,user_id) ON DELETE CASCADE,
    FOREIGN KEY(last_read_message_id) REFERENCES group_messages(id) ON DELETE SET NULL
  )`;
};

export const createUser = async (
  username: string,
  email: string,
  passwordHash: string,
): Promise<User> => {
  const [user] = await database<UserRow[]>`
    INSERT INTO users (username, email, password_hash)
    VALUES (${username}, ${email}, ${passwordHash})
    RETURNING id::text AS id, username, email, password_hash AS "passwordHash", created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  if (!user) throw new Error("PostgreSQL did not return the inserted user");
  return normalizeUser(user);
};

export const findUserByEmail = async (email: string): Promise<User | null> => {
  const [user] = await database<UserRow[]>`
    SELECT id::text AS id, username, email, password_hash AS "passwordHash", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `;
  return user ? normalizeUser(user) : null;
};

export const getFriends = async (
  currentUserId: string,
): Promise<ChatUser[]> => {
  return database<ChatUser[]>`
    SELECT users.id::text AS id, users.username
    FROM friend_requests
    JOIN users ON users.id = CASE
      WHEN friend_requests.sender_id = ${currentUserId}
        THEN friend_requests.receiver_id
      ELSE friend_requests.sender_id
    END
    WHERE friend_requests.status = 'accepted'
      AND (${currentUserId} = friend_requests.sender_id OR ${currentUserId} = friend_requests.receiver_id)
    ORDER BY lower(users.username) ASC, users.id ASC
  `;
};

export const searchUsers = async (
  currentUserId: string,
  query: string,
): Promise<FriendSearchResult[]> => {
  return database<FriendSearchResult[]>`
    SELECT
      users.id::text AS id,
      users.username,
      CASE
        WHEN friend_requests.status = 'accepted' THEN 'friends'
        WHEN friend_requests.status = 'pending'
          AND friend_requests.sender_id = ${currentUserId} THEN 'outgoing_pending'
        WHEN friend_requests.status = 'pending' THEN 'incoming_pending'
        ELSE 'none'
      END AS relationship
    FROM users
    LEFT JOIN friend_requests ON
      LEAST(friend_requests.sender_id, friend_requests.receiver_id) = LEAST(users.id, ${currentUserId})
      AND GREATEST(friend_requests.sender_id, friend_requests.receiver_id) = GREATEST(users.id, ${currentUserId})
    WHERE users.id <> ${currentUserId}
      AND (
        lower(users.username) LIKE '%' || lower(${query}) || '%'
        OR lower(users.email) = lower(${query})
      )
    ORDER BY
      CASE
        WHEN lower(users.username) = lower(${query}) OR lower(users.email) = lower(${query}) THEN 0
        ELSE 1
      END,
      lower(users.username) ASC
    LIMIT 10
  `;
};

export const getReceivedFriendRequests = async (
  currentUserId: string,
): Promise<FriendRequest[]> => {
  const rows = await database<FriendRequestRow[]>`
    SELECT
      friend_requests.id::text AS id,
      users.id::text AS "senderId",
      users.username AS "senderUsername",
      friend_requests.created_at AS "createdAt"
    FROM friend_requests
    JOIN users ON users.id = friend_requests.sender_id
    WHERE friend_requests.receiver_id = ${currentUserId}
      AND friend_requests.status = 'pending'
    ORDER BY friend_requests.created_at DESC, friend_requests.id DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    sender: { id: row.senderId, username: row.senderUsername },
    createdAt: toIsoString(row.createdAt),
  }));
};

export const getFriendshipStatus = async (
  firstUserId: string,
  secondUserId: string,
): Promise<"pending" | "accepted" | "rejected" | null> => {
  const [row] = await database<
    { status: "pending" | "accepted" | "rejected" }[]
  >`
    SELECT status
    FROM friend_requests
    WHERE LEAST(sender_id, receiver_id) = LEAST(${firstUserId}::bigint, ${secondUserId}::bigint)
      AND GREATEST(sender_id, receiver_id) = GREATEST(${firstUserId}::bigint, ${secondUserId}::bigint)
    LIMIT 1
  `;
  return row?.status ?? null;
};

export const areFriends = async (
  firstUserId: string,
  secondUserId: string,
): Promise<boolean> =>
  (await getFriendshipStatus(firstUserId, secondUserId)) === "accepted";

export const createFriendRequest = async (
  senderId: string,
  receiverId: string,
): Promise<CreateFriendRequestResult> => {
  const [existing] = await database<{ id: string; status: string }[]>`
    SELECT id::text AS id, status
    FROM friend_requests
    WHERE LEAST(sender_id, receiver_id) = LEAST(${senderId}::bigint, ${receiverId}::bigint)
      AND GREATEST(sender_id, receiver_id) = GREATEST(${senderId}::bigint, ${receiverId}::bigint)
    LIMIT 1
  `;
  if (existing?.status === "accepted") return { outcome: "friends" };
  if (existing?.status === "pending") return { outcome: "pending" };
  if (existing) {
    const [request] = await database<{ id: string }[]>`
      UPDATE friend_requests
      SET sender_id = ${senderId}, receiver_id = ${receiverId}, status = 'pending',
        created_at = NOW(), updated_at = NOW()
      WHERE id = ${existing.id}
      RETURNING id::text AS id
    `;
    if (!request) throw new Error("Friend request could not be renewed");
    return { outcome: "created", requestId: request.id };
  }
  const [request] = await database<{ id: string }[]>`
    INSERT INTO friend_requests (sender_id, receiver_id)
    VALUES (${senderId}, ${receiverId})
    RETURNING id::text AS id
  `;
  if (!request) throw new Error("Friend request could not be created");
  return { outcome: "created", requestId: request.id };
};

export const respondToFriendRequest = async (
  requestId: string,
  receiverId: string,
  status: "accepted" | "rejected",
): Promise<boolean> => {
  const rows = await database<{ id: string }[]>`
    UPDATE friend_requests
    SET status = ${status}, updated_at = NOW()
    WHERE id::text = ${requestId}
      AND receiver_id = ${receiverId}
      AND status = 'pending'
    RETURNING id::text AS id
  `;
  return rows.length === 1;
};

export const findChatUserById = async (
  userId: string,
): Promise<ChatUser | null> => {
  const [user] = await database<ChatUser[]>`
    SELECT id::text AS id, username
    FROM users
    WHERE id::text = ${userId}
    LIMIT 1
  `;
  return user ?? null;
};

export const findConflictingUser = async (
  username: string,
  email: string,
  excludedUserId?: string,
): Promise<"username" | "email" | null> => {
  const rows = excludedUserId
    ? await database<{ usernameConflict: boolean; emailConflict: boolean }[]>`
        SELECT
          bool_or(lower(username) = lower(${username})) AS "usernameConflict",
          bool_or(lower(email) = lower(${email})) AS "emailConflict"
        FROM users
        WHERE id <> ${excludedUserId}
          AND (lower(username) = lower(${username}) OR lower(email) = lower(${email}))
      `
    : await database<{ usernameConflict: boolean; emailConflict: boolean }[]>`
        SELECT
          bool_or(lower(username) = lower(${username})) AS "usernameConflict",
          bool_or(lower(email) = lower(${email})) AS "emailConflict"
        FROM users
        WHERE lower(username) = lower(${username}) OR lower(email) = lower(${email})
      `;
  if (rows[0]?.usernameConflict) return "username";
  if (rows[0]?.emailConflict) return "email";
  return null;
};

export const updateUser = async (
  userId: string,
  username: string,
  email: string,
): Promise<User> => {
  const [user] = await database<UserRow[]>`
    UPDATE users SET username = ${username}, email = ${email}, updated_at = NOW()
    WHERE id = ${userId}
    RETURNING id::text AS id, username, email, password_hash AS "passwordHash", created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  if (!user) throw new Error("User was not found");
  return normalizeUser(user);
};

export const createSession = async (
  userId: string,
  tokenHash: string,
  expiresAt: Date,
) => {
  await database`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${userId}, ${tokenHash}, ${expiresAt})`;
};

export const findUserBySession = async (
  tokenHash: string,
): Promise<User | null> => {
  const [user] = await database<UserRow[]>`
    SELECT users.id::text AS id, users.username, users.email,
      users.password_hash AS "passwordHash", users.created_at AS "createdAt", users.updated_at AS "updatedAt"
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ${tokenHash} AND sessions.expires_at > NOW()
    LIMIT 1
  `;
  return user ? normalizeUser(user) : null;
};

export const deleteSession = async (tokenHash: string) => {
  await database`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
};

export const createMessage = async (
  name: string,
  text: string,
): Promise<StoredMessage> => {
  const [message] = await database<MessageRow[]>`
    INSERT INTO messages (sender_name, message_text) VALUES (${name}, ${text})
    RETURNING id::text AS id, sender_name AS name, message_text AS text, created_at AS "createdAt"
  `;
  if (!message)
    throw new Error("PostgreSQL did not return the inserted message");
  return normalizeMessage(message);
};

export const createPrivateMessage = async (
  sender: ChatUser,
  receiverId: string,
  messageText: string,
  replyToMessageId: string | null = null,
  ghost = false,
): Promise<PrivateMessage> => {
  const [message] = await database<{ id: string }[]>`
    INSERT INTO messages (sender_name, sender_id, receiver_id, message_text, reply_to_message_id, message_status, state_updated_at)
    SELECT ${sender.username}, ${sender.id}, ${receiverId}, ${messageText}, ${replyToMessageId}::bigint, ${ghost ? "ghost" : "sent"}, clock_timestamp()
    WHERE ${replyToMessageId}::bigint IS NULL OR EXISTS (
      SELECT 1 FROM messages original WHERE original.id = ${replyToMessageId}::bigint
        AND original.message_status = 'sent'
        AND ((original.sender_id = ${sender.id} AND original.receiver_id = ${receiverId})
          OR (original.sender_id = ${receiverId} AND original.receiver_id = ${sender.id}))
    )
    RETURNING id::text AS id
  `;
  if (!message)
    throw new Error("Reply must reference a message in this conversation.");
  const stored = await findPrivateMessage(message.id);
  if (!stored) throw new Error("Private message was not found after saving.");
  return stored;
};

// Join the current original, rather than persisting a stale copy of reply content.
const selectPrivateMessages = async (
  ids: string[],
  viewerId: string | null = null,
  pool = database,
): Promise<PrivateMessage[]> => {
  if (!ids.length) return [];
  const rows = await pool<PrivateMessageRow[]>`
    SELECT m.id::text AS id, m.sender_id::text AS "senderId",
      m.receiver_id::text AS "receiverId",
      CASE WHEN m.deleted_at IS NULL THEN m.message_text ELSE '' END AS "messageText",
      COALESCE(m.released_at, m.created_at) AS "createdAt", m.read_at AS "readAt",
      m.message_status AS "messageStatus", m.scheduled_at AS "scheduledAt",
      m.released_at AS "releasedAt", m.state_updated_at AS "stateUpdatedAt",
      CASE WHEN m.message_status = 'sent' THEN COALESCE(m.delivery_id, m.id)::text ELSE NULL END AS "deliveryId",
      m.edited_at AS "editedAt", m.deleted_at AS "deletedAt",
      m.reply_to_message_id::text AS "replyToMessageId",
      original.sender_id::text AS "replySenderId",
      CASE WHEN original.deleted_at IS NULL THEN original.message_text ELSE '' END AS "replyText",
      original.edited_at AS "replyEditedAt", original.deleted_at AS "replyDeletedAt"
    FROM messages m
    LEFT JOIN messages original ON original.id = m.reply_to_message_id
      AND original.message_status = 'sent'
      AND ((original.sender_id = m.sender_id AND original.receiver_id = m.receiver_id)
        OR (original.sender_id = m.receiver_id AND original.receiver_id = m.sender_id))
    WHERE m.id IN ${pool(ids)} AND m.receiver_id IS NOT NULL AND m.sender_id IS NOT NULL
      AND (${viewerId}::bigint IS NULL OR m.message_status = 'sent' OR m.sender_id = ${viewerId}::bigint)
    ORDER BY COALESCE(m.released_at, m.created_at) ASC, m.id ASC
  `;
  return rows.map(normalizePrivateMessage);
};

export const findPrivateMessage = async (
  messageId: string,
): Promise<PrivateMessage | null> =>
  (await selectPrivateMessages([messageId]))[0] ?? null;

export type GhostAction =
  | { action: "edit"; text: string }
  | { action: "delete" }
  | { action: "schedule"; scheduledAt: string | null };

export const updateGhost = async (
  messageId: string,
  ownerId: string,
  command: GhostAction,
): Promise<PrivateMessage | null> => {
  const rows =
    command.action === "edit"
      ? await database<{ id: string }[]>`
      UPDATE messages SET message_text = ${command.text}, edited_at = clock_timestamp(), state_updated_at = clock_timestamp()
      WHERE id = ${messageId} AND sender_id = ${ownerId}
        AND message_status IN ('ghost', 'scheduled') AND deleted_at IS NULL
      RETURNING id::text AS id
    `
      : command.action === "delete"
        ? await database<{ id: string }[]>`
        UPDATE messages SET message_text = '', deleted_at = clock_timestamp(), message_status = 'cancelled',
          scheduled_at = NULL, state_updated_at = clock_timestamp()
        WHERE id = ${messageId} AND sender_id = ${ownerId}
          AND message_status IN ('ghost', 'scheduled') AND deleted_at IS NULL
        RETURNING id::text AS id
      `
        : await database<{ id: string }[]>`
        UPDATE messages SET scheduled_at = ${command.scheduledAt}::timestamptz,
          message_status = CASE WHEN ${command.scheduledAt}::timestamptz IS NULL THEN 'ghost' ELSE 'scheduled' END,
          state_updated_at = clock_timestamp()
        WHERE id = ${messageId} AND sender_id = ${ownerId}
          AND message_status IN ('ghost', 'scheduled') AND deleted_at IS NULL
          AND (${command.scheduledAt}::timestamptz IS NULL OR ${command.scheduledAt}::timestamptz > clock_timestamp())
        RETURNING id::text AS id
      `;
  return rows[0] ? findPrivateMessage(rows[0].id) : null;
};

// Compare-and-set is the only transition that makes a ghost visible. The same
// PostgreSQL sequence orders normal sends and releases for unread/read boundaries.
export const releaseGhost = async (
  messageId: string,
  ownerId: string,
): Promise<PrivateMessage | null> => {
  return database.begin(async (transaction) => {
    const [released] = await transaction<{ id: string }[]>`
    UPDATE messages m SET message_status = 'sent', released_at = clock_timestamp(),
      delivery_id = nextval(pg_get_serial_sequence('messages', 'id')),
      state_updated_at = clock_timestamp(), scheduled_at = NULL, read_at = NULL,
      ghost_publish_pending = TRUE
    WHERE m.id = ${messageId} AND m.sender_id = ${ownerId}
      AND m.message_status IN ('ghost', 'scheduled') AND m.deleted_at IS NULL AND m.released_at IS NULL
      AND EXISTS (SELECT 1 FROM friend_requests f WHERE f.status = 'accepted'
        AND LEAST(f.sender_id, f.receiver_id) = LEAST(m.sender_id, m.receiver_id)
        AND GREATEST(f.sender_id, f.receiver_id) = GREATEST(m.sender_id, m.receiver_id))
    RETURNING m.id::text AS id
  `;
    return released
      ? ((await selectPrivateMessages([released.id], null, transaction))[0] ??
          null)
      : null;
  });
};

export const releaseDueGhosts = async (
  pool = database,
): Promise<PrivateMessage[]> => {
  return pool.begin(async (transaction) => {
    const released = await transaction<{ id: string }[]>`
      WITH due AS (
        SELECT m.id FROM messages m
        WHERE m.message_status = 'scheduled' AND m.scheduled_at <= clock_timestamp()
          AND m.deleted_at IS NULL AND m.released_at IS NULL
          AND EXISTS (SELECT 1 FROM friend_requests f WHERE f.status = 'accepted'
            AND LEAST(f.sender_id, f.receiver_id) = LEAST(m.sender_id, m.receiver_id)
            AND GREATEST(f.sender_id, f.receiver_id) = GREATEST(m.sender_id, m.receiver_id))
        ORDER BY m.scheduled_at, m.id LIMIT 50 FOR UPDATE OF m SKIP LOCKED
      )
      UPDATE messages m SET message_status = 'sent', released_at = clock_timestamp(),
        delivery_id = nextval(pg_get_serial_sequence('messages', 'id')),
        state_updated_at = clock_timestamp(), scheduled_at = NULL, read_at = NULL,
        ghost_publish_pending = TRUE
      FROM due WHERE m.id = due.id
      RETURNING m.id::text AS id
    `;
    // Hydration must succeed before commit, otherwise the release rolls back.
    return selectPrivateMessages(
      released.map((row) => row.id),
      null,
      transaction,
    );
  });
};

// A small PostgreSQL outbox on the message row: sent is durable independently
// of realtime. A crash/error before acknowledgement leaves this flag retryable.
export const publishPendingGhosts = async (
  publish: (message: PrivateMessage, transaction: SQL) => Promise<void>,
  pool = database,
) => {
  const pending = await pool<{ id: string }[]>`
    SELECT id::text AS id FROM messages WHERE ghost_publish_pending = TRUE
    ORDER BY id LIMIT 50
  `;
  for (const { id } of pending) {
    try {
      await pool.begin(async (transaction) => {
        const locked = await transaction<{ id: string }[]>`
          SELECT id::text AS id FROM messages
          WHERE id = ${id} AND ghost_publish_pending = TRUE AND message_status = 'sent'
          FOR UPDATE SKIP LOCKED
        `;
        if (!locked.length) return;
        const [message] = await selectPrivateMessages([id], null, transaction);
        if (!message) throw new Error("Released ghost could not be loaded");
        await publish(message, transaction);
        await transaction`UPDATE messages SET ghost_publish_pending = FALSE WHERE id = ${id}`;
      });
    } catch (error) {
      console.error(
        `Failed to publish released ghost ${id}; will retry`,
        error,
      );
    }
  }
};

export const mutatePrivateMessage = async (
  messageId: string,
  ownerId: string,
  action: "edit" | "delete",
  text = "",
): Promise<PrivateMessage | null> => {
  // Ownership and tombstone checks also belong in the atomic UPDATE.
  const rows =
    action === "edit"
      ? await database<{ id: string }[]>`
        UPDATE messages SET message_text = ${text}, edited_at = clock_timestamp()
        WHERE id = ${messageId} AND sender_id = ${ownerId}
          AND receiver_id IS NOT NULL AND deleted_at IS NULL
          AND message_status = 'sent'
        RETURNING id::text AS id
      `
      : await database<{ id: string }[]>`
        UPDATE messages SET message_text = '', deleted_at = clock_timestamp()
        WHERE id = ${messageId} AND sender_id = ${ownerId}
          AND receiver_id IS NOT NULL AND deleted_at IS NULL
          AND message_status = 'sent'
        RETURNING id::text AS id
      `;
  return rows[0] ? findPrivateMessage(rows[0].id) : null;
};

export const getPrivateMessages = async (
  currentUserId: string,
  otherUserId: string,
): Promise<PrivateMessage[]> => {
  const messages = await database<{ id: string }[]>`
      SELECT id::text AS id
      FROM messages
      WHERE
        ((sender_id = ${currentUserId} AND receiver_id = ${otherUserId})
        OR (sender_id = ${otherUserId} AND receiver_id = ${currentUserId}))
        AND (message_status = 'sent' OR (sender_id = ${currentUserId} AND message_status IN ('ghost', 'scheduled')))
      ORDER BY COALESCE(released_at, created_at) DESC, id DESC
      LIMIT 50
  `;
  return selectPrivateMessages(
    messages.map((message) => message.id),
    currentUserId,
  );
};

export const getUnreadCounts = async (
  receiverId: string,
  pool = database,
): Promise<UnreadCount[]> => pool<UnreadCount[]>`
  SELECT
    messages.sender_id::text AS "friendId",
    count(*)::integer AS "unreadCount"
  FROM messages
  JOIN friend_requests ON friend_requests.status = 'accepted'
    AND LEAST(friend_requests.sender_id, friend_requests.receiver_id)
      = LEAST(messages.sender_id, messages.receiver_id)
    AND GREATEST(friend_requests.sender_id, friend_requests.receiver_id)
      = GREATEST(messages.sender_id, messages.receiver_id)
  WHERE messages.receiver_id = ${receiverId}
    AND messages.sender_id <> ${receiverId}
    AND messages.read_at IS NULL
    AND messages.deleted_at IS NULL
    AND messages.message_status = 'sent'
  GROUP BY messages.sender_id
`;

// The boundary must itself be an incoming message owned by this receiver.
// This avoids marking messages sent concurrently after the visible history read.
export const markMessagesRead = async (
  receiverId: string,
  senderId: string,
  throughMessageId: string,
): Promise<{ readAt: string | null; throughDeliveryId: string } | null> => {
  const [boundary] = await database<{ id: string; deliveryId: string }[]>`
    SELECT id::text AS id, COALESCE(delivery_id, id)::text AS "deliveryId" FROM messages
    WHERE id::text = ${throughMessageId}
      AND receiver_id = ${receiverId} AND sender_id = ${senderId}
      AND message_status = 'sent'
  `;

  if (!boundary) return null;
  const [result] = await database<{ readAt: Date | string | null }[]>`
    WITH updated AS (
      UPDATE messages SET read_at = NOW()
      WHERE receiver_id = ${receiverId} AND sender_id = ${senderId}
        AND COALESCE(delivery_id, id) <= ${boundary.deliveryId}::bigint AND read_at IS NULL
        AND message_status = 'sent'
      RETURNING read_at
    )
    SELECT max(read_at) AS "readAt" FROM updated
  `;
  return {
    readAt: result?.readAt ? toIsoString(result.readAt) : null,
    throughDeliveryId: boundary.deliveryId,
  };
};

type GroupSummaryRow = Omit<GroupSummary, "createdAt" | "updatedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
};
type GroupMessageRow = Omit<
  GroupMessage,
  "createdAt" | "editedAt" | "deletedAt" | "reply"
> & {
  createdAt: Date | string;
  editedAt: Date | string | null;
  deletedAt: Date | string | null;
  replySenderId: string | null;
  replySenderUsername: string | null;
  replyText: string | null;
  replyEditedAt: Date | string | null;
  replyDeletedAt: Date | string | null;
};
const normalizeGroupSummary = (row: GroupSummaryRow): GroupSummary => ({
  ...row,
  createdAt: toIsoString(row.createdAt),
  updatedAt: toIsoString(row.updatedAt),
});
const normalizeGroupMessage = (row: GroupMessageRow): GroupMessage => ({
  id: row.id,
  groupId: row.groupId,
  senderId: row.senderId,
  senderUsername: row.senderUsername,
  messageText: row.deletedAt ? "" : row.messageText,
  createdAt: toIsoString(row.createdAt),
  editedAt: row.editedAt ? toIsoString(row.editedAt) : null,
  deletedAt: row.deletedAt ? toIsoString(row.deletedAt) : null,
  replyToMessageId: row.replyToMessageId,
  reply:
    row.replyToMessageId && row.replySenderId
      ? {
          id: row.replyToMessageId,
          senderId: row.replySenderId,
          senderUsername: row.replySenderUsername ?? "Unknown",
          messageText: row.replyDeletedAt ? "" : (row.replyText ?? ""),
          editedAt: row.replyEditedAt ? toIsoString(row.replyEditedAt) : null,
          deletedAt: row.replyDeletedAt
            ? toIsoString(row.replyDeletedAt)
            : null,
        }
      : null,
});

export const getGroups = async (userId: string): Promise<GroupSummary[]> => {
  const rows = await database<GroupSummaryRow[]>`
    SELECT g.id::text id, g.name, g.created_by::text AS "createdBy", g.created_at AS "createdAt",
      g.updated_at AS "updatedAt", mine.role, count(DISTINCT members.user_id)::integer AS "memberCount",
      count(DISTINCT message.id) FILTER (WHERE message.id > COALESCE(reads.last_read_message_id, 0)
        AND message.sender_id <> ${userId} AND message.deleted_at IS NULL)::integer AS "unreadCount"
    FROM groups g JOIN group_members mine ON mine.group_id=g.id AND mine.user_id=${userId}
    JOIN group_members members ON members.group_id=g.id
    LEFT JOIN group_reads reads ON reads.group_id=g.id AND reads.user_id=${userId}
    LEFT JOIN group_messages message ON message.group_id=g.id
    GROUP BY g.id,mine.role,reads.last_read_message_id ORDER BY g.updated_at DESC,g.id DESC`;
  return rows.map(normalizeGroupSummary);
};

export const isGroupMember = async (groupId: string, userId: string) =>
  (
    await database<
      { ok: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM group_members WHERE group_id=${groupId} AND user_id=${userId}) ok`
  )[0]?.ok ?? false;

export const getGroupMemberIds = async (groupId: string): Promise<string[]> =>
  (
    await database<
      { id: string }[]
    >`SELECT user_id::text id FROM group_members WHERE group_id=${groupId}`
  ).map((row) => row.id);

export const getGroupInfo = async (
  groupId: string,
  viewerId: string,
): Promise<GroupInfo | null> => {
  const summary = (await getGroups(viewerId)).find(
    (group) => group.id === groupId,
  );
  if (!summary) return null;
  const rows = await database<(GroupMember & { joinedAt: Date | string })[]>`
    SELECT u.id::text id,u.username,gm.role,gm.joined_at AS "joinedAt" FROM group_members gm
    JOIN users u ON u.id=gm.user_id WHERE gm.group_id=${groupId} ORDER BY (gm.role='owner') DESC,gm.joined_at,u.id`;
  return {
    ...summary,
    members: rows.map((row) => ({
      ...row,
      joinedAt: toIsoString(row.joinedAt),
    })),
  };
};

export const createGroup = async (
  creatorId: string,
  name: string,
  memberIds: string[],
): Promise<GroupInfo | null> => {
  const unique = [...new Set(memberIds)].filter((id) => id !== creatorId);
  return database
    .begin(async (tx) => {
      if (unique.length) {
        const [{ count }] = await tx<
          { count: number }[]
        >`SELECT count(*)::integer count FROM users u WHERE u.id IN ${tx(unique)}
        AND EXISTS(SELECT 1 FROM friend_requests f WHERE f.status='accepted'
          AND LEAST(f.sender_id,f.receiver_id)=LEAST(${creatorId}::bigint,u.id)
          AND GREATEST(f.sender_id,f.receiver_id)=GREATEST(${creatorId}::bigint,u.id))`;
        if (count !== unique.length) return null;
      }
      const [group] = await tx<
        { id: string }[]
      >`INSERT INTO groups(name,created_by) VALUES(${name},${creatorId}) RETURNING id::text id`;
      await tx`INSERT INTO group_members(group_id,user_id,role) VALUES(${group.id},${creatorId},'owner')`;
      if (unique.length)
        await tx`INSERT INTO group_members(group_id,user_id,role) SELECT ${group.id},id,'member' FROM users WHERE id IN ${tx(unique)}`;
      return group.id;
    })
    .then((id) => (id ? getGroupInfo(id, creatorId) : null));
};

const selectGroupMessages = async (ids: string[]): Promise<GroupMessage[]> => {
  if (!ids.length) return [];
  const rows = await database<GroupMessageRow[]>`
    SELECT m.id::text id,m.group_id::text AS "groupId",m.sender_id::text AS "senderId",u.username AS "senderUsername",
      m.message_text AS "messageText",m.created_at AS "createdAt",m.edited_at AS "editedAt",m.deleted_at AS "deletedAt",
      m.reply_to_message_id::text AS "replyToMessageId",r.sender_id::text AS "replySenderId",ru.username AS "replySenderUsername",
      r.message_text AS "replyText",r.edited_at AS "replyEditedAt",r.deleted_at AS "replyDeletedAt"
    FROM group_messages m JOIN users u ON u.id=m.sender_id
    LEFT JOIN group_messages r ON r.id=m.reply_to_message_id AND r.group_id=m.group_id LEFT JOIN users ru ON ru.id=r.sender_id
    WHERE m.id IN ${database(ids)} ORDER BY m.id`;
  return rows.map(normalizeGroupMessage);
};

export const getGroupMessages = async (
  groupId: string,
  userId: string,
): Promise<GroupMessage[] | null> => {
  if (!(await isGroupMember(groupId, userId))) return null;
  const rows = await database<
    { id: string }[]
  >`SELECT id::text id FROM group_messages WHERE group_id=${groupId} ORDER BY id DESC LIMIT 50`;
  return selectGroupMessages(rows.reverse().map((row) => row.id));
};

export const createGroupMessage = async (
  groupId: string,
  senderId: string,
  text: string,
  replyId: string | null,
): Promise<GroupMessage | null> => {
  const [row] = await database<
    { id: string }[]
  >`INSERT INTO group_messages(group_id,sender_id,message_text,reply_to_message_id)
    SELECT ${groupId},${senderId},${text},${replyId}::bigint WHERE EXISTS(SELECT 1 FROM group_members WHERE group_id=${groupId} AND user_id=${senderId})
    AND (${replyId}::bigint IS NULL OR EXISTS(SELECT 1 FROM group_messages WHERE id=${replyId} AND group_id=${groupId})) RETURNING id::text id`;
  if (!row) return null;
  await database`UPDATE groups SET updated_at=clock_timestamp() WHERE id=${groupId}`;
  return (await selectGroupMessages([row.id]))[0] ?? null;
};

export const mutateGroupMessage = async (
  id: string,
  userId: string,
  action: "edit" | "delete",
  text = "",
): Promise<GroupMessage | null> => {
  const rows =
    action === "edit"
      ? await database<
          { id: string }[]
        >`UPDATE group_messages SET message_text=${text},edited_at=clock_timestamp()
    WHERE id=${id} AND sender_id=${userId} AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM group_members WHERE group_id=group_messages.group_id AND user_id=${userId}) RETURNING id::text id`
      : await database<
          { id: string }[]
        >`UPDATE group_messages SET message_text='',deleted_at=clock_timestamp()
    WHERE id=${id} AND sender_id=${userId} AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM group_members WHERE group_id=group_messages.group_id AND user_id=${userId}) RETURNING id::text id`;
  return rows[0]
    ? ((await selectGroupMessages([rows[0].id]))[0] ?? null)
    : null;
};

export const markGroupRead = async (
  groupId: string,
  userId: string,
): Promise<boolean> => {
  const rows =
    await database`INSERT INTO group_reads(group_id,user_id,last_read_message_id) SELECT ${groupId},${userId},max(m.id)
    FROM group_members gm LEFT JOIN group_messages m ON m.group_id=gm.group_id WHERE gm.group_id=${groupId} AND gm.user_id=${userId}
    GROUP BY gm.group_id,gm.user_id ON CONFLICT(group_id,user_id) DO UPDATE SET last_read_message_id=EXCLUDED.last_read_message_id,updated_at=clock_timestamp() RETURNING group_id`;
  return rows.length > 0;
};

export const updateGroup = async (
  groupId: string,
  ownerId: string,
  name: string,
): Promise<boolean> =>
  (
    await database`UPDATE groups SET name=${name},updated_at=clock_timestamp() WHERE id=${groupId} AND EXISTS(SELECT 1 FROM group_members WHERE group_id=groups.id AND user_id=${ownerId} AND role='owner') RETURNING id`
  ).length > 0;
export const addGroupMember = async (
  groupId: string,
  ownerId: string,
  userId: string,
): Promise<boolean> =>
  (
    await database`INSERT INTO group_members(group_id,user_id,role) SELECT ${groupId},${userId},'member' WHERE EXISTS(SELECT 1 FROM group_members WHERE group_id=${groupId} AND user_id=${ownerId} AND role='owner') AND EXISTS(SELECT 1 FROM friend_requests WHERE status='accepted' AND LEAST(sender_id,receiver_id)=LEAST(${ownerId}::bigint,${userId}::bigint) AND GREATEST(sender_id,receiver_id)=GREATEST(${ownerId}::bigint,${userId}::bigint)) ON CONFLICT DO NOTHING RETURNING group_id`
  ).length > 0;
export const removeGroupMember = async (
  groupId: string,
  ownerId: string,
  userId: string,
): Promise<boolean> =>
  (
    await database`DELETE FROM group_members gm WHERE group_id=${groupId} AND user_id=${userId} AND role='member' AND EXISTS(SELECT 1 FROM group_members owner WHERE owner.group_id=gm.group_id AND owner.user_id=${ownerId} AND owner.role='owner') RETURNING group_id`
  ).length > 0;
export const leaveGroup = async (
  groupId: string,
  userId: string,
): Promise<boolean> =>
  database.begin(async (tx) => {
    const members = await tx<
      { userId: string; role: "owner" | "member" }[]
    >`SELECT user_id::text AS "userId",role FROM group_members WHERE group_id=${groupId} ORDER BY joined_at,user_id FOR UPDATE`;
    const leaving = members.find((member) => member.userId === userId);
    if (!leaving) return false;
    if (leaving.role === "owner") {
      const next = members.find((member) => member.userId !== userId);
      if (!next) {
        await tx`DELETE FROM groups WHERE id=${groupId}`;
        return true;
      }
      await tx`UPDATE group_members SET role='member' WHERE group_id=${groupId} AND user_id=${userId}`;
      await tx`UPDATE group_members SET role='owner' WHERE group_id=${groupId} AND user_id=${next.userId}`;
      await tx`UPDATE groups SET created_by=${next.userId},updated_at=clock_timestamp() WHERE id=${groupId}`;
    }
    await tx`DELETE FROM group_members WHERE group_id=${groupId} AND user_id=${userId}`;
    return true;
  });

export const getRecentMessages = async (): Promise<StoredMessage[]> => {
  const messages = await database<MessageRow[]>`
    SELECT id, name, text, "createdAt" FROM (
      SELECT id::text AS id, sender_name AS name, message_text AS text, created_at AS "createdAt"
      FROM messages
      WHERE sender_id IS NULL AND receiver_id IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 50
    ) AS recent_messages
    ORDER BY "createdAt" ASC, id::bigint ASC
  `;
  return messages.map(normalizeMessage);
};
