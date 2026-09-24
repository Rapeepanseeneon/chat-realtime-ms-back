import { Hono, type Context, type Next } from "hono";
import type { SQL } from "bun";
import { mkdir, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getConnInfo, upgradeWebSocket, websocket } from "hono/bun";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { WSContext } from "hono/ws";
import {
  areFriends,
  createFriendRequest,
  createMessage,
  createPrivateMessage,
  createPrivateAttachmentMessage,
  findPrivateMessage,
  mutatePrivateMessage,
  updateGhost,
  releaseGhost,
  publishPendingGhosts,
  createSession,
  createUserWithSession,
  completeOnboarding,
  deleteSession,
  findConflictingUser,
  findChatUserById,
  findUserByEmail,
  findUserBySession,
  getFriends,
  getUnreadCounts,
  getFriendshipStatus,
  getPrivateMessages,
  getReceivedFriendRequests,
  getSentFriendRequests,
  cancelFriendRequest,
  getFriendSuggestions,
  getRecentMessages,
  initializeDatabase,
  respondToFriendRequest,
  searchUsers,
  toPublicUser,
  updateUser,
  getProfileLinks,
  replaceProfileLinks,
  getPublicProfile,
  getProfileByUsername,
  getVisibleProfileFriends,
  updateProfilePrivacy,
  getPresencePreferences,
  setUserAvatar,
  setFavoriteFriend,
  getUserSettings,
  updateUserSettings,
  updatePasswordAndReplaceSessions,
  createGroup,
  getGroups,
  getGroupInfo,
  getGroupMessages,
  getGroupMemberIds,
  createGroupMessage,
  createGroupAttachmentMessage,
  mutateGroupMessage,
  markGroupRead,
  isGroupMember,
  updateGroup,
  addGroupMember,
  removeGroupMember,
  leaveGroup,
  getAccessibleAttachment,
  type ChatUser,
  type PrivateMessage,
  type PublicUser,
  type StoredMessage,
  type GroupMessage,
  type PresenceStatus,
  type MessageTextSize,
  type UserSettings,
  type NewAttachment,
  type ProfilePrivacy,
} from "./database";
import {
  ChatStatusTracker,
  type StatusClientEvent,
  type StatusServerEvent,
} from "./chat-status";
import { startGhostScheduler } from "./ghost-scheduler";
import {
  attachmentFile,
  MAX_FILE_BYTES,
  removeAttachment,
  validateUpload,
  writeAttachment,
} from "./attachment-storage";
import { RateLimiter, type RateLimitDecision } from "./security/rate-limit";
import {
  assertRequestBodyWithin,
  MAX_JSON_BODY_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  PayloadTooLargeError,
  readJsonObject,
} from "./security/request-limits";

const MAX_MESSAGE_LENGTH = 1_000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_BIO_LENGTH = 150;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7;
const SESSION_COOKIE = "pb_session";
const MAX_HTTP_BODY_BYTES = MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 96 * 1024;
const WEBSOCKET_BACKPRESSURE_BYTES = 512 * 1024;
const MAX_QUEUED_CLIENT_EVENTS = 32;
const normalizeOrigin = (value: string) => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
};
const configuredFrontendOrigins = (
  Bun.env.FRONTEND_URLS ??
  Bun.env.FRONTEND_URL ??
  "http://localhost:3000"
)
  .split(",")
  .map(normalizeOrigin)
  .filter((origin): origin is string => origin !== null);
if (configuredFrontendOrigins.length === 0)
  throw new Error("FRONTEND_URLS must contain at least one valid HTTP origin");
const frontendOrigins = new Set(configuredFrontendOrigins);
const isTrustedFrontendOrigin = (origin: string | undefined) =>
  !!origin && frontendOrigins.has(normalizeOrigin(origin) ?? "");
const devHttpsEnabled = Bun.env.DEV_HTTPS === "true";
if (devHttpsEnabled && Bun.env.NODE_ENV === "production") {
  throw new Error("DEV_HTTPS is only supported outside production");
}
const avatarStorageDirectory = join(
  process.cwd(),
  Bun.env.AVATAR_STORAGE_DIR?.trim() || "storage/avatars",
);
const secureCookies =
  devHttpsEnabled ||
  Bun.env.COOKIE_SECURE === "true" ||
  (Bun.env.COOKIE_SECURE !== "false" && Bun.env.NODE_ENV === "production");
const trustProxy = Bun.env.TRUST_PROXY === "true";
const legacyGlobalChatEnabled = Bun.env.ENABLE_LEGACY_GLOBAL_CHAT === "true";

type Variables = { user: PublicUser };
type CallIceCandidate = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
};
type CallClientMessage =
  | {
      type: "call.offer";
      callId: string;
      calleeId: string;
      sdp: string;
      callType: "voice" | "video";
    }
  | { type: "call.answer"; callId: string; sdp: string }
  | {
      type: "call.ice_candidate";
      callId: string;
      candidate: CallIceCandidate;
    }
  | { type: "call.reject" | "call.end"; callId: string };
type ClientMessage =
  | {
      type: "message.send" | "ghost.create";
      receiverId: string;
      message: string;
      replyToMessageId: string | null;
    }
  | { type: "message.edit"; messageId: string; message: string }
  | { type: "message.delete"; messageId: string }
  | { type: "ghost.edit"; messageId: string; message: string }
  | { type: "ghost.delete"; messageId: string }
  | { type: "ghost.release"; messageId: string }
  | { type: "ghost.schedule"; messageId: string; scheduledAt: string | null }
  | { type: "message.send.global"; message: string }
  | {
      type: "group.message.send";
      groupId: string;
      message: string;
      replyToMessageId: string | null;
    }
  | { type: "group.message.edit"; messageId: string; message: string }
  | { type: "group.message.delete"; messageId: string }
  | { type: "group.read"; groupId: string }
  | { type: "group.typing.start"; groupId: string }
  | { type: "group.typing.stop"; groupId: string }
  | CallClientMessage
  | StatusClientEvent;
type ServerMessage =
  | { type: "message.new"; message: PrivateMessage }
  | { type: "message.edited" | "message.deleted"; message: PrivateMessage }
  | { type: "ghost.updated"; message: PrivateMessage }
  | { type: "message.new"; data: StoredMessage }
  | {
      type:
        "group.message.new" | "group.message.edited" | "group.message.deleted";
      message: GroupMessage;
    }
  | { type: "group.updated"; groupId: string }
  | {
      type: "group.typing.start" | "group.typing.stop";
      groupId: string;
      userId: string;
      username: string;
    }
  | { type: "settings.updated"; settings: UserSettings }
  | {
      type: "call.offer";
      callId: string;
      caller: Pick<PublicUser, "id" | "username" | "avatarUrl">;
      sdp: string;
      callType: "voice" | "video";
    }
  | {
      type: "call.answer";
      callId: string;
      fromUserId: string;
      sdp: string;
    }
  | {
      type: "call.ice_candidate";
      callId: string;
      fromUserId: string;
      candidate: CallIceCandidate;
    }
  | {
      type: "call.reject" | "call.end";
      callId: string;
      fromUserId: string;
      reason?: string;
    }
  | {
      type: "call.unavailable";
      callId: string;
      calleeId: string;
      reason: "offline" | "busy" | "not_friends";
    }
  | StatusServerEvent;

const app = new Hono<{ Variables: Variables }>();
const connectionsByUser = new Map<string, Set<WSContext>>();
const authenticatedClients = new Map<unknown, PublicUser>();
type ClientEventQueue = { tail: Promise<void>; pending: number };
const clientEventQueues = new Map<unknown, ClientEventQueue>();
const connectionIds = new Map<unknown, string>();
const groupTyping = new Map<
  unknown,
  Map<string, ReturnType<typeof setTimeout>>
>();
type ActiveCall = {
  callId: string;
  callerId: string;
  calleeId: string;
  callerClientKey: unknown;
  calleeClientKey: unknown | null;
  state: "ringing" | "connecting";
  timeout: ReturnType<typeof setTimeout> | null;
};
const activeCalls = new Map<string, ActiveCall>();
const activeCallByUser = new Map<string, string>();

const rateLimits = {
  loginIp: new RateLimiter({
    capacity: 60,
    refillWindowMs: 5 * 60_000,
    cooldownMs: 5 * 60_000,
  }),
  loginAccount: new RateLimiter({
    capacity: 8,
    refillWindowMs: 5 * 60_000,
    cooldownMs: 10 * 60_000,
  }),
  registerIp: new RateLimiter({
    capacity: 60,
    refillWindowMs: 60 * 60_000,
    cooldownMs: 30 * 60_000,
  }),
  registerIdentity: new RateLimiter({
    capacity: 3,
    refillWindowMs: 60 * 60_000,
    cooldownMs: 30 * 60_000,
  }),
  search: new RateLimiter({
    capacity: 40,
    refillWindowMs: 60_000,
    cooldownMs: 60_000,
  }),
  friendRequest: new RateLimiter({
    capacity: 12,
    refillWindowMs: 5 * 60_000,
    cooldownMs: 5 * 60_000,
  }),
  upload: new RateLimiter({
    capacity: 12,
    refillWindowMs: 5 * 60_000,
    cooldownMs: 5 * 60_000,
  }),
  settings: new RateLimiter({
    capacity: 20,
    refillWindowMs: 60_000,
    cooldownMs: 60_000,
  }),
  wsConnection: new RateLimiter({
    capacity: 120,
    refillWindowMs: 10_000,
    cooldownMs: 15_000,
  }),
  wsMalformed: new RateLimiter({
    capacity: 5,
    refillWindowMs: 30_000,
    cooldownMs: 60_000,
  }),
  wsMessage: new RateLimiter({
    capacity: 40,
    refillWindowMs: 10_000,
    cooldownMs: 30_000,
  }),
  wsTyping: new RateLimiter({
    capacity: 12,
    refillWindowMs: 5_000,
    cooldownMs: 15_000,
  }),
  wsPresence: new RateLimiter({
    capacity: 5,
    refillWindowMs: 10_000,
    cooldownMs: 30_000,
  }),
  wsCallOffer: new RateLimiter({
    capacity: 5,
    refillWindowMs: 60_000,
    cooldownMs: 5 * 60_000,
  }),
  wsCallSignal: new RateLimiter({
    capacity: 180,
    refillWindowMs: 60_000,
    cooldownMs: 60_000,
  }),
};
const getClientKey = (client: WSContext): unknown => client.raw ?? client;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const hashSessionToken = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

