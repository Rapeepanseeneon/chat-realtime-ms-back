import type { WSContext } from "hono/ws";
import {
  areFriends,
  getFriends,
  getUserSettings,
  getUnreadCounts,
  markMessagesRead,
  type PublicUser,
  type UnreadCount,
} from "./database";

export type StatusClientEvent =
  | { type: "chat.sync" }
  | { type: "message.read"; friendId: string; throughMessageId: string }
  | { type: "typing.start"; receiverId: string }
  | { type: "typing.stop"; receiverId: string };

export type FriendStatus = {
  id: string;
  online: boolean;
  status: "online" | "away" | "dnd" | "offline";
  customStatus: string;
  presenceRevision: number;
  unreadCount: number;
};

export type StatusServerEvent =
  | { type: "chat.state"; friends: FriendStatus[]; unreadRevision: number }
  | { type: "unread.update"; counts: UnreadCount[]; revision: number }
  | {
      type: "presence.update";
      userId: string;
      online: boolean;
      status: "online" | "away" | "dnd" | "offline";
      customStatus: string;
      revision: number;
    }
  | { type: "typing.start" | "typing.stop"; userId: string; receiverId: string }
  | {
      type: "message.read";
      readerId: string;
      senderId: string;
      throughMessageId: string;
      throughDeliveryId: string;
      readAt: string;
    }
  | { type: "error"; data: { message: string } };

type Transport = {
  keyFor: (client: WSContext) => unknown;
  clientsFor: (userId: string) => Iterable<WSContext>;
  isOnline: (userId: string) => boolean;
  sendToUser: (userId: string, event: StatusServerEvent) => void;
  sendToClient: (client: WSContext, event: StatusServerEvent) => void;
};

type TypingState = {
  timer: ReturnType<typeof setTimeout>;
  lastSentAt: number;
};

// Uses the existing authenticated connection registry; no additional sockets.
export class ChatStatusTracker {
  private readonly presenceRevisions = new Map<string, number>();
  private readonly unreadRevisions = new Map<string, number>();
  private readonly typingByClient = new Map<
    unknown,
    Map<string, TypingState>
  >();

  constructor(private readonly transport: Transport) {}

  private nextUnreadRevision(userId: string) {
    const revision = (this.unreadRevisions.get(userId) ?? 0) + 1;
    this.unreadRevisions.set(userId, revision);
    return revision;
  }

  private async publishPresence(userId: string) {
    const [friends, settings] = await Promise.all([
      getFriends(userId),
      getUserSettings(userId),
    ]);
    const publiclyOnline =
      this.transport.isOnline(userId) &&
      settings.showOnlineStatus &&
      settings.presenceStatus !== "invisible";
    // Recheck after the query so a slow open notification cannot overwrite close.
    const event: StatusServerEvent = {
      type: "presence.update",
      userId,
      online: publiclyOnline,
      status:
        publiclyOnline && settings.presenceStatus !== "invisible"
          ? settings.presenceStatus
          : "offline",
      customStatus: publiclyOnline ? settings.customStatus : "",
      revision: this.presenceRevisions.get(userId) ?? 0,
    };
    for (const friend of friends) this.transport.sendToUser(friend.id, event);
  }

  settingsChanged(userId: string) {
    this.presenceRevisions.set(
      userId,
      (this.presenceRevisions.get(userId) ?? 0) + 1,
    );
    return this.publishPresence(userId);
  }

  connected(user: PublicUser, client: WSContext, firstConnection: boolean) {
    if (firstConnection) {
      this.presenceRevisions.set(
        user.id,
        (this.presenceRevisions.get(user.id) ?? 0) + 1,
      );
      void this.publishPresence(user.id).catch((error) =>
        console.error("Failed to publish presence", error),
      );
    }
    void this.sync(user.id, client).catch((error) =>
      console.error("Failed to synchronize chat status", error),
    );
  }

  disconnected(userId: string, client: WSContext, lastConnection: boolean) {
    const key = this.transport.keyFor(client);
    for (const receiverId of [
      ...(this.typingByClient.get(key)?.keys() ?? []),
    ]) {
      this.stopTyping(userId, key, receiverId);
    }
    if (lastConnection) {
      this.presenceRevisions.set(
        userId,
        (this.presenceRevisions.get(userId) ?? 0) + 1,
      );
      void this.publishPresence(userId).catch((error) =>
        console.error("Failed to publish presence", error),
      );
    }
  }

