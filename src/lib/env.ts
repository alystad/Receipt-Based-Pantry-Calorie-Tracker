/** Central env access so a missing variable fails loudly at the call site. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. See .env.example for the full list.`
    );
  }
  return value;
}

export const env = {
  get databaseUrl() {
    return required('DATABASE_URL');
  },
  get sessionSecret() {
    return required('SESSION_SECRET');
  },
  get googleClientId() {
    return required('GOOGLE_CLIENT_ID');
  },
  get googleClientSecret() {
    return required('GOOGLE_CLIENT_SECRET');
  },
  get googleRedirectUri() {
    return process.env.GOOGLE_REDIRECT_URI ?? `${env.appUrl}/api/auth/google/callback`;
  },
  get openaiApiKey() {
    return required('OPENAI_API_KEY');
  },
  get visionModel() {
    return process.env.OPENAI_VISION_MODEL ?? 'gpt-4o';
  },
  get textModel() {
    return process.env.OPENAI_TEXT_MODEL ?? 'gpt-4o-mini';
  },
  /** Optional — src/lib/ai/stock-photo.ts degrades to AI-only when unset. */
  get unsplashAccessKey() {
    return process.env.UNSPLASH_ACCESS_KEY ?? '';
  },
  get appUrl() {
    return process.env.APP_URL ?? 'http://localhost:3000';
  },
  get cronSecret() {
    return process.env.CRON_SECRET ?? '';
  },
  /** Custom URL scheme the Expo app registers, for the OAuth callback's final mobile-only hop. */
  get mobileAppScheme() {
    return process.env.MOBILE_APP_SCHEME ?? 'pantry';
  },
  get isProduction() {
    return process.env.NODE_ENV === 'production';
  },
};