const hashRateKey = (value: string) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const getRequestAddress = (context: Context) => {
  if (trustProxy) {
    const forwarded = context.req
      .header("X-Forwarded-For")
      ?.split(",", 1)[0]
      ?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(context).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
};

const rateLimitResponse = (
  context: Context,
  decision: RateLimitDecision,
  message = "Too many requests. Please wait and try again.",
) => {
  context.header(
    "Retry-After",
    String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
  );
  return context.json({ error: message, code: "RATE_LIMITED" }, 429);
};

const enforceRateLimit = (
  context: Context,
  limiter: RateLimiter,
  key: string,
  message?: string,
) => {
  const decision = limiter.consume(key);
  return decision.allowed
    ? null
    : rateLimitResponse(context, decision, message);
};

const createSessionToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

const readJson = async (
  context: Context,
): Promise<Record<string, unknown> | null> => {
  return readJsonObject(context.req.raw, MAX_JSON_BODY_BYTES);
};

const validateProfile = (value: Record<string, unknown>) => {
  const username =
    typeof value.username === "string" ? value.username.trim() : "";
  const email =
    typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  const bio = typeof value.bio === "string" ? value.bio.trim() : "";
  const displayName =
    typeof value.displayName === "string" ? value.displayName.trim() : username;

  if (!username) return { error: "Username is required." } as const;
  if (username.length > 50)
    return { error: "Username must be 50 characters or fewer." } as const;
  if (!displayName || displayName.length > 80)
    return { error: "Display name must be 1-80 characters." } as const;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { error: "Please enter a valid email address." } as const;
  }
  if (bio.length > MAX_BIO_LENGTH)
    return {
      error: `Bio must be ${MAX_BIO_LENGTH} characters or fewer.`,
    } as const;
  return { username, email, bio, displayName } as const;
};

const validateProfilePrivacy = (
  value: Record<string, unknown>,
): ProfilePrivacy | null => {
  const privacy = {
    profileVisibility: value.profileVisibility,
    friendListVisibility: value.friendListVisibility,
    mutualFriendsVisibility: value.mutualFriendsVisibility,
    onlineStatusVisibility: value.onlineStatusVisibility,
  };
  return (privacy.profileVisibility === "public" ||
    privacy.profileVisibility === "friends" ||
    privacy.profileVisibility === "private") &&
    (privacy.friendListVisibility === "everyone" ||
      privacy.friendListVisibility === "friends" ||
      privacy.friendListVisibility === "only_me") &&
    (privacy.mutualFriendsVisibility === "everyone" ||
      privacy.mutualFriendsVisibility === "friends" ||
      privacy.mutualFriendsVisibility === "only_me") &&
    (privacy.onlineStatusVisibility === "everyone" ||
      privacy.onlineStatusVisibility === "friends" ||
      privacy.onlineStatusVisibility === "nobody")
    ? (privacy as ProfilePrivacy)
    : null;
};

const validateProfileLinks = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 8) return null;
  const links: { platform: string; label: string; url: string }[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const platform =
      typeof item.platform === "string" ? item.platform.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const rawUrl = typeof item.url === "string" ? item.url.trim() : "";
    if (
      !platform ||
      platform.length > 30 ||
      !label ||
      label.length > 60 ||
      rawUrl.length > 2048
    )
      return null;
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      links.push({ platform, label, url: url.toString() });
    } catch {
      return null;
    }
  }
  return links;
};

const avatarKind = (bytes: Uint8Array) => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { extension: "jpg", type: "image/jpeg" };
  if (
    bytes.length >= 8 &&
    bytes
      .slice(0, 8)
      .every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
  )
    return { extension: "png", type: "image/png" };
  if (
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  )
    return { extension: "webp", type: "image/webp" };
  return null;
};

const removeStoredAvatar = async (avatarUrl: string | null) => {
  if (!avatarUrl?.startsWith("/uploads/avatars/")) return;
  const filename = basename(avatarUrl);
  if (!/^[a-zA-Z0-9-]+\.(?:jpg|png|webp)$/.test(filename)) return;
  await unlink(join(avatarStorageDirectory, filename)).catch(() => undefined);
};

const getAuthenticatedUser = async (
  context: Context,
): Promise<PublicUser | null> => {
  const token = getCookie(context, SESSION_COOKIE);
  if (!token) return null;
  const user = await findUserBySession(hashSessionToken(token));
  return user ? toPublicUser(user) : null;
};

const requireAuth = async (
  context: Context<{ Variables: Variables }>,
  next: Next,
) => {
  const user = await getAuthenticatedUser(context);
  if (!user) return context.json({ error: "Please log in to continue." }, 401);
  context.set("user", user);
  await next();
};

const requireTrustedOrigin = async (context: Context, next: Next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(context.req.method)) {
    const origin = context.req.header("Origin");
    if (!isTrustedFrontendOrigin(origin)) {
      return context.json(
        { error: "This request origin is not allowed." },
        403,
      );
    }
  }
  await next();
};

const requireTrustedWebSocketOrigin = async (context: Context, next: Next) => {
  const origin = context.req.header("Origin");
  if (!isTrustedFrontendOrigin(origin))
    return context.json(
      { error: "This WebSocket origin is not allowed." },
      403,
    );
  await next();
};

const parseClientMessage = (rawValue: unknown): ClientMessage | null => {
  if (typeof rawValue !== "string") return null;
  try {
    const value: unknown = JSON.parse(rawValue);
    if (!isRecord(value)) return null;
    const isId = (id: unknown): id is string =>
      typeof id === "string" &&
      /^[1-9]\d{0,18}$/.test(id) &&
      BigInt(id) <= 9_223_372_036_854_775_807n;
    const isCallId = (id: unknown): id is string =>
      typeof id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      );
    const validSdp = (sdp: unknown) =>
      typeof sdp === "string" && sdp.length > 0 && sdp.length <= 65_536;
    if (value.type === "call.offer")
      return isCallId(value.callId) &&
        isId(value.calleeId) &&
        validSdp(value.sdp) &&
        (value.callType === undefined ||
          value.callType === "voice" ||
          value.callType === "video")
        ? {
            type: value.type,
            callId: value.callId,
            calleeId: value.calleeId,
            sdp: value.sdp as string,
            // Missing means voice for compatibility with already-open Step 12 clients.
            callType: value.callType === "video" ? "video" : "voice",
          }
        : null;
    if (value.type === "call.answer")
      return isCallId(value.callId) && validSdp(value.sdp)
        ? {
            type: value.type,
            callId: value.callId,
            sdp: value.sdp as string,
          }
        : null;
    if (value.type === "call.reject" || value.type === "call.end")
      return isCallId(value.callId)
        ? { type: value.type, callId: value.callId }
        : null;
    if (value.type === "call.ice_candidate") {
      if (!isCallId(value.callId) || !isRecord(value.candidate)) return null;
      const candidate = value.candidate;
      if (
        typeof candidate.candidate !== "string" ||
        candidate.candidate.length > 4096 ||
        (candidate.sdpMid != null && typeof candidate.sdpMid !== "string") ||
        (candidate.sdpMLineIndex != null &&
          (!Number.isInteger(candidate.sdpMLineIndex) ||
            Number(candidate.sdpMLineIndex) < 0)) ||
        (candidate.usernameFragment != null &&
          typeof candidate.usernameFragment !== "string")
      )
        return null;
      return {
        type: value.type,
        callId: value.callId,
        candidate: {
          candidate: candidate.candidate,
          sdpMid:
            typeof candidate.sdpMid === "string" ? candidate.sdpMid : null,
          sdpMLineIndex:
            candidate.sdpMLineIndex == null
              ? null
              : Number(candidate.sdpMLineIndex),
          usernameFragment:
            typeof candidate.usernameFragment === "string"
              ? candidate.usernameFragment
              : null,
        },
      };
    }
    if (value.type === "chat.sync") return { type: "chat.sync" };
    if (
      value.type === "group.read" ||
      value.type === "group.typing.start" ||
      value.type === "group.typing.stop"
    )
      return isId(value.groupId)
        ? { type: value.type, groupId: value.groupId }
        : null;
    if (value.type === "group.message.delete")
      return isId(value.messageId)
        ? { type: value.type, messageId: value.messageId }
        : null;
    if (value.type === "group.message.edit") {
      const message =
        typeof value.message === "string" ? value.message.trim() : "";
      return isId(value.messageId) &&
        message.length > 0 &&
        message.length <= MAX_MESSAGE_LENGTH
        ? { type: value.type, messageId: value.messageId, message }
        : null;
    }
    if (value.type === "group.message.send") {
      const message =
        typeof value.message === "string" ? value.message.trim() : "";
      return isId(value.groupId) &&
        message.length > 0 &&
        message.length <= MAX_MESSAGE_LENGTH &&
        (value.replyToMessageId == null || isId(value.replyToMessageId))
        ? {
            type: value.type,
            groupId: value.groupId,
            message,
            replyToMessageId:
              value.replyToMessageId == null
                ? null
                : (value.replyToMessageId as string),
          }
        : null;
    }
    if (value.type === "ghost.schedule") {
      if (!isId(value.messageId)) return null;
      if (value.scheduledAt === null)
        return {
          type: "ghost.schedule",
          messageId: value.messageId,
          scheduledAt: null,
        };
      if (
        typeof value.scheduledAt !== "string" ||
        !/(Z|[+-]\d{2}:\d{2})$/.test(value.scheduledAt)
      )
        return null;
      const time = Date.parse(value.scheduledAt);
      return Number.isFinite(time) && time > Date.now()
        ? {
            type: "ghost.schedule",
            messageId: value.messageId,
            scheduledAt: new Date(time).toISOString(),
          }
        : null;
    }
    if (
      value.type === "message.delete" ||
      value.type === "ghost.delete" ||
      value.type === "ghost.release"
    ) {
      return isId(value.messageId)
        ? { type: value.type, messageId: value.messageId }
        : null;
    }
    if (value.type === "message.edit" || value.type === "ghost.edit") {
      const message =
        typeof value.message === "string" ? value.message.trim() : "";
      return isId(value.messageId) &&
        message.length > 0 &&
        message.length <= MAX_MESSAGE_LENGTH
        ? { type: value.type, messageId: value.messageId, message }
        : null;
    }
    if (value.type === "message.read") {
      return isId(value.friendId) && isId(value.throughMessageId)
        ? {
            type: "message.read",
            friendId: value.friendId,
            throughMessageId: value.throughMessageId,
          }
        : null;
    }
    if (value.type === "typing.start" || value.type === "typing.stop") {
      return isId(value.receiverId)
        ? { type: value.type, receiverId: value.receiverId }
        : null;
    }
    if (value.type !== "message.send" && value.type !== "ghost.create")
      return null;

    if (
      value.type === "message.send" &&
      isRecord(value.data) &&
      typeof value.data.text === "string"
    ) {
      const legacyMessage = value.data.text.trim();
      if (!legacyMessage || legacyMessage.length > MAX_MESSAGE_LENGTH)
        return null;
      return { type: "message.send.global", message: legacyMessage };
    }

    if (
      typeof value.receiverId !== "string" ||
      typeof value.message !== "string"
    ) {
      return null;
    }
    const receiverId = value.receiverId.trim();
    const message = value.message.trim();
    if (!isId(receiverId)) return null;
    if (!message || message.length > MAX_MESSAGE_LENGTH) return null;
    if (value.replyToMessageId != null && !isId(value.replyToMessageId))
      return null;
    return {
      type: value.type,
      receiverId,
      message,
      replyToMessageId:
        value.replyToMessageId == null
          ? null
          : (value.replyToMessageId as string),
    };
  } catch {
    return null;
  }
};

