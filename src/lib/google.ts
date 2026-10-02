import { env } from './env';
import { query, queryOne } from './db';

/**
 * Google OAuth, hand-rolled over fetch rather than pulling in `googleapis`.
 * We need four endpoints total, and the SDK is a ~50MB dependency that hurts
 * cold starts on a free tier.
 */

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  // Read-only: we never modify or send mail.
  'https://www.googleapis.com/auth/gmail.readonly',
];

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: env.googleRedirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    // Both are required to actually receive a refresh token: `offline` asks
    // for one, `consent` forces re-issue for users who already granted access.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
};

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: env.googleRedirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export type GoogleProfile = { sub: string; email: string; name?: string; picture?: string };

export async function fetchProfile(accessToken: string): Promise<GoogleProfile> {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to load Google profile (${res.status})`);
  }
  return res.json();
}

export async function saveGoogleAccount(params: {
  userId: string;
  googleSub: string;
  tokens: TokenResponse;
}): Promise<void> {
  const { userId, googleSub, tokens } = params;
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await query(
    `INSERT INTO google_accounts
       (user_id, google_sub, access_token, refresh_token, token_expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       google_sub       = EXCLUDED.google_sub,
       access_token     = EXCLUDED.access_token,
       -- Google only returns a refresh token on first consent; never clobber
       -- a stored one with NULL.
       refresh_token    = COALESCE(EXCLUDED.refresh_token, google_accounts.refresh_token),
       token_expires_at = EXCLUDED.token_expires_at,
       scopes           = EXCLUDED.scopes,
       sync_error       = NULL,
       updated_at       = now()`,
    [
      userId,
      googleSub,
      tokens.access_token,
      tokens.refresh_token ?? null,
      expiresAt,
      tokens.scope ? tokens.scope.split(' ') : GOOGLE_SCOPES,
    ]
  );
}

type StoredAccount = {
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: Date | null;
};

/**
 * Returns a usable access token for the user, refreshing it if it expires
 * within the next minute. Throws if the account was never connected.
 */
export async function getAccessToken(userId: string): Promise<string> {
  const account = await queryOne<StoredAccount>(
    `SELECT user_id, access_token, refresh_token, token_expires_at
       FROM google_accounts WHERE user_id = $1`,
    [userId]
  );

  if (!account) throw new Error('Gmail is not connected for this user');

  const expiresAt = account.token_expires_at?.getTime() ?? 0;
  if (account.access_token && expiresAt > Date.now() + 60_000) {
    return account.access_token;
  }

  if (!account.refresh_token) {
    throw new Error('No refresh token stored; the user needs to reconnect Gmail');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      refresh_token: account.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    await query(`UPDATE google_accounts SET sync_error = $2 WHERE user_id = $1`, [
      userId,
      `Token refresh failed: ${detail.slice(0, 500)}`,
    ]);
    throw new Error(`Google token refresh failed (${res.status})`);
  }

  const tokens = (await res.json()) as TokenResponse;
  await query(
    `UPDATE google_accounts
        SET access_token = $2, token_expires_at = $3, sync_error = NULL, updated_at = now()
      WHERE user_id = $1`,
    [userId, tokens.access_token, new Date(Date.now() + tokens.expires_in * 1000)]
  );

  return tokens.access_token;
}

/** Best-effort revoke; used when a user disconnects Gmail. */
export async function revokeAccess(userId: string): Promise<void> {
  const account = await queryOne<StoredAccount>(
    `SELECT user_id, access_token, refresh_token, token_expires_at
       FROM google_accounts WHERE user_id = $1`,
    [userId]
  );
  const token = account?.refresh_token ?? account?.access_token;
  if (token) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => undefined);
  }
  await query(`DELETE FROM google_accounts WHERE user_id = $1`, [userId]);
}
