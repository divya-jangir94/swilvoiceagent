# n8n workflow: receiving raw audio (multipart/form-data)

The frontend sends **multipart/form-data** (raw audio file, no base64):

- **audio**: file (Blob) — `recording.webm`
- **session_id**, **message_id**, **timestamp**: text fields
- **conversation_history**: JSON string of previous messages (for AI context)

## Webhook node

- **HTTP Method**: POST  
- **Path**: e.g. `voice-agent-test`  
- **Options → Binary Property Name**: set to **`audio`** so the uploaded file appears as `binary.audio` (required for Deepgram).

## Full flow

```
Webhook → Deepgram STT → AI (LLM) → Cartesia TTS → Code node → Respond to Webhook
```

---

## Step 1 – Deepgram STT node

- **Content Type**: Binary Data  
- **Input Data Field Name**: `audio`  
- **Headers**: `Content-Type: audio/webm`

Extract the transcript in a Set node after Deepgram:

- `transcript` → `$json.results.channels[0].alternatives[0].transcript`
- `session_id`  → `$('Webhook').item.json.body.session_id`
- `message_id`  → `$('Webhook').item.json.body.message_id`

---

## Step 2 – AI / LLM node

Pass the transcript and conversation history to your LLM to get `assistant_reply`.

---

## Step 3 – Cartesia TTS node

Configure Cartesia to generate speech from `assistant_reply`.  
Cartesia outputs **binary audio data** (e.g. `audio/mpeg` MP3).

---

## Step 4 – Code node (extract Cartesia audio as base64)

Add a **Code** node after Cartesia TTS2. The node outputs binary audio under the field
name **`data`** (Mime Type: `audio/mpeg`, extension `mpga`).

This Code node extracts that binary and converts it to a base64 string so it can
travel inside the JSON response back to the frontend:

```js
// Cartesia TTS2 writes its audio to binary field "data" (audio/mpeg, .mpga)
const audio = $input.first().binary.data;

return [{
  json: {
    // Carry forward transcript + assistant_reply already set by earlier nodes
    ...$input.first().json,
    audio_base64:    audio.data,                        // base64 string (no "data:" prefix)
    audio_mime_type: audio.mimeType || "audio/mpeg"     // always "audio/mpeg" for Cartesia TTS2
  }
}];
```

> The `audio.data` property is the raw base64 string that n8n stores internally for all
> binary fields — no extra encoding step needed.

---

## Step 5 – Respond to Webhook node

Set **Response Body** to the output of the Code node. The final JSON must include:

```json
{
  "transcript":      "what the user said",
  "assistant_reply": "what the AI replied",
  "audio_base64":    "<base64 string from Cartesia>",
  "audio_mime_type": "audio/mpeg"
}
```

The frontend will automatically decode `audio_base64` with the given `audio_mime_type` and play it in the chat bubble.

---

## If the Webhook does not expose binary.audio

Some n8n versions or hosts do not populate `binary.audio` from multipart. If Deepgram fails with "no binary field 'audio'", try:

- **Binary Property Name** = `data` and Deepgram **Input Data Field Name** = `data`, or  
- Switch the frontend to JSON with `audio_base64` and add a Code node that creates `binary.audio` from it.
