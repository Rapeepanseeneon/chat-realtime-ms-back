import { Hono, type Context, type Next } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { WSContext } from "hono/ws";
import {
  areFriends,
  createFriendRequest,
  createMessage,
  createPrivateMessage,
  createSession,
  createUser,
  deleteSession,
  findConflictingUser,
  findChatUserById,
  findUserByEmail,
  findUserBySession,
  getFriends,
  getFriendshipStatus,
  getPrivateMessages,
  getReceivedFriendRequests,
  getRecentMessages,
  initializeDatabase,
  respondToFriendRequest,
  searchUsers,
  toPublicUser,
  updateUser,
  type ChatUser,
  type PrivateMessage,
  type PublicUser,
  type StoredMessage,
} from "./database";

const MAX_MESSAGE_LENGTH = 1_000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7;
const SESSION_COOKIE = "pb_session";
const frontendUrl = (Bun.env.FRONTEND_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const secureCookies =
  Bun.env.COOKIE_SECURE === "true" ||
  (Bun.env.COOKIE_SECURE !== "false" && Bun.env.NODE_ENV === "production");

type Variables = { user: PublicUser };
type ClientMessage =
  | { type: "message.send"; receiverId: string; message: string }
  | { type: "message.send.global"; message: string };
type ServerMessage =
  | { type: "message.new"; message: PrivateMessage }
  | { type: "message.new"; data: StoredMessage }
  | { type: "error"; data: { message: string } };

const app = new Hono<{ Variables: Variables }>();
const connectionsByUser = new Map<string, Set<WSContext>>();
const authenticatedClients = new Map<unknown, PublicUser>();
const getClientKey = (client: WSContext): unknown => client.raw ?? client;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const hashSessionToken = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

const createSessionToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

const readJson = async (
  context: Context,
): Promise<Record<string, unknown> | null> => {
  try {
    const value: unknown = await context.req.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const validateProfile = (value: Record<string, unknown>) => {
  const username =
    typeof value.username === "string" ? value.username.trim() : "";
  const email =
    typeof value.email === "string" ? value.email.trim().toLowerCase() : "";

  if (!username) return { error: "Username is required." } as const;
  if (username.length > 50)
    return { error: "Username must be 50 characters or fewer." } as const;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { error: "Please enter a valid email address." } as const;
  }
  return { username, email } as const;
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
    if (origin && origin !== frontendUrl) {
      return context.json(
        { error: "This request origin is not allowed." },
        403,
      );
    }
  }
  await next();
};

const parseClientMessage = (rawValue: unknown): ClientMessage | null => {
  if (typeof rawValue !== "string") return null;
  try {
    const value: unknown = JSON.parse(rawValue);
    if (!isRecord(value) || value.type !== "message.send") return null;

    if (isRecord(value.data) && typeof value.data.text === "string") {
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
    if (!/^\d+$/.test(receiverId)) return null;
    if (!message || message.length > MAX_MESSAGE_LENGTH) return null;
    return { type: "message.send", receiverId, message };
  } catch {
    return null;
  }
};

const sendJson = (client: WSContext, message: ServerMessage) => {
  try {
    client.send(JSON.stringify(message));
  } catch {
    removeConnection(client);
  }
};

const addConnection = (user: PublicUser, client: WSContext) => {
  const connections = connectionsByUser.get(user.id) ?? new Set<WSContext>();
  connections.add(client);
  connectionsByUser.set(user.id, connections);
  authenticatedClients.set(getClientKey(client), user);
};

const removeConnection = (client: WSContext) => {
  const key = getClientKey(client);
  const user = authenticatedClients.get(key);
  authenticatedClients.delete(key);
  if (!user) return;
  const connections = connectionsByUser.get(user.id);
  connections?.delete(client);
  if (connections?.size === 0) connectionsByUser.delete(user.id);
};

const sendToUser = (userId: string, message: ServerMessage) => {
  for (const client of connectionsByUser.get(userId) ?? []) {
    sendJson(client, message);
  }
};

const sendToAllUsers = (message: ServerMessage) => {
  for (const userId of connectionsByUser.keys()) sendToUser(userId, message);
};

await initializeDatabase();

app.use(
  "/api/*",
  cors({
    origin: frontendUrl,
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
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

app.post("/api/auth/register", async (context) => {
  const value = await readJson(context);
  if (!value)
    return context.json(
      { error: "Please provide valid registration details." },
      400,
    );
  const profile = validateProfile(value);
  if ("error" in profile) return context.json({ error: profile.error }, 400);

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
      {
        error: `${conflict === "username" ? "Username" : "Email"} is already in use.`,
      },
      409,
    );

  try {
    const passwordHash = await Bun.password.hash(password, "argon2id");
    const user = await createUser(
      profile.username,
      profile.email,
      passwordHash,
    );
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
        {
          error: `${racedConflict === "username" ? "Username" : "Email"} is already in use.`,
        },
        409,
      );
    return context.json(
      { error: "Account could not be created. Please try again." },
      500,
    );
  }
});

app.post("/api/auth/login", async (context) => {
  const value = await readJson(context);
  const email =
    typeof value?.email === "string" ? value.email.trim().toLowerCase() : "";
  const password = typeof value?.password === "string" ? value.password : "";
  if (!email || !password)
    return context.json({ error: "Email and password are required." }, 400);

  const user = await findUserByEmail(email);
  if (!user || !(await Bun.password.verify(password, user.passwordHash))) {
    return context.json({ error: "Email or password is incorrect." }, 401);
  }

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

app.post("/api/auth/logout", async (context) => {
  const token = getCookie(context, SESSION_COOKIE);
  if (token) await deleteSession(hashSessionToken(token));
  deleteCookie(context, SESSION_COOKIE, { path: "/", secure: secureCookies });
  return context.json({ message: "Logged out successfully." });
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
    );
    return context.json({
      user: toPublicUser(user),
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
    return context.json({ friends: await getFriends(context.get("user").id) });
  } catch (error) {
    console.error("Failed to load friends", error);
    return context.json({ error: "Friends could not be loaded." }, 500);
  }
});

app.get("/api/friends/search", requireAuth, async (context) => {
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

app.post("/api/friend-requests", requireAuth, async (context) => {
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
  try {
    return context.json({ messages: await getRecentMessages() });
  } catch (error) {
    console.error("Failed to load message history", error);
    return context.json({ error: "Failed to load message history" }, 500);
  }
});

app.use("/ws", requireAuth);
app.get(
  "/ws",
  upgradeWebSocket((context) => {
    const user = context.get("user");
    return {
      onOpen(_event, client) {
        addConnection(user, client);
        console.info(
          `WebSocket connected for user ${user.id} (${authenticatedClients.size} total)`,
        );
      },
      async onMessage(event, client) {
        const message = parseClientMessage(event.data);
        if (!message) {
          sendJson(client, {
            type: "error",
            data: {
              message: `Invalid message. Text must be 1-${MAX_MESSAGE_LENGTH} characters.`,
            },
          });
          return;
        }
        const sender = authenticatedClients.get(getClientKey(client));
        if (!sender) {
          sendJson(client, {
            type: "error",
            data: { message: "Your session is not authenticated." },
          });
          return;
        }
        if (message.type === "message.send.global") {
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
          const storedMessage = await createPrivateMessage(
            { id: sender.id, username: sender.username } satisfies ChatUser,
            receiver.id,
            message.message,
          );
          const serverMessage: ServerMessage = {
            type: "message.new",
            message: storedMessage,
          };
          sendToUser(sender.id, serverMessage);
          sendToUser(receiver.id, serverMessage);
        } catch (error) {
          console.error("Failed to save private message", error);
          sendJson(client, {
            type: "error",
            data: { message: "Message could not be saved. Please try again." },
          });
        }
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
console.info(`Realtime chat backend listening on http://localhost:${port}`);
export default { port, fetch: app.fetch, websocket };
