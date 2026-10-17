import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "./db";

const COOKIE_NAME = "ft_session";
const SESSION_DAYS = 30;

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(secret);
}

/**
 * Secure cookies require HTTPS. Production defaults to secure; set
 * SESSION_COOKIE_SECURE=false when serving over plain HTTP (e.g. a Fargate
 * task reached directly by IP, with no load balancer terminating TLS) —
 * otherwise the browser silently drops the session cookie and login loops.
 */
function cookieSecure(): boolean {
  const override = process.env.SESSION_COOKIE_SECURE;
  if (override != null) return override !== "false";
  return process.env.NODE_ENV === "production";
}

export async function createSession(userId: string): Promise<void> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secretKey());

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    maxAge: SESSION_DAYS * 24 * 60 * 60,
    path: "/",
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

/** The signed-in user's id, or null. Verifies the user still exists. */
export async function getSessionUserId(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const userId = payload.sub;
    if (typeof userId !== "string") return null;
    // A deleted account must not keep a working session.
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    return user?.id ?? null;
  } catch {
    return null;
  }
}

export async function getSessionUser() {
  const userId = await getSessionUserId();
  if (!userId) return null;
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, createdAt: true },
  });
}

/**
 * Call at the top of every protected page and every action that touches data.
 * Returns the owning user id, which all queries must filter on.
 */
export async function requireUserId(): Promise<string> {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  return userId;
}

// ---------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------

/**
 * Best-effort guard against guessing passwords and security answers. The
 * counter lives in memory, which is enough for the single-task deployment this
 * app ships with; behind several instances it would need shared state.
 */
const attempts = new Map<string, { count: number; firstAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function tooManyAttempts(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailedAttempt(key: string): void {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}
