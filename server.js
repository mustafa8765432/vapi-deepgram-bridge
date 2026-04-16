// server.js
// WebSocket bridge between Vapi (custom STT) and Deepgram (Arabic STT)
// Flow: Vapi --> this server --> Deepgram --> this server --> Vapi

require("dotenv").config();
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const DEEPGRAM_URL =
  "wss://api.deepgram.com/v1/listen" +
  "?language=ar" +
  "&model=nova-2" +
  "&encoding=linear16" +
  "&sample_rate=16000" +
  "&channels=2";

const wss = new WebSocket.Server({ port: PORT }, () => {
  console.log(`[Server] WebSocket bridge listening on port ${PORT}`);
});

wss.on("connection", (vapiSocket) => {
  console.log("[Vapi] Client connected");

  let deepgramSocket = null;
  let started = false;

  function connectToDeepgram() {
    console.log("[Deepgram] Opening connection...");

    const dgSocket = new WebSocket(DEEPGRAM_URL, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });

    dgSocket.on("open", () => console.log("[Deepgram] Connection established"));

    dgSocket.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString());
        const transcript = response?.channel?.alternatives?.[0]?.transcript ?? "";

        if (transcript.trim()) {
          const vapiResponse = {
            type: "transcriber-response",
            transcription: transcript,
            channel: "customer",
          };
          if (vapiSocket.readyState === WebSocket.OPEN) {
            vapiSocket.send(JSON.stringify(vapiResponse));
            console.log(`[Deepgram -> Vapi] Transcript: "${transcript}"`);
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
    if (!started) {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.type === "start") {
          console.log("[Vapi] Start message received");
          started = true;
          deepgramSocket = connectToDeepgram();
          return;
        }
      } catch (_) {
        console.warn("[Vapi] Non-JSON message before start");
      }
    }

    if (started && deepgramSocket?.readyState === WebSocket.OPEN) {
      deepgramSocket.send(message);
    }
  });

  vapiSocket.on("close", () => {
    console.log("[Vapi] Client disconnected");
    if (deepgramSocket?.readyState === WebSocket.OPEN) deepgramSocket.close();
  });

  vapiSocket.on("error", (err) => console.error("[Vapi] Error:", err.message));
});