import { expect, test } from "bun:test";
import { SQL } from "bun";
import { loadMigrations, migrateDatabase } from "../src/migrations";
import {
  assertSchemaIntegrityPreflight,
  getSchemaIntegrityViolations,
} from "../src/schema-integrity";
import { requireTestDatabase } from "../src/testing/test-environment";

const testDatabase = Bun.env.TEST_DATABASE_URL ? requireTestDatabase() : null;

const expectConstraint = async (
  operation: PromiseLike<unknown>,
  constraint: string,
) => {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(constraint);
};

(testDatabase ? test : test.skip)(
  "C3 relational invariants accept valid states and reject invalid states",
  async () => {
    if (!testDatabase) throw new Error("Missing TEST_DATABASE_URL");
    const admin = new SQL(testDatabase.url, { max: 1 });
    const schema = `schema_integrity_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(testDatabase.url);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const database = new SQL(url.toString(), { max: 3 });

    try {
      const status = await migrateDatabase(database);
      expect(status.applied).toEqual([1, 2]);

      const users = await database<{ id: string }[]>`
        INSERT INTO users(username, display_name, email, password_hash)
        VALUES
          ('Integrity A', 'Integrity A', 'integrity-a@example.test', 'hash'),
          ('Integrity B', 'Integrity B', 'integrity-b@example.test', 'hash'),
          ('Integrity C', NULL, 'integrity-c@example.test', 'hash')
        RETURNING id::text AS id
      `;
      const [a, b, c] = users;
      if (!a || !b || !c) throw new Error("Test users were not created");

      // Legacy global and valid private/Ghost states remain supported.
      await database`
        INSERT INTO messages(sender_name, message_text)
        VALUES('Legacy', 'global')
      `;
      const [privateMessage] = await database<{ id: string }[]>`
        INSERT INTO messages(sender_name, sender_id, receiver_id, message_text)
        VALUES('Integrity A', ${a.id}, ${b.id}, 'private')
        RETURNING id::text AS id
      `;
      await database`
        INSERT INTO messages(sender_name, sender_id, receiver_id, message_text, message_status, state_updated_at)
        VALUES('Integrity A', ${a.id}, ${b.id}, 'held', 'ghost', clock_timestamp())
      `;
      await database`
        INSERT INTO messages(sender_name, sender_id, receiver_id, message_text, message_status, scheduled_at, state_updated_at)
        VALUES('Integrity A', ${a.id}, ${b.id}, 'later', 'scheduled', clock_timestamp() + interval '1 hour', clock_timestamp())
      `;
      await database`
        INSERT INTO messages(sender_name, sender_id, receiver_id, message_text, message_status, deleted_at, state_updated_at)
        VALUES('Integrity A', ${a.id}, ${b.id}, '', 'cancelled', clock_timestamp(), clock_timestamp())
      `;

      await expectConstraint(
        database`
          INSERT INTO messages(sender_name, sender_id, message_text)
          VALUES('Integrity A', ${a.id}, 'partial participants')
        `,
        "messages_participants_valid",
      );
      await expectConstraint(
        database`
          INSERT INTO messages(sender_name, sender_id, receiver_id, message_text)
          VALUES('Integrity A', ${a.id}, ${a.id}, 'self message')
        `,
        "messages_participants_valid",
      );
      await expectConstraint(
        database`
          INSERT INTO messages(sender_name, sender_id, receiver_id, message_text, scheduled_at)
          VALUES('Integrity A', ${a.id}, ${b.id}, 'invalid sent state', clock_timestamp())
        `,
        "messages_state_consistency",
      );
      await expectConstraint(
        database`
          INSERT INTO messages(sender_name, sender_id, receiver_id, message_text, message_status, deleted_at, state_updated_at)
          VALUES('Integrity A', ${a.id}, ${b.id}, 'invalid ghost', 'ghost', clock_timestamp(), clock_timestamp())
        `,
        "messages_state_consistency",
      );
      await expectConstraint(
        database`
          INSERT INTO messages(sender_name, sender_id, receiver_id, message_text, released_at, delivery_id)
          VALUES('Integrity A', ${a.id}, ${b.id}, 'duplicate order', clock_timestamp(), ${privateMessage!.id})
        `,
        "messages_private_delivery_order_unique_idx",
      );
      await expectConstraint(
        database`
          INSERT INTO users(username, display_name, email, password_hash)
          VALUES('Invalid Display', '   ', 'invalid-display@example.test', 'hash')
        `,
        "users_display_name_valid",
      );

      const groups = await database<{ id: string }[]>`
        INSERT INTO groups(name, created_by)
        VALUES('Integrity One', ${a.id}), ('Integrity Two', ${a.id})
        RETURNING id::text AS id
      `;
      const [groupOne, groupTwo] = groups;
      if (!groupOne || !groupTwo)
        throw new Error("Test groups were not created");
      await database`
        INSERT INTO group_members(group_id, user_id, role)
        VALUES
          (${groupOne.id}, ${a.id}, 'owner'),
          (${groupOne.id}, ${b.id}, 'member'),
          (${groupTwo.id}, ${a.id}, 'owner'),
          (${groupTwo.id}, ${b.id}, 'member')
      `;
      const [originalOne] = await database<{ id: string }[]>`
        INSERT INTO group_messages(group_id, sender_id, message_text)
        VALUES(${groupOne.id}, ${a.id}, 'group one')
        RETURNING id::text AS id
      `;
      const [originalTwo] = await database<{ id: string }[]>`
        INSERT INTO group_messages(group_id, sender_id, message_text)
        VALUES(${groupTwo.id}, ${a.id}, 'group two')
        RETURNING id::text AS id
      `;
      await database`
        INSERT INTO group_messages(group_id, sender_id, message_text, reply_to_message_id)
        VALUES(${groupOne.id}, ${b.id}, 'valid reply', ${originalOne!.id})
      `;
      await expectConstraint(
        database`
          INSERT INTO group_messages(group_id, sender_id, message_text, reply_to_message_id)
          VALUES(${groupOne.id}, ${b.id}, 'cross reply', ${originalTwo!.id})
        `,
        "group_messages_reply_same_group_fkey",
      );
      await database`
        INSERT INTO group_reads(group_id, user_id, last_read_message_id)
        VALUES(${groupOne.id}, ${b.id}, ${originalOne!.id})
      `;
      await expectConstraint(
        database`
          UPDATE group_reads SET last_read_message_id=${originalTwo!.id}
          WHERE group_id=${groupOne.id} AND user_id=${b.id}
        `,
        "group_reads_message_same_group_fkey",
      );

      const attachments = await database<{ id: string }[]>`
        INSERT INTO chat_attachments(owner_id, kind, storage_key, original_name, mime_type, size_bytes)
        VALUES
          (${a.id}, 'file', 'integrity-private-valid', 'valid.txt', 'text/plain', 1),
          (${a.id}, 'file', 'integrity-private-invalid', 'invalid.txt', 'text/plain', 1),
          (${a.id}, 'file', 'integrity-group-valid', 'valid-group.txt', 'text/plain', 1),
          (${a.id}, 'file', 'integrity-group-invalid', 'invalid-group.txt', 'text/plain', 1)
        RETURNING id::text AS id
      `;
      await database`
        INSERT INTO messages(sender_name, sender_id, receiver_id, message_text, attachment_id)
        VALUES('Integrity A', ${a.id}, ${b.id}, '', ${attachments[0]!.id})
      `;
      await expectConstraint(
        database`
          INSERT INTO messages(sender_name, sender_id, receiver_id, message_text, attachment_id)
          VALUES('Integrity B', ${b.id}, ${a.id}, '', ${attachments[1]!.id})
        `,
        "messages_attachment_owner_fkey",
      );
      await database`
        INSERT INTO group_messages(group_id, sender_id, message_text, attachment_id)
        VALUES(${groupOne.id}, ${a.id}, '', ${attachments[2]!.id})
      `;
      await expectConstraint(
        database`
          INSERT INTO group_messages(group_id, sender_id, message_text, attachment_id)
          VALUES(${groupOne.id}, ${b.id}, '', ${attachments[3]!.id})
        `,
        "group_messages_attachment_owner_fkey",
      );

      expect(await assertSchemaIntegrityPreflight(database)).toEqual({
        invalidParticipants: 0,
        duplicateDeliveryOrders: 0,
        crossGroupReplies: 0,
        crossGroupReads: 0,
        invalidDisplayNames: 0,
        invalidGhostStates: 0,
        privateAttachmentOwnerMismatches: 0,
        groupAttachmentOwnerMismatches: 0,
      });
    } finally {
      await database.close();
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.close();
    }
  },
  30_000,
);

(testDatabase ? test : test.skip)(
  "C3 preflight reports legacy violations before migration metadata advances",
  async () => {
    if (!testDatabase) throw new Error("Missing TEST_DATABASE_URL");
    const admin = new SQL(testDatabase.url, { max: 1 });
    const schema = `schema_integrity_drift_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(testDatabase.url);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const database = new SQL(url.toString(), { max: 2 });

    try {
      const migrations = await loadMigrations();
      await database.begin((transaction) =>
        transaction.unsafe(migrations[0]!.sql),
      );
      const [user] = await database<{ id: string }[]>`
        INSERT INTO users(username, email, password_hash)
        VALUES('Preflight User', 'preflight@example.test', 'hash')
        RETURNING id::text AS id
      `;
      await database`
        INSERT INTO messages(sender_name, sender_id, message_text)
        VALUES('Preflight User', ${user!.id}, 'invalid partial participants')
      `;

      expect(
        (await getSchemaIntegrityViolations(database)).invalidParticipants,
      ).toBe(1);
      await expect(assertSchemaIntegrityPreflight(database)).rejects.toThrow(
        "invalidParticipants=1",
      );
      await expect(migrateDatabase(database, migrations)).rejects.toThrow(
        "migration execution failed",
      );
      const history = await database<{ version: number }[]>`
        SELECT version::integer AS version FROM schema_migrations ORDER BY version
      `;
      expect(history.map((row) => row.version)).toEqual([1]);
    } finally {
      await database.close();
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.close();
    }
  },
  30_000,
);
