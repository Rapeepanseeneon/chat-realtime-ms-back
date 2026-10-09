import { SQL } from "bun";
import {
  requireTestBackendPort,
  requireTestDatabase,
} from "../src/testing/test-environment";
import {
  parseDateIdCursor,
  parseFriendCursor,
  parseMemberCursor,
} from "../src/list-pagination";
import { parsePrivateHistoryCursor } from "../src/history-pagination";

type Tier = {
  name: "small" | "medium" | "large";
  friends: number;
  requestsEachDirection: number;
  groups: number;
  privateMessages: number;
  groupMessages: number;
  attachmentMetadata: number;
};

type Measurement = {
  tier: Tier["name"];
  path: string;
  repeats: number;
  medianMs: number;
  p95Ms: number;
  returnedRows: number;
};

type PlanObservation = {
  tier: Tier["name"];
  path: string;
  planningMs: number;
  executionMs: number;
  actualRows: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
  nodeTypes: string[];
  indexes: string[];
  sequentialScans: string[];
  sortMethods: string[];
};

const tiers: Tier[] = [
  {
    name: "small",
    friends: 20,
    requestsEachDirection: 20,
    groups: 8,
    privateMessages: 400,
    groupMessages: 400,
    attachmentMetadata: 40,
  },
  {
    name: "medium",
    friends: 80,
    requestsEachDirection: 80,
    groups: 30,
    privateMessages: 2_000,
    groupMessages: 2_000,
    attachmentMetadata: 180,
  },
  {
    name: "large",
    friends: 240,
    requestsEachDirection: 240,
    groups: 80,
    privateMessages: 6_000,
    groupMessages: 6_000,
    attachmentMetadata: 500,
  },
];

const prefix = "c45_perf_";
const testDatabase = requireTestDatabase();
const testPort = requireTestBackendPort();
if (testDatabase.databaseName !== "pb_messenger_test")
  throw new Error("C4.5 requires the dedicated pb_messenger_test database.");
if (testPort !== 3101)
  throw new Error("C4.5 requires isolated TEST_BACKEND_PORT 3101.");

Bun.env.DATABASE_URL = testDatabase.url;
Bun.env.PB_TEST_BACKEND = "1";
Bun.env.PORT = String(testPort);

const database = new SQL(testDatabase.url, { max: 4 });
const application = await import("../src/database");
await application.initializeDatabase();

const fixedStart = "2026-01-01T00:00:00.000Z";
const measurements: Measurement[] = [];
const plans: PlanObservation[] = [];
const tierCounts: Record<string, Record<string, number>> = {};
let prior: Tier = {
  name: "small",
  friends: 0,
  requestsEachDirection: 0,
  groups: 0,
  privateMessages: 0,
  groupMessages: 0,
  attachmentMetadata: 0,
};
let peakRssBytes = process.memoryUsage().rss;

const percentile = (sorted: number[], quantile: number) =>
  sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;

const measure = async (
  tier: Tier["name"],
  path: string,
  operation: () => Promise<number>,
  repeats = 16,
) => {
  for (let index = 0; index < 3; index += 1) await operation();
  const samples: number[] = [];
  let returnedRows = 0;
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    returnedRows = await operation();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  measurements.push({
    tier,
    path,
    repeats,
    medianMs: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    returnedRows,
  });
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
};

