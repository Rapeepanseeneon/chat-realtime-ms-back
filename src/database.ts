import { SQL } from "bun";

export type StoredMessage = {
  id: string;
  name: string;
  text: string;
  createdAt: string;
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

type UserRow = {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const databaseUrl = Bun.env.DATABASE_URL?.trim();

if (!databaseUrl) throw new Error("DATABASE_URL is required");

const database = new SQL(databaseUrl);
const toIsoString = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const normalizeMessage = (row: MessageRow): StoredMessage => ({
  id: row.id,
  name: row.name,
  text: row.text,
  createdAt: toIsoString(row.createdAt),
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
  await database`CREATE INDEX IF NOT EXISTS messages_created_at_id_idx ON messages (created_at DESC, id DESC)`;
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

export const getRecentMessages = async (): Promise<StoredMessage[]> => {
  const messages = await database<MessageRow[]>`
    SELECT id, name, text, "createdAt" FROM (
      SELECT id::text AS id, sender_name AS name, message_text AS text, created_at AS "createdAt"
      FROM messages ORDER BY created_at DESC, id DESC LIMIT 50
    ) AS recent_messages
    ORDER BY "createdAt" ASC, id::bigint ASC
  `;
  return messages.map(normalizeMessage);
};
