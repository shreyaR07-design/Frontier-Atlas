import { getApp, getApps, initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  type User,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
} from "firebase/auth";
import firebaseConfig from "../../firebase-applet-config.json";

export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
];

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

function buildGoogleProvider(selectAccount = false): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of GOOGLE_WORKSPACE_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({
    prompt: selectAccount ? "select_account consent" : "consent",
    include_granted_scopes: "true",
  });
  return provider;
}

// Keep OAuth access token strictly in memory (never localStorage/sessionStorage)
const DEFAULT_TOKEN_TTL_MS = 50 * 60 * 1000; // 50m proactive safety window before Google's 60m expiry
let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedTokenExpiresAtMs = 0;

export function isGoogleTokenValid(): boolean {
  if (!cachedAccessToken) return false;
  if (Date.now() >= cachedTokenExpiresAtMs) {
    cachedAccessToken = null;
    cachedTokenExpiresAtMs = 0;
    return false;
  }
  return true;
}

export function initGoogleAuth(
  onAuthenticated: (user: User, hasToken: boolean) => void,
  onSignedOut: () => void
): () => void {
  return onAuthStateChanged(auth, (user) => {
    if (user) {
      if (isGoogleTokenValid()) {
        onAuthenticated(user, true);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        cachedTokenExpiresAtMs = 0;
        onAuthenticated(user, false);
      }
    } else {
      cachedAccessToken = null;
      cachedTokenExpiresAtMs = 0;
      onSignedOut();
    }
  });
}

export function isGoogleOAuthBlockedMessage(messageOrErr: unknown): boolean {
  const raw =
    messageOrErr instanceof Error
      ? messageOrErr.message
      : typeof messageOrErr === "string"
      ? messageOrErr
      : JSON.stringify(messageOrErr ?? "");
  return /access_denied|403|unverified|verification|org_internal|not completed google|testing|disallowed|unauthorized-client/i.test(
    raw
  );
}

export function formatGoogleAuthError(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const customMsg =
    err &&
    typeof err === "object" &&
    "customData" in err &&
    (err as { customData?: { message?: unknown } }).customData?.message
      ? String((err as { customData?: { message?: unknown } }).customData?.message)
      : "";
  const rawMsg = err instanceof Error ? err.message : String(err);
  const combined = `${code} ${rawMsg} ${customMsg}`.trim();

  if (
    /access_denied|\b403\b|unverified|verification process|not completed.*verification|org_internal|disallowed_useragent|unauthorized-client/i.test(
      combined
    )
  ) {
    return "Google OAuth authorization was blocked (Error 403: access_denied). The OAuth application has not completed Google's verification process, so direct Google Sheets sign-in is restricted. Use Download All Datasets (6 CSVs) or Download ZIP below to import all SQLite records directly into Google Sheets.";
  }
  if (code === "auth/popup-blocked") {
    return "Google Sign-In popup was blocked by your browser. Allow popups for this site and click 'Sign in with Google' again, or use the CSV / ZIP download workflow below.";
  }
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    return "Google Sign-In popup was closed before completing authorization. Click 'Sign in with Google' to retry, or use the CSV / ZIP download workflow below.";
  }
  if (code === "auth/unauthorized-domain") {
    const origin = typeof window !== "undefined" ? window.location.origin : "this origin";
    return `Domain (${origin}) is not authorized in Firebase Auth OAuth settings (auth/unauthorized-domain). Add the preview hostname to Firebase Authentication -> Authorized domains, or use the CSV / ZIP download workflow below.`;
  }
  if (code === "auth/network-request-failed") {
    return "Network error during Google Sign-In. Check your connection and try again, or use the CSV / ZIP download workflow below.";
  }
  return rawMsg;
}

// Must be called from a button click or user interaction
export async function googleSignIn(options?: {
  selectAccount?: boolean;
}): Promise<{ user: User; accessToken: string; expiresAtMs: number }> {
  try {
    isSigningIn = true;
    const provider = buildGoogleProvider(Boolean(options?.selectAccount));
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error("Google Sign-In did not return a Google Workspace OAuth access token.");
    }

    // Attempt to read oauthExpireIn if Firebase attached it, else default to 50m proactive window
    const tokenResp = (result as unknown as { _tokenResponse?: { oauthExpireIn?: number | string } })
      ?._tokenResponse;
    const rawExpiresInSec = Number(tokenResp?.oauthExpireIn);
    const ttlMs =
      Number.isFinite(rawExpiresInSec) && rawExpiresInSec > 120
        ? Math.max(60_000, (rawExpiresInSec - 300) * 1000)
        : DEFAULT_TOKEN_TTL_MS;

    cachedAccessToken = credential.accessToken;
    cachedTokenExpiresAtMs = Date.now() + ttlMs;
    return {
      user: result.user,
      accessToken: cachedAccessToken,
      expiresAtMs: cachedTokenExpiresAtMs,
    };
  } catch (err) {
    throw new Error(formatGoogleAuthError(err));
  } finally {
    isSigningIn = false;
  }
}

export function getGoogleAccessToken(): string | null {
  if (!isGoogleTokenValid()) {
    return null;
  }
  return cachedAccessToken;
}

export function getGoogleTokenExpiresAt(): number | null {
  return isGoogleTokenValid() ? cachedTokenExpiresAtMs : null;
}

export function updateGoogleTokenExpiry(expiresInSeconds: number): void {
  if (!cachedAccessToken || !Number.isFinite(expiresInSeconds)) return;
  if (expiresInSeconds <= 60) {
    clearGoogleAccessToken();
    return;
  }
  cachedTokenExpiresAtMs = Date.now() + Math.max(60_000, (expiresInSeconds - 120) * 1000);
}

export function clearGoogleAccessToken(): void {
  cachedAccessToken = null;
  cachedTokenExpiresAtMs = 0;
}

export async function googleSignOut(): Promise<void> {
  clearGoogleAccessToken();
  await auth.signOut();
}
