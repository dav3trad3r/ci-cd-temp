import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";

export type AuthEnv = { Variables: { userId: string } };

/**
 * Rejects any request without a valid signed token and records who is asking.
 *
 * The template signs its own tokens with APP_JWT_SECRET so it runs anywhere. In a
 * Microsoft 365 organisation, swap this for Entra ID sign-in: verify the token against
 * Entra's published keys and use the user's object id as userId. The access tests in
 * tests/security/access.test.ts keep passing either way.
 */
export function requireUser(secret: string): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token) {
      return c.json({ error: "sign_in_required", message: "Sign in to continue." }, 401);
    }
    try {
      const payload = await verify(token, secret, "HS256");
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new Error("token has no subject");
      }
      c.set("userId", payload.sub);
    } catch {
      return c.json(
        { error: "sign_in_required", message: "Your session is not valid. Sign in again." },
        401,
      );
    }
    await next();
  };
}
