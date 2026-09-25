import { CryptoHasher, type SQL } from "bun";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const MIGRATION_LOCK_KEY = "pb_messenger_schema_migrations";
const MIGRATION_DIRECTORY = resolve(
  import.meta.dir,
  "../../database/migrations",
);
const MIGRATION_FILE = /^(\d+)_([a-z0-9_]+)\.sql$/;
const NON_TRANSACTIONAL_MARKER = "-- pb-migration: non-transactional";

export type Migration = {
  version: number;
  name: string;
  checksum: string;
  sql: string;
  transactional: boolean;
};

export type MigrationStatus = {
  applied: number[];
  pending: number[];
  ready: boolean;
  schemaVerified: boolean;
};

export class MigrationError extends Error {
  constructor(message: string) {
    super(`Database migration error: ${message}`);
    this.name = "MigrationError";
  }
}

export const checksumMigrationSql = (sql: string) =>
  new CryptoHasher("sha256").update(sql).digest("hex");

export const loadMigrations = async (): Promise<Migration[]> => {
  const files = (await readdir(MIGRATION_DIRECTORY)).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = MIGRATION_FILE.exec(file);
    if (!match) continue;
    const sql = await Bun.file(join(MIGRATION_DIRECTORY, file)).text();
    migrations.push({
      version: Number(match[1]),
      name: match[2],
      checksum: checksumMigrationSql(sql),
      sql,
      transactional: !sql.startsWith(NON_TRANSACTIONAL_MARKER),
    });
  }
  if (!migrations.length) throw new MigrationError("no migration files found.");
  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new MigrationError(
        `duplicate migration version ${migration.version}.`,
      );
    }
    versions.add(migration.version);
  }
  return migrations;
};

type ExpectedColumn = {
  name: string;
  nullable: "YES" | "NO";
  type: string;
};

const parseColumns = (definition: string): ExpectedColumn[] =>
  definition.split(",").map((column) => {
    const [name, type, nullable] = column.split(":");
    return { name, type, nullable: nullable as "YES" | "NO" };
  });

const EXPECTED_COLUMNS: Record<string, ExpectedColumn[]> = {
  users: parseColumns(
    "id:int8:NO,username:varchar:NO,email:varchar:NO,password_hash:text:NO,created_at:timestamptz:NO,updated_at:timestamptz:NO,avatar_url:text:YES,bio:varchar:NO,display_name:varchar:YES,onboarding_completed:bool:NO",
  ),
  user_settings: parseColumns(
    "user_id:int8:NO,presence_status:varchar:NO,custom_status:varchar:NO,show_online_status:bool:NO,send_read_receipts:bool:NO,show_typing_indicator:bool:NO,confirm_ghost_release:bool:NO,enter_to_send:bool:NO,message_text_size:varchar:NO,updated_at:timestamptz:NO",
  ),
  profile_links: parseColumns(
    "id:int8:NO,user_id:int8:NO,platform:varchar:NO,label:varchar:NO,url:text:NO,created_at:timestamptz:NO,updated_at:timestamptz:NO",
  ),
  favorite_friends: parseColumns(
    "user_id:int8:NO,friend_id:int8:NO,created_at:timestamptz:NO",
  ),
  friend_requests: parseColumns(
    "id:int8:NO,sender_id:int8:NO,receiver_id:int8:NO,status:varchar:NO,created_at:timestamptz:NO,updated_at:timestamptz:NO",
  ),
  profile_privacy: parseColumns(
    "user_id:int8:NO,profile_visibility:varchar:NO,friend_list_visibility:varchar:NO,mutual_friends_visibility:varchar:NO,online_status_visibility:varchar:NO,updated_at:timestamptz:NO",
  ),
  sessions: parseColumns(
    "id:int8:NO,user_id:int8:NO,token_hash:bpchar:NO,expires_at:timestamptz:NO,created_at:timestamptz:NO",
  ),
  chat_attachments: parseColumns(
    "id:int8:NO,owner_id:int8:NO,kind:varchar:NO,storage_key:varchar:YES,original_name:varchar:YES,mime_type:varchar:YES,size_bytes:int8:YES,latitude:float8:YES,longitude:float8:YES,created_at:timestamptz:NO",
  ),
  messages: parseColumns(
    "id:int8:NO,sender_name:varchar:NO,message_text:varchar:NO,created_at:timestamptz:NO,sender_id:int8:YES,receiver_id:int8:YES,read_at:timestamptz:YES,edited_at:timestamptz:YES,deleted_at:timestamptz:YES,reply_to_message_id:int8:YES,message_status:varchar:NO,scheduled_at:timestamptz:YES,released_at:timestamptz:YES,state_updated_at:timestamptz:YES,delivery_id:int8:YES,ghost_publish_pending:bool:NO,attachment_id:int8:YES",
  ),
  groups: parseColumns(
    "id:int8:NO,name:varchar:NO,created_by:int8:NO,created_at:timestamptz:NO,updated_at:timestamptz:NO",
  ),
  group_members: parseColumns(
    "group_id:int8:NO,user_id:int8:NO,role:varchar:NO,joined_at:timestamptz:NO",
  ),
  group_messages: parseColumns(
    "id:int8:NO,group_id:int8:NO,sender_id:int8:NO,message_text:varchar:NO,created_at:timestamptz:NO,edited_at:timestamptz:YES,deleted_at:timestamptz:YES,reply_to_message_id:int8:YES,attachment_id:int8:YES",
  ),
  group_reads: parseColumns(
    "group_id:int8:NO,user_id:int8:NO,last_read_message_id:int8:YES,updated_at:timestamptz:NO",
  ),
};

