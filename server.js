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
const oauthCookieMaxAgeSeconds = 60 * 10;
const registrationCodeMaxAgeMs = 10 * 60 * 1000;
const registrationCodeCooldownMs = 60 * 1000;
const maxRegistrationCodeAttempts = 5;
const maxJsonBytes = 1024 * 1024;
const database = loadDatabase();
let googleJwksCache = { expiresAt: 0, keys: [] };

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
    const canonicalRedirect = canonicalRedirectUrl(req, url);
    if (canonicalRedirect) {
      res.writeHead(308, { Location: canonicalRedirect });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const user = getAuthenticatedUser(req);
      sendJson(res, 200, { user: user ? publicUser(user) : null });
      return;
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/api/auth/register" || url.pathname === "/api/auth/register/start")
    ) {
      await handleRegisterStart(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/register/verify") {
      await handleRegisterVerify(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/google") {
      handleGoogleStart(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/google/callback") {
      await handleGoogleCallback(req, res, url);
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

async function handleRegisterStart(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
    return;
  }

  const registration = validateRegistrationPayload(payload);
  if (registration.error) {
    sendJson(res, registration.status, { error: registration.error });
    return;
  }

  const { name, email, password } = registration;
  if (database.users.some((user) => user.email === email)) {
    sendJson(res, 409, { error: "An account with that email already exists." });
    return;
  }

  pruneExpiredEmailCodes();
  const existingCode = findPendingRegistration(email);
  if (
    existingCode &&
    Date.now() - Date.parse(existingCode.updatedAt || existingCode.createdAt) < registrationCodeCooldownMs
  ) {
    sendJson(res, 429, { error: "Please wait a minute before requesting another code." });
    return;
  }

  const code = generateRegistrationCode();
  const salt = crypto.randomBytes(16).toString("base64url");
  const now = new Date().toISOString();
  const pendingRegistration = {
    id: crypto.randomUUID(),
    purpose: "registration",
    name,
    email,
    passwordHash: hashPassword(password),
    codeHash: hashRegistrationCode(email, code, salt),
    salt,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + registrationCodeMaxAgeMs).toISOString(),
  };

  database.emailCodes = database.emailCodes.filter(
    (record) => !(record.purpose === "registration" && record.email === email)
  );
  database.emailCodes.push(pendingRegistration);
  writeDatabase();

  try {
    const delivery = await sendRegistrationCodeEmail({ email, name, code });
    const response = {
      pendingVerification: true,
      email,
      expiresInSeconds: Math.round(registrationCodeMaxAgeMs / 1000),
    };
    if (delivery.devCode) response.devCode = delivery.devCode;
    sendJson(res, 202, response);
  } catch (error) {
    database.emailCodes = database.emailCodes.filter((record) => record.id !== pendingRegistration.id);
    writeDatabase();
    console.error("Registration email failed.", error);
    sendJson(res, error.status || 502, {
      error: error.publicMessage || error.message || "Could not send the verification email.",
    });
  }
}

async function handleRegisterVerify(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
    return;
  }

  const email = normalizeEmail(payload.email);
  const code = normalizeRegistrationCode(payload.code);

  if (!email) {
    sendJson(res, 400, { error: "Enter a valid email address." });
    return;
  }

  if (!code) {
    sendJson(res, 400, { error: "Enter the six-digit code." });
    return;
  }

  const pruned = pruneExpiredEmailCodes();
  const pendingRegistration = findPendingRegistration(email);
  if (!pendingRegistration) {
    if (pruned) writeDatabase();
    sendJson(res, 410, { error: "That code expired or was not found. Please request a new one." });
    return;
  }

  if (database.users.some((user) => user.email === email)) {
    database.emailCodes = database.emailCodes.filter((record) => record.id !== pendingRegistration.id);
    writeDatabase();
    sendJson(res, 409, { error: "An account with that email already exists." });
    return;
  }

  const submittedHash = hashRegistrationCode(email, code, pendingRegistration.salt);
  if (!timingSafeEqualString(submittedHash, pendingRegistration.codeHash)) {
    pendingRegistration.attempts = Number(pendingRegistration.attempts || 0) + 1;
    pendingRegistration.updatedAt = new Date().toISOString();

    if (pendingRegistration.attempts >= maxRegistrationCodeAttempts) {
      database.emailCodes = database.emailCodes.filter((record) => record.id !== pendingRegistration.id);
      writeDatabase();
      sendJson(res, 429, { error: "Too many incorrect codes. Please request a new one." });
      return;
    }

    writeDatabase();
    sendJson(res, 401, { error: "That code is not right." });
    return;
  }

  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    name: pendingRegistration.name,
    email,
    authProvider: "password",
    passwordHash: pendingRegistration.passwordHash,
    emailVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  database.users.push(user);
  database.emailCodes = database.emailCodes.filter((record) => record.id !== pendingRegistration.id);
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

  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
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

function validateRegistrationPayload(payload) {
  const name = normalizeName(payload.name);
  const email = normalizeEmail(payload.email);
  const password = typeof payload.password === "string" ? payload.password : "";

  if (!name) return { status: 400, error: "Name is required." };
  if (!email) return { status: 400, error: "Enter a valid email address." };
  if (password.length < 8) {
    return { status: 400, error: "Password must be at least 8 characters." };
  }

  return { name, email, password };
}

async function sendRegistrationCodeEmail({ email, name, code }) {
  if (process.env.EMAIL_DEV_MODE === "1") {
    console.log(`Registration code for ${email}: ${code}`);
    return { devCode: code };
  }

  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    const error = new Error("Email delivery is not configured yet.");
    error.status = 503;
    throw error;
  }

  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [email],
        subject: "Your This Day Then code",
        text: [
          `Hi ${name},`,
          "",
          `Your This Day Then verification code is ${code}.`,
          "It expires in 10 minutes.",
          "",
          "If you did not request this, you can ignore this email.",
        ].join("\n"),
        html: buildRegistrationEmailHtml({ name, code }),
      }),
    });
  } catch {
    const error = new Error("Could not reach the email service.");
    error.status = 502;
    throw error;
  }

  if (!response.ok) {
    const error = new Error("Could not send the verification email.");
    error.status = 502;
    try {
      error.publicMessage = "Could not send the verification email.";
      error.cause = await response.text();
    } catch {
      error.cause = `Email service returned ${response.status}.`;
    }
    throw error;
  }

  return {};
}