const sendJson = (client: WSContext, message: ServerMessage) => {
  try {
    const raw = client.raw as { getBufferedAmount?: () => number } | undefined;
    if (
      raw?.getBufferedAmount &&
      raw.getBufferedAmount() >= WEBSOCKET_BACKPRESSURE_BYTES
    ) {
      client.close(1013, "Realtime connection is overloaded");
      removeConnection(client);
      return;
    }
    client.send(JSON.stringify(message));
  } catch {
    removeConnection(client);
  }
};

const addConnection = (user: PublicUser, client: WSContext) => {
  const connections = connectionsByUser.get(user.id) ?? new Set<WSContext>();
  const firstConnection = connections.size === 0;
  connections.add(client);
  connectionsByUser.set(user.id, connections);
  authenticatedClients.set(getClientKey(client), user);
  chatStatus.connected(user, client, firstConnection);
};

const clearActiveCall = (call: ActiveCall) => {
  if (call.timeout) clearTimeout(call.timeout);
  activeCalls.delete(call.callId);
  if (activeCallByUser.get(call.callerId) === call.callId)
    activeCallByUser.delete(call.callerId);
  if (activeCallByUser.get(call.calleeId) === call.callId)
    activeCallByUser.delete(call.calleeId);
};

const finishActiveCall = (
  call: ActiveCall,
  type: "call.reject" | "call.end",
  fromUserId: string,
  reason?: string,
) => {
  clearActiveCall(call);
  const event: ServerMessage = {
    type,
    callId: call.callId,
    fromUserId,
    ...(reason ? { reason } : {}),
  };
  sendToUser(call.callerId, event);
  sendToUser(call.calleeId, event);
};

const endCallsForClient = (clientKey: unknown, userId: string) => {
  const callId = activeCallByUser.get(userId);
  const call = callId ? activeCalls.get(callId) : null;
  if (!call) return;
  const ownsPeerConnection =
    (call.callerId === userId && call.callerClientKey === clientKey) ||
    (call.calleeId === userId && call.calleeClientKey === clientKey);
  if (ownsPeerConnection)
    finishActiveCall(call, "call.end", userId, "disconnected");
};

const removeConnection = (client: WSContext) => {
  const key = getClientKey(client);
  for (const [groupId, timer] of groupTyping.get(key) ?? []) {
    clearTimeout(timer);
    const typingUser = authenticatedClients.get(key);
    if (typingUser)
      void broadcastToGroup(
        groupId,
        {
          type: "group.typing.stop",
          groupId,
          userId: typingUser.id,
          username: typingUser.username,
        },
        typingUser.id,
      );
  }
  groupTyping.delete(key);
  const user = authenticatedClients.get(key);
  if (user) endCallsForClient(key, user.id);
  authenticatedClients.delete(key);
  clientEventQueues.delete(key);
  const connectionId = connectionIds.get(key);
  if (connectionId) {
    rateLimits.wsConnection.delete(`connection:${connectionId}`);
    rateLimits.wsMalformed.delete(`malformed:${connectionId}`);
  }
  connectionIds.delete(key);
  if (!user) return;
  const connections = connectionsByUser.get(user.id);
  // Hono creates a fresh WSContext wrapper for each callback; match the raw socket.
  for (const connection of connections ?? []) {
    if (getClientKey(connection) === key) connections?.delete(connection);
  }
  if (connections?.size === 0) {
    connectionsByUser.delete(user.id);
    const callId = activeCallByUser.get(user.id);
    const call = callId ? activeCalls.get(callId) : null;
    if (call?.calleeId === user.id && call.state === "ringing")
      finishActiveCall(call, "call.end", user.id, "disconnected");
  }
  chatStatus.disconnected(user.id, client, !connectionsByUser.has(user.id));
};

const sendToUser = (userId: string, message: ServerMessage) => {
  for (const client of connectionsByUser.get(userId) ?? []) {
    sendJson(client, message);
  }
};

const sendToAllUsers = (message: ServerMessage) => {
  for (const userId of connectionsByUser.keys()) sendToUser(userId, message);
};

const handleCallMessage = async (
  message: CallClientMessage,
  sender: PublicUser,
  client: WSContext,
) => {
  const senderKey = getClientKey(client);
  if (message.type === "call.offer") {
    if (
      message.calleeId === sender.id ||
      !(await areFriends(sender.id, message.calleeId))
    ) {
      sendJson(client, {
        type: "call.unavailable",
        callId: message.callId,
        calleeId: message.calleeId,
        reason: "not_friends",
      });
      return;
    }
    const calleeSettings = await getUserSettings(message.calleeId);
    if (
      !connectionsByUser.has(message.calleeId) ||
      calleeSettings.presenceStatus === "invisible"
    ) {
      sendJson(client, {
        type: "call.unavailable",
        callId: message.callId,
        calleeId: message.calleeId,
        reason: "offline",
      });
      return;
    }
    // Re-check immediately before reserving both users. There is no await
    // between this check and the Map writes, so simultaneous offers cannot
    // claim the same participant.
    if (
      activeCalls.has(message.callId) ||
      activeCallByUser.has(sender.id) ||
      activeCallByUser.has(message.calleeId)
    ) {
      sendJson(client, {
        type: "call.unavailable",
        callId: message.callId,
        calleeId: message.calleeId,
        reason: "busy",
      });
      return;
    }
    const call: ActiveCall = {
      callId: message.callId,
      callerId: sender.id,
      calleeId: message.calleeId,
      callerClientKey: senderKey,
      calleeClientKey: null,
      state: "ringing",
      timeout: null,
    };
    call.timeout = setTimeout(
      () => finishActiveCall(call, "call.end", sender.id, "no_answer"),
      30_000,
    );
    activeCalls.set(call.callId, call);
    activeCallByUser.set(call.callerId, call.callId);
    activeCallByUser.set(call.calleeId, call.callId);
    sendToUser(call.calleeId, {
      type: "call.offer",
      callId: call.callId,
      caller: {
        id: sender.id,
        username: sender.username,
        avatarUrl: sender.avatarUrl,
      },
      sdp: message.sdp,
      callType: message.callType,
    });
    return;
  }

  const call = activeCalls.get(message.callId);
  if (!call || (sender.id !== call.callerId && sender.id !== call.calleeId))
    return;

  if (message.type === "call.answer") {
    if (sender.id !== call.calleeId || call.state !== "ringing") return;
    if (call.timeout) clearTimeout(call.timeout);
    call.timeout = null;
    call.state = "connecting";
    call.calleeClientKey = senderKey;
    const event: ServerMessage = {
      type: "call.answer",
      callId: call.callId,
      fromUserId: sender.id,
      sdp: message.sdp,
    };
    sendToUser(call.callerId, event);
    sendToUser(call.calleeId, event);
    return;
  }
  if (message.type === "call.ice_candidate") {
    const peerId = sender.id === call.callerId ? call.calleeId : call.callerId;
    sendToUser(peerId, {
      type: "call.ice_candidate",
      callId: call.callId,
      fromUserId: sender.id,
      candidate: message.candidate,
    });
    return;
  }
  if (message.type === "call.reject") {
    if (sender.id === call.calleeId && call.state === "ringing")
      finishActiveCall(call, "call.reject", sender.id);
    return;
  }
  finishActiveCall(call, "call.end", sender.id);
};

const isCallClientMessage = (
  message: ClientMessage,
): message is CallClientMessage => message.type.startsWith("call.");

const websocketEventLimit = (message: ClientMessage, userId: string) => {
  if (message.type === "call.offer")
    return rateLimits.wsCallOffer.consume(`call-offer:${userId}`);
  if (message.type.startsWith("call."))
    return rateLimits.wsCallSignal.consume(`call-signal:${userId}`);
  if (
    message.type === "typing.start" ||
    message.type === "typing.stop" ||
    message.type === "group.typing.start" ||
    message.type === "group.typing.stop"
  )
    return rateLimits.wsTyping.consume(`typing:${userId}`);
  if (message.type === "chat.sync")
    return rateLimits.wsPresence.consume(`presence:${userId}`);
  return rateLimits.wsMessage.consume(`message:${userId}`);
};

const sendWebSocketRateLimit = (
  client: WSContext,
  decision: RateLimitDecision,
) =>
  sendJson(client, {
    type: "error",
    data: {
      code: "RATE_LIMITED",
      message: `Too many realtime actions. Try again in ${Math.max(1, Math.ceil(decision.retryAfterMs / 1000))} seconds.`,
    },
  });

