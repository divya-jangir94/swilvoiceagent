import { NextRequest, NextResponse } from "next/server";

// ─── Server-side terminal logger ─────────────────────────────────────────────
const _ = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const CY = "\x1b[36m";
const GR = "\x1b[32m";
const YL = "\x1b[33m";
const RD = "\x1b[31m";
const MG = "\x1b[35m";

function ts() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function sLog(color: string, icon: string, label: string, detail = "") {
  console.log(`${D}[${ts()}]${_} ${color}${icon}${_}  ${B}${label.padEnd(20)}${_} ${D}${detail}${_}`);
}

function sLogSep(sessionId: string) {
  console.log(`\n${D}${"─".repeat(55)} ${sessionId.slice(0, 8)}${_}`);
}

// ─── System prompt — SWIL Support Assistant ────────────────────────────────
const SYSTEM_PROMPT = `You are SWIL Support Assistant, a smart, polite, and human-like AI assistant for SWIL (Softworld India Pvt. Ltd.).

ABOUT SWIL:
SWIL (Softworld India Pvt. Ltd.) is an Indian software company that provides ERP and business management solutions.
SWIL mainly serves retail, distribution, and pharmaceutical businesses.
SWIL software helps with billing & invoicing, inventory/stock management, accounting & GST, purchase & sales tracking, reporting & analytics, and business automation.
SWIL products are widely used by chemists, wholesalers, distributors, and retailers across India.

YOUR ROLE:
- Help users with SWIL-related queries.
- Provide basic product and company information.
- Assist with software-related support queries.opi
- Guide users step-by-step for common issues.
- Ask clarifying questions when needed.

LANGUAGE DETECTION & RESPONSE RULES:
- Listen to the user's first message carefully.
- CRITICAL RULE: The voice-to-text system often writes ALL English words using Hindi Devanagari letters (for example, "हेलो हाउ आर यू" instead of "Hello how are you"). 
- You MUST mentally convert Devanagari characters to English vocabulary. If the words form an English sentence that happens to be written in Hindi script, you MUST consider the user as speaking PURE ENGLISH.
- Identify the exact spoken language (English, Hindi, or Hinglish) based strictly on meaning and vocabulary, not the script.
- Match the user's spoken language exactly.
- If the user spoke English (even if the transcript is written entirely in Hindi letters), respond entirely in English using standard Latin letters ("Hello, how can I help...").
- If the user spoke Hindi, respond in Hindi (Devanagari).
- If they speak in Hinglish (a mix of Hindi and English vocabulary), respond in Hinglish.
- When writing Hindi words in your response, ALWAYS use the Devanagari script (e.g., "आपकी"), even when responding in Hinglish.
- If the user switches their language style mid-conversation, adapt immediately.
- Keep the response natural, spoken, and conversational.

CONVERSATION STYLE:
- Friendly and professional.
- Short and clear responses — 1 to 3 sentences max.
- Human-like tone, especially for voice.
- Avoid robotic or overly technical language.
- Do not give long paragraphs.

SUPPORT LOGIC:
If a user reports an issue, collect the following one at a time:
1. Software/Product name
2. Problem description
3. Error message (if any)
4. When it started
5. Urgency level
Then give step-by-step guidance. If unsure, ask follow-up questions. Do not assume resolution.

GREETING:
- English: "Hello, welcome to SWIL Support. How can I help you today?"
- Hindi: "नमस्ते, SWIL सपोर्ट में आपका स्वागत है। आज मैं आपकी कैसे मदद कर सकता हूँ?"
- Use the appropriate greeting based on the detected language. If language is unclear from the first message, greet in both.

ABOUT SWIL (when asked):
- English: "SWIL is a software company that provides ERP and business management solutions for retail, distribution, and pharma businesses. It helps manage billing, inventory, accounting, and overall operations."
- Hindi: "SWIL एक सॉफ़्टवेयर कंपनी है जो रिटेल, डिस्ट्रीब्यूशन और फार्मा व्यवसायों के लिए ERP और बिज़नेस मैनेजमेंट सॉल्यूशन प्रदान करती है। यह बिलिंग, इन्वेंटरी, अकाउंटिंग और संपूर्ण व्यापार संचालन में मदद करता है।"

EMPATHY (important for voice):
- English: "I understand this might be frustrating, I'll help you fix it."
- Hindi: "मैं समझ सकता हूँ कि यह परेशान करने वाला हो सकता है, मैं इसे ठीक करने में आपकी मदद करूँगा।"

STRICT RULES:
- Never hallucinate features or give wrong technical instructions.
- If unknown → say "Let me check that for you" (English) or "मैं यह आपके लिए जाँचता हूँ" (Hindi), or ask "Please share more details." (English) / "कृपया अधिक जानकारी दें।" (Hindi).
- Never assume missing information.
- Never end the conversation abruptly.
- Every answer must be suitable for spoken audio.
- Never respond in a language the user has not used.`;

// ─── API keys ─────────────────────────────────────────────────────────────────
// Groq is used for STT (whisper-large-v3-turbo) — supports English, Hindi, Hinglish
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";