const planSummary = (
  tier: Tier["name"],
  path: string,
  raw: unknown,
): PlanObservation => {
  const top = Array.isArray(raw) ? raw[0] : raw;
  if (!top || typeof top !== "object")
    throw new Error(`Invalid EXPLAIN output for ${path}.`);
  const root = top as Record<string, unknown>;
  const plan = root.Plan as Record<string, unknown>;
  const nodeTypes = new Set<string>();
  const indexes = new Set<string>();
  const sequentialScans = new Set<string>();
  const sortMethods = new Set<string>();
  const visit = (node: Record<string, unknown>) => {
    const nodeType = String(node["Node Type"] ?? "Unknown");
    nodeTypes.add(nodeType);
    if (typeof node["Index Name"] === "string") indexes.add(node["Index Name"]);
    if (nodeType === "Seq Scan" && typeof node["Relation Name"] === "string")
      sequentialScans.add(node["Relation Name"]);
    if (typeof node["Sort Method"] === "string")
      sortMethods.add(String(node["Sort Method"]));
    if (Array.isArray(node.Plans))
      for (const child of node.Plans)
        if (child && typeof child === "object")
          visit(child as Record<string, unknown>);
  };
  visit(plan);
  return {
    tier,
    path,
    planningMs: Number(Number(root["Planning Time"] ?? 0).toFixed(3)),
    executionMs: Number(Number(root["Execution Time"] ?? 0).toFixed(3)),
    actualRows: Number(plan["Actual Rows"] ?? 0),
    sharedHitBlocks: Number(plan["Shared Hit Blocks"] ?? 0),
    sharedReadBlocks: Number(plan["Shared Read Blocks"] ?? 0),
    tempReadBlocks: Number(plan["Temp Read Blocks"] ?? 0),
    tempWrittenBlocks: Number(plan["Temp Written Blocks"] ?? 0),
    nodeTypes: [...nodeTypes],
    indexes: [...indexes],
    sequentialScans: [...sequentialScans],
    sortMethods: [...sortMethods],
  };
};

const explain = async (
  tier: Tier["name"],
  path: string,
  query: Promise<{ "QUERY PLAN": unknown }[]>,
) => {
  const rows = await query;
  const value = rows[0]?.["QUERY PLAN"];
  plans.push(planSummary(tier, path, value));
};

const userName = (index: number) =>
  `${prefix}${String(index).padStart(4, "0")}`;

const cleanup = async () => {
  await database`
    DELETE FROM groups
    WHERE created_by IN (SELECT id FROM users WHERE email LIKE ${`${prefix}%@example.test`})
  `;
  await database`DELETE FROM users WHERE email LIKE ${`${prefix}%@example.test`}`;
};