function buildRegistrationEmailHtml({ name, code }) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6fbef;color:#163326;font-family:Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;">
      <p style="margin:0 0 16px;font-size:16px;">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 18px;font-size:16px;line-height:1.5;">Use this code to finish creating your This Day Then account.</p>
      <p style="margin:0 0 18px;font-size:32px;font-weight:700;letter-spacing:6px;color:#276243;">${escapeHtml(code)}</p>
      <p style="margin:0;color:#586d5d;font-size:14px;line-height:1.5;">It expires in 10 minutes. If you did not request this, you can ignore this email.</p>
    </div>
  </body>
</html>`;
}

function handleGoogleStart(req, res) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    redirectWithAuthMessage(req, res, "Google sign-in is not configured yet.");
    return;
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  const redirectUri = googleRedirectUri(req);
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
  }).toString();

  res.writeHead(302, {
    Location: authorizationUrl.toString(),
    "Set-Cookie": [
      buildTemporaryCookie("google_oauth_state", state, req),
      buildTemporaryCookie("google_oauth_nonce", nonce, req),
    ],
  });
  res.end();
}

async function handleGoogleCallback(req, res, url) {
  const cookies = parseCookies(req.headers.cookie);
  const expectedState = cookies.google_oauth_state;
  const expectedNonce = cookies.google_oauth_nonce;
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    redirectWithAuthMessage(req, res, "Google sign-in was cancelled.");
    return;
  }

  if (!expectedState || !expectedNonce || state !== expectedState || !code) {
    redirectWithAuthMessage(req, res, "Google sign-in could not be verified.");
    return;
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    redirectWithAuthMessage(req, res, "Google sign-in is not configured yet.");
    return;
  }

  try {
    const tokens = await exchangeGoogleCode(req, code);
    const claims = await verifyGoogleIdToken(tokens.id_token, expectedNonce);
    const user = findOrCreateGoogleUser(claims);
    const sessionToken = createSession(user.id);
    writeDatabase();

    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": [
        buildSessionCookie(sessionToken, req),
        clearCookie("google_oauth_state", req),
        clearCookie("google_oauth_nonce", req),
      ],
    });
    res.end();
  } catch (error) {
    console.error("Google sign-in failed.", error);
    redirectWithAuthMessage(req, res, "Google sign-in failed. Try again.");
  }
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

async function exchangeGoogleCode(req, code) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(req),
      grant_type: "authorization_code",
    }),
  });

  const payload = await response.json();
  if (!response.ok || !payload.id_token) {
    throw new Error(payload.error_description || payload.error || "Token exchange failed.");
  }

  return payload;
}

async function verifyGoogleIdToken(idToken, expectedNonce) {
  const [headerSegment, payloadSegment, signatureSegment] = String(idToken).split(".");
  if (!headerSegment || !payloadSegment || !signatureSegment) {
    throw new Error("Malformed Google ID token.");
  }

  const header = parseBase64UrlJson(headerSegment);
  const claims = parseBase64UrlJson(payloadSegment);
  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Unsupported Google ID token.");
  }

  const jwks = await getGoogleJwks();
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw new Error("Google signing key was not found.");
  }

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${headerSegment}.${payloadSegment}`);
  verifier.end();
  const verified = verifier.verify(
    crypto.createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signatureSegment, "base64url")
  );
  if (!verified) {
    throw new Error("Google ID token signature is invalid.");
  }

  const issuerValid = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!issuerValid || claims.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new Error("Google ID token audience or issuer is invalid.");
  }

  if (Number(claims.exp) * 1000 <= Date.now()) {
    throw new Error("Google ID token is expired.");
  }

  if (claims.nonce !== expectedNonce) {
    throw new Error("Google ID token nonce is invalid.");
  }

  if (!claims.sub || !claims.email || claims.email_verified !== true) {
    throw new Error("Google account email is not verified.");
  }

  return claims;
}