const EXPECTED_CONSTRAINTS = new Set(
  [
    "chat_attachments:chat_attachments_kind_valid:c",
    "chat_attachments:chat_attachments_owner_id_fkey:f",
    "chat_attachments:chat_attachments_payload_valid:c",
    "chat_attachments:chat_attachments_pkey:p",
    "chat_attachments:chat_attachments_storage_key_key:u",
    "favorite_friends:favorite_friends_friend_id_fkey:f",
    "favorite_friends:favorite_friends_not_self:c",
    "favorite_friends:favorite_friends_pkey:p",
    "favorite_friends:favorite_friends_user_id_fkey:f",
    "friend_requests:friend_requests_not_self:c",
    "friend_requests:friend_requests_pkey:p",
    "friend_requests:friend_requests_receiver_id_fkey:f",
    "friend_requests:friend_requests_sender_id_fkey:f",
    "friend_requests:friend_requests_status_valid:c",
    "group_members:group_members_group_id_fkey:f",
    "group_members:group_members_pkey:p",
    "group_members:group_members_role_valid:c",
    "group_members:group_members_user_id_fkey:f",
    "group_messages:group_messages_attachment_id_fkey:f",
    "group_messages:group_messages_group_id_fkey:f",
    "group_messages:group_messages_pkey:p",
    "group_messages:group_messages_reply_to_message_id_fkey:f",
    "group_messages:group_messages_sender_id_fkey:f",
    "group_messages:group_messages_text_valid:c",
    "group_reads:group_reads_group_id_user_id_fkey:f",
    "group_reads:group_reads_last_read_message_id_fkey:f",
    "group_reads:group_reads_pkey:p",
    "groups:groups_created_by_fkey:f",
    "groups:groups_name_not_blank:c",
    "groups:groups_pkey:p",
    "messages:messages_attachment_id_fkey:f",
    "messages:messages_message_text_not_blank:c",
    "messages:messages_pkey:p",
    "messages:messages_receiver_id_fkey:f",
    "messages:messages_reply_to_message_id_fkey:f",
    "messages:messages_sender_id_fkey:f",
    "messages:messages_sender_name_not_blank:c",
    "messages:messages_status_valid:c",
    "profile_links:profile_links_label_valid:c",
    "profile_links:profile_links_pkey:p",
    "profile_links:profile_links_platform_valid:c",
    "profile_links:profile_links_url_valid:c",
    "profile_links:profile_links_user_id_fkey:f",
    "profile_privacy:profile_privacy_friend_list_valid:c",
    "profile_privacy:profile_privacy_mutual_valid:c",
    "profile_privacy:profile_privacy_online_valid:c",
    "profile_privacy:profile_privacy_pkey:p",
    "profile_privacy:profile_privacy_profile_valid:c",
    "profile_privacy:profile_privacy_user_id_fkey:f",
    "sessions:sessions_pkey:p",
    "sessions:sessions_token_hash_key:u",
    "sessions:sessions_user_id_fkey:f",
    "user_settings:user_settings_custom_status_valid:c",
    "user_settings:user_settings_pkey:p",
    "user_settings:user_settings_presence_valid:c",
    "user_settings:user_settings_text_size_valid:c",
    "user_settings:user_settings_user_id_fkey:f",
    "users:users_email_not_blank:c",
    "users:users_pkey:p",
    "users:users_username_not_blank:c",
  ].sort(),
);

