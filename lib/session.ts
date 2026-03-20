import { ChatMessage, SessionState } from "@/types";

// Local storage key used to persist conversation state between reloads.
const STORAGE_KEY = "voice-agent-session";

// Create an empty session with sensible defaults.
export function createInitialSession(): SessionState {
  return {
    id: crypto.randomUUID(),
    messages: [],
    status: "idle",
    lastError: null
  };
}

// Load a session from localStorage, falling back to a fresh one if missing or invalid.
export function loadSession(): SessionState {
  if (typeof window === "undefined") {
    return createInitialSession();
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialSession();
    const parsed = JSON.parse(raw) as SessionState;
    return parsed;
  } catch {
    return createInitialSession();
  }
}

// Persist the session to localStorage. Errors are intentionally swallowed to avoid UX issues.
export function saveSession(state: SessionState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures; the app should still work without persistence.
  }
}

// Simple helper to append a new message into session state.
export function appendMessage(
  state: SessionState,
  message: ChatMessage
): SessionState {
  return {
    ...state,
    messages: [...state.messages, message]
  };
}