const broadcastToGroup = async (
  groupId: string,
  message: ServerMessage,
  excludeUserId?: string,
) => {
  for (const userId of await getGroupMemberIds(groupId))
    if (userId !== excludeUserId) sendToUser(userId, message);
};

const stopGroupTyping = async (
  client: WSContext,
  user: PublicUser,
  groupId: string,
) => {
  const key = getClientKey(client),
    groups = groupTyping.get(key),
    timer = groups?.get(groupId);
  if (timer) clearTimeout(timer);
  groups?.delete(groupId);
  if (groups?.size === 0) groupTyping.delete(key);
  await broadcastToGroup(
    groupId,
    {
      type: "group.typing.stop",
      groupId,
      userId: user.id,
      username: user.username,
    },
    user.id,
  );
};

const chatStatus = new ChatStatusTracker({
  keyFor: getClientKey,
  clientsFor: (userId) => connectionsByUser.get(userId) ?? [],
  isOnline: (userId) => (connectionsByUser.get(userId)?.size ?? 0) > 0,
  sendToUser,
  sendToClient: sendJson,
});

await initializeDatabase();
const publishReleasedGhost = async (
  message: PrivateMessage,
  transaction: SQL,
) => {
  sendToUser(message.senderId, { type: "message.new", message });
  sendToUser(message.receiverId, { type: "message.new", message });
  await chatStatus.publishUnread(message.receiverId, transaction);
};

const isDatabaseId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9]\d{0,18}$/.test(value) &&
  BigInt(value) <= 9_223_372_036_854_775_807n;

const saveAttachmentMessage = async (
  user: PublicUser,
  scope: "private" | "group",
  targetId: string,
  attachment: NewAttachment,
  caption: string,
) => {
  if (scope === "private") {
    const message = await createPrivateAttachmentMessage(
      {
        id: user.id,
        username: user.username,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
      },
      targetId,
      attachment,
      caption,
    );
    if (!message) return null;
    sendToUser(message.senderId, { type: "message.new", message });
    sendToUser(message.receiverId, { type: "message.new", message });
    await chatStatus.publishUnread(message.receiverId);
    return { scope, message } as const;
  }
  const message = await createGroupAttachmentMessage(
    targetId,
    user.id,
    attachment,
    caption,
  );
  if (!message) return null;
  await broadcastToGroup(targetId, { type: "group.message.new", message });
  for (const memberId of await getGroupMemberIds(targetId))
    sendToUser(memberId, { type: "group.updated", groupId: targetId });
  return { scope, message } as const;
};

app.onError((error, context) => {
  if (error instanceof PayloadTooLargeError)
    return context.json(
      { error: "Request body is too large.", code: "PAYLOAD_TOO_LARGE" },
      413,
    );
  console.error("Unhandled backend request error", error);
  return context.json(
    { error: "The request could not be completed.", code: "INTERNAL_ERROR" },
    500,
  );
});

app.use(
  "/api/*",
  cors({
    origin: (origin) => (isTrustedFrontendOrigin(origin) ? origin : ""),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    credentials: true,
  }),
);
app.use("/api/*", requireTrustedOrigin);

app.get("/", (context) =>
  context.json({ service: "chat-realtime-ms-back", websocket: "/ws" }),
);
app.get("/health", (context) =>
  context.json({ status: "ok", connectedClients: authenticatedClients.size }),
);
app.get("/uploads/avatars/:filename", async (context) => {
  const filename = context.req.param("filename");
  if (!/^[a-zA-Z0-9-]+\.(?:jpg|png|webp)$/.test(filename))
    return context.notFound();
  const file = Bun.file(join(avatarStorageDirectory, filename));
  if (!(await file.exists())) return context.notFound();
  return new Response(file, {
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

app.post("/api/auth/register", async (context) => {
  const address = getRequestAddress(context);
  const ipLimited = enforceRateLimit(
    context,
    rateLimits.registerIp,
    `register:ip:${address}`,
    "Too many registration attempts. Please wait and try again.",
  );
  if (ipLimited) return ipLimited;
  const value = await readJson(context);
  if (!value)
    return context.json(
      { error: "Please provide valid registration details." },
      400,
    );
  const profile = validateProfile(value);
  if ("error" in profile) return context.json({ error: profile.error }, 400);
  const identityLimited = enforceRateLimit(
    context,
    rateLimits.registerIdentity,
    `register:identity:${address}:${hashRateKey(`${profile.username.toLowerCase()}|${profile.email}`)}`,
    "Too many registration attempts for these details. Please wait and try again.",
  );
  if (identityLimited) return identityLimited;

  const password = typeof value.password === "string" ? value.password : "";
  const confirmPassword =
    typeof value.confirmPassword === "string" ? value.confirmPassword : "";
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return context.json(
      {
        error: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
      },
      400,
    );
  }
  if (password !== confirmPassword)
    return context.json({ error: "Passwords do not match." }, 400);

  const conflict = await findConflictingUser(profile.username, profile.email);
  if (conflict)
    return context.json(
      { error: "An account with those details already exists." },
      409,
    );

  try {
    const passwordHash = await Bun.password.hash(password, "argon2id");
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1_000);
    const user = await createUserWithSession(
      profile.username,
      profile.email,
      passwordHash,
      hashSessionToken(token),
      expiresAt,
    );
    setCookie(context, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_DURATION_SECONDS,
    });
    return context.json(
      { user: toPublicUser(user), message: "Account created successfully." },
      201,
    );
  } catch (error) {
    console.error("Failed to register user", error);
    const racedConflict = await findConflictingUser(
      profile.username,
      profile.email,
    );
    if (racedConflict)
      return context.json(
        { error: "An account with those details already exists." },
        409,
      );
    return context.json(
      { error: "Account could not be created. Please try again." },
      500,
    );
  }
});

app.post("/api/auth/login", async (context) => {
  const address = getRequestAddress(context);
  const ipLimited = enforceRateLimit(
    context,
    rateLimits.loginIp,
    `login:ip:${address}`,
    "Too many login attempts. Please wait and try again.",
  );
  if (ipLimited) return ipLimited;
  const value = await readJson(context);
  const email =
    typeof value?.email === "string" ? value.email.trim().toLowerCase() : "";
  const password = typeof value?.password === "string" ? value.password : "";
  if (!email || !password)
    return context.json({ error: "Email and password are required." }, 400);
  const loginAccountKey = `login:account:${hashRateKey(email)}`;
  const accountLimited = enforceRateLimit(
    context,
    rateLimits.loginAccount,
    loginAccountKey,
    "Too many login attempts. Please wait and try again.",
  );
  if (accountLimited) return accountLimited;

  const user = await findUserByEmail(email);
  if (!user || !(await Bun.password.verify(password, user.passwordHash))) {
    return context.json({ error: "Email or password is incorrect." }, 401);
  }
  rateLimits.loginAccount.delete(loginAccountKey);

  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1_000);
  await createSession(user.id, hashSessionToken(token), expiresAt);
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
  return context.json({
    user: toPublicUser(user),
    message: "Login successful.",
  });
});

app.get("/api/auth/me", requireAuth, (context) =>
  context.json({ user: context.get("user") }),
);

app.post("/api/onboarding/complete", requireAuth, async (context) => {
  try {
    const user = await completeOnboarding(context.get("user").id);
    if (!user) return context.json({ error: "User was not found." }, 404);
    return context.json({
      user,
      message: "Onboarding completed successfully.",
    });
  } catch (error) {
    console.error("Failed to complete onboarding", error);
    return context.json(
      { error: "Onboarding could not be completed. Please try again." },
      500,
    );
  }
});

app.post("/api/auth/logout", async (context) => {
  const token = getCookie(context, SESSION_COOKIE);
  if (token) await deleteSession(hashSessionToken(token));
  deleteCookie(context, SESSION_COOKIE, { path: "/", secure: secureCookies });
  return context.json({ message: "Logged out successfully." });
});

app.get("/api/settings", requireAuth, async (context) => {
  try {
    return context.json({
      settings: await getUserSettings(context.get("user").id),
    });
  } catch (error) {
    console.error("Failed to load settings", error);
    return context.json({ error: "Settings could not be loaded." }, 500);
  }
});

