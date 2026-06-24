import "dotenv/config";
import http from "node:http";
import process from "node:process";
import speech from "@google-cloud/speech";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.GOOGLE_SPEECH_WS_PORT || 8787);
const DEFAULT_LANGUAGE = "en-IN";

function getCredentials() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return undefined;
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (credentials.private_key) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  }
  return { credentials, projectId: credentials.project_id };
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

const speechClient = new speech.SpeechClient(getCredentials());
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404);
  response.end();
});

const wss = new WebSocketServer({ server, path: "/speech" });

wss.on("connection", (socket) => {
  let recognizeStream = null;
  let started = false;

  function closeRecognizeStream() {
    if (recognizeStream) {
      recognizeStream.removeAllListeners();
      recognizeStream.end();
      recognizeStream = null;
    }
  }

  function startRecognition(options = {}) {
    closeRecognizeStream();
    const languageCode = options.language || DEFAULT_LANGUAGE;
    recognizeStream = speechClient
      .streamingRecognize({
        config: {
          encoding: "WEBM_OPUS",
          sampleRateHertz: 48000,
          languageCode,
          enableAutomaticPunctuation: true,
          model: "latest_long",
        },
        interimResults: true,
      })
      .on("error", (error) => {
        send(socket, { type: "error", message: error?.message || "Google Speech streaming failed." });
      })
      .on("data", (data) => {
        const result = data.results?.[0];
        const transcript = result?.alternatives?.[0]?.transcript || "";
        if (!transcript) return;
        send(socket, {
          type: result.isFinal ? "final" : "interim",
          text: transcript,
        });
      });
    started = true;
    send(socket, { type: "ready", language: languageCode });
  }

  socket.on("message", (message, isBinary) => {
    if (!isBinary) {
      const payload = safeJson(message.toString());
      if (payload.type === "start") startRecognition(payload);
      if (payload.type === "stop") {
        closeRecognizeStream();
        send(socket, { type: "stopped" });
      }
      return;
    }

    if (!started) startRecognition();
    if (recognizeStream?.writable) {
      recognizeStream.write(message);
    }
  });

  socket.on("close", closeRecognizeStream);
  socket.on("error", closeRecognizeStream);
});

server.listen(PORT, () => {
  console.log(`Google Speech WebSocket server listening on ws://localhost:${PORT}/speech`);
});
