import { ChatMessage } from "@/types";
import { vLog, ms } from "@/lib/logger";

// ==========================
// Configuration
// ==========================

// Local Next.js API route that replaces the n8n webhook.
// All logic (STT via Deepgram nova-3, GPT-4o-mini AI) now
// runs in app/api/voice/route.ts — no external workflow tool needed.
const N8N_WEBHOOK_URL = "/api/voice";

// Shape of the JSON returned by /api/voice (Mode B).
export interface N8nWebhookResponse {
  transcript: string;
  assistant_reply: string;
  ssml_transcript?: string | null;
  audio_url?: string | null;
  audio_base64?: string | null;
  audio_mime_type?: string | null;
}

// ==========================
// Mock helpers (fallback)
// ==========================

// Small helper for adding an artificial delay when mocking.
function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simulate sending a voice recording + transcript to a backend and receiving an assistant reply.
// This is kept so the UI still works even if the n8n URL is not configured yet.
export async function mockSendVoiceQuery(params: {
  transcript: string;
  previousMessages: ChatMessage[];
}): Promise<{ replyText: string; replyAudioUrl?: string }> {
  const { transcript, previousMessages } = params;
  const lastUserNumber =
    previousMessages.filter((m) => m.role === "user").length + 1;

  // Fake "processing" delay so the UI feels realistic.
  await wait(900);

  const replyText =
    transcript.trim().length === 0
      ? "I didn't quite catch that. Try speaking a bit more clearly or loudly."
      : `You said: "${transcript}". This is mock response #${lastUserNumber}. In a real app, this would come from your voice agent backend.`;

  // For now we return no audio URL; AudioPlayer will show a placeholder message.
  return { replyText, replyAudioUrl: undefined };
}

// ==========================
// n8n upload helper
// ==========================

// Two-step voice pipeline:
//   Step 1 → POST /api/voice with transcribe_only=true  → get transcript immediately
//            → calls onTranscript(transcript) so UI can show real text right away
//   Step 2 → POST /api/voice with transcript text       → get AI reply + SSML
export async function sendRecordingToN8n(params: {
  audioBlob: Blob;
  sessionId: string;
  messageId: string;
  timestamp: string;
  previousMessages?: ChatMessage[];
  onTranscript?: (transcript: string) => void;
}): Promise<N8nWebhookResponse> {
  const { audioBlob, sessionId, messageId, timestamp, previousMessages, onTranscript } = params;

  if (!N8N_WEBHOOK_URL) {
    console.warn(
      "[n8n] NEXT_PUBLIC_N8N_WEBHOOK_URL is not set; falling back to mock behaviour."
    );
    throw new Error(
      "N8N webhook URL is not configured. Set NEXT_PUBLIC_N8N_WEBHOOK_URL in your .env.local file."
    );
  }

  if (!(audioBlob instanceof Blob)) {
    vLog("error", "AUDIO ERROR", `not a Blob — got: ${typeof audioBlob}`);
    throw new Error("Upload failed: audio is not a Blob.");
  }
  if (audioBlob.size === 0) {
    vLog("error", "AUDIO EMPTY", { type: audioBlob.type, size: audioBlob.size });
    throw new Error("Upload failed: recording is empty. Record for at least a second and try again.");
  }

  vLog("sep",   "NEW TURN",   "");
  vLog("info",  "AUDIO READY",   `${(audioBlob.size / 1024).toFixed(1)}KB  type=${audioBlob.type}`);
  vLog("step",  "STEP 1 / STT",  "sending audio → /api/voice (transcribe_only)");

  const t0 = Date.now();

  try {
    // ── Step 1: STT only — get transcript and update UI immediately ───────────
    const sttForm = new FormData();
    sttForm.append("audio", audioBlob, "recording.webm");
    sttForm.append("session_id", sessionId);
    sttForm.append("transcribe_only", "true");

    const sttT0 = Date.now();
    const sttResponse = await fetch(N8N_WEBHOOK_URL, { method: "POST", body: sttForm });

    if (!sttResponse.ok) {
      const text = await sttResponse.text().catch(() => "<no body>");
      vLog("error", "STT FAILED", `HTTP ${sttResponse.status} — ${text.slice(0, 120)}`);
      throw new Error(`Transcription failed with status ${sttResponse.status}: ${text}`);
    }

    const sttData = await sttResponse.json() as { transcript: string; language?: string };
    const transcript = sttData.transcript ?? "";

    vLog("ok", "TRANSCRIPT", `"${transcript || "(empty)"}"  ${ms(sttT0)}`);

    // Notify the UI immediately so the user message shows real text now
    if (onTranscript) {
      onTranscript(transcript);
      vLog("info", "UI UPDATED", "user message updated with transcript");
    }

    // ── Step 2: AI reply — send transcript, get assistant response ────────────
    vLog("step", "STEP 2 / AI",   "sending transcript → /api/voice (ai reply)");
    const replyForm = new FormData();
    replyForm.append("transcript", transcript);
    replyForm.append("session_id", sessionId);
    replyForm.append("message_id", messageId);
    replyForm.append("timestamp", timestamp);
    if (previousMessages && previousMessages.length > 0) {
      replyForm.append("conversation_history", JSON.stringify(previousMessages));
    }

    const aiT0 = Date.now();
    const response = await fetch(N8N_WEBHOOK_URL, { method: "POST", body: replyForm });

    if (!response.ok) {
      const text = await response.text().catch(() => "<no body>");
      vLog("error", "AI FAILED", `HTTP ${response.status} — ${text.slice(0, 120)}`);
      throw new Error(
        `n8n webhook request failed with status ${response.status}`
      );
    }

    const json = await response.json() as N8nWebhookResponse;
    vLog("ok", "AI RESPONSE", `received  ${ms(aiT0)}`);

    // Normalize: support plain_reply / output as fallback field names
    if (!json.assistant_reply) {
      const raw = json as unknown as Record<string, unknown>;
      if (typeof raw.plain_reply === "string") json.assistant_reply = raw.plain_reply;
      else if (typeof raw.output === "string")  json.assistant_reply = raw.output;
    }

    if (typeof json.assistant_reply !== "string") {
      vLog("error", "BAD RESPONSE", json);
      throw new Error("API response did not contain assistant_reply.");
    }

    vLog("ok",   "REPLY TEXT", `"${json.assistant_reply.slice(0, 80)}${json.assistant_reply.length > 80 ? "…" : ""}"`);
    vLog("info", "TOTAL TIME", ms(t0));
    return json;

  } catch (error) {
    vLog("error", "PIPELINE ERROR", error instanceof Error ? error.message : String(error));
    throw error instanceof Error
      ? error
      : new Error("Unknown error while sending audio to n8n.");
  }
}