const EXPECTED_INDEXES = new Set(
  [
    "chat_attachments:chat_attachments_owner_idx",
    "chat_attachments:chat_attachments_pkey",
    "chat_attachments:chat_attachments_storage_key_key",
    "favorite_friends:favorite_friends_pkey",
    "friend_requests:friend_requests_pkey",
    "friend_requests:friend_requests_receiver_status_idx",
    "friend_requests:friend_requests_sender_status_idx",
    "friend_requests:friend_requests_user_pair_unique_idx",
    "group_members:group_members_pkey",
    "group_members:group_members_user_idx",
    "group_members:group_single_owner_idx",
    "group_messages:group_messages_attachment_unique_idx",
    "group_messages:group_messages_history_idx",
    "group_messages:group_messages_pkey",
    "group_reads:group_reads_pkey",
    "groups:groups_pkey",
    "messages:messages_attachment_unique_idx",
    "messages:messages_created_at_id_idx",
    "messages:messages_due_ghost_idx",
    "messages:messages_pending_ghost_publish_idx",
    "messages:messages_pkey",
    "messages:messages_private_conversation_idx",
    "messages:messages_unread_receiver_sender_idx",
    "profile_links:profile_links_pkey",
    "profile_links:profile_links_user_idx",
    "profile_privacy:profile_privacy_pkey",
    "sessions:sessions_expires_at_idx",
    "sessions:sessions_pkey",
    "sessions:sessions_token_hash_key",
    "sessions:sessions_user_id_idx",
    "user_settings:user_settings_pkey",
    "users:users_email_lower_unique_idx",
    "users:users_pkey",
    "users:users_username_lower_unique_idx",
  ].sort(),
);

const sameSet = (actual: Set<string>, expected: Set<string>) =>
  actual.size === expected.size &&
  [...actual].every((value) => expected.has(value));

export const hasApplicationSchema = async (database: SQL) => {
  const names = Object.keys(EXPECTED_COLUMNS);
  const [row] = await database<{ count: number }[]>`
    SELECT count(*)::integer AS count
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name IN ${database(names)}
  `;
  return (row?.count ?? 0) > 0;
};

export const verifyBaselineSchema = async (database: SQL) => {
  const tables = Object.keys(EXPECTED_COLUMNS);
  const columns = await database<
    {
      tableName: string;
      columnName: string;
      type: string;
      nullable: "YES" | "NO";
    }[]
  >`
    SELECT table_name AS "tableName", column_name AS "columnName",
      udt_name AS type, is_nullable AS nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name IN ${database(tables)}
    ORDER BY table_name, ordinal_position
  `;
  for (const table of tables) {
    const actual = new Set(
      columns
        .filter((column) => column.tableName === table)
        .map(
          ({ columnName: name, type, nullable }) =>
            `${name}:${type}:${nullable}`,
        ),
    );
    const expected = new Set(
      EXPECTED_COLUMNS[table]!.map(
        ({ name, type, nullable }) => `${name}:${type}:${nullable}`,
      ),
    );
    if (!sameSet(actual, expected)) {
      throw new MigrationError(`schema drift detected in table ${table}.`);
    }
  }

  const constraints = await database<
    { tableName: string; name: string; type: string }[]
  >`
    SELECT relation.relname AS "tableName", constraint_record.conname AS name,
      constraint_record.contype::text AS type
    FROM pg_constraint constraint_record
    JOIN pg_class relation ON relation.oid = constraint_record.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND relation.relname IN ${database(tables)}
      AND constraint_record.contype <> 'n'
  `;
  const constraintSet = new Set(
    constraints.map((item) => `${item.tableName}:${item.name}:${item.type}`),
  );
  if (!sameSet(constraintSet, EXPECTED_CONSTRAINTS)) {
    throw new MigrationError("schema drift detected in constraints.");
  }

  const indexes = await database<{ tableName: string; name: string }[]>`
    SELECT tablename AS "tableName", indexname AS name
    FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename IN ${database(tables)}
  `;
  const indexSet = new Set(
    indexes.map((item) => `${item.tableName}:${item.name}`),
  );
  if (!sameSet(indexSet, EXPECTED_INDEXES)) {
    throw new MigrationError("schema drift detected in indexes.");
  }
};

