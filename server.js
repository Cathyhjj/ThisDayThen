import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 3000;

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
      sendJson(res, 200, {
        realtimeReady: Boolean(process.env.OPENAI_API_KEY),
        mode: process.env.OPENAI_API_KEY ? "openai-realtime" : "browser-demo",
      });
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
