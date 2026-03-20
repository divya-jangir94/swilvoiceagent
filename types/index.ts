// Basic types for messages, sessions, and audio.

export type Role = "user" | "assistant";

// Shape of each chat message rendered in the conversation history.
export interface ChatMessage {
  id: string;
  role: Role;
  // Main text content shown in the chat bubble.
  text: string;
  // Timestamp when this message was created (ISO string).
  createdAt: string;
  // Optional, more detailed transcript text (useful for user messages).
  transcript?: string;
  // Optional URL for audio associated with this message.
  audioUrl?: string;
}

// High-level recording states that drive the UI.
export type RecordingStatus =
  | "idle"
  | "requesting_permission"
  | "recording"
  | "processing"
  | "error";

// Same as RecordingStatus but named from the recorder's perspective,
// to make it easier to use in components that care only about the
// microphone/recording lifecycle.
export type RecorderState = RecordingStatus;

// Minimal metadata we send alongside an audio upload so the backend / n8n
// flow can keep track of which browser session and which message the audio
// belongs to.
export interface UploadVoiceRequestMetadata {
  sessionId: string;
  messageId: string;
  timestamp: string; // ISO string
}

// Contract for the voice agent API / n8n webhook response.
// This matches the documented JSON shape from the backend.
export interface VoiceAgentApiResponse {
  transcript: string;
  assistant_reply: string;
  audio_url?: string;
  audio_base64?: string;
  session_id?: string;
  message_id?: string;
  error?: string;
}

export interface SessionState {
  id: string;
  messages: ChatMessage[];
  status: RecordingStatus;
  lastError?: string | null;
}