  async sync(userId: string, client: WSContext) {
    const unreadRevision = this.nextUnreadRevision(userId);
    const [friends, counts] = await Promise.all([
      getFriends(userId),
      getUnreadCounts(userId),
    ]);
    const friendSettings = new Map(
      await Promise.all(
        friends.map(async (friend) => [
          friend.id,
          await getUserSettings(friend.id),
        ] as const),
      ),
    );
    const countByFriend = new Map(
      counts.map((count) => [count.friendId, count.unreadCount]),
    );
    this.transport.sendToClient(client, {
      type: "chat.state",
      unreadRevision,
      friends: friends.map((friend) => {
        const settings = friendSettings.get(friend.id)!;
        const publiclyOnline =
          this.transport.isOnline(friend.id) &&
          settings.showOnlineStatus &&
          settings.presenceStatus !== "invisible";
        return {
          id: friend.id,
          online: publiclyOnline,
          status:
            publiclyOnline && settings.presenceStatus !== "invisible"
              ? settings.presenceStatus
              : "offline",
          customStatus: publiclyOnline ? settings.customStatus : "",
          presenceRevision: this.presenceRevisions.get(friend.id) ?? 0,
          unreadCount: countByFriend.get(friend.id) ?? 0,
        };
      }),
    });
  }

  async publishUnread(userId: string, pool?: import("bun").SQL) {
    // Assign before the query. Clients discard out-of-order snapshots.
    const revision = this.nextUnreadRevision(userId);
    const counts = await getUnreadCounts(userId, pool);
    this.transport.sendToUser(userId, {
      type: "unread.update",
      counts,
      revision,
    });
  }

  private isTyping(userId: string, receiverId: string) {
    for (const client of this.transport.clientsFor(userId)) {
      if (
        this.typingByClient.get(this.transport.keyFor(client))?.has(receiverId)
      )
        return true;
    }
    return false;
  }

  stopTyping(userId: string, key: unknown, receiverId: string) {
    const recipients = this.typingByClient.get(key);
    const state = recipients?.get(receiverId);
    if (!state) return;
    clearTimeout(state.timer);
    recipients?.delete(receiverId);
    if (recipients?.size === 0) this.typingByClient.delete(key);
    if (!this.isTyping(userId, receiverId)) {
      this.transport.sendToUser(receiverId, {
        type: "typing.stop",
        userId,
        receiverId,
      });
    }
  }

  private startTyping(userId: string, client: WSContext, receiverId: string) {
    const key = this.transport.keyFor(client);
    const recipients =
      this.typingByClient.get(key) ?? new Map<string, TypingState>();
    // A single tab types in only one conversation at a time.
    for (const previousId of [...recipients.keys()]) {
      if (previousId !== receiverId) this.stopTyping(userId, key, previousId);
    }
    const previous = recipients.get(receiverId);
    if (previous) clearTimeout(previous.timer);
    const now = Date.now();
    const shouldSend = !previous || now - previous.lastSentAt >= 800;
    recipients.set(receiverId, {
      lastSentAt: shouldSend ? now : previous.lastSentAt,
      timer: setTimeout(() => this.stopTyping(userId, key, receiverId), 3_500),
    });
    this.typingByClient.set(key, recipients);
    if (shouldSend) {
      this.transport.sendToUser(receiverId, {
        type: "typing.start",
        userId,
        receiverId,
      });
    }
  }

  async handle(event: StatusClientEvent, user: PublicUser, client: WSContext) {
    if (event.type === "chat.sync") {
      await this.sync(user.id, client);
      return;
    }
    const friendId =
      event.type === "message.read" ? event.friendId : event.receiverId;
    if (friendId === user.id || !(await areFriends(user.id, friendId))) {
      this.transport.sendToClient(client, {
        type: "error",
        data: {
          message: "Chat status is only available between accepted friends.",
        },
      });
      return;
    }
    if (event.type === "typing.start") {
      if (!(await getUserSettings(user.id)).showTypingIndicator) return;
      if (
        [...this.transport.clientsFor(user.id)].some(
          (connection) =>
            this.transport.keyFor(connection) === this.transport.keyFor(client),
        )
      ) {
        this.startTyping(user.id, client, friendId);
      }
    } else if (event.type === "typing.stop") {
      this.stopTyping(user.id, this.transport.keyFor(client), friendId);
    } else if (event.type === "message.read") {
      const settings = await getUserSettings(user.id);
      const result = await markMessagesRead(
        user.id,
        friendId,
        event.throughMessageId,
      );
      if (!result) {
        this.transport.sendToClient(client, {
          type: "error",
          data: {
            message: "You can only mark your own received messages as read.",
          },
        });
        return;
      }
      if (result.readAt && settings.sendReadReceipts) {
        const receipt: StatusServerEvent = {
          type: "message.read",
          readerId: user.id,
          senderId: friendId,
          throughMessageId: event.throughMessageId,
          throughDeliveryId: result.throughDeliveryId,
          readAt: result.readAt,
        };
        this.transport.sendToUser(friendId, receipt);
        this.transport.sendToUser(user.id, receipt);
      }
      await this.publishUnread(user.id);
    }
  }
}
