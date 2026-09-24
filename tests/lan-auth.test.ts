import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  getOptionalIntegrationTestEnvironment,
  verifyTestBackend,
} from "../src/testing/test-environment";

const integration = getOptionalIntegrationTestEnvironment();
const api = integration?.apiUrl;
const origins = (Bun.env.CHAT_TEST_FRONTEND_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

(api && origins.length ? test : test.skip)(
  "localhost and LAN origins can register, login, keep cookies and authenticate WebSockets",
  async () => {
    if (!api || !integration) throw Error("Missing integration environment");
    await verifyTestBackend(integration);
    const db = new SQL(integration.databaseUrl, { max: 1 });
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const emails: string[] = [];
    const sockets: WebSocket[] = [];
    try {
      const anonymousOnboarding = await fetch(
        `${api}/api/onboarding/complete`,
        { method: "POST", headers: { Origin: origins[0] } },
      );
      expect(anonymousOnboarding.status).toBe(401);

      for (const [index, origin] of origins.entries()) {
        const email = `lan-auth-${index}-${suffix}@example.test`;
        const password = "Lan-auth-test-42";
        emails.push(email);
        const preflight = await fetch(`${api}/api/auth/login`, {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe(
          origin,
        );
        expect(preflight.headers.get("access-control-allow-credentials")).toBe(
          "true",
        );

        const register = await fetch(`${api}/api/auth/register`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({
            username: `LanUser${index}${suffix}`,
            email,
            password,
            confirmPassword: password,
          }),
        });
        expect(register.status).toBe(201);
        const registrationCookie = (
          register.headers.get("set-cookie") ?? ""
        ).split(";", 1)[0];
        expect(registrationCookie).toContain("pb_session=");
        const registrationBody = (await register.json()) as {
          user: { onboardingCompleted: boolean };
        };
        expect(registrationBody.user.onboardingCompleted).toBe(false);

        const completeOnboarding = await fetch(
          `${api}/api/onboarding/complete`,
          {
            method: "POST",
            headers: { Origin: origin, Cookie: registrationCookie },
          },
        );
        expect(completeOnboarding.status).toBe(200);
        expect(
          (
            (await completeOnboarding.json()) as {
              user: { onboardingCompleted: boolean };
            }
          ).user.onboardingCompleted,
        ).toBe(true);

        const login = await fetch(`${api}/api/auth/login`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        expect(login.status).toBe(200);
        expect(login.headers.get("access-control-allow-origin")).toBe(origin);
        const setCookie = login.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain("pb_session=");
        expect(setCookie.toLowerCase()).toContain("httponly");
        expect(setCookie.toLowerCase()).toContain("samesite=lax");
        if (api.startsWith("https://"))
          expect(setCookie.toLowerCase()).toContain("secure");
        const cookie = setCookie.split(";", 1)[0];

        const me = await fetch(`${api}/api/auth/me`, {
          headers: { Origin: origin, Cookie: cookie },
        });
        expect(me.status).toBe(200);
        const currentUser = (
          (await me.json()) as {
            user: { email: string; onboardingCompleted: boolean };
          }
        ).user;
        expect(currentUser.email).toBe(email);
        expect(currentUser.onboardingCompleted).toBe(true);

        if (Bun.env.CHAT_TEST_VERIFY_FRONTEND === "true") {
          const chat = await fetch(`${origin}/chat`, {
            headers: { Cookie: cookie },
            redirect: "manual",
          });
          expect(chat.status).toBe(200);
          expect(await chat.text()).toContain("Pb Messenger");
        }

        const socket = new WebSocket(api.replace(/^http/, "ws") + "/ws", {
          headers: { Origin: origin, Cookie: cookie },
        });
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve();
          socket.onerror = () => reject(Error("Authorized WebSocket failed"));
        });
        expect(socket.readyState).toBe(WebSocket.OPEN);
      }

      const blockedOrigin = "http://untrusted.invalid:3000";
      const blocked = await fetch(`${api}/api/auth/login`, {
        method: "POST",
        headers: {
          Origin: blockedOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: "nobody@example.test", password: "x" }),
      });
      expect(blocked.status).toBe(403);
      expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      for (const socket of sockets) socket.close();
      if (emails.length)
        await db`DELETE FROM users WHERE email IN ${db(emails)}`;
      await db.close();
    }
  },
  30000,
);
