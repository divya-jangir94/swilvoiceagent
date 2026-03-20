import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  base64ToAudioUrl,
  createMicEnergyMonitor,
  fetchCartesiaAudio,
  FILLER_PHRASES,
  isSpeechRecognitionSupported,
  startBargeInListener,
  startWebSpeechSTT,
  type MicEnergyMonitor,
  type WebSpeechHandle,
} from "@/lib/audio";
import { vLog, ms } from "@/lib/logger";
import { appendMessage, createInitialSession, loadSession, saveSession } from "@/lib/session";
import type { ChatMessage, RecordingStatus, SessionState } from "@/types";
import { ChatMessage as ChatMessageBubble } from "./ChatMessage";

const MAX_TURNS = 50;

// ─── helpers ──────────────────────────────────────────────────────────────────

// Detect whether an AI response is Hindi (Devanagari) or English (Latin).
// Used to pick the correct TTS language for Cartesia (the 'hi' model handles Hinglish well).
function detectResponseLanguage(text: string): "hi" | "en" {
  const devanagariCount = (text.match(/[\u0900-\u097F]/g) ?? []).length;
  return devanagariCount > 0 ? "hi" : "en";
}

/**
 * Levenshtein edit distance between two strings.
 * Used for fuzzy echo detection (e.g. STT hears "swin" instead of "swil").
 */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

/**
 * Returns true when a STT transcript looks like an echo of the bot's last reply.
 *
 * Three independent checks — any one passing = echo:
 *
 *  Check 1 — Direct substring
 *    The normalized transcript appears verbatim inside the normalized bot reply.
 *    Catches clean echoes where the STT hears the bot's audio perfectly.
 *
 *  Check 2 — Word overlap (≥ 40 %)
 *    At least 40 % of the transcript's meaningful words (length > 2) exist
 *    in the bot reply.  Catches partial echoes (tail of a long sentence).
 *
 *  Check 3 — Bigram overlap (≥ 30 %)
 *    Consecutive 2-word pairs from the transcript are matched against all
 *    bigrams in the bot reply.  Echoes preserve word ORDER — real user
 *    sentences almost never reproduce the same consecutive word pairs as
 *    the bot, even when some individual words coincidentally match.
 *    This is the most discriminating check for garbled/partial echoes.
 *
 * Works for both Latin (English) and Devanagari (Hindi) scripts.
 * Safe for earphones: real user words won't match the bot → always false.
 */
