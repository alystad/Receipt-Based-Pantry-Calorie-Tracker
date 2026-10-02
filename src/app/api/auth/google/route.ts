import { NextResponse, type NextRequest } from 'next/server';
import { buildAuthUrl } from '@/lib/google';
import { issueOAuthState } from '@/lib/session';

export const runtime = 'nodejs';

/**
 * Kicks off Google sign-in + Gmail consent in one round trip. `?platform=mobile`
 * (set by the Expo app's expo-auth-session call) makes the callback hand back
 * a bearer token via a custom URL scheme instead of a session cookie — see
 * the callback route.
 */
export async function GET(request: NextRequest) {
  const platform = request.nextUrl.searchParams.get('platform') === 'mobile' ? 'mobile' : 'web';
  const state = await issueOAuthState(platform);
  return NextResponse.redirect(buildAuthUrl(state));
}
