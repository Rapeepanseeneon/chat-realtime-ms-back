import { expect, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import {
  getOptionalIntegrationTestEnvironment,
  requireTestAttachmentStorageDirectory,
  verifyTestBackend,
} from "../src/testing/test-environment";

const integration = getOptionalIntegrationTestEnvironment();
const api = integration?.apiUrl;
const origin = Bun.env.FRONTEND_URL ?? "http://localhost:3000";

(api ? test : test.skip)(
  "private and group attachments persist, stay authorized and publish realtime once",
  async () => {
    if (!api || !integration) throw Error("Missing integration environment");
    await verifyTestBackend(integration);
    const testAttachmentDirectory = requireTestAttachmentStorageDirectory();
    const db = new SQL(integration.databaseUrl, { max: 1 });
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const users = ["A", "B", "C"].map((label) => ({
      id: "",
      username: `Attach${label}${suffix}`,
      email: `attach-${label}-${suffix}@example.test`.toLowerCase(),
      cookie: "",
    }));
    const sockets: { socket: WebSocket; events: any[] }[] = [];
    const json = (path: string, cookie: string, body?: unknown) =>
      fetch(api + path, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: origin,
          Cookie: cookie,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const upload = (
      cookie: string,
      scope: "private" | "group",
      targetId: string,
      kind: "image" | "file",
      file: File,
      caption = "",
    ) => {
      const form = new FormData();
      form.set("scope", scope);
      form.set("targetId", targetId);
      form.set("kind", kind);
      form.set("caption", caption);
      form.set("file", file, file.name);
      return fetch(`${api}/api/attachments`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
        body: form,
      });
    };
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

    try {
      for (const user of users) {
        const password = "Attachment-test-42";
        expect(
          (
            await json("/api/auth/register", "", {
              ...user,
              password,
              confirmPassword: password,
            })
          ).status,
        ).toBe(201);
        const login = await json("/api/auth/login", "", {
          email: user.email,
          password,
        });
        user.cookie = login.headers.get("set-cookie")!.split(";")[0];
        user.id = ((await login.json()) as any).user.id;
      }
      const [a, b, c] = users;
      await db`INSERT INTO friend_requests(sender_id,receiver_id,status) VALUES(${a.id},${b.id},'accepted')`;
      const groupResponse = await json("/api/groups", a.cookie, {
        name: "Attachment Team",
        memberIds: [b.id],
      });
      expect(groupResponse.status).toBe(201);
      const group = ((await groupResponse.json()) as any).group;
      const [sa, sb, sc] = await Promise.all(
        users.map((user) => connect(user.cookie)),
      );

      const invalid = await upload(
        a.cookie,
        "private",
        b.id,
        "image",
        new File(["not-image"], "fake.png", { type: "image/png" }),
      );
      expect(invalid.status).toBe(400);
      const unauthorizedPrivate = await upload(
        c.cookie,
        "private",
        b.id,
        "file",
        new File(["secret"], "note.txt", { type: "text/plain" }),
      );
      expect({
        status: unauthorizedPrivate.status,
        body: await unauthorizedPrivate.text(),
      }).toEqual({
        status: 403,
        body: JSON.stringify({
          error: "You can only share with accepted friends.",
        }),
      });

      const png = new File(
        [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
        "shared.png",
        { type: "image/png" },
      );
      const photoResponse = await upload(
        a.cookie,
        "private",
        b.id,
        "image",
        png,
        "Photo",
      );
      expect(photoResponse.status).toBe(201);
      const photo = ((await photoResponse.json()) as any).message;
      await until(() =>
        [sa, sb].every((client) =>
          client.events.some(
            (event) =>
              event.type === "message.new" && event.message.id === photo.id,
          ),
        ),
      );
      expect(sc.events.some((event) => event.message?.id === photo.id)).toBe(
        false,
      );
      expect(photo.attachment.kind).toBe("image");
      expect(
        (
          await fetch(api + photo.attachment.contentUrl, {
            headers: { Origin: origin, Cookie: b.cookie },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(api + photo.attachment.contentUrl, {
            headers: { Origin: origin, Cookie: c.cookie },
          })
        ).status,
      ).toBe(404);

      const locationResponse = await json(
        "/api/attachments/location",
        a.cookie,
        {
          scope: "private",
          targetId: b.id,
          latitude: 13.7563,
          longitude: 100.5018,
          caption: "Bangkok",
        },
      );
      expect(locationResponse.status).toBe(201);
      const location = ((await locationResponse.json()) as any).message;
      expect(location.attachment.latitude).toBe(13.7563);

      const groupResponse2 = await upload(
        a.cookie,
        "group",
        group.id,
        "file",
        new File(["group attachment"], "group.txt", { type: "text/plain" }),
      );
      expect(groupResponse2.status).toBe(201);
      const groupMessage = ((await groupResponse2.json()) as any).message;
      await until(() =>
        sb.events.some(
          (event) =>
            event.type === "group.message.new" &&
            event.message.id === groupMessage.id,
        ),
      );
      expect(
        sc.events.some((event) => event.message?.id === groupMessage.id),
      ).toBe(false);
      expect(
        (
          await upload(
            c.cookie,
            "group",
            group.id,
            "file",
            new File(["intrusion"], "bad.txt", { type: "text/plain" }),
          )
        ).status,
      ).toBe(403);

      const privateHistory = (await (
        await json(`/api/messages/${b.id}`, a.cookie)
      ).json()) as any;
      expect(
        privateHistory.messages.filter(
          (message: any) => message.id === photo.id,
        ),
      ).toHaveLength(1);
      expect(
        privateHistory.messages.some(
          (message: any) => message.id === location.id,
        ),
      ).toBe(true);
      const groupHistory = (await (
        await json(`/api/groups/${group.id}/messages`, b.cookie)
      ).json()) as any;
      expect(
        groupHistory.messages.filter(
          (message: any) => message.id === groupMessage.id,
        ),
      ).toHaveLength(1);
    } finally {
      for (const client of sockets) client.socket.close();
      const keys = await db<{ storageKey: string }[]>`
        SELECT storage_key AS "storageKey" FROM chat_attachments
        WHERE owner_id IN (SELECT id FROM users WHERE email IN ${db(users.map((user) => user.email))})
          AND storage_key IS NOT NULL
      `;
      await db`DELETE FROM groups WHERE created_by IN (SELECT id FROM users WHERE email IN ${db(users.map((user) => user.email))})`;
      await db`DELETE FROM users WHERE email IN ${db(users.map((user) => user.email))}`;
      for (const item of keys)
        await unlink(join(testAttachmentDirectory, item.storageKey)).catch(
          () => undefined,
        );
      await db.close();
    }
  },
  30000,
);
