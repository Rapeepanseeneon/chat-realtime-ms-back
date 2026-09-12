import { SQL } from "bun";

export type StoredMessage = {
  id: string;
  name: string;
  text: string;
  createdAt: string;
};

type MessageRow = {
  id: string;
  name: string;
  text: string;
  createdAt: Date | string;
};

const databaseUrl = Bun.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const database = new SQL(databaseUrl);

const normalizeMessage = (row: MessageRow): StoredMessage => ({
  id: row.id,
  name: row.name,
  text: row.text,
  createdAt:
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt).toISOString(),
});

export const initializeDatabase = async () => {
  await database`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      sender_name VARCHAR(50) NOT NULL,
      message_text VARCHAR(1000) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT messages_sender_name_not_blank
        CHECK (char_length(btrim(sender_name)) BETWEEN 1 AND 50),
      CONSTRAINT messages_message_text_not_blank
        CHECK (char_length(btrim(message_text)) BETWEEN 1 AND 1000)
    )
  `;

  await database`
    CREATE INDEX IF NOT EXISTS messages_created_at_id_idx
    ON messages (created_at DESC, id DESC)
  `;
};

export const createMessage = async (
  name: string,
  text: string,
): Promise<StoredMessage> => {
  const [message] = await database<MessageRow[]>`
    INSERT INTO messages (sender_name, message_text)
    VALUES (${name}, ${text})
    RETURNING
      id::text AS id,
      sender_name AS name,
      message_text AS text,
      created_at AS "createdAt"
  `;

  if (!message) {
    throw new Error("PostgreSQL did not return the inserted message");
  }

  return normalizeMessage(message);
};

export const getRecentMessages = async (): Promise<StoredMessage[]> => {
  const messages = await database<MessageRow[]>`
    SELECT id, name, text, "createdAt"
    FROM (
      SELECT
        id::text AS id,
        sender_name AS name,
        message_text AS text,
        created_at AS "createdAt"
      FROM messages
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    ) AS recent_messages
    ORDER BY "createdAt" ASC, id::bigint ASC
  `;

  return messages.map(normalizeMessage);
};
