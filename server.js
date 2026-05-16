import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 3000;
const localTtsUrl = process.env.LOCAL_TTS_URL || "";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/voice-status") {
      const realtimeReady = Boolean(process.env.OPENAI_API_KEY);
      const localTtsReady = Boolean(localTtsUrl);
      sendJson(res, 200, {
        localTtsReady,
        realtimeReady,
        mode: preferredVoiceMode({ localTtsReady, realtimeReady }),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/local-tts") {
      await handleLocalTts(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/realtime-session") {
      await handleRealtimeSession(req, res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "Method Not Allowed");
      return;
    }

    serveStatic(url.pathname, res, req.method === "HEAD");
  } catch (error) {
    console.error(error);
    sendText(res, 500, "Internal Server Error");
  }
});

server.listen(port, () => {
  console.log(`This Day Then is listening on ${port}`);
});

async function handleRealtimeSession(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(res, 503, {
      error: "OPENAI_API_KEY is not configured. Browser demo voice mode is still available.",
    });
    return;
  }

  const sdp = await readBody(req);
  const sessionConfig = JSON.stringify({
    type: "realtime",
    model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
    instructions:
      "You are the warm, calm voice companion for This Day Then. Speak briefly, softly, and ask one gentle question at a time. Help the user notice ordinary details from today. Avoid therapy, diagnosis, pressure, and long explanations.",
    audio: {
      input: {
        transcription: {
          model: process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 850,
        },
      },
      output: {
        voice: process.env.OPENAI_REALTIME_VOICE || "marin",
      },
    },
  });

  const formData = new FormData();
  formData.set("sdp", sdp);
  formData.set("session", sessionConfig);

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: formData,
  });

  const body = await response.text();
  res.writeHead(response.status, {
    "Content-Type": response.ok ? "application/sdp" : "text/plain; charset=utf-8",
  });
  res.end(body);
}

async function handleLocalTts(req, res) {
  if (!localTtsUrl) {
    sendJson(res, 503, {
      error: "LOCAL_TTS_URL is not configured. Browser demo voice mode is still available.",
    });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Expected a JSON body." });
    return;
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    sendJson(res, 400, { error: "Text is required." });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.LOCAL_TTS_TIMEOUT_MS || 45000)
  );

  try {
    const response = await fetch(localTtsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        reference_audio: process.env.LOCAL_TTS_REFERENCE_AUDIO || "",
        voice: process.env.LOCAL_TTS_VOICE || "warm",
        exaggeration: Number(process.env.LOCAL_TTS_EXAGGERATION || 0.45),
      }),
      signal: controller.signal,
    });

    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      sendText(res, response.status, body.toString("utf8") || "Local TTS failed.");
      return;
    }

    res.writeHead(200, {
      "Content-Type": response.headers.get("content-type") || "audio/wav",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (error) {
    const message =
      error.name === "AbortError"
        ? "Local TTS timed out."
        : "Local TTS is not reachable. Browser demo voice mode is still available.";
    sendJson(res, 502, { error: message });
  } finally {
    clearTimeout(timeout);
  }
}

function preferredVoiceMode({ localTtsReady, realtimeReady }) {
  if (process.env.VOICE_MODE === "browser-demo") return "browser-demo";
  if (process.env.VOICE_MODE === "openai-realtime" && realtimeReady) return "openai-realtime";
  if (process.env.VOICE_MODE === "local-tts" && localTtsReady) return "local-tts";
  if (localTtsReady) return "local-tts";
  if (realtimeReady) return "openai-realtime";
  return "browser-demo";
}

function serveStatic(pathname, res, isHead) {
  const safePath = path
    .normalize(decodeURIComponent(pathname))
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]/, "");
  const requestedPath = safePath || "index.html";
  let filePath = path.join(__dirname, requestedPath);

  if (!filePath.startsWith(__dirname)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, "index.html");
  }

  const extension = path.extname(filePath);
  const contentType = mimeTypes[extension] || "application/octet-stream";
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=0, s-maxage=300",
  });
  if (isHead) {
    res.end();
  } else {
    res.end(body);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