async function getGoogleJwks() {
  if (googleJwksCache.keys.length && googleJwksCache.expiresAt > Date.now()) {
    return googleJwksCache;
  }

  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!response.ok) {
    throw new Error("Could not fetch Google signing keys.");
  }

  const payload = await response.json();
  const cacheControl = response.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
  googleJwksCache = {
    expiresAt: Date.now() + maxAgeSeconds * 1000,
    keys: Array.isArray(payload.keys) ? payload.keys : [],
  };
  return googleJwksCache;
}

function findOrCreateGoogleUser(claims) {
  const googleId = String(claims.sub);
  const email = normalizeEmail(claims.email);
  const name = normalizeName(claims.name) || email.split("@")[0] || "Google user";
  const now = new Date().toISOString();
  let user =
    database.users.find((candidate) => candidate.googleId === googleId) ||
    database.users.find((candidate) => candidate.email === email);

  if (user) {
    user.googleId = user.googleId || googleId;
    user.authProvider = user.passwordHash ? "password+google" : "google";
    user.name = user.name || name;
    user.avatarUrl = typeof claims.picture === "string" ? claims.picture : user.avatarUrl || "";
    user.updatedAt = now;
    return user;
  }

  user = {
    id: crypto.randomUUID(),
    name,
    email,
    googleId,
    authProvider: "google",
    avatarUrl: typeof claims.picture === "string" ? claims.picture : "",
    createdAt: now,
    updatedAt: now,
  };
  database.users.push(user);
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

function buildTemporaryCookie(name, value, req) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${oauthCookieMaxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(req) {
  return clearCookie("session", req);
}

function clearCookie(name, req) {
  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function isSecureRequest(req) {
  return Boolean(req.socket.encrypted || firstHeaderValue(req.headers["x-forwarded-proto"]) === "https");
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function generateRegistrationCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function normalizeRegistrationCode(value) {
  if (typeof value !== "string") return "";
  const digits = value.replace(/\D/g, "");
  return digits.length === 6 ? digits : "";
}

function hashRegistrationCode(email, code, salt) {
  return crypto.createHash("sha256").update(`${salt}:${email}:${code}`).digest("base64url");
}

function timingSafeEqualString(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function findPendingRegistration(email) {
  return database.emailCodes.find(
    (record) => record.purpose === "registration" && record.email === email
  );
}

function pruneExpiredEmailCodes() {
  const now = Date.now();
  const before = database.emailCodes.length;
  database.emailCodes = database.emailCodes.filter((record) => Date.parse(record.expiresAt) > now);
  return database.emailCodes.length !== before;
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
    avatarUrl: user.avatarUrl || "",
    authProvider: user.authProvider || (user.googleId ? "google" : "password"),
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
    return { users: [], sessions: [], entries: [], emailCodes: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(databasePath, "utf8"));
  return {
    users: Array.isArray(parsed.users) ? parsed.users : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    emailCodes: Array.isArray(parsed.emailCodes) ? parsed.emailCodes : [],
  };
}

function writeDatabase() {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const tempPath = `${databasePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(database, null, 2)}\n`);
  fs.renameSync(tempPath, databasePath);
}

function googleRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${requestOrigin(req)}/api/auth/google/callback`;
}

function canonicalRedirectUrl(req, url) {
  const canonicalHost = normalizeHost(process.env.CANONICAL_HOST);
  if (!canonicalHost) return "";

  const requestHost = normalizeHost(firstHeaderValue(req.headers["x-forwarded-host"]) || req.headers.host);
  if (requestHost !== `www.${canonicalHost}`) return "";

  const protocol = firstHeaderValue(req.headers["x-forwarded-proto"]) || (isSecureRequest(req) ? "https" : "http");
  const destination = new URL(`${protocol}://${canonicalHost}`);
  destination.pathname = url.pathname;
  destination.search = url.search;
  return destination.toString();
}

function requestOrigin(req) {
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]);
  const protocol = forwardedProto || (isSecureRequest(req) ? "https" : "http");
  const host = forwardedHost || req.headers.host || `127.0.0.1:${port}`;
  return `${protocol}://${host}`;
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value.split(",")[0].trim() : "";
}

function normalizeHost(value = "") {
  return String(value).trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function redirectWithAuthMessage(req, res, message) {
  const destination = new URL("/", requestOrigin(req));
  destination.searchParams.set("authMessage", message);
  res.writeHead(302, {
    Location: `${destination.pathname}${destination.search}`,
    "Set-Cookie": [clearCookie("google_oauth_state", req), clearCookie("google_oauth_nonce", req)],
  });
  res.end();
}

function parseBase64UrlJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
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
