import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  getOptionalIntegrationTestEnvironment,
  verifyTestBackend,
} from "../src/testing/test-environment";

const integration = getOptionalIntegrationTestEnvironment();
const api = integration?.apiUrl;
const origin = Bun.env.FRONTEND_URL ?? "http://localhost:3000";

(api ? test : test.skip)(
  "voice call signaling authenticates users, prevents duplicates and stays private",
  async () => {
    if (!api || !integration) throw Error("Missing integration environment");
    await verifyTestBackend(integration);
    const db = new SQL(integration.databaseUrl, { max: 1 });
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const users = ["A", "B", "C"].map((label) => ({
      id: "",
      username: `Call${label}${suffix}`,
      email: `call-${label}-${suffix}@example.test`.toLowerCase(),
      cookie: "",
    }));
    const sockets: { socket: WebSocket; events: any[] }[] = [];
    const call = (
      path: string,
      cookie = "",
      body?: unknown,
      method = body ? "POST" : "GET",
    ) =>
      fetch(api + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const until = async (check: () => boolean, timeout = 5000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (check()) return;
        await Bun.sleep(20);
      }
      throw Error("Event timeout");
    };
    const connect = async (cookie: string) => {
      const socket = new WebSocket(api.replace(/^http/, "ws") + "/ws", {
        headers: { Cookie: cookie, Origin: origin },
      });
      const client = { socket, events: [] as any[] };
      sockets.push(client);
      socket.onmessage = (event) =>
        client.events.push(JSON.parse(String(event.data)));
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(Error("WS failed"));
      });
      return client;
    };
    const send = (client: (typeof sockets)[number], value: unknown) =>
      client.socket.send(JSON.stringify(value));

    try {
      for (const user of users) {
        const password = "Call-test-42";
        expect(
          (
            await call("/api/auth/register", "", {
              ...user,
              password,
              confirmPassword: password,
            })
          ).status,
        ).toBe(201);
        const login = await call("/api/auth/login", "", {
          email: user.email,
          password,
        });
        user.cookie = login.headers.get("set-cookie")!.split(";")[0];
        user.id = ((await login.json()) as any).user.id;
      }
      const [a, b, c] = users;
      await db`INSERT INTO friend_requests(sender_id,receiver_id,status) VALUES(${a.id},${b.id},'accepted')`;
      const [sa, sb, sc] = await Promise.all(
        users.map((user) => connect(user.cookie)),
      );

      const rejectedCallId = crypto.randomUUID();
      send(sa, {
        type: "call.offer",
        callId: rejectedCallId,
        calleeId: b.id,
        callerId: c.id,
        sdp: "offer-one",
        callType: "video",
      });
      await until(() =>
        sb.events.some(
          (event) =>
            event.type === "call.offer" && event.callId === rejectedCallId,
        ),
      );
      const offer = sb.events.find(
        (event) =>
          event.type === "call.offer" && event.callId === rejectedCallId,
      );
      expect(offer.caller.id).toBe(a.id);
      expect(offer.callType).toBe("video");
      expect(sc.events.some((event) => event.callId === rejectedCallId)).toBe(
        false,
      );

      const duplicateId = crypto.randomUUID();
      send(sa, {
        type: "call.offer",
        callId: duplicateId,
        calleeId: b.id,
        sdp: "duplicate",
        callType: "video",
      });
      await until(() =>
        sa.events.some(
          (event) =>
            event.type === "call.unavailable" &&
            event.callId === duplicateId &&
            event.reason === "busy",
        ),
      );
      send(sb, { type: "call.reject", callId: rejectedCallId });
      await until(() =>
        sa.events.some(
          (event) =>
            event.type === "call.reject" && event.callId === rejectedCallId,
        ),
      );

      const unauthorizedId = crypto.randomUUID();
      send(sc, {
        type: "call.offer",
        callId: unauthorizedId,
        calleeId: b.id,
        sdp: "intrusion",
        callType: "video",
      });
      await until(() =>
        sc.events.some(
          (event) =>
            event.type === "call.unavailable" &&
            event.callId === unauthorizedId &&
            event.reason === "not_friends",
        ),
      );
      expect(sb.events.some((event) => event.callId === unauthorizedId)).toBe(
        false,
      );

      const connectedCallId = crypto.randomUUID();
      send(sa, {
        type: "call.offer",
        callId: connectedCallId,
        calleeId: b.id,
        sdp: "offer-two",
        callType: "voice",
      });
      await until(() =>
        sb.events.some(
          (event) =>
            event.type === "call.offer" && event.callId === connectedCallId,
        ),
      );
      send(sb, {
        type: "call.answer",
        callId: connectedCallId,
        sdp: "answer-two",
      });
      await until(() =>
        sa.events.some(
          (event) =>
            event.type === "call.answer" && event.callId === connectedCallId,
        ),
      );
      expect(
        sa.events.filter(
          (event) =>
            event.type === "call.answer" && event.callId === connectedCallId,
        ),
      ).toHaveLength(1);
      send(sa, {
        type: "call.ice_candidate",
        callId: connectedCallId,
        candidate: {
          candidate: "candidate:voice-test",
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: null,
        },
      });
      await until(() =>
        sb.events.some(
          (event) =>
            event.type === "call.ice_candidate" &&
            event.callId === connectedCallId,
        ),
      );
      expect(sc.events.some((event) => event.callId === connectedCallId)).toBe(
        false,
      );
      send(sb, { type: "call.end", callId: connectedCallId });
      await until(() =>
        sa.events.some(
          (event) =>
            event.type === "call.end" && event.callId === connectedCallId,
        ),
      );

      const disconnectedCallId = crypto.randomUUID();
      send(sa, {
        type: "call.offer",
        callId: disconnectedCallId,
        calleeId: b.id,
        sdp: "disconnect-test",
        callType: "voice",
      });
      await until(() =>
        sb.events.some(
          (event) =>
            event.type === "call.offer" && event.callId === disconnectedCallId,
        ),
      );
      sb.socket.close();
      await until(() =>
        sa.events.some(
          (event) =>
            event.type === "call.end" &&
            event.callId === disconnectedCallId &&
            event.reason === "disconnected",
        ),
      );
      const offlineId = crypto.randomUUID();
      send(sa, {
        type: "call.offer",
        callId: offlineId,
        calleeId: b.id,
        sdp: "offline",
        callType: "voice",
      });
      await until(() =>
        sa.events.some(
          (event) =>
            event.type === "call.unavailable" &&
            event.callId === offlineId &&
            event.reason === "offline",
        ),
      );
    } finally {
      for (const client of sockets) client.socket.close();
      await db`DELETE FROM users WHERE email IN ${db(users.map((user) => user.email))}`;
      await db.close();
    }
  },
  30000,
);
