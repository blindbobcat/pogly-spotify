const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";
const SCOPES = "user-read-currently-playing user-read-playback-state";

function getRedirectUri(): string {
  return window.location.origin + window.location.pathname;
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => chars[byte % chars.length]).join("");
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest("SHA-256", encoder.encode(plain));
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function redirectToSpotifyAuth(clientId: string): Promise<void> {
  const codeVerifier = generateRandomString(64);
  const hashed = await sha256(codeVerifier);
  const codeChallenge = base64UrlEncode(hashed);

  localStorage.setItem("spotify_code_verifier", codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    redirect_uri: getRedirectUri(),
  });

  window.location.href = `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  clientId: string,
  code: string
): Promise<TokenResponse> {
  const codeVerifier = localStorage.getItem("spotify_code_verifier");
  if (!codeVerifier) throw new Error("Missing code verifier");

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: getRedirectUri(),
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) throw new Error("Token exchange failed");

  const data = await response.json();
  saveTokens(data);
  localStorage.removeItem("spotify_code_verifier");

  // Clean up URL
  window.history.replaceState({}, document.title, window.location.pathname);

  return data;
}

export async function refreshAccessToken(clientId: string): Promise<TokenResponse> {
  const refreshToken = localStorage.getItem("spotify_refresh_token");
  if (!refreshToken) throw new Error("No refresh token");

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    localStorage.removeItem("spotify_access_token");
    localStorage.removeItem("spotify_refresh_token");
    localStorage.removeItem("spotify_token_expiry");
    throw new Error("Token refresh failed");
  }

  const data = await response.json();
  saveTokens(data);
  return data;
}

function saveTokens(data: TokenResponse): void {
  localStorage.setItem("spotify_access_token", data.access_token);
  if (data.refresh_token) {
    localStorage.setItem("spotify_refresh_token", data.refresh_token);
  }
  const expiry = Date.now() + data.expires_in * 1000;
  localStorage.setItem("spotify_token_expiry", expiry.toString());
}

export async function getValidAccessToken(clientId: string): Promise<string | null> {
  const token = localStorage.getItem("spotify_access_token");
  const expiry = localStorage.getItem("spotify_token_expiry");

  if (!token || !expiry) return null;

  if (Date.now() > parseInt(expiry) - 60_000) {
    try {
      const data = await refreshAccessToken(clientId);
      return data.access_token;
    } catch {
      return null;
    }
  }

  return token;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
}

export interface SpotifyImage {
  url: string;
  height: number;
  width: number;
}

export interface NowPlaying {
  isPlaying: boolean;
  trackName: string;
  artistName: string;
  albumName: string;
  albumArt: string;
  progressMs: number;
  durationMs: number;
  trackUrl: string;
}

export async function getCurrentlyPlaying(
  accessToken: string
): Promise<NowPlaying | null> {
  const response = await fetch(`${SPOTIFY_API_URL}/me/player/currently-playing`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 204 || response.status === 202) return null;
  if (!response.ok) throw new Error(`API error: ${response.status}`);

  const data = await response.json();

  if (!data.item || data.currently_playing_type !== "track") return null;

  return {
    isPlaying: data.is_playing,
    trackName: data.item.name,
    artistName: data.item.artists.map((a: { name: string }) => a.name).join(", "),
    albumName: data.item.album.name,
    albumArt: data.item.album.images[0]?.url ?? "",
    progressMs: data.progress_ms ?? 0,
    durationMs: data.item.duration_ms,
    trackUrl: data.item.external_urls?.spotify ?? "",
  };
}

export function isAuthenticated(): boolean {
  return !!localStorage.getItem("spotify_access_token");
}

export function logout(): void {
  localStorage.removeItem("spotify_access_token");
  localStorage.removeItem("spotify_refresh_token");
  localStorage.removeItem("spotify_token_expiry");
  localStorage.removeItem("spotify_code_verifier");
}
