import type { SQL } from "bun";

export type SchemaIntegrityViolations = {
  invalidParticipants: number;
  duplicateDeliveryOrders: number;
  crossGroupReplies: number;
  crossGroupReads: number;
  invalidDisplayNames: number;
  invalidGhostStates: number;
  privateAttachmentOwnerMismatches: number;
  groupAttachmentOwnerMismatches: number;
};

export const getSchemaIntegrityViolations = async (
  database: SQL,
): Promise<SchemaIntegrityViolations> => {
  const [violations] = await database<SchemaIntegrityViolations[]>`
    SELECT
      (SELECT count(*)::integer FROM messages
        WHERE NOT (
          (sender_id IS NULL AND receiver_id IS NULL AND message_status = 'sent')
          OR
          (sender_id IS NOT NULL AND receiver_id IS NOT NULL AND sender_id <> receiver_id)
        )) AS "invalidParticipants",
      (SELECT count(*)::integer FROM (
        SELECT COALESCE(delivery_id, id)
        FROM messages
        WHERE sender_id IS NOT NULL AND receiver_id IS NOT NULL
        GROUP BY COALESCE(delivery_id, id)
        HAVING count(*) > 1
      ) duplicate_delivery) AS "duplicateDeliveryOrders",
      (SELECT count(*)::integer
        FROM group_messages reply
        JOIN group_messages original ON original.id = reply.reply_to_message_id
        WHERE reply.group_id <> original.group_id
      ) AS "crossGroupReplies",
      (SELECT count(*)::integer
        FROM group_reads reads
        JOIN group_messages message ON message.id = reads.last_read_message_id
        WHERE reads.group_id <> message.group_id
      ) AS "crossGroupReads",
      (SELECT count(*)::integer FROM users
        WHERE display_name IS NOT NULL
          AND char_length(btrim(display_name)) NOT BETWEEN 1 AND 80
      ) AS "invalidDisplayNames",
      (SELECT count(*)::integer FROM messages
        WHERE NOT (
          (message_status = 'sent'
            AND scheduled_at IS NULL
            AND (
              (released_at IS NULL AND delivery_id IS NULL AND ghost_publish_pending = FALSE)
              OR
              (released_at IS NOT NULL AND delivery_id IS NOT NULL)
            ))
          OR
          (message_status = 'ghost'
            AND scheduled_at IS NULL AND released_at IS NULL AND read_at IS NULL
            AND delivery_id IS NULL AND deleted_at IS NULL
            AND ghost_publish_pending = FALSE)
          OR
          (message_status = 'scheduled'
            AND scheduled_at IS NOT NULL AND released_at IS NULL AND read_at IS NULL
            AND delivery_id IS NULL AND deleted_at IS NULL
            AND ghost_publish_pending = FALSE)
          OR
          (message_status = 'cancelled'
            AND scheduled_at IS NULL AND released_at IS NULL AND read_at IS NULL
            AND delivery_id IS NULL AND deleted_at IS NOT NULL
            AND ghost_publish_pending = FALSE)
        )) AS "invalidGhostStates",
      (SELECT count(*)::integer
        FROM messages message
        JOIN chat_attachments attachment ON attachment.id = message.attachment_id
        WHERE message.sender_id IS NULL OR attachment.owner_id <> message.sender_id
      ) AS "privateAttachmentOwnerMismatches",
      (SELECT count(*)::integer
        FROM group_messages message
        JOIN chat_attachments attachment ON attachment.id = message.attachment_id
        WHERE attachment.owner_id <> message.sender_id
      ) AS "groupAttachmentOwnerMismatches"
  `;
  if (!violations)
    throw new Error("Schema integrity preflight returned no result.");
  return violations;
};

export const assertSchemaIntegrityPreflight = async (database: SQL) => {
  const violations = await getSchemaIntegrityViolations(database);
  const failed = Object.entries(violations).filter(([, count]) => count > 0);
  if (failed.length) {
    throw new Error(
      `Schema integrity preflight failed: ${failed
        .map(([category, count]) => `${category}=${count}`)
        .join(", ")}.`,
    );
  }
  return violations;
};
