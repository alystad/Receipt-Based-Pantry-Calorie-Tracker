import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { env } from './env';
import { queryOne } from './db';

// A signed token rather than a session table or a third-party auth service:
// Google is the only identity provider here, and the constraint is that
// nothing but OpenAI costs money. The same signed payload format serves two
// transports — an httpOnly cookie for a browser client, and a bearer token
// for the Expo app (which has no shared cookie jar with the backend). Native
// clients send `Authorization: Bearer <token>`, checked before the cookie.
const COOKIE_NAME = 'pantry_session';
const OAUTH_STATE_COOKIE = 'pantry_oauth_state';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type SessionPayload = { userId: string; issuedAt: number };

function sign(value: string): string {
  return createHmac('sha256', env.sessionSecret).update(value).digest('base64url');
}

function encode(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function decode(token: string): SessionPayload | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = sign(body);
  // Both are base64url of a sha256 digest, so lengths match unless tampered.
  if (expected.length !== signature.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    if (Date.now() - payload.issuedAt > MAX_AGE_SECONDS * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createSession(userId: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, encode({ userId, issuedAt: Date.now() }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/** Same signed payload as the cookie, handed to a mobile client to store and send as a bearer token. */
export async function issueMobileToken(userId: string): Promise<string> {
  return encode({ userId, issuedAt: Date.now() });
}

export async function getSessionUserId(): Promise<string | null> {
  const authHeader = (await headers()).get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const payload = decode(authHeader.slice('Bearer '.length).trim());
    if (payload) return payload.userId;
  }

  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  return token ? (decode(token)?.userId ?? null) : null;
}

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  picture_url: string | null;
  onboarded_at: Date | null;
  gmail_connected: boolean;
  last_synced_at: Date | null;
};

/**
 * Wrapped in React's `cache()` so repeated calls within the same render pass
 * (the `(app)` layout's auth guard, plus every tab page that re-derives
 * `user` for its typed fields) share one Postgres round trip instead of each
 * issuing its own — this only dedupes within a single request, it does not
 * persist across navigations.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const userId = await getSessionUserId();
  if (!userId) return null;

  return queryOne<CurrentUser>(
    `SELECT u.id, u.email, u.name, u.picture_url, u.onboarded_at,
            (g.refresh_token IS NOT NULL) AS gmail_connected,
            g.last_synced_at
       FROM users u
       LEFT JOIN google_accounts g ON g.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
});

/** For route handlers: returns the user id or throws a 401-shaped error. */
export async function requireUserId(): Promise<string> {
  const userId = await getSessionUserId();
  if (!userId) throw new UnauthorizedError();
  return userId;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'UnauthorizedError';
  }
}

// --- OAuth CSRF state ------------------------------------------------------

/**
 * The `m.`/`w.` prefix is carried through Google's round trip unmodified
 * (Google just echoes back whatever `state` it was given), so the callback
 * can tell whether to hand back a bearer token via a custom URL scheme
 * (mobile) or a session cookie (browser) without any other side channel.
 */
export async function issueOAuthState(platform: 'mobile' | 'web'): Promise<string> {
  const state = `${platform === 'mobile' ? 'm' : 'w'}.${randomBytes(16).toString('hex')}`;
  const store = await cookies();
  store.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/',
    maxAge: 600,
  });
  return state;
}

export async function consumeOAuthState(
  received: string | null
): Promise<{ valid: boolean; mobile: boolean }> {
  const store = await cookies();
  const expected = store.get(OAUTH_STATE_COOKIE)?.value;
  store.delete(OAUTH_STATE_COOKIE);
  const valid = Boolean(expected && received && expected === received);
  return { valid, mobile: expected?.startsWith('m.') ?? false };
}