const seedTier = async (tier: Tier) => {
  const previousUsers = prior.requestsEachDirection * 3 + 1;
  const targetUsers = tier.requestsEachDirection * 3 + 1;
  if (targetUsers > previousUsers) {
    await database`
      INSERT INTO users(username,display_name,email,password_hash)
      SELECT ${prefix} || lpad(value::text,4,'0'),
        ${prefix} || lpad(value::text,4,'0'),
        ${prefix} || lpad(value::text,4,'0') || '@example.test',
        'c45-test-only'
      FROM generate_series(${previousUsers},${targetUsers - 1}) value
    `;
  }
  if (previousUsers === 1) {
    await database`
      INSERT INTO users(username,display_name,email,password_hash)
      VALUES(${userName(0)},${userName(0)},${`${userName(0)}@example.test`},'c45-test-only')
      ON CONFLICT DO NOTHING
    `;
  }
  const [root] = await database<{ id: string }[]>`
    SELECT id::text id FROM users WHERE username=${userName(0)}
  `;
  if (!root) throw new Error("Synthetic root user was not created.");

  if (tier.friends > prior.friends) {
    await database`
      INSERT INTO friend_requests(sender_id,receiver_id,status,created_at,updated_at)
      SELECT ${root.id}, friend.id, 'accepted',
        ${fixedStart}::timestamptz + (value / 2) * interval '1 millisecond',
        ${fixedStart}::timestamptz + (value / 2) * interval '1 millisecond'
      FROM generate_series(${prior.friends + 1},${tier.friends}) value
      JOIN users friend ON friend.username=${prefix} || lpad((value*3-2)::text,4,'0')
    `;
    await database`
      INSERT INTO friend_requests(sender_id,receiver_id,status,created_at,updated_at)
      SELECT friend.id, candidate.id, 'accepted',
        ${fixedStart}::timestamptz + value * interval '1 millisecond',
        ${fixedStart}::timestamptz + value * interval '1 millisecond'
      FROM generate_series(${prior.friends + 1},${tier.friends}) value
      JOIN users friend ON friend.username=${prefix} || lpad((value*3-2)::text,4,'0')
      JOIN users candidate ON candidate.username=${prefix} || lpad((value*3-1)::text,4,'0')
    `;
  }
  if (tier.requestsEachDirection > prior.requestsEachDirection) {
    await database`
      INSERT INTO friend_requests(sender_id,receiver_id,status,created_at,updated_at)
      SELECT sender.id, ${root.id}, 'pending',
        ${fixedStart}::timestamptz + (value / 2) * interval '1 millisecond',
        ${fixedStart}::timestamptz + (value / 2) * interval '1 millisecond'
      FROM generate_series(${prior.requestsEachDirection + 1},${tier.requestsEachDirection}) value
      JOIN users sender ON sender.username=${prefix} || lpad((value*3-1)::text,4,'0')
    `;
    await database`
      INSERT INTO friend_requests(sender_id,receiver_id,status,created_at,updated_at)
      SELECT ${root.id}, receiver.id, 'pending',
        ${fixedStart}::timestamptz + (value / 2) * interval '1 millisecond',
        ${fixedStart}::timestamptz + (value / 2) * interval '1 millisecond'
      FROM generate_series(${prior.requestsEachDirection + 1},${tier.requestsEachDirection}) value
      JOIN users receiver ON receiver.username=${prefix} || lpad((value*3)::text,4,'0')
    `;
  }
  if (tier.groups > prior.groups) {
    await database`
      INSERT INTO groups(name,created_by,created_at,updated_at)
      SELECT ${prefix} || 'group_' || lpad(value::text,4,'0'), ${root.id},
        ${fixedStart}::timestamptz + value * interval '1 second',
        ${fixedStart}::timestamptz + (value / 2) * interval '1 second'
      FROM generate_series(${prior.groups + 1},${tier.groups}) value
    `;
    await database`
      INSERT INTO group_members(group_id,user_id,role,joined_at)
      SELECT group_row.id, ${root.id}, 'owner', group_row.created_at
      FROM groups group_row
      WHERE group_row.name LIKE ${`${prefix}group_%`}
        AND substring(group_row.name from '[0-9]+$')::integer > ${prior.groups}
    `;
    await database`
      INSERT INTO group_members(group_id,user_id,role,joined_at)
      SELECT group_row.id, member.id, 'member',
        group_row.created_at + member_number * interval '1 millisecond'
      FROM groups group_row
      CROSS JOIN generate_series(1,${Math.min(tier.friends, 180)}) member_number
      JOIN users member ON member.username=${prefix} || lpad((member_number*3-2)::text,4,'0')
      WHERE group_row.name LIKE ${`${prefix}group_%`}
        AND substring(group_row.name from '[0-9]+$')::integer > ${prior.groups}
    `;
  }
  if (tier.privateMessages > prior.privateMessages) {
    await database`
      INSERT INTO messages(
        sender_name,sender_id,receiver_id,message_text,created_at,read_at,
        message_status,scheduled_at,released_at,delivery_id,state_updated_at
      )
      SELECT
        CASE WHEN value % 2 = 1 THEN ${userName(0)} ELSE friend.username END,
        CASE WHEN value % 2 = 1 THEN ${root.id}::bigint ELSE friend.id END,
        CASE WHEN value % 2 = 1 THEN friend.id ELSE ${root.id}::bigint END,
        ${prefix} || 'private_' || value,
        ${fixedStart}::timestamptz + (value / 2) * interval '1 millisecond',
        CASE
          WHEN value % 20 IN (1,3) THEN NULL
          WHEN value % 2 = 0 AND value % 4 = 0 THEN NULL
          ELSE ${fixedStart}::timestamptz
        END,
        CASE WHEN value % 20 = 1 THEN 'ghost'
          WHEN value % 20 = 3 THEN 'scheduled' ELSE 'sent' END,
        CASE WHEN value % 20 = 3 THEN clock_timestamp()+interval '7 days' ELSE NULL END,
        CASE WHEN value % 20 = 5 THEN ${fixedStart}::timestamptz + value * interval '1 millisecond' ELSE NULL END,
        CASE WHEN value % 20 = 5
          THEN nextval(pg_get_serial_sequence('messages','id')) ELSE NULL END,
        ${fixedStart}::timestamptz + value * interval '1 millisecond'
      FROM generate_series(${prior.privateMessages + 1},${tier.privateMessages}) value
      JOIN users friend ON friend.username=${prefix} || lpad((CASE
        WHEN value % 4 <> 0 THEN 1
        ELSE ((value-1) % ${tier.friends})*3+1
      END)::text,4,'0')
    `;
  }
  if (tier.groupMessages > prior.groupMessages) {
    await database`
      WITH target_groups AS (
        SELECT id,row_number() OVER(ORDER BY name) position
        FROM groups WHERE name LIKE ${`${prefix}group_%`}
      )
      INSERT INTO group_messages(group_id,sender_id,message_text,created_at)
      SELECT target.id, sender.user_id, ${prefix} || 'group_message_' || value,
        ${fixedStart}::timestamptz + (value / 2) * interval '1 millisecond'
      FROM generate_series(${prior.groupMessages + 1},${tier.groupMessages}) value
      JOIN target_groups target ON target.position=((value-1) % ${tier.groups})+1
      JOIN LATERAL (
        SELECT user_id FROM group_members
        WHERE group_id=target.id AND user_id<>${root.id}
        ORDER BY user_id LIMIT 1
      ) sender ON TRUE
    `;
    await database`
      WITH ranked AS (
        SELECT id,group_id,row_number() OVER(PARTITION BY group_id ORDER BY id) row_number,
          count(*) OVER(PARTITION BY group_id) total
        FROM group_messages
        WHERE message_text LIKE ${`${prefix}group_message_%`}
      ), boundaries AS (
        SELECT group_id,max(id) FILTER(WHERE row_number<=GREATEST(1,total/2)) boundary
        FROM ranked GROUP BY group_id
      )
      INSERT INTO group_reads(group_id,user_id,last_read_message_id)
      SELECT group_id,${root.id},boundary FROM boundaries
      ON CONFLICT(group_id,user_id) DO UPDATE
        SET last_read_message_id=EXCLUDED.last_read_message_id,updated_at=clock_timestamp()
    `;
  }
  if (tier.attachmentMetadata > prior.attachmentMetadata) {
    await database`
      INSERT INTO chat_attachments(owner_id,kind,storage_key,original_name,mime_type,size_bytes)
      SELECT ${root.id}, CASE WHEN value % 2=0 THEN 'image' ELSE 'file' END,
        ${prefix} || 'storage_' || value,
        ${prefix} || 'file_' || value || CASE WHEN value % 2=0 THEN '.png' ELSE '.txt' END,
        CASE WHEN value % 2=0 THEN 'image/png' ELSE 'text/plain' END,
        1024 + value
      FROM generate_series(${prior.attachmentMetadata + 1},${tier.attachmentMetadata}) value
    `;
  }
  await database`ANALYZE users,friend_requests,messages,groups,group_members,group_messages,group_reads,chat_attachments`;
  prior = tier;
  return root.id;
};