app.put("/api/settings", requireAuth, async (context) => {
  const userId = context.get("user").id;
  const limited = enforceRateLimit(
    context,
    rateLimits.settings,
    `settings:${userId}`,
  );
  if (limited) return limited;
  const value = await readJson(context);
  if (!value)
    return context.json({ error: "Please provide valid settings." }, 400);
  const allowedKeys = new Set([
    "presenceStatus",
    "customStatus",
    "showOnlineStatus",
    "sendReadReceipts",
    "showTypingIndicator",
    "confirmGhostRelease",
    "enterToSend",
    "messageTextSize",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    return context.json(
      { error: "One or more settings are not supported." },
      400,
    );
  try {
    const current = await getUserSettings(userId);
    const presenceStatus = (value.presenceStatus ??
      current.presenceStatus) as PresenceStatus;
    const messageTextSize = (value.messageTextSize ??
      current.messageTextSize) as MessageTextSize;
    const customStatus =
      value.customStatus === undefined
        ? current.customStatus
        : typeof value.customStatus === "string"
          ? value.customStatus.trim()
          : null;
    const booleanKeys = [
      "showOnlineStatus",
      "sendReadReceipts",
      "showTypingIndicator",
      "confirmGhostRelease",
      "enterToSend",
    ] as const;
    if (
      !["online", "away", "dnd", "invisible"].includes(presenceStatus) ||
      !["small", "default", "large"].includes(messageTextSize) ||
      customStatus === null ||
      customStatus.length > 80 ||
      booleanKeys.some(
        (key) => value[key] !== undefined && typeof value[key] !== "boolean",
      )
    ) {
      return context.json({ error: "One or more settings are invalid." }, 400);
    }
    const settings = await updateUserSettings(userId, {
      presenceStatus,
      customStatus,
      messageTextSize,
      showOnlineStatus:
        typeof value.showOnlineStatus === "boolean"
          ? value.showOnlineStatus
          : current.showOnlineStatus,
      sendReadReceipts:
        typeof value.sendReadReceipts === "boolean"
          ? value.sendReadReceipts
          : current.sendReadReceipts,
      showTypingIndicator:
        typeof value.showTypingIndicator === "boolean"
          ? value.showTypingIndicator
          : current.showTypingIndicator,
      confirmGhostRelease:
        typeof value.confirmGhostRelease === "boolean"
          ? value.confirmGhostRelease
          : current.confirmGhostRelease,
      enterToSend:
        typeof value.enterToSend === "boolean"
          ? value.enterToSend
          : current.enterToSend,
    });
    await chatStatus.settingsChanged(userId);
    sendToUser(userId, { type: "settings.updated", settings });
    return context.json({ settings, message: "Settings updated." });
  } catch (error) {
    console.error("Failed to update settings", error);
    return context.json({ error: "Settings could not be updated." }, 500);
  }
});

app.put("/api/settings/password", requireAuth, async (context) => {
  const publicUser = context.get("user");
  const limited = enforceRateLimit(
    context,
    rateLimits.settings,
    `settings:${publicUser.id}`,
  );
  if (limited) return limited;
  const value = await readJson(context);
  const currentPassword =
    typeof value?.currentPassword === "string" ? value.currentPassword : "";
  const newPassword =
    typeof value?.newPassword === "string" ? value.newPassword : "";
  const confirmPassword =
    typeof value?.confirmPassword === "string" ? value.confirmPassword : "";
  if (!currentPassword)
    return context.json({ error: "Current password is required." }, 400);
  if (
    newPassword.length < MIN_PASSWORD_LENGTH ||
    newPassword.length > MAX_PASSWORD_LENGTH
  )
    return context.json(
      {
        error: `New password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
      },
      400,
    );
  if (newPassword !== confirmPassword)
    return context.json({ error: "New passwords do not match." }, 400);
  const user = await findUserByEmail(publicUser.email);
  if (!user || !(await Bun.password.verify(currentPassword, user.passwordHash)))
    return context.json({ error: "Current password is incorrect." }, 401);
  const passwordHash = await Bun.password.hash(newPassword, "argon2id");
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1_000);
  if (
    !(await updatePasswordAndReplaceSessions(
      user.id,
      passwordHash,
      hashSessionToken(token),
      expiresAt,
    ))
  )
    return context.json({ error: "Password could not be changed." }, 500);
  for (const client of [...(connectionsByUser.get(user.id) ?? [])]) {
    client.close(1008, "Session replaced after password change");
    removeConnection(client);
  }
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
  return context.json({ message: "Password changed successfully." });
});

app.get("/api/profile", requireAuth, async (context) => {
  const user = context.get("user");
  const profile = await getProfileByUsername(user.id, user.username);
  return context.json({ user, profile, links: await getProfileLinks(user.id) });
});

app.get("/api/profiles/by-username/:username", requireAuth, async (context) => {
  const username = (context.req.param("username") ?? "").trim();
  if (!username || username.length > 50)
    return context.json({ error: "Profile was not found." }, 404);
  const profile = await getProfileByUsername(context.get("user").id, username);
  if (!profile) return context.json({ error: "Profile was not found." }, 404);
  const settings = await getUserSettings(profile.id);
  const online =
    profile.canViewOnline &&
    settings.showOnlineStatus &&
    settings.presenceStatus !== "invisible" &&
    (connectionsByUser.get(profile.id)?.size ?? 0) > 0;
  const { canViewOnline: _canViewOnline, ...safeProfile } = profile;
  return context.json({
    profile: {
      ...safeProfile,
      online,
      status: online ? settings.presenceStatus : "offline",
      customStatus: online ? settings.customStatus : "",
    },
  });
});

app.get(
  "/api/profiles/by-username/:username/friends",
  requireAuth,
  async (context) => {
    const username = (context.req.param("username") ?? "").trim();
    const friends = await getVisibleProfileFriends(
      context.get("user").id,
      username,
    );
    return friends
      ? context.json({ friends })
      : context.json({ error: "Friend list is private." }, 403);
  },
);

app.put("/api/profile/privacy", requireAuth, async (context) => {
  const value = await readJson(context);
  const privacy = value ? validateProfilePrivacy(value) : null;
  if (!privacy)
    return context.json({ error: "Invalid profile privacy settings." }, 400);
  const userId = context.get("user").id;
  const savedPrivacy = await updateProfilePrivacy(userId, privacy);
  await chatStatus.settingsChanged(userId);
  return context.json({
    privacy: savedPrivacy,
    message: "Privacy settings updated.",
  });
});

app.get("/api/profiles/:userId", requireAuth, async (context) => {
  const userId = context.req.param("userId") ?? "";
  if (!/^[1-9]\d{0,18}$/.test(userId))
    return context.json({ error: "Profile was not found." }, 404);
  const profile = await getPublicProfile(context.get("user").id, userId);
  return profile
    ? context.json({ profile })
    : context.json({ error: "Profile was not found." }, 404);
});

app.put("/api/profile", requireAuth, async (context) => {
  const value = await readJson(context);
  if (!value)
    return context.json(
      { error: "Please provide valid profile details." },
      400,
    );
  const profile = validateProfile(value);
  if ("error" in profile) return context.json({ error: profile.error }, 400);
  const links =
    value.links === undefined ? undefined : validateProfileLinks(value.links);
  if (links === null)
    return context.json(
      { error: "Add up to 8 valid http or https profile links." },
      400,
    );
  const currentUser = context.get("user");
  const conflict = await findConflictingUser(
    profile.username,
    profile.email,
    currentUser.id,
  );
  if (conflict)
    return context.json(
      {
        error: `${conflict === "username" ? "Username" : "Email"} is already in use.`,
      },
      409,
    );

  try {
    const user = await updateUser(
      currentUser.id,
      profile.username,
      profile.email,
      profile.bio,
      profile.displayName,
    );
    if (links) await replaceProfileLinks(currentUser.id, links);
    return context.json({
      user: toPublicUser(user),
      links: links ?? (await getProfileLinks(currentUser.id)),
      message: "Profile updated successfully.",
    });
  } catch (error) {
    console.error("Failed to update profile", error);
    const racedConflict = await findConflictingUser(
      profile.username,
      profile.email,
      currentUser.id,
    );
    if (racedConflict)
      return context.json(
        {
          error: `${racedConflict === "username" ? "Username" : "Email"} is already in use.`,
        },
        409,
      );
    return context.json(
      { error: "Profile could not be updated. Please try again." },
      500,
    );
  }
});

app.post("/api/profile/avatar", requireAuth, async (context) => {
  const limited = enforceRateLimit(
    context,
    rateLimits.upload,
    `upload:${context.get("user").id}`,
    "Too many uploads. Please wait and try again.",
  );
  if (limited) return limited;
  await assertRequestBodyWithin(
    context.req.raw,
    MAX_AVATAR_BYTES + MULTIPART_OVERHEAD_BYTES,
  );
  let form: FormData;
  try {
    form = await context.req.formData();
  } catch {
    return context.json({ error: "Avatar upload is malformed." }, 400);
  }
  let uploadedPath: string | null = null;
  try {
    const file = form.get("avatar");
    if (
      !(file instanceof File) ||
      file.size < 1 ||
      file.size > MAX_AVATAR_BYTES
    )
      return context.json({ error: "Choose an image up to 5 MB." }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = avatarKind(bytes);
    if (!kind || !["image/jpeg", "image/png", "image/webp"].includes(file.type))
      return context.json(
        { error: "Avatar must be a JPG, PNG, or WebP image." },
        400,
      );
    await mkdir(avatarStorageDirectory, { recursive: true });
    const filename = `${context.get("user").id}-${crypto.randomUUID()}.${kind.extension}`;
    uploadedPath = `/uploads/avatars/${filename}`;
    await Bun.write(join(avatarStorageDirectory, filename), bytes);
    const result = await setUserAvatar(context.get("user").id, uploadedPath);
    await removeStoredAvatar(result.previousAvatarUrl);
    return context.json({
      user: toPublicUser(result.user),
      message: "Profile picture updated.",
    });
  } catch (error) {
    if (uploadedPath) await removeStoredAvatar(uploadedPath);
    console.error("Failed to update avatar", error);
    return context.json(
      { error: "Profile picture could not be updated." },
      500,
    );
  }
});

app.delete("/api/profile/avatar", requireAuth, async (context) => {
  try {
    const result = await setUserAvatar(context.get("user").id, null);
    await removeStoredAvatar(result.previousAvatarUrl);
    return context.json({
      user: toPublicUser(result.user),
      message: "Profile picture removed.",
    });
  } catch (error) {
    console.error("Failed to remove avatar", error);
    return context.json(
      { error: "Profile picture could not be removed." },
      500,
    );
  }
});

app.get("/api/users", requireAuth, async (context) => {
  try {
    const users = await getFriends(context.get("user").id);
    return context.json({ users });
  } catch (error) {
    console.error("Failed to load friends", error);
    return context.json({ error: "Friends could not be loaded." }, 500);
  }
});

app.get("/api/friends", requireAuth, async (context) => {
  try {
    const userId = context.get("user").id;
    const [friends, counts] = await Promise.all([
      getFriends(userId),
      getUnreadCounts(userId),
    ]);
    const preferences = await getPresencePreferences(
      friends.map((friend) => friend.id),
    );
    const unread = new Map(
      counts.map((count) => [count.friendId, count.unreadCount]),
    );
    const visibleFriends = friends.map((friend) => {
      const settings = preferences.get(friend.id)!;
      const online =
        (connectionsByUser.get(friend.id)?.size ?? 0) > 0 &&
        settings.showOnlineStatus &&
        settings.onlineStatusVisibility !== "nobody" &&
        settings.presenceStatus !== "invisible";
      return {
        ...friend,
        unreadCount: unread.get(friend.id) ?? 0,
        online,
        status:
          online && settings.presenceStatus !== "invisible"
            ? settings.presenceStatus
            : "offline",
        customStatus: online ? settings.customStatus : "",
      };
    });
    return context.json({
      friends: visibleFriends,
    });
  } catch (error) {
    console.error("Failed to load friends", error);
    return context.json({ error: "Friends could not be loaded." }, 500);
  }
});

app.put("/api/friends/:friendId/favorite", requireAuth, async (context) => {
  const friendId = context.req.param("friendId") ?? "";
  const value = await readJson(context);
  if (!/^[1-9]\d{0,18}$/.test(friendId) || typeof value?.favorite !== "boolean")
    return context.json({ error: "Invalid favorite preference." }, 400);
  const saved = await setFavoriteFriend(
    context.get("user").id,
    friendId,
    value.favorite,
  );
  return saved
    ? context.json({ favorite: value.favorite })
    : context.json({ error: "Only accepted friends can be favorited." }, 403);
});

app.get("/api/friends/search", requireAuth, async (context) => {
  const limited = enforceRateLimit(
    context,
    rateLimits.search,
    `search:${context.get("user").id}`,
    "Too many searches. Please wait and try again.",
  );
  if (limited) return limited;
  const query = (context.req.query("q") ?? "").trim();
  if (!query || query.length > 254) {
    return context.json({ error: "Enter a username or email to search." }, 400);
  }
  try {
    return context.json({
      users: await searchUsers(context.get("user").id, query),
    });
  } catch (error) {
    console.error("Failed to search users", error);
    return context.json({ error: "User search could not be completed." }, 500);
  }
});

app.get("/api/friend-requests", requireAuth, async (context) => {
  try {
    return context.json({
      requests: await getReceivedFriendRequests(context.get("user").id),
    });
  } catch (error) {
    console.error("Failed to load friend requests", error);
    return context.json({ error: "Friend requests could not be loaded." }, 500);
  }
});

app.get("/api/friend-requests/sent", requireAuth, async (context) => {
  try {
    return context.json({
      requests: await getSentFriendRequests(context.get("user").id),
    });
  } catch (error) {
    console.error("Failed to load sent friend requests", error);
    return context.json({ error: "Sent requests could not be loaded." }, 500);
  }
});

app.get("/api/friends/suggestions", requireAuth, async (context) => {
  try {
    return context.json({
      users: await getFriendSuggestions(context.get("user").id),
    });
  } catch (error) {
    console.error("Failed to load friend suggestions", error);
    return context.json(
      { error: "Friend suggestions could not be loaded." },
      500,
    );
  }
});

app.post("/api/friend-requests", requireAuth, async (context) => {
  const limited = enforceRateLimit(
    context,
    rateLimits.friendRequest,
    `friend-request:${context.get("user").id}`,
    "Too many friend requests. Please wait and try again.",
  );
  if (limited) return limited;
  const value = await readJson(context);
  const receiverId =
    typeof value?.receiverId === "string" ? value.receiverId.trim() : "";
  const sender = context.get("user");
  if (!/^\d+$/.test(receiverId)) {
    return context.json({ error: "Please select a valid user." }, 400);
  }
  if (receiverId === sender.id) {
    return context.json({ error: "You cannot add yourself as a friend." }, 400);
  }
  try {
    if (!(await findChatUserById(receiverId))) {
      return context.json({ error: "User was not found." }, 404);
    }
    const result = await createFriendRequest(sender.id, receiverId);
    if (result.outcome === "friends") {
      return context.json({ error: "You are already friends." }, 409);
    }
    if (result.outcome === "pending") {
      return context.json(
        { error: "A friend request is already pending." },
        409,
      );
    }
    return context.json(
      { requestId: result.requestId, message: "Friend request sent." },
      201,
    );
  } catch (error) {
    console.error("Failed to create friend request", error);
    const status = await getFriendshipStatus(sender.id, receiverId).catch(
      () => null,
    );
    if (status === "accepted") {
      return context.json({ error: "You are already friends." }, 409);
    }
    if (status === "pending") {
      return context.json(
        { error: "A friend request is already pending." },
        409,
      );
    }
    return context.json({ error: "Friend request could not be sent." }, 500);
  }
});

app.put("/api/friend-requests/:requestId", requireAuth, async (context) => {
  const limited = enforceRateLimit(
    context,
    rateLimits.friendRequest,
    `friend-request:${context.get("user").id}`,
    "Too many friend request actions. Please wait and try again.",
  );
  if (limited) return limited;
  const requestId = context.req.param("requestId") ?? "";
  const value = await readJson(context);
  const action = value?.action;
  if (
    !/^\d+$/.test(requestId) ||
    (action !== "accept" && action !== "reject")
  ) {
    return context.json(
      { error: "Please provide a valid request action." },
      400,
    );
  }
  const updatedStatus = action === "accept" ? "accepted" : "rejected";
  try {
    const updated = await respondToFriendRequest(
      requestId,
      context.get("user").id,
      updatedStatus,
    );
    if (!updated) {
      return context.json(
        { error: "Pending friend request was not found." },
        404,
      );
    }
    return context.json({
      message:
        updatedStatus === "accepted"
          ? "Friend request accepted."
          : "Friend request rejected.",
    });
  } catch (error) {
    console.error("Failed to respond to friend request", error);
    return context.json({ error: "Friend request could not be updated." }, 500);
  }
});

app.delete("/api/friend-requests/:requestId", requireAuth, async (context) => {
  const limited = enforceRateLimit(
    context,
    rateLimits.friendRequest,
    `friend-request:${context.get("user").id}`,
    "Too many friend request actions. Please wait and try again.",
  );
  if (limited) return limited;
  const requestId = context.req.param("requestId") ?? "";
  if (!/^\d+$/.test(requestId))
    return context.json({ error: "Invalid friend request." }, 400);
  try {
    const cancelled = await cancelFriendRequest(
      requestId,
      context.get("user").id,
    );
    return cancelled
      ? context.json({ message: "Friend request cancelled." })
      : context.json({ error: "Pending sent request was not found." }, 404);
  } catch (error) {
    console.error("Failed to cancel friend request", error);
    return context.json(
      { error: "Friend request could not be cancelled." },
      500,
    );
  }
});

app.get("/api/groups", requireAuth, async (context) => {
  try {
    return context.json({ groups: await getGroups(context.get("user").id) });
  } catch (error) {
    console.error("Failed to load groups", error);
    return context.json({ error: "Groups could not be loaded." }, 500);
  }
});

app.post("/api/groups", requireAuth, async (context) => {
  const value = await readJson(context),
    name = typeof value?.name === "string" ? value.name.trim() : "";
  const memberIds = Array.isArray(value?.memberIds)
    ? [
        ...new Set(
          value.memberIds.filter(
            (id): id is string =>
              typeof id === "string" && /^[1-9]\d{0,18}$/.test(id),
          ),
        ),
      ]
    : [];
  if (
    !name ||
    name.length > 80 ||
    memberIds.length > 50 ||
    memberIds.length !==
      (Array.isArray(value?.memberIds) ? value.memberIds.length : 0)
  )
    return context.json(
      { error: "Enter a group name and select valid friends." },
      400,
    );
  try {
    const group = await createGroup(context.get("user").id, name, memberIds);
    if (!group)
      return context.json(
        { error: "Groups may contain accepted friends only." },
        403,
      );
    for (const id of group.members.map((member) => member.id))
      sendToUser(id, { type: "group.updated", groupId: group.id });
    return context.json({ group }, 201);
  } catch (error) {
    console.error("Failed to create group", error);
    return context.json({ error: "Group could not be created." }, 500);
  }
});

app.get("/api/groups/:groupId", requireAuth, async (context) => {
  const id = context.req.param("groupId") ?? "";
  if (!/^[1-9]\d{0,18}$/.test(id))
    return context.json({ error: "Group not found." }, 404);
  const group = await getGroupInfo(id, context.get("user").id);
  return group
    ? context.json({ group })
    : context.json({ error: "Group not found." }, 404);
});

app.get("/api/groups/:groupId/messages", requireAuth, async (context) => {
  const id = context.req.param("groupId") ?? "";
  if (!/^[1-9]\d{0,18}$/.test(id))
    return context.json({ error: "Group not found." }, 404);
  const messages = await getGroupMessages(id, context.get("user").id);
  return messages
    ? context.json({ messages })
    : context.json({ error: "You are not a member of this group." }, 403);
});

app.put("/api/groups/:groupId", requireAuth, async (context) => {
  const groupId = context.req.param("groupId") ?? "",
    userId = context.get("user").id,
    value = await readJson(context),
    action = value?.action;
  if (!/^[1-9]\d{0,18}$/.test(groupId))
    return context.json({ error: "Group not found." }, 404);
  try {
    const before = await getGroupMemberIds(groupId);
    let ok = false;
    if (action === "rename") {
      const name = typeof value?.name === "string" ? value.name.trim() : "";
      if (!name || name.length > 80)
        return context.json(
          { error: "Group name is required and may be at most 80 characters." },
          400,
        );
      ok = await updateGroup(groupId, userId, name);
    } else if (action === "add" || action === "remove") {
      const target = typeof value?.userId === "string" ? value.userId : "";
      if (!/^[1-9]\d{0,18}$/.test(target))
        return context.json({ error: "Select a valid member." }, 400);
      ok =
        action === "add"
          ? await addGroupMember(groupId, userId, target)
          : await removeGroupMember(groupId, userId, target);
    } else if (action === "leave") ok = await leaveGroup(groupId, userId);
    else return context.json({ error: "Invalid group action." }, 400);
    if (!ok)
      return context.json({ error: "Group action is not allowed." }, 403);
    const after = await getGroupMemberIds(groupId);
    for (const id of new Set([...before, ...after]))
      sendToUser(id, { type: "group.updated", groupId });
    return context.json({ message: "Group updated." });
  } catch (error) {
    console.error("Failed to update group", error);
    return context.json({ error: "Group could not be updated." }, 500);
  }
});

// Never return even a ghost's existence to the receiver or another user.
app.get("/api/ghosts/:messageId", requireAuth, async (context) => {
  const id = context.req.param("messageId") ?? "";
  if (!/^[1-9]\d{0,18}$/.test(id))
    return context.json({ error: "Ghost not found." }, 404);
  const message = await findPrivateMessage(id);
  const user = context.get("user");
  if (
    !message ||
    message.senderId !== user.id ||
    message.messageStatus === "sent" ||
    message.messageStatus === "cancelled" ||
    !(await areFriends(user.id, message.receiverId))
  )
    return context.json({ error: "Ghost not found." }, 404);
  return context.json({ message });
});

app.get("/api/messages/:userId", requireAuth, async (context) => {
  const currentUser = context.get("user");
  const otherUserId = context.req.param("userId");
  if (
    !otherUserId ||
    !/^\d+$/.test(otherUserId) ||
    otherUserId === currentUser.id
  ) {
    return context.json({ error: "Please select a valid user." }, 400);
  }

  try {
    const otherUser = await findChatUserById(otherUserId);
    if (!otherUser) return context.json({ error: "User was not found." }, 404);
    if (!(await areFriends(currentUser.id, otherUserId))) {
      return context.json(
        { error: "You can only view messages with accepted friends." },
        403,
      );
    }
    const messages = await getPrivateMessages(currentUser.id, otherUserId);
    return context.json({ messages });
  } catch (error) {
    console.error("Failed to load private message history", error);
    return context.json({ error: "Message history could not be loaded." }, 500);
  }
});

app.get("/api/messages", requireAuth, async (context) => {
  if (!legacyGlobalChatEnabled)
    return context.json(
      { error: "Legacy global chat is disabled.", code: "FEATURE_DISABLED" },
      404,
    );
  try {
    return context.json({ messages: await getRecentMessages() });
  } catch (error) {
    console.error("Failed to load message history", error);
    return context.json({ error: "Failed to load message history" }, 500);
  }
});

app.post("/api/attachments", requireAuth, async (context) => {
  const limited = enforceRateLimit(
    context,
    rateLimits.upload,
    `upload:${context.get("user").id}`,
    "Too many uploads. Please wait and try again.",
  );
  if (limited) return limited;
  await assertRequestBodyWithin(context.req.raw, MAX_HTTP_BODY_BYTES);
  let form: FormData;
  try {
    form = await context.req.formData();
  } catch {
    return context.json({ error: "Attachment upload is malformed." }, 400);
  }
  let storageKey: string | null = null;
  try {
    const file = form.get("file");
    const kind = form.get("kind");
    const scope = form.get("scope");
    const targetId = form.get("targetId");
    const rawCaption = form.get("caption");
    const caption = typeof rawCaption === "string" ? rawCaption.trim() : "";
    if (
      !(file instanceof File) ||
      (scope !== "private" && scope !== "group") ||
      !isDatabaseId(targetId) ||
      caption.length > MAX_MESSAGE_LENGTH
    )
      return context.json({ error: "Invalid attachment request." }, 400);
    const validated = await validateUpload(
      file,
      typeof kind === "string" ? kind : "",
    );
    if ("error" in validated)
      return context.json({ error: validated.error }, 400);
    storageKey = await writeAttachment(validated);
    const result = await saveAttachmentMessage(
      context.get("user"),
      scope,
      targetId,
      {
        kind: validated.kind,
        storageKey,
        fileName: validated.originalName,
        mimeType: validated.mimeType,
        sizeBytes: validated.sizeBytes,
      },
      caption,
    );
    if (!result) {
      await removeAttachment(storageKey);
      return context.json(
        {
          error:
            scope === "private"
              ? "You can only share with accepted friends."
              : "You are not a member of this group.",
        },
        403,
      );
    }
    return context.json(result, 201);
  } catch (error) {
    if (storageKey) await removeAttachment(storageKey);
    console.error("Failed to upload chat attachment", error);
    return context.json({ error: "Attachment could not be sent." }, 500);
  }
});

app.post("/api/attachments/location", requireAuth, async (context) => {
  const limited = enforceRateLimit(
    context,
    rateLimits.upload,
    `upload:${context.get("user").id}`,
    "Too many shared items. Please wait and try again.",
  );
  if (limited) return limited;
  const value = await readJson(context);
  const scope = value?.scope;
  const targetId = value?.targetId;
  const latitude = value?.latitude;
  const longitude = value?.longitude;
  const caption =
    typeof value?.caption === "string" ? value.caption.trim() : "";
  if (
    (scope !== "private" && scope !== "group") ||
    !isDatabaseId(targetId) ||
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    caption.length > MAX_MESSAGE_LENGTH
  )
    return context.json({ error: "Invalid location request." }, 400);
  try {
    const result = await saveAttachmentMessage(
      context.get("user"),
      scope,
      targetId,
      { kind: "location", latitude, longitude },
      caption,
    );
    return result
      ? context.json(result, 201)
      : context.json(
          {
            error:
              scope === "private"
                ? "You can only share with accepted friends."
                : "You are not a member of this group.",
          },
          403,
        );
  } catch (error) {
    console.error("Failed to share location", error);
    return context.json({ error: "Location could not be sent." }, 500);
  }
});

app.get(
  "/api/attachments/:attachmentId/content",
  requireAuth,
  async (context) => {
    const id = context.req.param("attachmentId");
    if (!isDatabaseId(id)) return context.notFound();
    const attachment = await getAccessibleAttachment(
      id,
      context.get("user").id,
    );
    if (!attachment?.storageKey || !attachment.mimeType)
      return context.notFound();
    const file = attachmentFile(attachment.storageKey);
    if (!(await file.exists())) return context.notFound();
    const disposition = attachment.kind === "image" ? "inline" : "attachment";
    const encodedName = encodeURIComponent(attachment.fileName ?? "attachment");
    return new Response(file, {
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  },
);

app.use("/ws", requireTrustedWebSocketOrigin);
app.use("/ws", requireAuth);
app.get(
  "/ws",
  upgradeWebSocket((context) => {
    const user = context.get("user");
    const token = getCookie(context, SESSION_COOKIE);
    const sessionHash = token ? hashSessionToken(token) : null;
    const connectionId = crypto.randomUUID();
    return {
      onOpen(_event, client) {
        connectionIds.set(getClientKey(client), connectionId);
        addConnection(user, client);
        console.info(
          `WebSocket connected for user ${user.id} (${authenticatedClients.size} total)`,
        );
      },
      onMessage(event, client) {
        const key = getClientKey(client);
        const overall = rateLimits.wsConnection.consume(
          `connection:${connectionId}`,
        );
        if (!overall.allowed) {
          sendWebSocketRateLimit(client, overall);
          client.close(1008, "Realtime event rate exceeded");
          removeConnection(client);
          return;
        }
        const message = parseClientMessage(event.data);
        if (!message) {
          const malformed = rateLimits.wsMalformed.consume(
            `malformed:${connectionId}`,
          );
          sendJson(client, {
            type: "error",
            data: {
              code: "INVALID_EVENT",
              message: `Invalid message. Text must be 1-${MAX_MESSAGE_LENGTH} characters.`,
            },
          });
          if (!malformed.allowed) {
            client.close(1008, "Too many malformed events");
            removeConnection(client);
          }
          return;
        }
        const queue = clientEventQueues.get(key) ?? {
          tail: Promise.resolve(),
          pending: 0,
        };
        if (queue.pending >= MAX_QUEUED_CLIENT_EVENTS) {
          sendJson(client, {
            type: "error",
            data: {
              code: "QUEUE_OVERFLOW",
              message: "Too many realtime actions are waiting to be processed.",
            },
          });
          client.close(1013, "Realtime queue overflow");
          removeConnection(client);
          return;
        }
        queue.pending += 1;
        const task = queue.tail
          .then(async () => {
            const registered = authenticatedClients.get(getClientKey(client));
            const verified =
              registered && sessionHash
                ? await findUserBySession(sessionHash)
                : null;
            const sender = verified ? toPublicUser(verified) : null;
            if (!sender) {
              sendJson(client, {
                type: "error",
                data: { message: "Your session is not authenticated." },
              });
              client.close(1008, "Session expired");
              removeConnection(client);
              return;
            }
            const eventLimit = websocketEventLimit(message, sender.id);
            if (!eventLimit.allowed) {
              sendWebSocketRateLimit(client, eventLimit);
              return;
            }
            if (isCallClientMessage(message)) {
              try {
                await handleCallMessage(message, sender, client);
              } catch (error) {
                console.error("Failed to handle voice call signal", error);
                sendJson(client, {
                  type: "error",
                  data: {
                    message: "Voice call signaling failed. Please try again.",
                  },
                });
              }
              return;
            }
            if (
              message.type === "chat.sync" ||
              message.type === "message.read" ||
              message.type === "typing.start" ||
              message.type === "typing.stop"
            ) {
              try {
                await chatStatus.handle(message, sender, client);
              } catch (error) {
                console.error("Failed to update chat status", error);
                sendJson(client, {
                  type: "error",
                  data: {
                    message:
                      "Chat status could not be updated. Please try again.",
                  },
                });
              }
              return;
            }
            if (message.type === "group.read") {
              if (!(await markGroupRead(message.groupId, sender.id)))
                sendJson(client, {
                  type: "error",
                  data: { message: "You are not a member of this group." },
                });
              else {
                sendToUser(sender.id, {
                  type: "group.updated",
                  groupId: message.groupId,
                });
              }
              return;
            }
            if (
              message.type === "group.typing.start" ||
              message.type === "group.typing.stop"
            ) {
              if (!(await isGroupMember(message.groupId, sender.id))) {
                sendJson(client, {
                  type: "error",
                  data: { message: "You are not a member of this group." },
                });
                return;
              }
              if (message.type === "group.typing.stop")
                await stopGroupTyping(client, sender, message.groupId);
              else {
                if (!(await getUserSettings(sender.id)).showTypingIndicator)
                  return;
                const key = getClientKey(client),
                  groups = groupTyping.get(key) ?? new Map();
                const existing = groups.get(message.groupId);
                if (existing) clearTimeout(existing);
                if (!existing)
                  await broadcastToGroup(
                    message.groupId,
                    {
                      type: "group.typing.start",
                      groupId: message.groupId,
                      userId: sender.id,
                      username: sender.username,
                    },
                    sender.id,
                  );
                groups.set(
                  message.groupId,
                  setTimeout(
                    () => void stopGroupTyping(client, sender, message.groupId),
                    2500,
                  ),
                );
                groupTyping.set(key, groups);
              }
              return;
            }
            if (
              message.type === "group.message.edit" ||
              message.type === "group.message.delete"
            ) {
              const updated = await mutateGroupMessage(
                message.messageId,
                sender.id,
                message.type === "group.message.edit" ? "edit" : "delete",
                message.type === "group.message.edit" ? message.message : "",
              );
              if (!updated) {
                sendJson(client, {
                  type: "error",
                  data: {
                    message:
                      "You can only update your own undeleted group messages.",
                  },
                });
                return;
              }
              await broadcastToGroup(updated.groupId, {
                type:
                  message.type === "group.message.edit"
                    ? "group.message.edited"
                    : "group.message.deleted",
                message: updated,
              });
              for (const id of await getGroupMemberIds(updated.groupId))
                sendToUser(id, {
                  type: "group.updated",
                  groupId: updated.groupId,
                });
              return;
            }
            if (message.type === "group.message.send") {
              const stored = await createGroupMessage(
                message.groupId,
                sender.id,
                message.message,
                message.replyToMessageId,
              );
              if (!stored) {
                sendJson(client, {
                  type: "error",
                  data: {
                    message:
                      "Group message was rejected. Check membership and reply target.",
                  },
                });
                return;
              }
              await stopGroupTyping(client, sender, message.groupId);
              await broadcastToGroup(message.groupId, {
                type: "group.message.new",
                message: stored,
              });
              for (const id of await getGroupMemberIds(message.groupId))
                sendToUser(id, {
                  type: "group.updated",
                  groupId: message.groupId,
                });
              return;
            }
            if (message.type === "message.send.global") {
              if (!legacyGlobalChatEnabled) {
                sendJson(client, {
                  type: "error",
                  data: {
                    code: "FEATURE_DISABLED",
                    message: "Legacy global chat is disabled.",
                  },
                });
                return;
              }
              try {
                const storedMessage = await createMessage(
                  sender.username,
                  message.message,
                );
                sendToAllUsers({ type: "message.new", data: storedMessage });
              } catch (error) {
                console.error("Failed to save legacy global message", error);
                sendJson(client, {
                  type: "error",
                  data: {
                    message: "Message could not be saved. Please try again.",
                  },
                });
              }
              return;
            }
            if (
              message.type === "ghost.edit" ||
              message.type === "ghost.delete" ||
              message.type === "ghost.schedule" ||
              message.type === "ghost.release"
            ) {
              const original = await findPrivateMessage(message.messageId);
              if (
                !original ||
                original.senderId !== sender.id ||
                original.deletedAt ||
                !["ghost", "scheduled"].includes(original.messageStatus) ||
                !(await areFriends(sender.id, original.receiverId))
              ) {
                sendJson(client, {
                  type: "error",
                  data: {
                    message:
                      "Ghost is not available or you do not have permission.",
                  },
                });
                return;
              }
              if (message.type === "ghost.release") {
                const released = await releaseGhost(original.id, sender.id);
                if (released) await publishPendingGhosts(publishReleasedGhost);
                else
                  sendJson(client, {
                    type: "error",
                    data: {
                      message:
                        "Ghost has already changed or cannot be released.",
                    },
                  });
              } else {
                const updated = await updateGhost(
                  original.id,
                  sender.id,
                  message.type === "ghost.edit"
                    ? { action: "edit", text: message.message }
                    : message.type === "ghost.delete"
                      ? { action: "delete" }
                      : {
                          action: "schedule",
                          scheduledAt: message.scheduledAt,
                        },
                );
                if (updated)
                  sendToUser(sender.id, {
                    type: "ghost.updated",
                    message: updated,
                  });
                else
                  sendJson(client, {
                    type: "error",
                    data: {
                      message:
                        "Ghost has already changed. Schedule must be in the future.",
                    },
                  });
              }
              return;
            }
            if (
              message.type === "message.edit" ||
              message.type === "message.delete"
            ) {
              try {
                const original = await findPrivateMessage(message.messageId);
                if (
                  !original ||
                  original.senderId !== sender.id ||
                  original.messageStatus !== "sent" ||
                  original.deletedAt
                ) {
                  sendJson(client, {
                    type: "error",
                    data: {
                      message:
                        "You can only edit or delete your own undeleted messages.",
                    },
                  });
                  return;
                }
                if (!(await areFriends(sender.id, original.receiverId))) {
                  sendJson(client, {
                    type: "error",
                    data: {
                      message:
                        "You can only update messages with accepted friends.",
                    },
                  });
                  return;
                }
                const updated = await mutatePrivateMessage(
                  original.id,
                  sender.id,
                  message.type === "message.edit" ? "edit" : "delete",
                  message.type === "message.edit" ? message.message : "",
                );
                if (!updated) {
                  sendJson(client, {
                    type: "error",
                    data: { message: "This message can no longer be updated." },
                  });
                  return;
                }
                const update: ServerMessage = {
                  type:
                    message.type === "message.edit"
                      ? "message.edited"
                      : "message.deleted",
                  message: updated,
                };
                sendToUser(updated.senderId, update);
                sendToUser(updated.receiverId, update);
                if (message.type === "message.delete")
                  await chatStatus.publishUnread(updated.receiverId);
              } catch (error) {
                console.error("Failed to update private message", error);
                sendJson(client, {
                  type: "error",
                  data: {
                    message: "Message could not be updated. Please try again.",
                  },
                });
              }
              return;
            }
            if (message.receiverId === sender.id) {
              sendJson(client, {
                type: "error",
                data: { message: "You cannot send a message to yourself." },
              });
              return;
            }
            try {
              const receiver = await findChatUserById(message.receiverId);
              if (!receiver) {
                sendJson(client, {
                  type: "error",
                  data: { message: "The selected user was not found." },
                });
                return;
              }
              if (!(await areFriends(sender.id, receiver.id))) {
                sendJson(client, {
                  type: "error",
                  data: { message: "You can only message accepted friends." },
                });
                return;
              }
              if (message.replyToMessageId) {
                const original = await findPrivateMessage(
                  message.replyToMessageId,
                );
                if (
                  !original ||
                  original.messageStatus !== "sent" ||
                  !(
                    (original.senderId === sender.id &&
                      original.receiverId === receiver.id) ||
                    (original.senderId === receiver.id &&
                      original.receiverId === sender.id)
                  )
                ) {
                  sendJson(client, {
                    type: "error",
                    data: {
                      message:
                        "Reply must reference a message in this conversation.",
                    },
                  });
                  return;
                }
              }
              const storedMessage = await createPrivateMessage(
                {
                  id: sender.id,
                  username: sender.username,
                  avatarUrl: sender.avatarUrl,
                  bio: sender.bio,
                } satisfies ChatUser,
                receiver.id,
                message.message,
                message.replyToMessageId,
                message.type === "ghost.create",
              );
              const serverMessage: ServerMessage = {
                type: "message.new",
                message: storedMessage,
              };
              if (message.type === "ghost.create") {
                sendToUser(sender.id, {
                  type: "ghost.updated",
                  message: storedMessage,
                });
                chatStatus.stopTyping(
                  sender.id,
                  getClientKey(client),
                  receiver.id,
                );
                return;
              }
              sendToUser(sender.id, serverMessage);
              sendToUser(receiver.id, serverMessage);
              chatStatus.stopTyping(
                sender.id,
                getClientKey(client),
                receiver.id,
              );
              await chatStatus
                .publishUnread(receiver.id)
                .catch((error) =>
                  console.error("Failed to publish unread counts", error),
                );
            } catch (error) {
              console.error("Failed to save private message", error);
              sendJson(client, {
                type: "error",
                data: {
                  message: "Message could not be saved. Please try again.",
                },
              });
            }
          })
          .catch((error) => {
            console.error("Failed to process WebSocket event", error);
            sendJson(client, {
              type: "error",
              data: {
                message: "Event could not be processed. Please try again.",
              },
            });
          });
        queue.tail = task;
        clientEventQueues.set(key, queue);
        void task.finally(() => {
          queue.pending = Math.max(0, queue.pending - 1);
          if (queue.pending === 0 && clientEventQueues.get(key) === queue)
            clientEventQueues.delete(key);
        });
      },
      onClose(_event, client) {
        removeConnection(client);
        console.info(
          `WebSocket disconnected (${authenticatedClients.size} total)`,
        );
      },
      onError(_event, client) {
        removeConnection(client);
        console.error(`WebSocket error (${authenticatedClients.size} total)`);
      },
    };
  }),
);

const port = Number(Bun.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const devTls = await (async () => {
  if (!devHttpsEnabled) return undefined;
  const certPath = Bun.env.TLS_CERT_PATH?.trim();
  const keyPath = Bun.env.TLS_KEY_PATH?.trim();
  if (!certPath || !keyPath) {
    throw new Error(
      "TLS_CERT_PATH and TLS_KEY_PATH are required when DEV_HTTPS=true",
    );
  }
  const cert = Bun.file(resolve(process.cwd(), certPath));
  const key = Bun.file(resolve(process.cwd(), keyPath));
  if (!(await cert.exists()) || !(await key.exists())) {
    throw new Error("The configured development TLS certificate was not found");
  }
  return { cert, key };
})();
// Start background work only after binding succeeds. A duplicate development
// process that fails to bind must not claim scheduled rows without recipients.
const hardenedWebSocket = {
  ...websocket,
  maxPayloadLength: MAX_WEBSOCKET_PAYLOAD_BYTES,
  backpressureLimit: WEBSOCKET_BACKPRESSURE_BYTES,
  closeOnBackpressureLimit: true,
  idleTimeout: 120,
};
const createServer = () =>
  Bun.serve({
    port,
    fetch: app.fetch,
    websocket: hardenedWebSocket,
    maxRequestBodySize: MAX_HTTP_BODY_BYTES,
    tls: devTls,
  });
const serverRuntime = globalThis as typeof globalThis & {
  pbMessengerServer?: ReturnType<typeof createServer>;
};
if (serverRuntime.pbMessengerServer) {
  serverRuntime.pbMessengerServer.reload({
    fetch: app.fetch,
    websocket: hardenedWebSocket,
  });
} else {
  serverRuntime.pbMessengerServer = createServer();
}
export const server = serverRuntime.pbMessengerServer;
startGhostScheduler(publishReleasedGhost);
const backendProtocol = devHttpsEnabled ? "https" : "http";
console.info(
  `Realtime chat backend listening on ${backendProtocol}://localhost:${port}`,
);
console.info(`Allowed frontend origins: ${[...frontendOrigins].join(", ")}`);