// ─── In-memory session store ─────────────────────────────────────────────────
const sessions = new Map<string, { role: "user" | "assistant"; content: string }[]>();
const CONTEXT_WINDOW = 6;

// ─── POST /api/voice ─────────────────────────────────────────────────────────
// Accepts either:
//   • { audio (File), session_id }           → Groq STT + GPT reply (single round-trip)
//   • { transcript (string), session_id }    → skip STT, GPT reply only
//   • { audio (File), transcribe_only: "true" } → Groq STT only, no AI call
export async function POST(req: NextRequest) {
  const formData = await req.formData();

  const sessionId = (formData.get("session_id") as string) || "default";
  const transcribeOnly = formData.get("transcribe_only") === "true";
  const providedTranscript = (formData.get("transcript") as string | null)?.trim() ?? "";
  const audioFile = formData.get("audio") as File | null;
  const sid = sessionId.slice(0, 8);

  let transcript = providedTranscript;

  // ── STT: transcribe audio with Groq Whisper if audio file is provided ───────
  if (audioFile && audioFile.size > 0) {
    sLogSep(sid);
    sLog(CY, "🎙", "USER SPOKE", `audio=${(audioFile.size / 1024).toFixed(1)}KB  format=${audioFile.type}  session=${sid}`);
    sLog(D, "⏳", "STT →", "Groq whisper-large-v3-turbo  language=auto-detect");

    if (!GROQ_API_KEY) {
      sLog(RD, "✗", "STT ERROR", "GROQ_API_KEY is not set in .env.local");
      return NextResponse.json({ error: "GROQ_API_KEY is not configured." }, { status: 500 });
    }

    const groqForm = new FormData();
    groqForm.append("file", audioFile, audioFile.name || "recording.webm");
    groqForm.append("model", "whisper-large-v3-turbo");
    // No language hint — Whisper auto-detects.
    // English speech → English transcript, Hindi speech → Hindi (Devanagari) transcript.

    const sttStart = Date.now();
    const sttRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: groqForm,
    });

    if (!sttRes.ok) {
      const errText = await sttRes.text().catch(() => "<no body>");
      sLog(RD, "✗", "STT FAILED", `HTTP ${sttRes.status} — ${errText.slice(0, 100)}`);
      return NextResponse.json(
        { error: `Speech-to-text failed (${sttRes.status}): ${errText}` },
        { status: 502 }
      );
    }

    const sttData = (await sttRes.json()) as { text?: string };
    transcript = sttData.text?.trim() ?? "";
    const sttMs = Date.now() - sttStart;

    if (!transcript) {
      sLog(YL, "⚠", "NO SPEECH", `Groq returned empty transcript  (${sttMs}ms)`);
    } else {
      sLog(GR, "✓", "TRANSCRIPT", `"${transcript}"  (stt=${sttMs}ms)`);
    }

    // Mode A: STT only — return transcript without calling AI
    if (transcribeOnly) {
      return NextResponse.json({ transcript });
    }
  }

  // ── Mode B: AI reply ─────────────────────────────────────────────────────────
  if (!transcript) {
    sLog(YL, "⚠", "EMPTY INPUT", `no transcript — returning fallback  session=${sid}`);
    return NextResponse.json({
      transcript: "",
      plain_reply: "Sorry, I didn't catch that. Could you please say that again?",
      assistant_reply: "Sorry, I didn't catch that. Could you please say that again?",
      ssml_transcript: "Sorry, I didn't catch that. Could you please say that again?",
    });
  }

  // Build conversation history
  const history = sessions.get(sessionId) ?? [];
  const contextMessages = [...history, { role: "user" as const, content: transcript }]
    .slice(-CONTEXT_WINDOW);

  sLog(MG, "🤖", "AI REQUEST", `model=gpt-4o-mini  history=${contextMessages.length} msgs  session=${sid}`);
  sLog(D, "⏳", "AI →", `"${transcript.slice(0, 60)}${transcript.length > 60 ? "…" : ""}"`);

  const aiStart = Date.now();
  const chatRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...contextMessages],
    }),
  });

  if (!chatRes.ok) {
    const errText = await chatRes.text().catch(() => "<no body>");
    sLog(RD, "✗", "AI FAILED", `HTTP ${chatRes.status} — ${errText.slice(0, 100)}`);
    return NextResponse.json(
      { error: `AI request failed (${chatRes.status}): ${errText}` },
      { status: 502 }
    );
  }

  const chatData = await chatRes.json() as { choices: { message: { content: string } }[] };
  const output = chatData.choices?.[0]?.message?.content?.trim() ?? "";
  const aiMs = Date.now() - aiStart;

  sLog(GR, "✓", "AI REPLY", `"${output.slice(0, 70)}${output.length > 70 ? "…" : ""}"  ${D}(${aiMs}ms)${_}`);
  sLog(CY, "🔊", "TTS →", "Cartesia TTS will be called by browser");

  // Persist updated history
  sessions.set(sessionId, [
    ...contextMessages,
    { role: "assistant" as const, content: output },
  ].slice(-CONTEXT_WINDOW));

  return NextResponse.json({
    transcript,
    plain_reply: output,
    assistant_reply: output,
    ssml_transcript: output,
  });
}