const countSyntheticRows = async () => {
  const [row] = await database<Record<string, number>[]>`
    SELECT
      (SELECT count(*)::integer FROM users WHERE email LIKE ${`${prefix}%@example.test`}) users,
      (SELECT count(*)::integer FROM friend_requests request
        WHERE request.sender_id IN (SELECT id FROM users WHERE email LIKE ${`${prefix}%@example.test`})
          AND request.receiver_id IN (SELECT id FROM users WHERE email LIKE ${`${prefix}%@example.test`})) friend_requests,
      (SELECT count(*)::integer FROM messages WHERE message_text LIKE ${`${prefix}%`}) messages,
      (SELECT count(*)::integer FROM groups WHERE name LIKE ${`${prefix}%`}) groups,
      (SELECT count(*)::integer FROM group_members member
        JOIN groups target ON target.id=member.group_id WHERE target.name LIKE ${`${prefix}%`}) group_members,
      (SELECT count(*)::integer FROM group_messages WHERE message_text LIKE ${`${prefix}%`}) group_messages,
      (SELECT count(*)::integer FROM chat_attachments WHERE storage_key LIKE ${`${prefix}%`}) attachments
  `;
  return row!;
};

const traversePages = async <T extends { id: string }>(
  load: (cursor: string | null) => Promise<{
    items: T[];
    hasMore: boolean;
    nextCursor: string | null;
  }>,
) => {
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await load(cursor);
    if (page.items.length > 50)
      throw new Error("Page exceeded requested bound.");
    ids.push(...page.items.map((item) => item.id));
    if (!page.hasMore) break;
    if (!page.nextCursor || cursors.has(page.nextCursor))
      throw new Error("Cursor traversal did not advance.");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
  if (new Set(ids).size !== ids.length)
    throw new Error("Stable traversal returned duplicate IDs.");
  return ids;
};

