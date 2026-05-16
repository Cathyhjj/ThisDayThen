import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 3000;
const localTtsUrl = process.env.LOCAL_TTS_URL || "";
const databasePath = process.env.DIARY_DB_PATH
  ? path.resolve(process.env.DIARY_DB_PATH)
  : path.join(__dirname, "data", "this-day-then-db.json");
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;
const maxJsonBytes = 1024 * 1024;
const database = loadDatabase();

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
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const user = getAuthenticatedUser(req);
      sendJson(res, 200, { user: user ? publicUser(user) : null });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      await handleRegister(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      handleLogout(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/entries") {
      handleListEntries(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/entries") {
      await handleSaveEntry(req, res);
      return;
    }

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

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "Not found." });
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

async function handleRegister(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
    return;
  }

  const name = normalizeName(payload.name);
  const email = normalizeEmail(payload.email);
  const password = typeof payload.password === "string" ? payload.password : "";

  if (!name) {
    sendJson(res, 400, { error: "Name is required." });
    return;
  }

  if (!email) {
    sendJson(res, 400, { error: "Enter a valid email address." });
    return;
  }

  if (password.length < 8) {
    sendJson(res, 400, { error: "Password must be at least 8 characters." });
    return;
  }

  if (database.users.some((user) => user.email === email)) {
    sendJson(res, 409, { error: "An account with that email already exists." });
    return;
  }

  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: hashPassword(password),
    createdAt: now,
    updatedAt: now,
  };
  database.users.push(user);
  const sessionToken = createSession(user.id);
  writeDatabase();

  res.writeHead(201, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": buildSessionCookie(sessionToken, req),
  });
  res.end(JSON.stringify({ user: publicUser(user) }));
}

async function handleLogin(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
    return;
  }

  const email = normalizeEmail(payload.email);
  const password = typeof payload.password === "string" ? payload.password : "";
  const user = database.users.find((candidate) => candidate.email === email);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    sendJson(res, 401, { error: "Email or password is not right." });
    return;
  }

  const sessionToken = createSession(user.id);
  writeDatabase();

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": buildSessionCookie(sessionToken, req),
  });
  res.end(JSON.stringify({ user: publicUser(user) }));
}

function handleLogout(req, res) {
  const sessionToken = parseCookies(req.headers.cookie).session;
  if (sessionToken) {
    const sessionId = hashSessionToken(sessionToken);
    database.sessions = database.sessions.filter((session) => session.id !== sessionId);
    writeDatabase();
  }

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": clearSessionCookie(req),
  });
  res.end(JSON.stringify({ ok: true }));
}

function handleListEntries(req, res) {
  const user = requireUser(req, res);
  if (!user) return;

  const entries = database.entries
    .filter((entry) => entry.userId === user.id)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(publicEntry);

  sendJson(res, 200, { entries });
}

async function handleSaveEntry(req, res) {
  const user = requireUser(req, res);
  if (!user) return;

  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
    return;
  }

  const date = normalizeDate(payload.date);
  const summary = normalizeSummary(payload.summary);
  const conversation = normalizeConversation(payload.conversation);

  if (!date) {
    sendJson(res, 400, { error: "A valid date is required." });
    return;
  }

  if (!summary) {
    sendJson(res, 400, { error: "Diary text is required." });
    return;
  }

  const now = new Date().toISOString();
  let entry = database.entries.find(
    (candidate) => candidate.userId === user.id && candidate.date === date
  );

  if (entry) {
    entry.summary = summary;
    entry.conversation = conversation;
    entry.updatedAt = now;
  } else {
    entry = {
      id: crypto.randomUUID(),
      userId: user.id,
      date,
      summary,
      conversation,
      createdAt: now,
      updatedAt: now,
    };
    database.entries.push(entry);
  }

  writeDatabase();
  sendJson(res, 200, { entry: publicEntry(entry) });
}

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

function requireUser(req, res) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Please sign in first." });
    return null;
  }
  return user;
}

function getAuthenticatedUser(req) {
  const sessionToken = parseCookies(req.headers.cookie).session;
  if (!sessionToken) return null;

  const sessionId = hashSessionToken(sessionToken);
  const session = database.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return null;

  if (Date.parse(session.expiresAt) <= Date.now()) {
    database.sessions = database.sessions.filter((candidate) => candidate.id !== sessionId);
    writeDatabase();
    return null;
  }

  return database.users.find((user) => user.id === session.userId) || null;
}

function createSession(userId) {
  pruneExpiredSessions();
  const token = crypto.randomBytes(32).toString("base64url");
  database.sessions.push({
    id: hashSessionToken(token),
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + sessionMaxAgeSeconds * 1000).toISOString(),
  });
  return token;
}

function pruneExpiredSessions() {
  const now = Date.now();
  const before = database.sessions.length;
  database.sessions = database.sessions.filter((session) => Date.parse(session.expiresAt) > now);
  return database.sessions.length !== before;
}

function buildSessionCookie(token, req) {
  const parts = [
    `session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${sessionMaxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(req) {
  const parts = ["session=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function isSecureRequest(req) {
  return Boolean(req.socket.encrypted || req.headers["x-forwarded-proto"] === "https");
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function parseCookies(header = "") {
  return header.split(";").reduce((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) return cookies;
    try {
      cookies[rawName] = decodeURIComponent(rawValue.join("="));
    } catch {
      cookies[rawName] = rawValue.join("=");
    }
    return cookies;
  }, {});
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, savedHash) {
  const [algorithm, salt, hash] = String(savedHash).split(":");
  if (algorithm !== "scrypt" || !salt || !hash) return false;

  const expected = Buffer.from(hash, "base64url");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  };
}

function publicEntry(entry) {
  return {
    id: entry.id,
    date: entry.date,
    summary: entry.summary,
    conversation: Array.isArray(entry.conversation) ? entry.conversation : [],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function normalizeName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 80) : "";
}

function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizeDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : value;
}

function normalizeSummary(value) {
  return typeof value === "string" ? value.trim().slice(0, 12000) : "";
}

function normalizeConversation(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-80)
    .map((message) => ({
      role: ["user", "bot", "assistant"].includes(message?.role) ? message.role : "user",
      text: typeof message?.text === "string" ? message.text.trim().slice(0, 5000) : "",
      at:
        typeof message?.at === "string" && !Number.isNaN(Date.parse(message.at))
          ? message.at
          : new Date().toISOString(),
    }))
    .filter((message) => message.text);
}

function loadDatabase() {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  if (!fs.existsSync(databasePath)) {
    return { users: [], sessions: [], entries: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(databasePath, "utf8"));
  return {
    users: Array.isArray(parsed.users) ? parsed.users : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
  };
}

function writeDatabase() {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const tempPath = `${databasePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(database, null, 2)}\n`);
  fs.renameSync(tempPath, databasePath);
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

async function readJson(req) {
  const body = await readBody(req, maxJsonBytes);
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Expected a JSON body.");
    error.status = 400;
    throw error;
  }
}

function readBody(req, maxBytes = maxJsonBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        settled = true;
        const error = new Error("Request body is too large.");
        error.status = 413;
        reject(error);
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!settled) resolve(body);
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
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
