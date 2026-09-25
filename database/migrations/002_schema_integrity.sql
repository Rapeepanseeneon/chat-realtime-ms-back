DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM messages
    WHERE NOT (
      (sender_id IS NULL AND receiver_id IS NULL AND message_status = 'sent')
      OR
      (sender_id IS NOT NULL AND receiver_id IS NOT NULL AND sender_id <> receiver_id)
    )
  ) THEN
    RAISE EXCEPTION 'C3 preflight failed: invalid message participants';
  END IF;

  IF EXISTS (
    SELECT 1 FROM messages
    WHERE sender_id IS NOT NULL AND receiver_id IS NOT NULL
    GROUP BY COALESCE(delivery_id, id)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'C3 preflight failed: duplicate private delivery order';
  END IF;

  IF EXISTS (
    SELECT 1 FROM group_messages reply
    JOIN group_messages original ON original.id = reply.reply_to_message_id
    WHERE reply.group_id <> original.group_id
  ) THEN
    RAISE EXCEPTION 'C3 preflight failed: cross-group reply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM group_reads reads
    JOIN group_messages message ON message.id = reads.last_read_message_id
    WHERE reads.group_id <> message.group_id
  ) THEN
    RAISE EXCEPTION 'C3 preflight failed: cross-group read marker';
  END IF;

  IF EXISTS (
    SELECT 1 FROM users
    WHERE display_name IS NOT NULL
      AND char_length(btrim(display_name)) NOT BETWEEN 1 AND 80
  ) THEN
    RAISE EXCEPTION 'C3 preflight failed: invalid display name';
  END IF;

  IF EXISTS (
    SELECT 1 FROM messages
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
    )
  ) THEN
    RAISE EXCEPTION 'C3 preflight failed: invalid Ghost state';
  END IF;

  IF EXISTS (
    SELECT 1 FROM messages message
    JOIN chat_attachments attachment ON attachment.id = message.attachment_id
    WHERE message.sender_id IS NULL OR attachment.owner_id <> message.sender_id
  ) THEN
    RAISE EXCEPTION 'C3 preflight failed: private attachment owner mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM group_messages message
    JOIN chat_attachments attachment ON attachment.id = message.attachment_id
    WHERE attachment.owner_id <> message.sender_id
  ) THEN
    RAISE EXCEPTION 'C3 preflight failed: group attachment owner mismatch';
  END IF;
END $$;

ALTER TABLE users
  ADD CONSTRAINT users_display_name_valid
  CHECK (display_name IS NULL OR char_length(btrim(display_name)) BETWEEN 1 AND 80);

ALTER TABLE messages
  ADD CONSTRAINT messages_participants_valid
  CHECK (
    (sender_id IS NULL AND receiver_id IS NULL AND message_status = 'sent')
    OR
    (sender_id IS NOT NULL AND receiver_id IS NOT NULL AND sender_id <> receiver_id)
  ),
  ADD CONSTRAINT messages_state_consistency
  CHECK (
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
  ),
  ADD CONSTRAINT messages_attachment_requires_sender
  CHECK (attachment_id IS NULL OR sender_id IS NOT NULL);

CREATE UNIQUE INDEX messages_private_delivery_order_unique_idx
  ON messages ((COALESCE(delivery_id, id)))
  WHERE sender_id IS NOT NULL AND receiver_id IS NOT NULL;

ALTER TABLE chat_attachments
  ADD CONSTRAINT chat_attachments_id_owner_unique UNIQUE (id, owner_id);

ALTER TABLE messages
  ADD CONSTRAINT messages_attachment_owner_fkey
  FOREIGN KEY (attachment_id, sender_id)
  REFERENCES chat_attachments(id, owner_id)
  ON DELETE SET NULL (attachment_id);

ALTER TABLE group_messages
  ADD CONSTRAINT group_messages_group_id_id_unique UNIQUE (group_id, id),
  ADD CONSTRAINT group_messages_reply_same_group_fkey
  FOREIGN KEY (group_id, reply_to_message_id)
  REFERENCES group_messages(group_id, id)
  ON DELETE SET NULL (reply_to_message_id),
  ADD CONSTRAINT group_messages_attachment_owner_fkey
  FOREIGN KEY (attachment_id, sender_id)
  REFERENCES chat_attachments(id, owner_id)
  ON DELETE SET NULL (attachment_id);

ALTER TABLE group_reads
  ADD CONSTRAINT group_reads_message_same_group_fkey
  FOREIGN KEY (group_id, last_read_message_id)
  REFERENCES group_messages(group_id, id)
  ON DELETE SET NULL (last_read_message_id);
