// Audio utilities for the voice agent UI.
import { vLog, ms } from "@/lib/logger";

// ─────────────────────────────────────────────────────────────────
// Web Speech API — free, browser-native STT powered by Google.
// Excellent Hindi + Hinglish (code-switching) support.
// Works in Chrome and Edge only (not Firefox/Safari).
// ─────────────────────────────────────────────────────────────────

// Web Speech API types (not included in all TypeScript DOM lib targets)
interface SpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: { length: number;[i: number]: { isFinal: boolean;[i: number]: { transcript: string } } };
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

type SpeechRecognitionCtor = new () => SpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  return (
    (window as unknown as Record<string, unknown>).SpeechRecognition as SpeechRecognitionCtor ??
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition as SpeechRecognitionCtor ??
    null
  );
}

/** Returns true if the browser supports Web Speech API (Chrome / Edge). */
export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

/**
 * Short natural acknowledgment phrases played immediately when the user stops
 * speaking, while the AI response is being fetched in the background.
 * Keeps one set per TTS language so the voice always matches the conversation.
 */
export const FILLER_PHRASES: Record<"en" | "hi", string[]> = {
  en: ["hmm", "okay", "got it"],
  hi: ["हाँ", "जी", "अच्छा"],
};

export interface WebSpeechHandle {
  stop: () => void;
}

/**
 * Barge-in listener — runs silently while TTS audio is playing.
 *
 * Fires onDetected(partialText) once the user has said at least 3 words.
 * Using 3 words (instead of 1) prevents a single echoed word from speakers
 * from falsely interrupting the bot mid-sentence.
 *
 * The caller receives partialText in onDetected and should echo-check it
 * before stopping TTS. The same session continues and fires onInterim() +
 * onEnd() with the full utterance — no second STT session needed.
 */
export function startBargeInListener(params: {
  lang?: string;
  onDetected: (partialText: string) => void;
  onInterim: (text: string) => void;
  onEnd: (finalTranscript: string) => void;
  onError?: () => void;
}): WebSpeechHandle {
  const SR = getSpeechRecognitionCtor();
  if (!SR) throw new Error("Web Speech API not supported.");

  const recognition = new SR();
  recognition.lang = params.lang ?? "en-IN";
  recognition.interimResults = true;
  recognition.continuous = false;  // onend fires automatically after user pauses — needed for transcript handoff
  recognition.maxAlternatives = 1;

  let bargeInTriggered = false;
  let finalTranscript = "";
  let ended = false;

  // Minimum words before considering it a real barge-in.
  // Set to 2 so that single echoed syllables or brief noise don't false-trigger.
  // Real user interruptions are almost always 2+ words ("wait", "listen here", "हाँ सुनो").
  const BARGE_IN_WORD_THRESHOLD = 2;

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) { finalTranscript += r[0].transcript; }
      else { interim += r[0].transcript; }
    }
    const combined = (finalTranscript + " " + interim).trim();
    const wordCount = combined.split(/\s+/).filter(Boolean).length;

    if (!bargeInTriggered && wordCount >= BARGE_IN_WORD_THRESHOLD) {
      bargeInTriggered = true;
      params.onDetected(combined); // pass partial text for echo pre-check
    }
    if (bargeInTriggered) {
      params.onInterim(combined);
    }
  };

  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    params.onError?.();
  };

  recognition.onend = () => {
    if (!ended) {
      ended = true;
      params.onEnd(finalTranscript.trim());
    }
  };

  try {
    recognition.start();
    vLog("info", "BARGE-IN", "listener started");
  } catch {
    // Silently ignore — mic may be briefly unavailable between sessions
  }

  return {
    stop: () => {
      if (!ended) {
        ended = true;
        try { recognition.stop(); } catch { /* ignore */ }
      }
    },
  };
}

/**
 * Starts a single-utterance Web Speech recognition session.
 *
 * - lang "en-IN"  → English (India) model — handles English clearly + romanized Hinglish
 * - Fires onInterim() with live text as the user speaks
 * - Fires onEnd() with the final transcript when the user stops speaking
 * - Fires onError() for real errors (not "no-speech" / "aborted")
 */