const runTier = async (tier: Tier, rootId: string) => {
  const [friend] = await database<{ id: string; email: string }[]>`
    SELECT id::text id,email FROM users WHERE username=${userName(1)}
  `;
  const [group] = await database<{ id: string }[]>`
    SELECT id::text id FROM groups WHERE name LIKE ${`${prefix}group_%`}
    ORDER BY updated_at DESC,id DESC LIMIT 1
  `;
  if (!friend || !group)
    throw new Error("Synthetic benchmark targets missing.");

  const privateFirst = await application.getPrivateMessages(rootId, friend.id, {
    limit: 50,
    before: null,
  });
  const privateCursor = privateFirst.nextCursor
    ? parsePrivateHistoryCursor(privateFirst.nextCursor)
    : null;
  const groupFirst = await application.getGroupMessages(group.id, rootId, {
    limit: 50,
    beforeId: null,
  });
  if (!groupFirst) throw new Error("Group history authorization failed.");

  await measure(
    tier.name,
    "private_history_newest",
    async () =>
      (
        await application.getPrivateMessages(rootId, friend.id, {
          limit: 50,
          before: null,
        })
      ).messages.length,
  );
  await measure(
    tier.name,
    "private_history_older",
    async () =>
      (
        await application.getPrivateMessages(rootId, friend.id, {
          limit: 50,
          before: privateCursor,
        })
      ).messages.length,
  );
  await measure(
    tier.name,
    "group_history_newest",
    async () =>
      (await application.getGroupMessages(group.id, rootId, {
        limit: 50,
        beforeId: null,
      }))!.messages.length,
  );
  await measure(
    tier.name,
    "group_history_older",
    async () =>
      (await application.getGroupMessages(group.id, rootId, {
        limit: 50,
        beforeId: groupFirst.nextBeforeId,
      }))!.messages.length,
  );
  const receivedFirst = await application.getReceivedFriendRequests(rootId, {
    limit: 50,
    cursor: null,
  });
  await measure(
    tier.name,
    "requests_received",
    async () =>
      (
        await application.getReceivedFriendRequests(rootId, {
          limit: 50,
          cursor: null,
        })
      ).items.length,
  );
  await measure(
    tier.name,
    "requests_received_older",
    async () =>
      (
        await application.getReceivedFriendRequests(rootId, {
          limit: 50,
          cursor: receivedFirst.nextCursor
            ? parseDateIdCursor("received", receivedFirst.nextCursor)
            : null,
        })
      ).items.length,
  );
  const sentFirst = await application.getSentFriendRequests(rootId, {
    limit: 50,
    cursor: null,
  });
  await measure(
    tier.name,
    "requests_sent",
    async () =>
      (
        await application.getSentFriendRequests(rootId, {
          limit: 50,
          cursor: null,
        })
      ).items.length,
  );
  await measure(
    tier.name,
    "requests_sent_older",
    async () =>
      (
        await application.getSentFriendRequests(rootId, {
          limit: 50,
          cursor: sentFirst.nextCursor
            ? parseDateIdCursor("sent", sentFirst.nextCursor)
            : null,
        })
      ).items.length,
  );
  await measure(
    tier.name,
    "friends_page",
    async () =>
      (await application.getFriendsPage(rootId, { limit: 50, cursor: null }))
        .items.length,
  );
  await measure(
    tier.name,
    "friends_full_traversal",
    async () =>
      (
        await traversePages((cursor) =>
          application.getFriendsPage(rootId, {
            limit: 50,
            cursor: cursor ? parseFriendCursor(cursor) : null,
          }),
        )
      ).length,
    8,
  );
  await measure(
    tier.name,
    "friends_realtime_complete_set",
    async () => (await application.getFriends(rootId)).length,
  );
  await measure(
    tier.name,
    "groups_page_with_aggregates",
    async () =>
      (await application.getGroups(rootId, { limit: 50, cursor: null })).items
        .length,
  );
  await measure(
    tier.name,
    "groups_full_traversal",
    async () =>
      (
        await traversePages((cursor) =>
          application.getGroups(rootId, {
            limit: 50,
            cursor: cursor ? parseDateIdCursor("groups", cursor) : null,
          }),
        )
      ).length,
    8,
  );
  await measure(
    tier.name,
    "group_members_page",
    async () =>
      (await application.getGroupInfo(group.id, rootId, {
        limit: 50,
        cursor: null,
      }))!.members.length,
  );
  await measure(
    tier.name,
    "group_members_full_traversal",
    async () => {
      let cursor: string | null = null;
      const ids: string[] = [];
      do {
        const info = await application.getGroupInfo(group.id, rootId, {
          limit: 50,
          cursor: cursor ? parseMemberCursor(cursor) : null,
        });
        if (!info) throw new Error("Group membership disappeared.");
        ids.push(...info.members.map((member) => member.id));
        cursor = info.memberPage.hasMore ? info.memberPage.nextCursor : null;
      } while (cursor);
      return ids.length;
    },
    8,
  );
  await measure(tier.name, "group_broadcast_member_batching", async () => {
    let count = 0;
    for await (const _id of application.iterateGroupMemberIds(group.id, 50))
      count += 1;
    return count;
  });
  await measure(
    tier.name,
    "username_substring_search",
    async () => (await application.searchUsers(rootId, "perf_0")).length,
  );
  await measure(
    tier.name,
    "exact_email_search",
    async () => (await application.searchUsers(rootId, friend.email)).length,
  );
  await measure(
    tier.name,
    "friend_suggestions",
    async () => (await application.getFriendSuggestions(rootId)).length,
  );
  await measure(
    tier.name,
    "unread_counts",
    async () => (await application.getUnreadCounts(rootId)).length,
  );
  await measure(
    tier.name,
    "ghost_sender_visibility",
    async () =>
      (
        await application.getPrivateMessages(rootId, friend.id, {
          limit: 50,
          before: null,
        })
      ).messages.length,
  );
  const inspectVisibility = async (viewerId: string, otherId: string) => {
    let before: ReturnType<typeof parsePrivateHistoryCursor> = null;
    let hidden = 0;
    let pages = 0;
    do {
      const page = await application.getPrivateMessages(viewerId, otherId, {
        limit: 100,
        before,
      });
      hidden += page.messages.filter(
        (message) => message.messageStatus !== "sent",
      ).length;
      pages += 1;
      before = page.nextCursor
        ? parsePrivateHistoryCursor(page.nextCursor)
        : null;
      if (!page.hasMore) break;
    } while (before && pages < 10);
    return hidden;
  };
  if ((await inspectVisibility(rootId, friend.id)) === 0)
    throw new Error("Sender could not see a synthetic hidden ghost.");
  if ((await inspectVisibility(friend.id, rootId)) !== 0)
    throw new Error("Receiver history leaked a hidden ghost.");

  const friendIds = await traversePages((cursor) =>
    application.getFriendsPage(rootId, {
      limit: 50,
      cursor: cursor ? parseFriendCursor(cursor) : null,
    }),
  );
  const groupIds = await traversePages((cursor) =>
    application.getGroups(rootId, {
      limit: 50,
      cursor: cursor ? parseDateIdCursor("groups", cursor) : null,
    }),
  );
  const memberIds = await traversePages(async (cursor) => {
    const info = await application.getGroupInfo(group.id, rootId, {
      limit: 50,
      cursor: cursor ? parseMemberCursor(cursor) : null,
    });
    if (!info) throw new Error("Group member traversal lost authorization.");
    return {
      items: info.members,
      hasMore: info.memberPage.hasMore,
      nextCursor: info.memberPage.nextCursor,
    };
  });
  const broadcastIds: string[] = [];
  for await (const id of application.iterateGroupMemberIds(group.id, 17))
    broadcastIds.push(id);
  if (new Set(broadcastIds).size !== broadcastIds.length)
    throw new Error("Broadcast batching returned duplicate members.");
  if (broadcastIds.length !== memberIds.length)
    throw new Error("Broadcast batching did not reach every group member.");
  if (friendIds.length !== tier.friends)
    throw new Error(`Friend traversal mismatch: ${friendIds.length}.`);
  if (groupIds.length !== tier.groups)
    throw new Error(`Group traversal mismatch: ${groupIds.length}.`);

  const boundary = await database<{ id: string }[]>`
    SELECT id::text id FROM messages
    WHERE receiver_id=${rootId} AND sender_id=${friend.id} AND message_status='sent'
    ORDER BY COALESCE(delivery_id,id) DESC LIMIT 1
  `;
  if (boundary[0])
    await measure(tier.name, "read_seen_boundary", async () =>
      (await application.markMessagesRead(rootId, friend.id, boundary[0]!.id))
        ? 1
        : 0,
    );

  await explain(
    tier.name,
    "private_history_newest",
    database<{ "QUERY PLAN": unknown }[]>`
      EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT id FROM messages
      WHERE LEAST(sender_id,receiver_id)=LEAST(${rootId}::bigint,${friend.id}::bigint)
        AND GREATEST(sender_id,receiver_id)=GREATEST(${rootId}::bigint,${friend.id}::bigint)
        AND (message_status='sent' OR (sender_id=${rootId} AND message_status IN ('ghost','scheduled')))
      ORDER BY COALESCE(released_at,created_at) DESC,id DESC LIMIT 51
    `,
  );
  await explain(
    tier.name,
    "received_requests",
    database<{ "QUERY PLAN": unknown }[]>`
      EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT id FROM friend_requests
      WHERE receiver_id=${rootId} AND status='pending'
      ORDER BY created_at DESC,id DESC LIMIT 51
    `,
  );
  await explain(
    tier.name,
    "friends_page",
    database<{ "QUERY PLAN": unknown }[]>`
      EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT users.id FROM friend_requests request
      JOIN users ON users.id=CASE WHEN request.sender_id=${rootId}
        THEN request.receiver_id ELSE request.sender_id END
      WHERE request.status='accepted'
        AND (request.sender_id=${rootId} OR request.receiver_id=${rootId})
      ORDER BY lower(users.username),users.id LIMIT 51
    `,
  );
  await explain(
    tier.name,
    "groups_page",
    database<{ "QUERY PLAN": unknown }[]>`
      EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT target.id FROM group_members membership
      JOIN groups target ON target.id=membership.group_id
      WHERE membership.user_id=${rootId}
      ORDER BY target.updated_at DESC,target.id DESC LIMIT 51
    `,
  );
  await explain(
    tier.name,
    "group_history",
    database<{ "QUERY PLAN": unknown }[]>`
      EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT id FROM group_messages WHERE group_id=${group.id}
      ORDER BY id DESC LIMIT 51
    `,
  );
  await explain(
    tier.name,
    "group_members",
    database<{ "QUERY PLAN": unknown }[]>`
      EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT user_id FROM group_members WHERE group_id=${group.id}
      ORDER BY CASE WHEN role='owner' THEN 0 ELSE 1 END,joined_at,user_id LIMIT 51
    `,
  );
  await explain(
    tier.name,
    "username_substring",
    database<{ "QUERY PLAN": unknown }[]>`
      EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT id FROM users WHERE lower(username) LIKE '%perf_0%' ORDER BY lower(username) LIMIT 10
    `,
  );
  await explain(
    tier.name,
    "username_trigram_probe",
    database<{ "QUERY PLAN": unknown }[]>`
      EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT id FROM users WHERE lower(username) LIKE '%perf_05%'
    `,
  );
  await explain(
    tier.name,
    "exact_email",
    database<{ "QUERY PLAN": unknown }[]>`
      EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT id FROM users WHERE lower(email)=lower(${friend.email})
    `,
  );
  await explain(
    tier.name,
    "scheduled_ghost_due",
    database<{ "QUERY PLAN": unknown }[]>`
      EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT id FROM messages
      WHERE message_status='scheduled' AND scheduled_at<=clock_timestamp()
        AND deleted_at IS NULL AND released_at IS NULL
      ORDER BY scheduled_at,id LIMIT 50
    `,
  );

  tierCounts[tier.name] = await countSyntheticRows();
};