function isEcho(transcript: string, lastBotReply: string): boolean {
  if (!lastBotReply || !transcript) return false;

  // Normalise: lowercase, strip punctuation, collapse whitespace
  const normStr = (t: string) =>
    t.toLowerCase()
      .replace(/[^\w\s\u0900-\u097F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // Word list filtered to meaningful words (length > 2)
  const wordList = (t: string) =>
    normStr(t).split(" ").filter((w) => w.length > 2);

  // Bigram list from a word array: ["a b c"] → ["a b", "b c"]
  const bigrams = (words: string[]) =>
    words.slice(0, -1).map((w, i) => `${w} ${words[i + 1]}`);

  const tNorm = normStr(transcript);
  const bNorm = normStr(lastBotReply);
  const tWords = wordList(transcript);
  const bWords = new Set(wordList(lastBotReply));
  const bBigrams = new Set(bigrams(wordList(lastBotReply)));

  if (tWords.length === 0) return false;

  // ── Check 1: direct substring ─────────────────────────────────────────────
  // Transcript appears verbatim in the bot reply → definite echo
  if (tNorm.length >= 20 && bNorm.includes(tNorm)) {
    return true;
  }

  // ── Check 2: word overlap ─────────────────────────────────────────────────
  const wordMatches = tWords.filter((w) => bWords.has(w)).length;
  const wordOverlap = wordMatches / tWords.length;
  if (wordOverlap >= 0.80) {
    return true;
  }

  // ── Check 3: bigram overlap ───────────────────────────────────────────────
  // Echoes preserve word order; real replies don't share consecutive pairs
  const tBigrams = bigrams(tWords);
  const bigramMatches = tBigrams.filter((bg) => bBigrams.has(bg)).length;
  const bigramOverlap = tBigrams.length > 0 ? bigramMatches / tBigrams.length : 0;
  if (bigramOverlap >= 0.70) {
    return true;
  }

  return false;
}

// Fisher-Yates shuffle — used to randomise the filler queue so the same
// phrase never plays twice in a row until the whole set has been used.
function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatTime(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function VoiceRecorder() {
  // ── session / UI state ─────────────────────────────────────────────────────
  const [session, setSession] = useState<SessionState | null>(null);
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [interimText, setInterimText] = useState("");   // live STT preview

  // ── call-mode state ────────────────────────────────────────────────────────
  const [isCallActive, setIsCallActive] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [isBargedIn, setIsBargedIn] = useState(false);  // true while barge-in recording

  // ── refs ───────────────────────────────────────────────────────────────────
  const isCallActiveRef = useRef(false);
  const speechHandleRef = useRef<WebSpeechHandle | null>(null); // main STT handle
  const bargeInHandleRef = useRef<WebSpeechHandle | null>(null); // barge-in STT handle
  const bargeInFiredRef = useRef(false);                        // prevents double-trigger
  const bargeInTimerRef = useRef<number | null>(null);          // startup delay timer
  const processTranscriptRef = useRef<((t: string) => void) | undefined>(undefined);
  const startCallListeningRef = useRef<(() => void) | undefined>(undefined);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const callStartRef = useRef<number | null>(null);
  const audioInstanceRef = useRef<HTMLAudioElement | null>(null);
  // Tracks the last assistant reply text so isEcho() can compare it against STT results
  const lastBotReplyRef = useRef<string>("");
  // Timestamp (ms) when the last TTS audio finished — used for temporal echo guard
  const lastTTSEndRef = useRef<number>(0);
  // Consecutive "no speech" counter — used to show a mic-check hint after repeated failures
  const noSpeechCountRef = useRef<number>(0);

  // ── AEC / energy-gate refs ─────────────────────────────────────────────────
  // getUserMedia stream requested with echoCancellation:true.
  // Dual purpose: (a) passively enables OS-level hardware AEC so Web Speech
  // API hears a cleaner signal on the same physical mic; (b) powers the
  // energy monitor used to gate barge-in triggers.
  const micStreamRef = useRef<MediaStream | null>(null);
  const micEnergyMonitorRef = useRef<MicEnergyMonitor | null>(null);
  // Average mic RMS sampled during the first second of TTS playback.
  // Represents the "echo floor" — the level the mic sees purely from
  // speaker output.  Barge-in is only accepted when the mic is significantly
  // louder than this baseline (i.e. the user is actually speaking).
  const echoBaselineRef = useRef<number>(0);
  // setInterval handle used while sampling the echo baseline.
  const echoBaselineSamplerRef = useRef<number | null>(null);

  // ── filler audio cache ─────────────────────────────────────────────────────
  // Blobs are pre-fetched once when the call starts so playback is instant.
  // Stored as shuffled arrays; we round-robin through them to avoid repetition.
  const fillerCacheRef = useRef<Record<"en" | "hi", Blob[]>>({ en: [], hi: [] });
  const fillerIndexRef = useRef<Record<"en" | "hi", number>>({ en: 0, hi: 0 });
  const fillerLangRef = useRef<"en" | "hi">("en"); // mirrors the last TTS language used
  const fillerLoadedRef = useRef(false);

  // ── helpers ────────────────────────────────────────────────────────────────
  const updateSession = (updater: (prev: SessionState) => SessionState) => {
    setSession((prev) => {
      const base = prev ?? loadSession();
      const next = updater(base);
      saveSession(next);
      return next;
    });
  };

  const setCallActive = (value: boolean) => {
    isCallActiveRef.current = value;
    setIsCallActive(value);
  };

  // ── on mount: restore persisted session ───────────────────────────────────
  useEffect(() => {
    const current = loadSession();
    setSession(current);
    setStatus(current.status === "processing" ? "idle" : current.status);
    setError(current.lastError ?? null);
  }, []);

  // ── recording timer ────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "recording") { setRecordSeconds(0); return; }
    const t0 = Date.now();
    const id = window.setInterval(() => setRecordSeconds(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [status]);

  // ── call timer ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isCallActive) { setCallSeconds(0); callStartRef.current = null; return; }
    if (!callStartRef.current) callStartRef.current = Date.now();
    const id = window.setInterval(
      () => setCallSeconds(Math.floor((Date.now() - (callStartRef.current ?? Date.now())) / 1000)),
      1000
    );
    return () => window.clearInterval(id);
  }, [isCallActive]);

  // ── filler helpers ─────────────────────────────────────────────────────────

  // Pre-fetch all filler phrases (both languages) and cache them as Blobs.
  // Fetched one-at-a-time to stay within Cartesia's concurrency limit (free plan = 1).
  // Called once when the call starts; subsequent calls are no-ops.
  const prefetchFillers = useCallback(async () => {
    if (fillerLoadedRef.current) return;
    // Mark loaded immediately so concurrent calls from re-renders are no-ops.
    // The cache ref is populated incrementally — getNextFiller() returns null
    // until at least one blob is ready, then fillers become available one by one.
    fillerLoadedRef.current = true;
    for (const t of FILLER_PHRASES.en) {
      try {
        const blob = await fetchCartesiaAudio(t, "en");
        fillerCacheRef.current.en.push(blob);
      } catch { /* optional — skip on error */ }
    }
    for (const t of FILLER_PHRASES.hi) {
      try {
        const blob = await fetchCartesiaAudio(t, "hi");
        fillerCacheRef.current.hi.push(blob);
      } catch { /* optional — skip on error */ }
    }
    vLog("ok", "FILLERS", `loaded ${fillerCacheRef.current.en.length} en + ${fillerCacheRef.current.hi.length} hi fillers`);
  }, []);

  // Return the next filler Blob for the current language (round-robin, never repeats
  // until all phrases in the set have been used once).
  const getNextFiller = useCallback((): Blob | null => {
    const lang = fillerLangRef.current;
    const cache = fillerCacheRef.current[lang];
    if (!cache.length) return null;
    const idx = fillerIndexRef.current[lang] % cache.length;
    fillerIndexRef.current[lang]++;
    // Re-shuffle when the set wraps around so the order feels fresh
    if (fillerIndexRef.current[lang] % cache.length === 0) {
      fillerCacheRef.current[lang] = shuffleArray(cache);
    }
    return cache[idx];
  }, []);

  // Play a filler Blob immediately — lightweight version of playBlob that:
  //   • Does NOT start the barge-in listener (filler is too short to warrant it)
  //   • Does NOT trigger startCallListening on end (processTranscript is still running)
  //   • DOES set audioInstanceRef so playBlob can cleanly supersede it when the
  //     real response is ready
  const playFillerBlob = useCallback((blob: Blob) => {
    if (audioInstanceRef.current) {
      audioInstanceRef.current.pause();
      audioInstanceRef.current = null;
    }
    // Kill any stale barge-in listener from the previous TTS turn so it
    // cannot fire on the filler audio or on residual speaker echo.
    stopBargeIn();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audioInstanceRef.current = audio;

    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (audioInstanceRef.current === audio) audioInstanceRef.current = null;
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (audioInstanceRef.current === audio) audioInstanceRef.current = null;
    };

    audio.play().catch(() => {
      URL.revokeObjectURL(url);
      if (audioInstanceRef.current === audio) audioInstanceRef.current = null;
    });
  }, []);

  // ── helpers: stop the barge-in listener and its startup timer ────────────
  const stopBargeIn = useCallback(() => {
    if (bargeInTimerRef.current !== null) {
      window.clearTimeout(bargeInTimerRef.current);
      bargeInTimerRef.current = null;
    }
    bargeInHandleRef.current?.stop();
    bargeInHandleRef.current = null;
    bargeInFiredRef.current = false;
    setIsBargedIn(false);
  }, []);

  // ── play a Blob using a fresh Audio() instance (with barge-in support) ───
  const playBlob = useCallback((blob: Blob) => {
    // Stop any previous audio and barge-in listener
    if (audioInstanceRef.current) {
      audioInstanceRef.current.pause();
      audioInstanceRef.current = null;
    }
    stopBargeIn();

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audioInstanceRef.current = audio;
    const playT0 = Date.now();

    audio.onplay = () => {
      vLog("ok", "PLAYBACK START", `${(blob.size / 1024).toFixed(1)}KB audio playing`);
      setIsSpeaking(true);

      // ── Echo baseline sampling ─────────────────────────────────────────────
      // Sample the mic RMS for the first second of TTS playback and store the
      // average.  During this window only speaker echo reaches the mic (the
      // user has not yet started speaking), so the average represents the
      // "echo floor".  Barge-in is later gated against this value.
      if (micEnergyMonitorRef.current) {
        if (echoBaselineSamplerRef.current !== null) {
          window.clearInterval(echoBaselineSamplerRef.current);
        }
        const samples: number[] = [];
        echoBaselineSamplerRef.current = window.setInterval(() => {
          const rms = micEnergyMonitorRef.current?.getRMS() ?? 0;
          if (rms > 0) samples.push(rms);
        }, 80);
        window.setTimeout(() => {
          if (echoBaselineSamplerRef.current !== null) {
            window.clearInterval(echoBaselineSamplerRef.current);
            echoBaselineSamplerRef.current = null;
          }
          if (samples.length > 0) {
            const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
            echoBaselineRef.current = avg;
            vLog("info", "ECHO BASELINE", `mic RMS = ${avg.toFixed(1)} over ${samples.length} samples`);
          }
        }, 1000);
      }

      if (isCallActiveRef.current) {
        const dur = isFinite(audio.duration) ? audio.duration : 3;
        // Open mic almost immediately for fast barge-in
        const bargeInDelay = 200;

        // ── startBarge: defined here so echo-restarts and timeout-restarts
        // can both reuse the same setup without duplicating callbacks.
        const startBarge = () => {
          if (!isCallActiveRef.current || bargeInFiredRef.current) return;
          if (audioInstanceRef.current !== audio) return;

          // Stop any orphaned listener from a previous restart before creating
          // a new one — prevents two concurrent sessions with stale callbacks.
          bargeInHandleRef.current?.stop();
          bargeInHandleRef.current = null;

          bargeInHandleRef.current = startBargeInListener({
            lang: "en-IN",

            // ① ≥3 user words detected → echo pre-check, then stop TTS
            onDetected: (partialText) => {
              if (bargeInFiredRef.current) return;
              if (audioInstanceRef.current !== audio) return;

              // ── Guard 1: early single-word echo ──────────────────────────────
              // Only reject a 1-word burst in the very first 500 ms of playback
              // when a single echoed syllable could fire the threshold.
              // Do NOT block multi-word bursts — those are real user interrupts.
              const audioElapsed = Date.now() - playT0;
              const wordCount = partialText.trim().split(/\s+/).filter(Boolean).length;
              if (audioElapsed < 500 && wordCount <= 1) {
                vLog("warn", "BARGE-IN ECHO", `temporal guard: ${wordCount} word at ${audioElapsed}ms — flushing`);
                bargeInHandleRef.current?.stop();
                bargeInHandleRef.current = null;
                setTimeout(startBarge, 300);
                return;
              }

              // ── Guard 2: adaptive energy gate ────────────────────────────────
              // On very quiet mic setups (baseline ≤ 0.8), the RMS readings for
              // bot echo vs user voice are indistinguishable (both ~0.6).
              // We skip the gate entirely for these "quiet mic" users.
              // For speaker/loud users (baseline > 0.8), the gate helps prevent
              // loud echo from falsely triggering a barge-in.
              let energyPassedGate = true;
              if (micEnergyMonitorRef.current && echoBaselineRef.current > 0.8) {
                const micRMS = micEnergyMonitorRef.current.getRMS();
                const threshold = echoBaselineRef.current * 1.5;
                if (micRMS < threshold) {
                  energyPassedGate = false;
                  vLog("warn", "BARGE-IN ECHO", `energy gate: mic=${micRMS.toFixed(1)} baseline=${echoBaselineRef.current.toFixed(1)} — flushing`);
                  bargeInHandleRef.current?.stop();
                  bargeInHandleRef.current = null;
                  setTimeout(startBarge, 300);
                  return;
                }
                vLog("info", "BARGE-IN", `energy confirmed voice: mic=${micRMS.toFixed(1)} vs baseline=${echoBaselineRef.current.toFixed(1)}`);
              }

              // ── Guard 3: text + fuzzy overlap ────────────────────────────────
              // Runs even if energy gate passes (to catch loud-speaker echo).
              if (lastBotReplyRef.current) {
                const tNorm = partialText.toLowerCase().replace(/[^\w\s\u0900-\u097F]/g, " ").replace(/\s+/g, " ").trim();
                const bNorm = lastBotReplyRef.current.toLowerCase().replace(/[^\w\s\u0900-\u097F]/g, " ").replace(/\s+/g, " ").trim();
                const tWords = tNorm.split(" ").filter(w => w.length > 0);
                const bWords = bNorm.split(" ").filter(w => w.length > 0);

                const isPrefixEcho = tNorm.length >= 3 && bNorm.startsWith(tNorm);
                const isLongEcho = tNorm.length >= 10 && bNorm.includes(tNorm);
                const isWordOverlapEcho = isEcho(partialText, lastBotReplyRef.current);

                // Fuzzy first-word: only fires when energy also passed (meaning some
                // audio was detected) — prevents false positives on unrelated words.
                const tFirst = tWords[0] ?? "";
                const bFirst = bWords[0] ?? "";
                const isFuzzyFirstWord = energyPassedGate
                  && tFirst.length >= 3 && bFirst.length >= 3
                  && editDistance(tFirst, bFirst) <= 1;

                if (isPrefixEcho || isLongEcho || isWordOverlapEcho || isFuzzyFirstWord) {
                  const reason = isPrefixEcho ? "prefix" : isLongEcho ? "substring" : isFuzzyFirstWord ? `fuzzy(${tFirst}≈${bFirst})` : "overlap";
                  vLog("warn", "BARGE-IN ECHO", `text guard: flushed (${reason}): "${partialText.slice(0, 50)}"`);
                  bargeInHandleRef.current?.stop();
                  bargeInHandleRef.current = null;
                  setTimeout(startBarge, 300);
                  return;
                }
              }

              bargeInFiredRef.current = true;
              vLog("info", "BARGE-IN", `user interrupted — "${partialText.slice(0, 40)}"`);
              
              // 1. Pause bot audio immediately
              audio.pause();
              URL.revokeObjectURL(url);
              audioInstanceRef.current = null;
              setIsSpeaking(false);
              setInterimText(""); // clear interim text to show fresh capture

              // 2. Stop the current barge-in listener session
              bargeInHandleRef.current?.stop();
              bargeInHandleRef.current = null;

              // 3. Start a FRESH main listening session to capture the full message.
              // This gives the user a full Web Speech session duration to finish speak.
              setTimeout(() => {
                if (isCallActiveRef.current) {
                  startCallListeningRef.current?.();
                }
              }, 150);
            },

            // ② Live preview while user speaks
            onInterim: (text) => setInterimText(text),

            // ③ Recognition session ended
            onEnd: () => {
              bargeInHandleRef.current = null;
              // If bargeInFired was true, we've already started the fresh session
              // so there's nothing to do here. Reset the flag.
              if (bargeInFiredRef.current) {
                bargeInFiredRef.current = false;
                return;
              }

              // Case B — barge-in never fired (Chrome no-speech timeout, ~7 s).
              // If the bot is still speaking, restart the listener so coverage is
              // continuous for long responses.  If audio already ended, do nothing
              // — audio.onended will start main STT after the echo-cooldown.
              if (!isCallActiveRef.current) return;
              if (audioInstanceRef.current === audio) {
                vLog("info", "BARGE-IN", "no-speech timeout — restarting listener");
                setTimeout(startBarge, 100);
              }
            },

            // ④ Error — silently let audio finish; onended restores normal flow
            onError: () => {
              bargeInHandleRef.current = null;
            },
          });
        };

        bargeInTimerRef.current = window.setTimeout(() => {
          bargeInTimerRef.current = null;
          startBarge();
        }, bargeInDelay);
      }
    };

    audio.onended = () => {
      vLog("info", "PLAYBACK END", `finished  ${ms(playT0)}`);
      setIsSpeaking(false);
      URL.revokeObjectURL(url);
      audioInstanceRef.current = null;
      stopBargeIn();
      // Cancel baseline sampler in case audio ended before the 1s window closed
      if (echoBaselineSamplerRef.current !== null) {
        window.clearInterval(echoBaselineSamplerRef.current);
        echoBaselineSamplerRef.current = null;
      }
      lastTTSEndRef.current = Date.now(); // stamp for temporal echo guard
      if (isCallActiveRef.current) {
        // Echo cooldown: base 300 ms + 80 ms/s, capped at 1500 ms.
        // Gives speaker echo time to decay without making the response window
        // so long that the user's quick reply is missed.
        const dur = isFinite(audio.duration) ? audio.duration : 2;
        // Base 200 ms + 50 ms/s, capped at 800 ms.
        // Reduced from 300+80*dur (cap 1500) — the temporal guard (1-word /
        // 1200 ms) and isEcho text filter are now the primary echo defences,
        // so we can open the mic sooner and reduce inter-turn latency.
        const echoCooldown = Math.min(200 + Math.round(dur * 50), 800);
        vLog("info", "ECHO GUARD", `waiting ${echoCooldown}ms before listening (dur=${dur.toFixed(1)}s)`);
        setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, echoCooldown);
      }
    };

    audio.onerror = (e) => {
      vLog("error", "PLAYBACK ERROR", e);
      setIsSpeaking(false);
      URL.revokeObjectURL(url);
      audioInstanceRef.current = null;
      stopBargeIn();
      if (echoBaselineSamplerRef.current !== null) {
        window.clearInterval(echoBaselineSamplerRef.current);
        echoBaselineSamplerRef.current = null;
      }
      if (isCallActiveRef.current) {
        setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 800);
      }
    };

    audio.play().catch((err) => {
      vLog("warn", "PLAY BLOCKED", `autoplay policy blocked — ${err}`);
      setIsSpeaking(false);
      stopBargeIn();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopBargeIn]);

  // ── auto-scroll to latest message ─────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session?.messages.length]);

  // ── derived values ─────────────────────────────────────────────────────────
  const isRecording = status === "recording";
  const isProcessing = status === "processing";
  const isRequesting = status === "requesting_permission";
  const isListening = isRecording || isRequesting;

  const userTurnCount = session?.messages.filter((m) => m.role === "user").length ?? 0;
  const isSessionComplete = userTurnCount >= MAX_TURNS;
  const messageCount = session?.messages.length ?? 0;

  // ── send transcript to AI → TTS → play ────────────────────────────────────
  const processTranscript = useCallback(async (transcript: string) => {
    // We got real speech (from main STT or barge-in) — reset the consecutive
    // no-speech counter so the "Can't hear you" hint doesn't fire on the next turn.
    noSpeechCountRef.current = 0;
    setStatus("processing");
    setInterimText("");
    const createdAt = new Date().toISOString();

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: transcript,
      createdAt,
      transcript,
    };

    let prevSnapshot: ChatMessage[] = [];
    let sessionId = "";
    updateSession((prev) => {
      prevSnapshot = prev.messages;
      sessionId = prev.id;
      return { ...appendMessage(prev, userMessage), status: "processing", lastError: null };
    });

    const newUserTurns = prevSnapshot.filter((m) => m.role === "user").length + 1;

    // ── Lazy filler prefetch — fire once on the first user turn ──────────────
    // Doing this here (not at call-start) guarantees the mic is already
    // proven-working before we make any Cartesia network requests.
    // prefetchFillers() is a no-op on subsequent turns (fillerLoadedRef guard).
    if (newUserTurns === 1) {
      prefetchFillers(); // non-blocking — runs in background while AI processes
    }

    // ── Play filler immediately so silence is filled while AI processes ───────
    // getNextFiller() returns null on turn 1 (still loading) — that's fine,
    // the user won't notice on the very first reply.
    // From turn 2 onwards the cache is populated and fillers play instantly.
    const fillerBlob = getNextFiller();
    if (fillerBlob) {
      vLog("info", "FILLER", `playing ${fillerLangRef.current} filler`);
      playFillerBlob(fillerBlob);
    }

    try {
      // Send transcript to /api/voice — Groq STT is skipped, goes straight to GPT
      const form = new FormData();
      form.append("transcript", transcript);
      form.append("session_id", sessionId || (session ?? loadSession()).id);

      const res = await fetch("/api/voice", { method: "POST", body: form });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`AI request failed (${res.status}): ${text}`);
      }

      const json = await res.json() as { assistant_reply?: string; plain_reply?: string };
      const assistantText =
        (json.assistant_reply || json.plain_reply || "").trim() ||
        "Sorry, I couldn't generate a response.";

      vLog("ok", "AI REPLY", `"${assistantText.slice(0, 70)}${assistantText.length > 70 ? "…" : ""}"`);

      // Store for echo suppression — isEcho() compares STT results against this
      lastBotReplyRef.current = assistantText;

      const ttsLang = detectResponseLanguage(assistantText);
      // Keep the filler language in sync so next turn uses the right set
      fillerLangRef.current = ttsLang;

      let ttsBlob: Blob | undefined;
      try {
        ttsBlob = await fetchCartesiaAudio(assistantText, ttsLang);
      } catch (ttsErr) {
        vLog("error", "TTS FAILED", ttsErr instanceof Error ? ttsErr.message : String(ttsErr));
      }

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: assistantText,
        createdAt: new Date().toISOString(),
        transcript,
        audioUrl: undefined,
      };

      updateSession((prev) => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
        status: "idle",
        lastError: null,
      }));

      setStatus("idle");

      if (newUserTurns >= MAX_TURNS && isCallActiveRef.current) {
        setCallActive(false);
        return;
      }

      if (ttsBlob) {
        playBlob(ttsBlob);
      } else if (isCallActiveRef.current) {
        setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 800);
      }

    } catch (apiError) {
      const msg = apiError instanceof Error ? apiError.message : "Failed to reach the voice agent.";
      vLog("error", "PIPELINE ERROR", msg);
      setError(msg);
      setStatus("error");
      updateSession((prev) => ({
        ...prev,
        messages: prev.messages.filter((m) => m.id !== userMessage.id),
        status: "error",
        lastError: msg,
      }));

      if (isCallActiveRef.current) {
        setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 2500);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, playBlob, getNextFiller, playFillerBlob]);

  // ── call mode: Web Speech API → AI → TTS loop ─────────────────────────────
  const startCallListening = useCallback(() => {
    if (!isCallActiveRef.current) return;

    // Browser support check
    if (!isSpeechRecognitionSupported()) {
      setError("Voice input requires Chrome or Edge. Please open this page in Chrome.");
      setStatus("error");
      setCallActive(false);
      return;
    }

    // Stop any stale session before creating a new one — prevents two concurrent
    // recognition instances when the function is called in quick succession
    // (e.g. echo guard retries, barge-in fallback, error retries).
    if (speechHandleRef.current) {
      speechHandleRef.current.stop();
      speechHandleRef.current = null;
    }

    setError(null);
    setStatus("recording");
    setInterimText("");

    try {
      const handle = startWebSpeechSTT({
        lang: "en-IN",  // English (India) — captures English perfectly, Hindi via romanization

        onInterim: (text) => {
          setInterimText(text);
        },

        onEnd: (finalTranscript) => {
          speechHandleRef.current = null;
          setInterimText("");

          if (!isCallActiveRef.current) return;

          const clean = finalTranscript.trim();

          if (!clean) {
            noSpeechCountRef.current += 1;
            vLog("warn", "NO SPEECH", `Web Speech returned empty — retry #${noSpeechCountRef.current}`);
            if (noSpeechCountRef.current >= 2) {
              // Show a mic-check hint after 2 consecutive silent rounds
              setError("Can't hear you. Please speak clearly or check your microphone.");
              setStatus("error");
              // Auto-clear the error and retry after 3 s so the call stays alive
              setTimeout(() => {
                if (isCallActiveRef.current) {
                  setError(null);
                  noSpeechCountRef.current = 0;
                  startCallListeningRef.current?.();
                }
              }, 3000);
            } else {
              setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 500);
            }
            return;
          }
          // Reset counter on successful speech
          noSpeechCountRef.current = 0;

          // ── Echo guard (3 layers) ─────────────────────────────────────────
          const wordCount = clean.split(/\s+/).filter(Boolean).length;
          const msSinceTTS = Date.now() - lastTTSEndRef.current;

          // Layer 1 — Temporal + length: a single-word burst arriving within
          // 1200 ms of TTS end is almost always speaker echo, not real speech.
          // Uses 1 word (not 3) so real short replies like "हाँ जी" or "okay"
          // are never suppressed — only bare single-word echo blips are caught.
          if (wordCount === 1 && msSinceTTS < 1200) {
            vLog("warn", "ECHO (temporal)", `"${clean}" — 1 word, ${msSinceTTS}ms after TTS`);
            setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 300);
            return;
          }

          // Layer 2 — Word overlap: transcript matches bot reply text
          if (isEcho(clean, lastBotReplyRef.current)) {
            vLog("warn", "ECHO (overlap)", `"${clean.slice(0, 60)}" — restarting listener`);
            setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 300);
            return;
          }

          processTranscript(clean);
        },

        onError: (err) => {
          speechHandleRef.current = null;
          setInterimText("");
          vLog("error", "WEB SPEECH ERROR", err.message);
          setError(err.message);
          setStatus("error");
          if (isCallActiveRef.current) {
            setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 2000);
          }
        },
      });

      speechHandleRef.current = handle;

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Speech recognition failed.";
      setError(msg);
      setStatus("error");
      setCallActive(false);
    }
  }, [processTranscript]);

  // Keep refs in sync so closures (playBlob, barge-in) always call the latest version
  useEffect(() => {
    startCallListeningRef.current = startCallListening;
  }, [startCallListening]);

  useEffect(() => {
    processTranscriptRef.current = processTranscript;
  }, [processTranscript]);

  // ── call controls ──────────────────────────────────────────────────────────
  const handleStartCall = () => {
    if (isSessionComplete) return;
    vLog("ok", "CALL STARTED", "user initiated call");
    setCallActive(true);
    callStartRef.current = Date.now();
    noSpeechCountRef.current = 0;
    echoBaselineRef.current = 0;

    // ── Start listening FIRST so the user's opening words are never missed ──
    // Previously getUserMedia was called before Web Speech, which caused a
    // hardware-level conflict: Chrome's Audio pipeline was occupied by the AEC
    // stream setup, making Web Speech return "(no speech)" immediately on the
    // first turn. Starting Web Speech first avoids this race condition entirely.
    startCallListening();

    // ── Acquire AEC stream in the background, 400 ms after Web Speech starts ──
    // Two benefits once active:
    //   (a) echoCancellation:true on getUserMedia triggers OS-level hardware AEC
    //       for the physical device. Web Speech API shares the same mic so it
    //       also receives the AEC-processed signal — cleaner input.
    //   (b) The stream feeds createMicEnergyMonitor so we can gate barge-in
    //       triggers against the echo-floor baseline on subsequent turns.
    // Delayed 400 ms so the AudioContext doesn't interfere with Web Speech startup.
    setTimeout(() => {
      if (!isCallActiveRef.current) return;
      navigator.mediaDevices?.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }).then((stream) => {
        if (!isCallActiveRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        micStreamRef.current = stream;
        micEnergyMonitorRef.current = createMicEnergyMonitor(stream);
        vLog("info", "AEC STREAM", "mic acquired — hardware echo cancellation active");
      }).catch(() => {
        vLog("warn", "AEC STREAM", "could not acquire AEC stream — energy gate disabled");
      });
    }, 400);
  };

  const handleEndCall = () => {
    vLog("info", "CALL ENDED", callStartRef.current ? `duration=${((Date.now() - callStartRef.current) / 1000).toFixed(0)}s` : "");
    setCallActive(false);
    setIsSpeaking(false);
    setInterimText("");
    setIsBargedIn(false);

    // Stop any playing audio
    if (audioInstanceRef.current) {
      audioInstanceRef.current.pause();
      audioInstanceRef.current = null;
    }

    // Stop main STT and barge-in listener
    speechHandleRef.current?.stop();
    speechHandleRef.current = null;
    stopBargeIn();

    // Release AEC mic stream and energy monitor
    if (echoBaselineSamplerRef.current !== null) {
      window.clearInterval(echoBaselineSamplerRef.current);
      echoBaselineSamplerRef.current = null;
    }
    micEnergyMonitorRef.current?.stop();
    micEnergyMonitorRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    echoBaselineRef.current = 0;

    setStatus("idle");
  };

  // ── new session ────────────────────────────────────────────────────────────
  const handleNewSession = () => {
    if (isCallActive) handleEndCall();
    const fresh = createInitialSession();
    setSession(fresh);
    saveSession(fresh);
    setError(null);
    setStatus("idle");
    setInterimText("");
  };

  // ── call status label ──────────────────────────────────────────────────────
  const callStatusLabel =
    isRequesting ? "Connecting…" :
      isBargedIn ? "Listening…" :
        isListening ? "Listening…" :
          isProcessing ? "Processing…" :
            isSpeaking ? "Speaking…" :
              "Ready";

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full w-full overflow-hidden rounded-2xl border border-white/[0.06] shadow-[0_0_80px_rgba(109,40,217,0.15)]">

      {/* ── Main panel ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col bg-[#080B18]">

        {/* Header */}
        <header className="flex flex-shrink-0 items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-50">Conversation</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {messageCount} {messageCount === 1 ? "message" : "messages"} · Session active
            </p>
          </div>

          <div className="flex items-center gap-3">

            {/* New session */}
            <button
              type="button"
              onClick={handleNewSession}
              className="rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[10px] font-medium text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
            >
              New session
            </button>

            {/* Status badge */}
            <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ${isBargedIn ? "bg-orange-500/20 text-orange-400" :
              isListening ? "bg-red-500/20 text-red-400" :
                isProcessing ? "bg-amber-500/20 text-amber-400" :
                  isSpeaking ? "bg-sky-500/20 text-sky-400" :
                    isSessionComplete ? "bg-emerald-500/20 text-emerald-400" :
                      isCallActive ? "bg-emerald-500/20 text-emerald-400" :
                        "bg-violet-500/20 text-violet-400"
              }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${isBargedIn ? "animate-pulse bg-orange-400" :
                isListening ? "animate-pulse bg-red-400" :
                  isProcessing ? "animate-pulse bg-amber-400" :
                    isSpeaking ? "animate-pulse bg-sky-400" :
                      isSessionComplete ? "bg-emerald-400" :
                        isCallActive ? "animate-pulse bg-emerald-400" :
                          "bg-violet-400"
                }`} />
              {isBargedIn ? "Interrupted" :
                isListening ? "Rec" :
                  isProcessing ? "Processing" :
                    isSpeaking ? "Speaking" :
                      isSessionComplete ? "Done" :
                        isCallActive ? "Live" :
                          "Live"}
            </span>

            {/* Waveform icon */}
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          </div>
        </header>

        {/* Messages */}
        <main className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-4">
            {session?.messages.length ? (
              session.messages.map((message, idx) => {
                const isLastUserMsg =
                  message.role === "user" &&
                  idx === session.messages.length - 1 &&
                  isProcessing;
                return (
                  <ChatMessageBubble
                    key={message.id}
                    message={message}
                    isPending={isLastUserMsg}
                  />
                );
              })
            ) : (
              <div className="mt-10 flex flex-col items-center gap-3 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-violet-500/10 ring-1 ring-violet-500/20">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-slate-300">Ready to start a conversation</p>
                <p className="max-w-[260px] text-xs leading-relaxed text-slate-500">
                  Press <span className="font-semibold text-emerald-400">Start Call</span> below.
                  Speak naturally — the agent listens, replies with voice, then listens again automatically.
                </p>
              </div>
            )}

            {/* Live interim text — shows what you're saying in real-time */}
            {(isListening || isBargedIn) && interimText && (
              <div className="flex justify-end">
                <span className={`max-w-[75%] rounded-2xl rounded-br-sm px-3 py-2 text-xs italic ring-1 ${isBargedIn
                  ? "bg-orange-500/20 text-orange-300 ring-orange-500/30"
                  : "bg-violet-600/30 text-violet-300 ring-violet-500/30"
                  }`}>
                  {interimText}
                </span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </main>

        {/* Bottom bar */}
        <div className="flex-shrink-0 border-t border-white/[0.06] px-5 py-5">

          {/* Error banner */}
          {error && (
            <div className="mb-4 rounded-lg border border-rose-700/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
              {error}
            </div>
          )}

          {/* Session complete */}
          {isSessionComplete ? (
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm font-semibold text-emerald-300">Session complete</p>
              <p className="text-xs text-slate-500">You&apos;ve asked all {MAX_TURNS} questions.</p>
              <button
                type="button"
                onClick={handleNewSession}
                className="mt-1 rounded-full bg-violet-600 px-6 py-2 text-xs font-semibold text-white shadow-lg shadow-violet-500/20 transition hover:bg-violet-500"
              >
                Start new session
              </button>
            </div>

          ) : isCallActive ? (
            /* ── Active call UI ── */
            <div className="flex flex-col items-center gap-4">

              {/* Call status bar */}
              <div className="flex items-center gap-2.5 rounded-full bg-white/[0.04] px-4 py-2 ring-1 ring-white/[0.08]">
                <span className={`h-2 w-2 flex-shrink-0 rounded-full ${isBargedIn ? "animate-pulse bg-orange-400" :
                  isListening ? "animate-pulse bg-red-400" :
                    isProcessing ? "animate-pulse bg-amber-400" :
                      isSpeaking ? "animate-pulse bg-sky-400" :
                        "bg-emerald-400"
                  }`} />
                <span className="text-xs font-medium text-slate-300">{callStatusLabel}</span>
                <span className="text-[11px] font-mono text-slate-500">{formatTime(callSeconds)}</span>
              </div>

              {/* Recording waveform hint while listening */}
              {isListening && (
                <div className="flex items-end gap-0.5 h-6">
                  {[3, 6, 4, 8, 5, 9, 4, 6, 3].map((h, i) => (
                    <span
                      key={i}
                      className="w-1 rounded-full bg-red-400/70 animate-pulse"
                      style={{
                        height: `${h * (recordSeconds % 2 === 0 ? 1 : 1.3)}px`,
                        animationDelay: `${i * 80}ms`
                      }}
                    />
                  ))}
                </div>
              )}

              {/* End Call button */}
              <button
                type="button"
                onClick={handleEndCall}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 shadow-xl shadow-red-600/30 transition hover:scale-105 hover:bg-red-500"
                aria-label="End call"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path fillRule="evenodd" d="M1.5 4.5a3 3 0 013-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 01-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 006.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 011.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 01-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5z" clipRule="evenodd" />
                </svg>
              </button>
              <p className="text-[11px] text-slate-500">Tap to end call</p>
            </div>

          ) : (
            /* ── Start call UI ── */
            <div className="flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={handleStartCall}
                className="relative flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600 shadow-xl shadow-emerald-600/30 transition hover:scale-105 hover:bg-emerald-500"
                aria-label="Start call"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path fillRule="evenodd" d="M1.5 4.5a3 3 0 013-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 01-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 006.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 011.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 01-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5z" clipRule="evenodd" />
                </svg>
              </button>
              <p className="text-xs text-slate-400">Start call to begin</p>
              <p className="text-[11px] text-slate-600">
                Speak naturally — the agent detects when you stop and replies automatically
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
