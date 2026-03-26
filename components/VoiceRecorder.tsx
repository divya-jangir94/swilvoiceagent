import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  base64ToAudioUrl,
  createMicEnergyMonitor,
  fetchCartesiaAudio,
  FILLER_PHRASES,
  isSpeechRecognitionSupported,
  startWebSpeechSTT,
  startBargeInListener,
  startContinuousWebSpeechSTT,
  monitorSilence,
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

const STT_DOMAIN_VOCAB = [
  "hello",
  "hi",
  "thanks",
  "please",
  "stop",
  "start",
  "repeat",
  "again",
  // SWIL / product-specific terms (preferred by fuzzy auto-correction).
  "swil",
  "erp",
  "login",
  "logout",
  "password",
  "billing",
  "invoice",
  "invoicing",
  "inventory",
  "stock",
  "gst",
  "accounting",
  "purchase",
  "sales",
  "reporting",
  "analytics",
  "automation",
  "dashboard",
  "english",
];

/**
 * Force keyword normalization (alias -> canonical).
 * This is stronger than fuzzy matching: when an alias is detected in the
 * transcript, we replace it so the AI always sees the expected word.
 */
const STT_KEYWORD_ALIASES: Record<string, string> = {
  // Phrase-level brand aliases (common STT mis-hearings in context).
  "sur erp": "swil erp",
  "sir erp": "swil erp",
  "siri erp": "swil erp",
  "self erp": "swil erp",
  "seal erp": "swil erp",
  "swirl erp": "swil erp",
  feelerp: "swil erp", 

  // SWIL brand aliases seen in STT mis-hearings.
  swell: "swil",
  steel: "swil",
  essel: "swil",
  sweet: "swil", 
  school: "swil", 
  civil: "swil", 
  fhill: "swil",

  // ERP term aliases.
  "e r p": "erp",
  erp: "erp",
  urp: "erp",
  airp: "erp",
  er: "erp",
  rp: "erp",
 erb: "erp",
 trp: "erp", 

  // login/logout aliases.
  "log in": "login",
  "log-in": "login",
  logout: "logout",
  "log out": "logout",
  "log-out": "logout",

  // password aliases.
  password: "password",
  passward: "password",

  // common support terms.
  billing: "billing",
  invoice: "invoice",
  inventory: "inventory",
  deshboard: "dashboard",
  dashbord: "dashboard",
  "dash board": "dashboard",
  classboard: "dashboard",
  gst: "gst",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeKeywordAliases(transcript: string): string {
  let out = transcript;

  // Replace phrases/words case-insensitively using word boundaries.
  // Supports aliases with spaces or hyphens by allowing `[\s-]+` between tokens.
  for (const [alias, canonical] of Object.entries(STT_KEYWORD_ALIASES)) {
    const aliasTokens = alias
      .replace(/-/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (aliasTokens.length === 0) continue;

    const aliasPattern = aliasTokens.map(escapeRegExp).join("[\\s\\-]+");
    const re = new RegExp(`\\b${aliasPattern}\\b`, "gi");
    out = out.replace(re, canonical);
  }

  return out;
}

function normalizeSpeechTextForWords(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\w\s\u0900-\u097F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSpeechWords(t: string): string[] {
  return normalizeSpeechTextForWords(t).split(" ").filter(Boolean);
}

function looksDevanagariWord(w: string): boolean {
  return /[\u0900-\u097F]/.test(w);
}

function phoneticNormalizeLatinWord(w: string): string {
  return w
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/[q]/g, "k")
    .replace(/[vw]/g, "v")
    .replace(/[z]/g, "s")
    .replace(/[x]/g, "ks")
    .replace(/(.)\1+/g, "$1");
}

function bestFuzzyCandidate(
  sourceWord: string,
  vocab: string[]
): { candidate: string; confidence: number } | null {
  const word = sourceWord.toLowerCase();
  if (!word) return null;

  const isDevanagari = looksDevanagariWord(word);
  const sourcePhonetic = isDevanagari ? "" : phoneticNormalizeLatinWord(word);

  let best: { candidate: string; score: number } | null = null;
  let secondBestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of vocab) {
    if (!candidate) continue;
    if (candidate === word) {
      return { candidate, confidence: 1 };
    }
    if (Math.abs(candidate.length - word.length) > 3) continue;

    const d = editDistance(word, candidate);
    const maxLen = Math.max(word.length, candidate.length, 1);
    const similarity = 1 - d / maxLen;

    let score = similarity;
    if (!isDevanagari) {
      const cPhonetic = phoneticNormalizeLatinWord(candidate);
      if (sourcePhonetic && cPhonetic) {
        const pd = editDistance(sourcePhonetic, cPhonetic);
        const pLen = Math.max(sourcePhonetic.length, cPhonetic.length, 1);
        const phoneticSimilarity = 1 - pd / pLen;
        score = Math.max(score, (similarity * 0.7) + (phoneticSimilarity * 0.3));
      }
    }

    if (score > (best?.score ?? Number.NEGATIVE_INFINITY)) {
      secondBestScore = best?.score ?? Number.NEGATIVE_INFINITY;
      best = { candidate, score };
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  if (!best) return null;
  const confidence = best.score - Math.max(secondBestScore, 0);
  return { candidate: best.candidate, confidence };
}

function buildCorrectionVocabulary(params: {
  lastBotReply: string;
  recentMessages: ChatMessage[];
}): string[] {
  const out = new Set<string>();
  for (const w of STT_DOMAIN_VOCAB) out.add(w);

  const pushText = (txt: string) => {
    for (const w of tokenizeSpeechWords(txt)) {
      if (w.length >= 3) out.add(w);
    }
  };

  if (params.lastBotReply) pushText(params.lastBotReply);
  for (const m of params.recentMessages) {
    if (m.text) pushText(m.text);
    if (m.transcript) pushText(m.transcript);
  }

  return Array.from(out);
}

/**
 * Conservative fuzzy auto-correction for Web Speech STT output.
 * Replaces a word only on high confidence (very close candidate match).
 */
function autoCorrectTranscriptFuzzy(params: {
  transcript: string;
  lastBotReply: string;
  recentMessages: ChatMessage[];
}): string {
  const { transcript, lastBotReply, recentMessages } = params;
  if (!transcript.trim()) return transcript;

  const vocab = buildCorrectionVocabulary({ lastBotReply, recentMessages });
  if (vocab.length === 0) return transcript;

  const rawTokens = transcript.split(/\s+/).filter(Boolean);
  const corrected = rawTokens.map((rawToken) => {
    // Keep punctuation around the word.
    const prefix = (rawToken.match(/^[^\w\u0900-\u097F]*/) ?? [""])[0];
    const suffix = (rawToken.match(/[^\w\u0900-\u097F]*$/) ?? [""])[0];
    const core = rawToken.slice(prefix.length, rawToken.length - suffix.length);
    if (!core) return rawToken;

    const coreNorm = core.toLowerCase();
    if (coreNorm.length < 4) return rawToken;

    const best = bestFuzzyCandidate(coreNorm, vocab);
    if (!best || best.candidate === coreNorm) return rawToken;

    // Conservative gating:
    // - similarity threshold guards against semantic drift
    // - confidence margin avoids replacing when multiple candidates are similarly close
    const dist = editDistance(coreNorm, best.candidate);
    const maxLen = Math.max(coreNorm.length, best.candidate.length, 1);
    const similarity = 1 - dist / maxLen;
    const maxAllowed = coreNorm.length >= 8 ? 2 : 1;
    if (dist > maxAllowed) return rawToken;
    if (similarity < 0.72) return rawToken;
    if (best.confidence < 0.08) return rawToken;

    // Keep simple capitalization style of the original token.
    const replacement =
      core[0] === core[0].toUpperCase()
        ? best.candidate[0].toUpperCase() + best.candidate.slice(1)
        : best.candidate;
    return `${prefix}${replacement}${suffix}`;
  });

  return corrected.join(" ");
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

/**
 * Like isEcho(), but tolerates minor ASR word mistakes using edit distance
 * (e.g. "swim" instead of "swil").
 *
 * This is primarily used to stop "self voice" barge-in where the bot's
 * playback leaks into STT with 1-character errors.
 */
function isEchoFuzzy(transcript: string, lastBotReply: string): boolean {
  if (!lastBotReply || !transcript) return false;

  const normStr = (t: string) =>
    t.toLowerCase()
      .replace(/[^\w\s\u0900-\u097F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const wordList = (t: string) =>
    normStr(t).split(" ").filter((w) => w.length > 2);

  const tWords = wordList(transcript);
  const bWords = wordList(lastBotReply);
  if (tWords.length === 0 || bWords.length === 0) return false;

  let matches = 0;
  for (const tw of tWords) {
    const ok = bWords.some((bw) => bw === tw || editDistance(tw, bw) <= 1);
    if (ok) matches += 1;
  }

  const matchRatio = matches / tWords.length;
  return tWords.length >= 2 && matchRatio >= 0.8;
}


function normalizeSpeechText(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\w\sऀ-ॿ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Self-voice reference guard for active TTS playback.
 *
 * Compares barge-in partial text against the exact normalized transcript
 * currently being played by the agent. If they are very similar, it is
 * likely speaker echo/self voice and should not trigger barge-in.
 */
function matchesSelfVoiceReference(partialText: string, activeTTSReference: string): boolean {
  if (!partialText || !activeTTSReference) return false;

  const pNorm = normalizeSpeechText(partialText);
  const rNorm = normalizeSpeechText(activeTTSReference);
  if (!pNorm || !rNorm) return false;

  // Fast exact/prefix checks for common echo cases
  if (pNorm.length >= 3 && rNorm.startsWith(pNorm)) return true;
  if (pNorm.length >= 10 && rNorm.includes(pNorm)) return true;

  const pWords = pNorm.split(" ").filter(Boolean);
  const rWords = rNorm.split(" ").filter(Boolean);
  if (!pWords.length || !rWords.length) return false;

  let fuzzyMatches = 0;
  for (const pw of pWords) {
    if (pw.length < 2) continue;
    const hit = rWords.some((rw) => rw === pw || (rw.length >= 2 && editDistance(pw, rw) <= 1));
    if (hit) fuzzyMatches += 1;
  }

  const ratio = fuzzyMatches / Math.max(1, pWords.length);
  return pWords.length >= 2 && ratio >= 0.7;
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
  const [isUserSpeaking, setIsUserSpeaking] = useState(false); // true from first speech until end-of-speech VAD

  // ── refs ───────────────────────────────────────────────────────────────────
  const isCallActiveRef = useRef(false);
  const speechHandleRef = useRef<WebSpeechHandle | null>(null); // main STT handle
  const bargeInHandleRef = useRef<WebSpeechHandle | null>(null); // barge-in STT handle
  const bargeInFiredRef = useRef(false);                        // prevents double-trigger
  const isUserSpeakingRef = useRef(false);
  const bargeInTimerRef = useRef<number | null>(null);          // startup delay timer
  const bargeInConfirmingRef = useRef(false);                 // prevents double confirm
  const vadCleanupRef = useRef<(() => void) | null>(null);
  const vadFinalizationTimeoutRef = useRef<number | null>(null);
  const capturedFinalRef = useRef<string>(""); // collects ONLY final transcript chunks
  const latestInterimRef = useRef<string>(""); // fallback when no final chunk arrives
  const processTranscriptRef = useRef<((t: string) => void) | undefined>(undefined);
  const startCallListeningRef = useRef<(() => void) | undefined>(undefined);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const callStartRef = useRef<number | null>(null);
  const audioInstanceRef = useRef<HTMLAudioElement | null>(null);
  // Tracks the last assistant reply text so isEcho() can compare it against STT results
  const lastBotReplyRef = useRef<string>("");
  // Normalized text of the exact TTS currently playing. Used as self-voice
  // reference so barge-in ignores agent playback picked up by the mic.
  const activeTTSReferenceRef = useRef<string>("");
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
  // True only after we sampled echoBaselineRef for the current TTS turn.
  // Prevents accepting barge-in based on stale/unknown baseline.
  const echoBaselineReadyRef = useRef<boolean>(false);
  // setInterval handle used while sampling the echo baseline.
  const echoBaselineSamplerRef = useRef<number | null>(null);

  // ── filler audio cache ─────────────────────────────────────────────────────
  // Blobs are pre-fetched once when the call starts so playback is instant.
  // Stored as shuffled arrays; we round-robin through them to avoid repetition.
  const fillerCacheRef = useRef<Record<"en" | "hi", Blob[]>>({ en: [], hi: [] });
  const fillerIndexRef = useRef<Record<"en" | "hi", number>>({ en: 0, hi: 0 });
  const fillerLangRef = useRef<"en" | "hi">("en"); // mirrors the last TTS language used
  const fillerLoadedRef = useRef(false);
  const fillerTimerRef = useRef<number | null>(null);

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
    activeTTSReferenceRef.current = "";
  }, []);

  // ── play a Blob using a fresh Audio() instance (with barge-in support) ───
  const playBlob = useCallback((blob: Blob, ttsReferenceText = "") => {
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
      activeTTSReferenceRef.current = normalizeSpeechText(ttsReferenceText);

      // Reset per-turn echo baseline so barge-in gating matches this specific TTS audio.
      echoBaselineRef.current = 0;
      echoBaselineReadyRef.current = false;

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
          echoBaselineReadyRef.current = true;
        }, 750);
      }

      if (isCallActiveRef.current) {
        const dur = isFinite(audio.duration) ? audio.duration : 3;
        // Open mic almost immediately for fast barge-in
        const bargeInDelay = 350;

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

              // If we have a mic energy monitor, wait for the echo baseline to be sampled
              // before accepting a barge-in. This prevents interrupting on the first
              // few echoed words while the baseline is still "unknown".
              if (micEnergyMonitorRef.current && !echoBaselineReadyRef.current && audioElapsed < 350) {
                vLog("warn", "BARGE-IN", `baseline not ready (${audioElapsed}ms) — flushing`);
                bargeInHandleRef.current?.stop();
                bargeInHandleRef.current = null;
                setTimeout(startBarge, 300);
                return;
              }

              // ── Guard 1.5: self-voice reference (active TTS text) ───────────
              // If partial STT looks like what the bot is currently saying, treat
              // it as echo and keep playing.
              if (matchesSelfVoiceReference(partialText, activeTTSReferenceRef.current)) {
                const baseline = echoBaselineRef.current;
                const micNow = micEnergyMonitorRef.current?.getRMS() ?? 0;
                const nearEchoFloor = micNow < Math.max(baseline * 1.35, baseline + 0.35, 0.9);

                if (nearEchoFloor) {
                  vLog(
                    "warn",
                    "BARGE-IN ECHO",
                    `self-reference guard: \"${partialText.slice(0, 50)}\" mic=${micNow.toFixed(1)} baseline=${baseline.toFixed(1)}`
                  );
                  bargeInHandleRef.current?.stop();
                  bargeInHandleRef.current = null;
                  setTimeout(startBarge, 300);
                  return;
                }

                vLog(
                  "info",
                  "BARGE-IN",
                  `self-reference seen but energy high; continue mic=${micNow.toFixed(1)} baseline=${baseline.toFixed(1)}`
                );
              }

              // ── Guard 2: adaptive energy gate ────────────────────────────────
              // Require mic energy to be above the sampled echo baseline.
              // This prevents "self voice" barge-ins when the user isn't
              // actually speaking but the bot's playback is leaking into STT.
              let energyPassedGate = true;
              if (micEnergyMonitorRef.current && echoBaselineReadyRef.current) {
                const micRMS = micEnergyMonitorRef.current.getRMS();
                const baseline = echoBaselineRef.current;
                const isQuietMic = baseline <= 0.8;

                // For quiet mic setups, mic RMS may be similar for bot echo vs real user speech.
                // In that case, skip the energy gate and rely on the text/final-echo rejection.
                if (!isQuietMic) {
                  const threshold = Math.max(baseline * 1.5, baseline + 0.25);
                  if (micRMS < threshold) {
                    energyPassedGate = false;
                    vLog(
                      "warn",
                      "BARGE-IN ECHO",
                      `energy gate: mic=${micRMS.toFixed(1)} baseline=${baseline.toFixed(1)} thr=${threshold.toFixed(1)} — flushing`
                    );
                    bargeInHandleRef.current?.stop();
                    bargeInHandleRef.current = null;
                    setTimeout(startBarge, 300);
                    return;
                  }
                  vLog("info", "BARGE-IN", `energy confirmed voice: mic=${micRMS.toFixed(1)} vs baseline=${baseline.toFixed(1)}`);
                } else {
                  vLog("info", "BARGE-IN", `quiet mic: skipping energy gate baseline=${baseline.toFixed(1)} mic=${micRMS.toFixed(1)}`);
                }
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
                const isFuzzyWordOverlapEcho = isEchoFuzzy(partialText, lastBotReplyRef.current);

                // Fuzzy first-word: only fires when energy also passed (meaning some
                // audio was detected) — prevents false positives on unrelated words.
                const tFirst = tWords[0] ?? "";
                const bFirst = bWords[0] ?? "";
                const isFuzzyFirstWord = energyPassedGate
                  && tFirst.length >= 3 && bFirst.length >= 3
                  && editDistance(tFirst, bFirst) <= 1;

                const baseline = echoBaselineRef.current;
                const micNow = micEnergyMonitorRef.current?.getRMS() ?? 0;
                const nearEchoFloor = micNow < Math.max(baseline * 1.35, baseline + 0.35, 0.9);

                // Overlap-based text guards are very effective for echo, but if mic
                // energy is clearly above echo floor, the user may be talking over TTS.
                const shouldFlushByTextGuard =
                  (isPrefixEcho || isLongEcho || isWordOverlapEcho || isFuzzyWordOverlapEcho || isFuzzyFirstWord)
                  && nearEchoFloor;

                if (shouldFlushByTextGuard) {
                  const reason = isPrefixEcho
                    ? "prefix"
                    : isLongEcho
                      ? "substring"
                      : isFuzzyWordOverlapEcho
                        ? "fuzzy-word-overlap"
                        : isFuzzyFirstWord
                          ? `fuzzy(${tFirst}≈${bFirst})`
                          : "overlap";
                  vLog(
                    "warn",
                    "BARGE-IN ECHO",
                    `text guard: flushed (${reason}): "${partialText.slice(0, 50)}" mic=${micNow.toFixed(1)} baseline=${baseline.toFixed(1)}`
                  );
                  bargeInHandleRef.current?.stop();
                  bargeInHandleRef.current = null;
                  setTimeout(startBarge, 300);
                  return;
                }

                if (isPrefixEcho || isLongEcho || isWordOverlapEcho || isFuzzyWordOverlapEcho || isFuzzyFirstWord) {
                  vLog(
                    "info",
                    "BARGE-IN",
                    `text overlap seen but energy high; continue mic=${micNow.toFixed(1)} baseline=${baseline.toFixed(1)}`
                  );
                }
              }

              // Energy confirmation: self-voice often produces a short ASR trigger,
              // but real speech stays loud for a short sustained window.
              // We only pause TTS after sustained mic energy exceeds a stricter gate.
              if (bargeInConfirmingRef.current) return;
              bargeInConfirmingRef.current = true;

              const baselineForConfirm = echoBaselineReadyRef.current ? echoBaselineRef.current : 0.3;
              // During TTS, AEC often keeps mic RMS low (0.5–4) even for real speech.
              // A fixed floor like 6.5 made barge-in impossible. Use baseline-relative
              // thresholds: quiet echo floor → need clear lift above it; loud floor → stricter ratio.
              const quietEcho = baselineForConfirm <= 1.15;
              const thresholdConfirm = quietEcho
                // Quiet-mic devices often report real user speech around 1.1–1.6 RMS.
                // Keep threshold low enough to allow barge-in while self-reference
                // guard still blocks bot playback.
                ? Math.max(baselineForConfirm * 1.30, baselineForConfirm + 0.25, 0.9)
                : Math.max(baselineForConfirm * 1.30, baselineForConfirm + 0.30);
              const partialWordCount = partialText.trim().split(/\s+/).filter(Boolean).length;

              let hits = 0;
              let total = 0;
              let peak = 0;
              const confirmStart = Date.now();
              const tickMs = 50;
              const confirmWindowMs = 450;
              const interval = window.setInterval(() => {
                if (!micEnergyMonitorRef.current) return;
                const rms = micEnergyMonitorRef.current.getRMS();
                total += 1;
                if (rms > peak) peak = rms;
                if (rms >= thresholdConfirm) hits += 1;
              }, tickMs);

              window.setTimeout(() => {
                window.clearInterval(interval);
                bargeInConfirmingRef.current = false;

                // Ensure we are still looking at the same TTS audio turn.
                if (!isCallActiveRef.current) return;
                if (audioInstanceRef.current !== audio) return;

                const elapsed = Date.now() - confirmStart;
                const hitRatio = total > 0 ? hits / total : 0;
                // ~9 samples @ 50ms; allow slower/soft speech by accepting
                // either sustained medium lift or a short strong peak.
                const peakConfirms = peak >= thresholdConfirm + (quietEcho ? 0.10 : 0.15);
                const sustained =
                  total >= 5 && hits >= 2 && hitRatio >= 0.22;
                const slowSpeechFallback =
                  partialWordCount >= 2 &&
                  total >= 6 &&
                  peak >= Math.max(baselineForConfirm + 0.25, 1.0);
                const confirmed =
                  sustained ||
                  (total >= 4 && peakConfirms && hits >= 1) ||
                  slowSpeechFallback;

                if (!confirmed) {
                  vLog(
                    "warn",
                    "BARGE-IN ECHO",
                    `energy confirmation failed: rmsHits=${hits}/${total} (${(elapsed)}ms) thr=${thresholdConfirm.toFixed(1)} — ignoring`
                  );
                  bargeInHandleRef.current?.stop();
                  bargeInHandleRef.current = null;
                  setTimeout(startBarge, 250);
                  return;
                }

                bargeInFiredRef.current = true;
                vLog("info", "BARGE-IN", `user interrupted — "${partialText.slice(0, 40)}"`);

                // 1. Pause bot audio immediately
                audio.pause();
                URL.revokeObjectURL(url);
                audioInstanceRef.current = null;
                activeTTSReferenceRef.current = "";
                // Stamp "TTS ended" timestamp even though we paused early.
                // This improves the echo guard window for the next VAD listening cycle.
                lastTTSEndRef.current = Date.now();
                setIsSpeaking(false);
                setIsBargedIn(true);
                setInterimText(partialText.trim()); // show what we captured so far

                // Stop barge-in recognition and switch to the VAD-driven listening
                // flow. We finalize only via VAD silence.
                bargeInHandleRef.current?.stop();
                bargeInHandleRef.current = null;
                setTimeout(() => {
                  if (isCallActiveRef.current) startCallListeningRef.current?.();
                }, 150);
              }, confirmWindowMs);
            },

            // ② Live preview while user speaks
            onInterim: (text) => setInterimText(text),

            // ③ Recognition session ended
            onEnd: (finalTranscript) => {
              bargeInHandleRef.current = null;
              if (bargeInFiredRef.current) {
                bargeInFiredRef.current = false;
                setIsBargedIn(false);
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
      activeTTSReferenceRef.current = "";
      stopBargeIn();
      // Cancel baseline sampler in case audio ended before the 1s window closed
      if (echoBaselineSamplerRef.current !== null) {
        window.clearInterval(echoBaselineSamplerRef.current);
        echoBaselineSamplerRef.current = null;
      }
      echoBaselineRef.current = 0;
      echoBaselineReadyRef.current = false;
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
      activeTTSReferenceRef.current = "";
      stopBargeIn();
      if (echoBaselineSamplerRef.current !== null) {
        window.clearInterval(echoBaselineSamplerRef.current);
        echoBaselineSamplerRef.current = null;
      }
      echoBaselineRef.current = 0;
      echoBaselineReadyRef.current = false;
      if (isCallActiveRef.current) {
        setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 800);
      }
    };

    audio.play().catch((err) => {
      vLog("warn", "PLAY BLOCKED", `autoplay policy blocked — ${err}`);
      setIsSpeaking(false);
      activeTTSReferenceRef.current = "";
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

    // ── Situational filler: only if AI is still processing after delay ────────
    // This avoids unnecessary fillers on very fast responses.
    const transcriptWordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
    const shouldConsiderFiller = newUserTurns > 1 || transcriptWordCount >= 3;
    if (fillerTimerRef.current !== null) {
      window.clearTimeout(fillerTimerRef.current);
      fillerTimerRef.current = null;
    }
    if (shouldConsiderFiller) {
      fillerTimerRef.current = window.setTimeout(() => {
        fillerTimerRef.current = null;
        if (!isCallActiveRef.current) return;
        if (status !== "processing") return;
        if (isSpeaking || isUserSpeakingRef.current) return;

        const fillerBlob = getNextFiller();
        if (fillerBlob) {
          vLog("info", "FILLER", `playing ${fillerLangRef.current} filler`);
          playFillerBlob(fillerBlob);
        }
      }, 900);
    }

    try {
      // Send transcript to /api/voice — Groq STT is skipped, goes straight to GPT
      // Canonicalize key terms so the assistant understands them consistently.
      const normalizedTranscript = normalizeKeywordAliases(transcript);
      const form = new FormData();
      form.append("transcript", normalizedTranscript);
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
      if (fillerTimerRef.current !== null) {
        window.clearTimeout(fillerTimerRef.current);
        fillerTimerRef.current = null;
      }

      if (newUserTurns >= MAX_TURNS && isCallActiveRef.current) {
        setCallActive(false);
        return;
      }

      if (ttsBlob) {
        playBlob(ttsBlob, assistantText);
      } else if (isCallActiveRef.current) {
        setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 800);
      }

    } catch (apiError) {
      const msg = apiError instanceof Error ? apiError.message : "Failed to reach the voice agent.";
      vLog("error", "PIPELINE ERROR", msg);
      setError(msg);
      setStatus("error");
      if (fillerTimerRef.current !== null) {
        window.clearTimeout(fillerTimerRef.current);
        fillerTimerRef.current = null;
      }
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
  }, [session, status, isSpeaking, playBlob, getNextFiller, playFillerBlob]);

  // ── call mode: VAD + continuous Web Speech STT → AI → TTS loop ───────────
  const startCallListening = useCallback(() => {
    if (!isCallActiveRef.current) return;

    // Browser support check
    if (!isSpeechRecognitionSupported()) {
      setError("Voice input requires Chrome or Edge. Please open this page in Chrome.");
      setStatus("error");
      setCallActive(false);
      return;
    }

    // Stop any stale session before creating a new one.
    if (speechHandleRef.current) {
      speechHandleRef.current.stop();
      speechHandleRef.current = null;
    }
    if (vadCleanupRef.current) {
      vadCleanupRef.current();
      vadCleanupRef.current = null;
    }
    if (vadFinalizationTimeoutRef.current !== null) {
      window.clearTimeout(vadFinalizationTimeoutRef.current);
      vadFinalizationTimeoutRef.current = null;
    }

    setError(null);
    setStatus("recording");
    setInterimText("");
    isUserSpeakingRef.current = false;
    setIsUserSpeaking(false);
    capturedFinalRef.current = "";
    latestInterimRef.current = "";

    // We need the echo-cancelled mic stream for VAD.
    if (!micStreamRef.current) {
      setTimeout(() => {
        if (isCallActiveRef.current) startCallListeningRef.current?.();
      }, 250);
      return;
    }

    const msSinceTTS = Date.now() - lastTTSEndRef.current;
    // During immediate post-TTS time windows, raise threshold to reduce bot-echo triggering.
    const threshold = msSinceTTS < 700 ? 14 : 8;
    const userTurnsSoFar =
      (session ?? loadSession()).messages.filter((m) => m.role === "user").length;
    // Fast-start for the very first utterance after pressing Start Call:
    // users often say a short greeting ("hello"), so we endpoint sooner.
    const isFirstTurnInSession = userTurnsSoFar === 0;
    const silenceDurationMs = isFirstTurnInSession ? 900 : 1800;
    const postSilenceBufferMs = isFirstTurnInSession ? 250 : 800;
    const minSpeechDurationMs = isFirstTurnInSession ? 350 : 650;
    const noSpeechTimeoutMs = isFirstTurnInSession ? 4000 : 7000;

    try {
      // 1) Continuous STT: collect ONLY final segments
      speechHandleRef.current = startContinuousWebSpeechSTT({
        lang: "en-IN",
        onFinal: (finalText) => {
          const t = finalText.trim();
          if (!t) return;
          capturedFinalRef.current = capturedFinalRef.current ? `${capturedFinalRef.current} ${t}` : t;
          vLog("info", "STT FINAL", `"${t.slice(0, 60)}"`);
        },
        onInterim: (text) => {
          latestInterimRef.current = text.trim();
          setInterimText(text);
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

      // 2) VAD: finalize only when silence persists long enough.
      vadCleanupRef.current = monitorSilence(
        micStreamRef.current,
        (spokenMs) => {
          // This callback already implies silenceDurationMs + postSilenceBufferMs,
          // and monitorSilence also ignores short utterances.
          vadCleanupRef.current = null;

          isUserSpeakingRef.current = false;
          setIsUserSpeaking(false);
          setInterimText("");

          if (!isCallActiveRef.current) return;

          // Keep STT alive briefly so final chunks can arrive after VAD silence.
          if (vadFinalizationTimeoutRef.current !== null) {
            window.clearTimeout(vadFinalizationTimeoutRef.current);
            vadFinalizationTimeoutRef.current = null;
          }
          vadFinalizationTimeoutRef.current = window.setTimeout(() => {
            vadFinalizationTimeoutRef.current = null;
            if (!isCallActiveRef.current) return;

            speechHandleRef.current?.stop();
            speechHandleRef.current = null;

            // Prefer true final chunks. If browser didn't emit isFinal in time,
            // fall back to interim only when we actually detected speech.
            let clean = capturedFinalRef.current.trim();
            if (!clean) {
              const interimFallback = latestInterimRef.current.trim();
              const interimWords = interimFallback.split(/\s+/).filter(Boolean);
              const hadRealSpeech = spokenMs >= 300;
              // Guard against no-speech timeouts picking up stray echo/noise text.
              if (hadRealSpeech && (interimWords.length >= 1 || interimFallback.length >= 4)) {
                clean = interimFallback;
                vLog("info", "STT FALLBACK", `using interim fallback: "${clean.slice(0, 60)}"`);
              }
            }
            capturedFinalRef.current = "";
            latestInterimRef.current = "";

            if (!clean) {
              noSpeechCountRef.current += 1;
              vLog("warn", "NO SPEECH", `VAD ended but transcript empty — retry #${noSpeechCountRef.current}`);
              if (noSpeechCountRef.current >= 2) {
                setError("Can't hear you. Please speak clearly or check your microphone.");
                setStatus("error");
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

            const cleanWords = clean.split(/\s+/).filter(Boolean);
            const hadRealSpeech = spokenMs >= 300;
            if (!hadRealSpeech && cleanWords.length <= 2 && clean.length < 18) {
              noSpeechCountRef.current += 1;
              vLog("warn", "NO SPEECH", `discarding low-speech transcript "${clean}" — retry #${noSpeechCountRef.current}`);
              setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 350);
              return;
            }

            noSpeechCountRef.current = 0;

            // ── Echo guard (avoid self-voice / bot playback) ────────────────
            const wordCount = cleanWords.length;
            const msSinceTTS2 = Date.now() - lastTTSEndRef.current;
            if (wordCount === 1 && msSinceTTS2 < 1200) {
              vLog("warn", "ECHO (temporal)", `"${clean}" — 1 word, ${msSinceTTS2}ms after TTS`);
              setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 300);
              return;
            }
            if (isEcho(clean, lastBotReplyRef.current) || isEchoFuzzy(clean, lastBotReplyRef.current)) {
              vLog("warn", "ECHO (overlap)", `"${clean.slice(0, 60)}" — restarting listener`);
              setTimeout(() => { if (isCallActiveRef.current) startCallListeningRef.current?.(); }, 300);
              return;
            }

            const recentMessagesForCorrection = (session ?? loadSession()).messages.slice(-12);
            const correctedTranscript = autoCorrectTranscriptFuzzy({
              transcript: clean,
              lastBotReply: lastBotReplyRef.current,
              recentMessages: recentMessagesForCorrection,
            });
            if (correctedTranscript !== clean) {
              vLog("info", "STT AUTOCORRECT", `"${clean}" -> "${correctedTranscript}"`);
            }

            processTranscript(correctedTranscript);
          }, isFirstTurnInSession ? 1200 : 700);
        },
        {
          threshold,
          silenceDurationMs,
          postSilenceBufferMs,
          minSpeechDurationMs,
          noSpeechTimeoutMs,
          onSpeechStart: () => {
            if (!isUserSpeakingRef.current) {
              isUserSpeakingRef.current = true;
              setIsUserSpeaking(true);
            }
          },
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Speech recognition failed.";
      setError(msg);
      setStatus("error");
      setCallActive(false);
    }
  }, [processTranscript, session]);

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

    // Acquire echo-cancelled mic immediately (VAD + continuous STT depend on it).
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
      startCallListening();
    }).catch(() => {
      vLog("warn", "AEC STREAM", "could not acquire AEC stream");
      setError("Microphone permission failed. Please allow mic access and try again.");
      setStatus("error");
      setCallActive(false);
    });
  };

  const handleEndCall = () => {
    vLog("info", "CALL ENDED", callStartRef.current ? `duration=${((Date.now() - callStartRef.current) / 1000).toFixed(0)}s` : "");
    setCallActive(false);
    setIsSpeaking(false);
    setInterimText("");
    setIsBargedIn(false);
    if (fillerTimerRef.current !== null) {
      window.clearTimeout(fillerTimerRef.current);
      fillerTimerRef.current = null;
    }

    // Stop any playing audio
    if (audioInstanceRef.current) {
      audioInstanceRef.current.pause();
      audioInstanceRef.current = null;
    }

    // Stop main STT and barge-in listener
    speechHandleRef.current?.stop();
    speechHandleRef.current = null;
    stopBargeIn();
    vadCleanupRef.current?.();
    vadCleanupRef.current = null;
    if (vadFinalizationTimeoutRef.current !== null) {
      window.clearTimeout(vadFinalizationTimeoutRef.current);
      vadFinalizationTimeoutRef.current = null;
    }
    isUserSpeakingRef.current = false;
    setIsUserSpeaking(false);

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