const startedRssBytes = process.memoryUsage().rss;
const [databaseBefore] = await database<{ bytes: string }[]>`
  SELECT pg_database_size(current_database())::text bytes
`;
let databasePeakBytes = Number(databaseBefore!.bytes);

try {
  await database`SELECT pg_advisory_lock(4450005)`;
  await cleanup();
  for (const tier of tiers) {
    const rootId = await seedTier(tier);
    await runTier(tier, rootId);
    const [size] = await database<{ bytes: string }[]>`
      SELECT pg_database_size(current_database())::text bytes
    `;
    databasePeakBytes = Math.max(databasePeakBytes, Number(size!.bytes));
  }
  const indexes = await database<{ indexname: string; indexdef: string }[]>`
    SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND indexname IN (
      'messages_private_effective_history_idx','users_username_lower_trgm_idx',
      'friend_requests_receiver_status_idx','friend_requests_sender_status_idx',
      'group_single_owner_idx'
    ) ORDER BY indexname
  `;
  if (indexes.length !== 5)
    throw new Error("One or more required Migration 003 indexes are missing.");
  const [locks] = await database<{ waiting: number }[]>`
    SELECT count(*)::integer waiting FROM pg_locks WHERE granted=FALSE
  `;
  console.log(
    JSON.stringify(
      {
        environment: {
          postgresVersion: (
            await database<
              { version: string }[]
            >`SELECT current_setting('server_version') version`
          )[0]!.version,
          database: testDatabase.databaseName,
          testPort,
          repeatCount: 16,
          warmupCount: 3,
        },
        tiers,
        tierCounts,
        measurements,
        plans,
        indexes,
        resources: {
          startedRssBytes,
          peakRssBytes,
          databaseBeforeBytes: Number(databaseBefore!.bytes),
          databasePeakBytes,
          waitingLocks: locks!.waiting,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await cleanup();
  await database`SELECT pg_advisory_unlock(4450005)`;
  await database.close();
}
