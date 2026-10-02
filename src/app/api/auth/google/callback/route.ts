import { NextResponse, type NextRequest } from 'next/server';
import { exchangeCodeForTokens, fetchProfile, saveGoogleAccount } from '@/lib/google';
import { consumeOAuthState, createSession, issueMobileToken } from '@/lib/session';
import { queryOne } from '@/lib/db';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

/**
 * Google always lands here — the redirect URI registered in Cloud Console is
 * fixed to this one HTTPS route regardless of which client started the flow.
 * What happens next branches on the `m.`/`w.` prefix threaded through
 * `state` (see /api/auth/google): a mobile-started flow ends with a redirect
 * to the Expo app's custom URL scheme carrying a bearer token in the query
 * string (expo-auth-session captures it); a web-started flow falls back to
 * the original cookie-session behavior, useful for manual/curl testing since
 * there's no browser UI left to redirect into.
 */
function mobileRedirect(params: Record<string, string>): NextResponse {
  const query = new URLSearchParams(params);
  return NextResponse.redirect(`${env.mobileAppScheme}://auth-callback?${query}`);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const error = params.get('error');
  const code = params.get('code');
  const { valid, mobile } = await consumeOAuthState(params.get('state'));

  const fail = (reason: string) =>
    mobile
      ? mobileRedirect({ error: reason })
      : NextResponse.json({ error: reason }, { status: 400 });

  if (error) return fail(error);
  if (!code) return fail('missing_code');
  if (!valid) return fail('state_mismatch');

  try {
    const tokens = await exchangeCodeForTokens(code);
    const profile = await fetchProfile(tokens.access_token);

    // Google identity doubles as the app account: one consent screen total.
    const user = await queryOne<{ id: string; onboarded_at: Date | null }>(
      `INSERT INTO users (email, name, picture_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET
         name        = COALESCE(EXCLUDED.name, users.name),
         picture_url = COALESCE(EXCLUDED.picture_url, users.picture_url),
         updated_at  = now()
       RETURNING id, onboarded_at`,
      [profile.email, profile.name ?? null, profile.picture ?? null]
    );
    if (!user) throw new Error('Failed to upsert user');

    await saveGoogleAccount({ userId: user.id, googleSub: profile.sub, tokens });

    // Default preference row so the planner always has something to read.
    await queryOne(
      `INSERT INTO user_preferences (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      [user.id]
    );

    const onboarded = Boolean(user.onboarded_at);

    if (mobile) {
      const token = await issueMobileToken(user.id);
      return mobileRedirect({ token, onboarded: String(onboarded) });
    }

    await createSession(user.id);
    return NextResponse.json({ ok: true, onboarded });
  } catch (err) {
    console.error('[auth/callback]', err);
    return fail('oauth_failed');
  }
}