export function startWebSpeechSTT(params: {
  lang?: string;
  onInterim: (text: string) => void;
  onEnd: (finalTranscript: string) => void;
  onError: (err: Error) => void;
}): WebSpeechHandle {
  const SR = getSpeechRecognitionCtor();
  if (!SR) throw new Error("Web Speech API not supported. Please open this page in Chrome or Edge.");

  const recognition = new SR();
  recognition.lang = params.lang ?? "en-IN"; // en-IN handles English cleanly + romanized Hinglish
  recognition.interimResults = true;
  recognition.continuous = false;  // must be false — onend only fires in single-utterance mode
  recognition.maxAlternatives = 1;

  let finalTranscript = "";
  let ended = false;

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) {
        finalTranscript += r[0].transcript;
      } else {
        interim += r[0].transcript;
      }
    }
    params.onInterim((finalTranscript + " " + interim).trim());
  };

  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    // "no-speech" and "aborted" are normal — onend will still fire
    if (event.error === "no-speech" || event.error === "aborted") return;
    params.onError(new Error(`Speech recognition error: ${event.error}`));
  };

  recognition.onend = () => {
    if (!ended) {
      ended = true;
      vLog("ok", "WEB SPEECH", `ended — "${finalTranscript || "(no speech)"}"`);
      params.onEnd(finalTranscript.trim());
    }
  };

  vLog("info", "WEB SPEECH", `started — lang=${recognition.lang}`);
  recognition.start();

  return {
    stop: () => {
      ended = true;
      try { recognition.stop(); } catch { /* ignore */ }
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Cartesia TTS — called directly from the browser.
// ─────────────────────────────────────────────────────────────────
const CARTESIA_API_URL = "https://api.cartesia.ai/tts/bytes";
const CARTESIA_API_KEY = "sk_car_aikUv8n322LXqMDYMMMbqc";
const CARTESIA_VERSION = "2026-03-01";
const CARTESIA_MODEL = "sonic-3";
const CARTESIA_VOICE_ID = "791d5162-d5eb-40f0-8189-f19db44611d8";

/**
 * Calls Cartesia TTS with the given plain text and returns an audio Blob.
 * @param language  "en" for English (default) or "hi" for Hindi
 */
export async function fetchCartesiaAudio(text: string, language: "en" | "hi" = "en"): Promise<Blob> {
  const plainText = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

  vLog("step", "TTS REQUEST", `Cartesia sonic-3 [${language}] — "${plainText.slice(0, 60)}${plainText.length > 60 ? "…" : ""}"`);

  const ttsT0 = Date.now();
  const res = await fetch(CARTESIA_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CARTESIA_API_KEY}`,
      "Cartesia-Version": CARTESIA_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: CARTESIA_MODEL,
      transcript: plainText,
      language,
      voice: { mode: "id", id: CARTESIA_VOICE_ID },
      generation_config: { speed: 1.0, emotion: "calm" },
      output_format: { container: "mp3", bit_rate: 128000, sample_rate: 44100 },
    }),
  });

  const contentType = res.headers.get("content-type") ?? "unknown";
  const arrayBuffer = await res.arrayBuffer();

  const first4 = Array.from(new Uint8Array(arrayBuffer.slice(0, 4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

  if (!res.ok) {
    const errText = new TextDecoder().decode(arrayBuffer);
    vLog("error", "TTS FAILED", `HTTP ${res.status}  content-type=${contentType} — ${errText.slice(0, 100)}`);
    throw new Error(`Cartesia TTS failed (${res.status}): ${errText}`);
  }

  if (first4.startsWith("7b")) {
    const errText = new TextDecoder().decode(arrayBuffer);
    vLog("error", "TTS ERROR", `JSON error body instead of audio — ${errText.slice(0, 100)}`);
    throw new Error(`Cartesia returned a JSON error instead of audio: ${errText}`);
  }

  vLog("ok", "TTS READY", `${(arrayBuffer.byteLength / 1024).toFixed(1)}KB  format=${contentType}  ${ms(ttsT0)}`);
  return new Blob([arrayBuffer], { type: "audio/mpeg" });
}

// ─────────────────────────────────────────────────────────────────
// Browser microphone recording via MediaRecorder API.
// Returns the recorder, a promise that resolves to the audio Blob
// when recording stops, AND the raw stream for VAD monitoring.
// ─────────────────────────────────────────────────────────────────
export async function startBrowserRecording(): Promise<{
  recorder: MediaRecorder;
  audioPromise: Promise<Blob>;
  stream: MediaStream;
}> {
  if (typeof window === "undefined") {
    throw new Error("Recording is only available in the browser.");
  }

  vLog("info", "MIC REQUEST", "requesting microphone access…");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const mimeType =
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "";
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  const recStart = Date.now();

  vLog("ok", "REC STARTED", `format=${mimeType || "browser default"}  — speak now`);

  const audioPromise = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    recorder.onerror = () => {
      vLog("error", "REC ERROR", "MediaRecorder error event fired");
      reject(new Error("Recording failed."));
    };

    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());

      const totalSize = chunks.reduce(
        (sum, c) => sum + (c instanceof Blob ? c.size : 0),
        0
      );
      const duration = ((Date.now() - recStart) / 1000).toFixed(1);

      if (chunks.length === 0 || totalSize === 0) {
        if (parseFloat(duration) > 0.5) {
          vLog("warn", "REC EMPTY", `stopped after ${duration}s but no audio data — try speaking louder`);
        }
        reject(new Error("Recording produced no audio data."));
        return;
      }

      vLog("ok", "REC STOPPED", `duration=${duration}s  size=${(totalSize / 1024).toFixed(1)}KB  chunks=${chunks.length}`);
      resolve(new Blob(chunks, { type: mimeType || "audio/webm" }));
    };
  });

  recorder.start(250);
  return { recorder, audioPromise, stream };
}

// ─────────────────────────────────────────────────────────────────
// Mic Energy Monitor
//
// Captures microphone audio via Web Audio API and returns a live
// RMS value (0–100 scale, same as monitorSilence) on demand.
//
// Two roles:
//   1. Passive AEC — requesting echoCancellation on this stream tells
//      the OS/browser to enable hardware echo cancellation for the
//      physical device, which also benefits the Web Speech API on most
//      browsers since they share the same physical mic.
//   2. Energy-based echo gate — compare mic RMS against the echo
//      baseline sampled at TTS playback start to distinguish real
//      user speech from speaker echo picked up by the microphone.
// ─────────────────────────────────────────────────────────────────

export interface MicEnergyMonitor {
  /** Snapshot of mic RMS on a 0–100 scale. Call any time; returns 0 after stop(). */
  getRMS: () => number;
  stop: () => void;
}

/**
 * Creates a lightweight microphone energy monitor backed by Web Audio API.
 * Pass the stream returned by getUserMedia({ audio: { echoCancellation: true } }).
 */
export function createMicEnergyMonitor(stream: MediaStream): MicEnergyMonitor {
  const AudioCtxCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  const ctx = new AudioCtxCtor();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  ctx.createMediaStreamSource(stream).connect(analyser);

  const buf = new Uint8Array(analyser.frequencyBinCount);
  let stopped = false;

  return {
    getRMS: () => {
      if (stopped) return 0;
      analyser.getByteTimeDomainData(buf);
      let s = 0;
      for (const b of buf) { const d = (b - 128) / 128; s += d * d; }
      return Math.sqrt(s / buf.length) * 100;
    },
    stop: () => {
      stopped = true;
      ctx.close().catch(() => { });
    },
  };
}

// Create an object URL from an audio Blob for playback in an <audio> element.
export function blobToAudioUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

// Convert a base64-encoded audio string into a data URL.
export function base64ToAudioUrl(
  base64: string,
  mimeType = "audio/mpeg"
): string {
  if (base64.startsWith("data:")) return base64;
  return `data:${mimeType};base64,${base64}`;
}

// ─────────────────────────────────────────────────────────────────
// Voice Activity Detection (VAD)
//
// Monitors microphone audio levels via Web Audio API.
// Calls onSilenceDetected() when the user stops speaking for
// silenceDurationMs milliseconds after having spoken at least once.
//
// Returns a cleanup function — call it to cancel monitoring early.
// ─────────────────────────────────────────────────────────────────
export function monitorSilence(
  stream: MediaStream,
  onSilenceDetected: () => void,
  options?: {
    threshold?: number;
    silenceDurationMs?: number;
    minRecordingMs?: number;
    maxRecordingMs?: number;
    noSpeechTimeoutMs?: number;
  }
): () => void {
  const {
    threshold = 8,
    silenceDurationMs = 1500,
    minRecordingMs = 1200,
    maxRecordingMs = 60_000,
    noSpeechTimeoutMs = 12_000,
  } = options ?? {};

  const AudioCtxCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;

  const audioContext = new AudioCtxCtor();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;

  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  let hasSpeech = false;
  let silenceStart: number | null = null;
  let stopped = false;
  const startedAt = Date.now();
  let speechLoggedAt: number | null = null;

  const cleanup = () => {
    stopped = true;
    clearTimeout(maxTimer);
    clearTimeout(noSpeechTimer);
    audioContext.close().catch(() => { });
  };

  const trigger = () => {
    if (stopped) return;
    cleanup();
    onSilenceDetected();
  };

  const maxTimer = window.setTimeout(trigger, maxRecordingMs);
  const noSpeechTimer = window.setTimeout(() => {
    if (!hasSpeech) trigger();
  }, noSpeechTimeoutMs);

  const tick = () => {
    if (stopped) return;

    analyser.getByteTimeDomainData(dataArray);

    let sumSq = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const d = (dataArray[i] - 128) / 128;
      sumSq += d * d;
    }
    const rms = Math.sqrt(sumSq / dataArray.length) * 100;

    if (rms > threshold) {
      if (!hasSpeech) {
        speechLoggedAt = Date.now();
        vLog("info", "VAD: SPEECH", `voice detected  rms=${rms.toFixed(1)}`);
      }
      hasSpeech = true;
      silenceStart = null;
    } else if (hasSpeech && Date.now() - startedAt >= minRecordingMs) {
      if (silenceStart === null) silenceStart = Date.now();
      if (Date.now() - silenceStart >= silenceDurationMs) {
        const spokenMs = speechLoggedAt ? Date.now() - speechLoggedAt : 0;
        vLog("info", "VAD: SILENCE", `silence detected — stopping  spoken≈${(spokenMs / 1000).toFixed(1)}s`);
        trigger();
        return;
      }
    }

    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
  return cleanup;
}
