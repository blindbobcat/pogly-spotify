import { useEffect, useState, useCallback, useRef } from "react";
import {
  redirectToSpotifyAuth,
  exchangeCodeForToken,
  getValidAccessToken,
  getCurrentlyPlaying,
  isAuthenticated,
  logout,
  type NowPlaying,
} from "./spotify";

const POLL_INTERVAL = 3000;

interface AppProps {
  clientId: string;
}

export default function App({ clientId }: AppProps) {
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const [authed, setAuthed] = useState(isAuthenticated());
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const lastFetchRef = useRef<{ progressMs: number; durationMs: number; timestamp: number } | null>(null);

  // Handle OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code && clientId) {
      exchangeCodeForToken(clientId, code)
        .then(() => {
          setAuthed(true);
          setError(null);
        })
        .catch(() => setError("Authentication failed. Try again."));
    }
  }, [clientId]);

  // Poll currently playing
  const fetchNowPlaying = useCallback(async () => {
    if (!clientId) return;
    const token = await getValidAccessToken(clientId);
    if (!token) {
      setAuthed(false);
      return;
    }
    try {
      const data = await getCurrentlyPlaying(token);
      if (data) {
        lastFetchRef.current = {
          progressMs: data.progressMs,
          durationMs: data.durationMs,
          timestamp: Date.now(),
        };
      }
      setNowPlaying(data);
      setError(null);
    } catch {
      setError("Failed to fetch playback");
    }
  }, [clientId]);

  useEffect(() => {
    if (!authed) return;
    fetchNowPlaying();
    const interval = setInterval(fetchNowPlaying, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [authed, fetchNowPlaying]);

  // Animate progress bar smoothly between polls
  useEffect(() => {
    if (!nowPlaying?.isPlaying || !progressRef.current) {
      cancelAnimationFrame(animationRef.current);
      return;
    }

    const animate = () => {
      if (!progressRef.current || !lastFetchRef.current) return;
      const { progressMs, durationMs, timestamp } = lastFetchRef.current;
      const elapsed = Date.now() - timestamp;
      const currentProgress = Math.min(progressMs + elapsed, durationMs);
      const pct = (currentProgress / durationMs) * 100;
      progressRef.current.style.width = `${pct}%`;
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
  }, [nowPlaying]);

  // Show/hide animation
  useEffect(() => {
    if (nowPlaying?.isPlaying) {
      setVisible(true);
    } else {
      const timeout = setTimeout(() => setVisible(false), 500);
      return () => clearTimeout(timeout);
    }
  }, [nowPlaying?.isPlaying]);

  if (!clientId) {
    return (
      <div className="setup">
        <p>
          Missing <code>client_id</code> parameter. Set your Spotify Client ID in
          the Pogly widget variables.
        </p>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="setup">
        <button className="auth-btn" onClick={() => redirectToSpotifyAuth(clientId)}>
          Connect Spotify
        </button>
        {error && <p className="error">{error}</p>}
        <p className="hint">
          You only need to do this once per browser. After connecting, the widget
          will remember your session.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="setup">
        <p className="error">{error}</p>
        <button
          className="auth-btn"
          onClick={() => {
            logout();
            setAuthed(false);
            setError(null);
          }}
        >
          Reconnect
        </button>
      </div>
    );
  }

  return (
    <div className={`widget ${visible ? "visible" : "hidden"}`}>
      {nowPlaying && (
        <>
          <div className="album-art">
            <img src={nowPlaying.albumArt} alt={nowPlaying.albumName} />
          </div>
          <div className="track-info">
            <div className="track-name">{nowPlaying.trackName}</div>
            <div className="artist-name">{nowPlaying.artistName}</div>
            <div className="progress-bar">
              <div className="progress-fill" ref={progressRef} />
            </div>
            <div className="time-info">
              <span>{formatTime(nowPlaying.progressMs)}</span>
              <span>{formatTime(nowPlaying.durationMs)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
