// server.js
// WebSocket bridge between Vapi (custom STT) and Deepgram (Arabic STT)
// Flow: Vapi --> this server --> Deepgram --> this server --> Vapi

require("dotenv").config();
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Create HTTP server with health check endpoint
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    console.log("[Health] Ping received — server is awake");
  } else {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required");
  }
});

// Attach WebSocket server to HTTP server
const wss = new WebSocket.Server({ server, path: "/transcriber" });

server.listen(PORT, () => {
  console.log(`[Server] HTTP + WebSocket bridge listening on port ${PORT}`);
});

// Downmix linear16 stereo PCM to mono (average L + R per frame)
function stereoToMono(buffer) {
  const frames = Math.floor(buffer.length / 4);
  const output = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = buffer.readInt16LE(i * 4);
    const r = buffer.readInt16LE(i * 4 + 2);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((l + r) / 2))), i * 2);
  }
  return output;
}

wss.on("connection", (vapiSocket, req) => {
  console.log("[Vapi] Client connected");
  console.log(`[Vapi] Headers: ${JSON.stringify(req.headers)}`);
  console.log(`[Vapi] URL: ${req.url}`);

  let deepgramSocket = null;
  let started = false;
  let audioBuffer = [];
  let messageCount = 0;
  let vapiChannels = 1;

  function connectToDeepgram(sampleRate) {
    const url =
      "wss://api.deepgram.com/v1/listen" +
      "?language=ar" +
      "&model=nova-3" +
      "&encoding=linear16" +
      `&sample_rate=${sampleRate}` +
      "&channels=1" +
      "&interim_results=true" +
      "&smart_format=true";

    console.log(`[Deepgram] Opening connection — URL: ${url.replace(DEEPGRAM_API_KEY, "***")}`);

    const dgSocket = new WebSocket(url, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });

    // Capture actual HTTP error body when Deepgram rejects the upgrade
    dgSocket.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk.toString()));
      res.on("end", () => {
        console.error(`[Deepgram] Rejected — status: ${res.statusCode}, body: ${body}`);
      });
    });

    dgSocket.on("open", () => {
      console.log("[Deepgram] Connection established");
      if (audioBuffer.length > 0) {
        console.log(`[Deepgram] Flushing ${audioBuffer.length} buffered audio chunks`);
        for (const chunk of audioBuffer) {
          dgSocket.send(chunk);
        }
        audioBuffer = [];
      }
    });

    dgSocket.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString());
        const transcript = response?.channel?.alternatives?.[0]?.transcript ?? "";
        const isFinal = response?.is_final ?? false;

        if (transcript.trim()) {
          const vapiResponse = {
            type: "transcriber-response",
            transcription: transcript,
            channel: "customer",
            transcriptType: isFinal ? "final" : "partial",
          };
          if (vapiSocket.readyState === WebSocket.OPEN) {
            vapiSocket.send(JSON.stringify(vapiResponse));
            console.log(`[Deepgram -> Vapi] (${isFinal ? "final" : "partial"}) "${transcript}"`);
          }
        }
      } catch (err) {
        console.error("[Deepgram] Failed to parse message:", err.message);
      }
    });

    dgSocket.on("error", (err) => console.error("[Deepgram] Error:", err.message));
    dgSocket.on("close", (code) => console.log(`[Deepgram] Closed — code: ${code}`));

    return dgSocket;
  }

  vapiSocket.on("message", (message) => {
    messageCount++;
    const isBinary = Buffer.isBuffer(message) || message instanceof ArrayBuffer;

    if (messageCount <= 5) {
      if (isBinary) {
        console.log(`[Vapi] Message #${messageCount}: binary, ${message.length} bytes`);
      } else {
        console.log(`[Vapi] Message #${messageCount}: text, ${message.toString().substring(0, 500)}`);
      }
    } else if (messageCount % 100 === 0) {
      console.log(`[Vapi] ${messageCount} messages received so far`);
    }

    if (!started) {
      try {
        const parsed = JSON.parse(message.toString());
        console.log(`[Vapi] Parsed JSON message type: ${parsed.type}`);
        if (parsed.type === "start") {
          const sampleRate = parsed.sampleRate || parsed.sample_rate || 16000;
          vapiChannels = parsed.channels || 1;
          console.log("[Vapi] Start message received:", JSON.stringify(parsed));
          started = true;
          deepgramSocket = connectToDeepgram(sampleRate);
          return;
        }
      } catch (_) {
        // Not JSON — binary audio arrived before start message
        console.log("[Vapi] Binary audio before start — connecting with defaults (16000Hz mono)");
        started = true;
        vapiChannels = 1;
        deepgramSocket = connectToDeepgram(16000);
      }
    }

    // Forward audio to Deepgram (downmix to mono if stereo) or buffer if still connecting
    if (started && isBinary) {
      const audio = vapiChannels === 2 ? stereoToMono(message) : message;
      if (deepgramSocket?.readyState === WebSocket.OPEN) {
        deepgramSocket.send(audio);
      } else {
        audioBuffer.push(audio);
      }
    }
  });

  vapiSocket.on("close", (code, reason) => {
    console.log(`[Vapi] Client disconnected — code: ${code}, reason: ${reason?.toString() || "none"}, total messages: ${messageCount}`);
    audioBuffer = [];
    if (deepgramSocket?.readyState === WebSocket.OPEN) deepgramSocket.close();
  });

  vapiSocket.on("error", (err) => console.error("[Vapi] Error:", err.message));
});