const historyExists = async (database: SQL) => {
  const [row] = await database<{ exists: boolean }[]>`
    SELECT to_regclass(current_schema() || '.schema_migrations') IS NOT NULL AS exists
  `;
  return row?.exists ?? false;
};

const createHistory = (database: SQL) =>
  database.unsafe(`
    CREATE TABLE schema_migrations (
      version BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )
  `);

type HistoryRow = { version: string | number; name: string; checksum: string };

const readHistory = async (database: SQL): Promise<HistoryRow[]> =>
  (await historyExists(database))
    ? database<HistoryRow[]>`
        SELECT version, name, checksum FROM schema_migrations ORDER BY version
      `
    : [];

const assertHistoryCompatible = (
  history: HistoryRow[],
  migrations: Migration[],
) => {
  const manifest = new Map(
    migrations.map((migration) => [migration.version, migration]),
  );
  for (const row of history) {
    const migration = manifest.get(Number(row.version));
    if (!migration) {
      throw new MigrationError(`unknown applied migration ${row.version}.`);
    }
    if (
      row.name !== migration.name ||
      row.checksum.trim() !== migration.checksum
    ) {
      throw new MigrationError(
        `migration ${row.version} history/checksum drift detected.`,
      );
    }
  }
};

const recordMigration = (database: SQL, migration: Migration) =>
  database`
    INSERT INTO schema_migrations(version, name, checksum)
    VALUES(${migration.version}, ${migration.name}, ${migration.checksum})
  `;

export const getMigrationStatus = async (
  database: SQL,
  providedMigrations?: Migration[],
): Promise<MigrationStatus> => {
  const migrations = providedMigrations ?? (await loadMigrations());
  const history = await readHistory(database);
  assertHistoryCompatible(history, migrations);
  const applied = history.map((row) => Number(row.version));
  const pending = migrations
    .filter((migration) => !applied.includes(migration.version))
    .map((migration) => migration.version);
  const schemaVerified = pending.length === 0;
  if (schemaVerified) await verifyBaselineSchema(database);
  return { applied, pending, ready: schemaVerified, schemaVerified };
};

export const assertDatabaseReady = async (database: SQL) => {
  const status = await getMigrationStatus(database);
  if (!status.ready) {
    throw new MigrationError(
      `pending migrations: ${status.pending.join(", ") || "migration history is missing"}. Run the explicit migration command before startup.`,
    );
  }
};

const applyMigration = async (database: SQL, migration: Migration) => {
  const execute = async (connection: SQL) => {
    await connection.unsafe(migration.sql);
    await recordMigration(connection, migration);
  };
  if (migration.transactional) {
    await database.begin(execute);
  } else {
    await execute(database);
  }
};

export const migrateDatabase = async (
  pool: SQL,
  providedMigrations?: Migration[],
): Promise<MigrationStatus> => {
  const migrations = providedMigrations ?? (await loadMigrations());
  const database = await pool.reserve({ signal: AbortSignal.timeout(10_000) });
  let locked = false;
  try {
    await database`SELECT pg_advisory_lock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`;
    locked = true;
    let history = await readHistory(database);
    assertHistoryCompatible(history, migrations);

    for (const migration of migrations) {
      if (history.some((row) => Number(row.version) === migration.version))
        continue;
      const appSchemaExists = await hasApplicationSchema(database);
      const historyTableExists = await historyExists(database);

      if (migration.version === migrations[0]?.version && appSchemaExists) {
        // Adoption is read-only until the complete expected baseline passes.
        await verifyBaselineSchema(database);
        await database.begin(async (transaction) => {
          if (!historyTableExists) await createHistory(transaction);
          await recordMigration(transaction, migration);
        });
      } else {
        if (!historyTableExists) {
          await database.begin(async (transaction) => {
            await createHistory(transaction);
            await transaction.unsafe(migration.sql);
            await recordMigration(transaction, migration);
          });
        } else {
          await applyMigration(database, migration);
        }
      }
      history = await readHistory(database);
      assertHistoryCompatible(history, migrations);
    }
    return await getMigrationStatus(database, migrations);
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError(
      "migration execution failed; no later migration was run.",
    );
  } finally {
    if (locked) {
      try {
        await database`SELECT pg_advisory_unlock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`;
      } catch {
        // Releasing the reserved connection below also releases session locks.
      }
    }
    await database.release();
  }
};
