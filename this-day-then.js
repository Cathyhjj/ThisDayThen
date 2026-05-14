const STORAGE_KEY = "this-day-then.entries.v1";
const CHAT_KEY = "this-day-then.chat.v1";
const THEME_KEY = "this-day-then.theme.v1";

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  selectedDate: toDateInputValue(new Date()),
  entries: loadEntries(),
  chat: loadChat(),
  voice: {
    active: false,
    listening: false,
    speaking: false,
    recognition: null,
    mode: "browser-demo",
    transcriptVisible: false,
    realtime: null,
  },
};

const prompts = [
  "I'm here. What stayed with you from today?",
  "Was there a small moment you almost missed, but future-you might want to remember?",
  "Who or what shaped the feeling of the day?",
  "If this day had a color or weather, what would it be?",
  "What should the five lines be gentle about?",
];

const demoEntries = [
  {
    date: "2025-05-12",
    summary:
      "I woke up earlier than I expected.\nWork felt heavy, but I found one clean hour.\nDinner was simple and warm.\nI missed home for a moment in the afternoon.\nThe day ended softer than it began.",
    conversation: [],
    updatedAt: "2025-05-12T22:12:00.000Z",
  },
  {
    date: "2024-05-12",
    summary:
      "The rain made everything quieter.\nI spent too much time in my head.\nA message from a friend changed the shape of the evening.\nI wanted more certainty than the day could give.\nStill, I noticed I was trying.",
    conversation: [],
    updatedAt: "2024-05-12T21:04:00.000Z",
  },
  {
    date: "2023-05-12",
    summary:
      "I felt new to almost everything.\nThe city looked larger than my courage.\nI bought coffee and pretended to know my route.\nThere was fear, but also a tiny spark.\nI think this was the beginning of something.",
    conversation: [],
    updatedAt: "2023-05-12T20:42:00.000Z",
  },
];

const elements = {
  breathCanvas: document.querySelector("#breathCanvas"),
  dateInput: document.querySelector("#dateInput"),
  dateHeading: document.querySelector("#date-heading"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  messageInput: document.querySelector("#messageInput"),
  summaryEditor: document.querySelector("#summaryEditor"),
  generateSummary: document.querySelector("#generateSummary"),
  regenerateSummary: document.querySelector("#regenerateSummary"),
  saveSummary: document.querySelector("#saveSummary"),
  resetChat: document.querySelector("#resetChat"),
  yearStack: document.querySelector("#yearStack"),
  compareYears: document.querySelector("#compareYears"),
  reflectionBox: document.querySelector("#reflectionBox"),
  archiveList: document.querySelector("#archiveList"),
  seedDemoData: document.querySelector("#seedDemoData"),
  timelineSeedDemoData: document.querySelector("#timelineSeedDemoData"),
  themeToggle: document.querySelector("#themeToggle"),
  voiceOrb: document.querySelector("#voiceOrb"),
  voiceStage: document.querySelector(".voice-stage"),
  voiceState: document.querySelector("#voiceState"),
  voiceHint: document.querySelector("#voiceHint"),
  startVoice: document.querySelector("#startVoice"),
  finishVoice: document.querySelector("#finishVoice"),
  toggleTranscript: document.querySelector("#toggleTranscript"),
};

init();

function init() {
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme === "night") {
    document.documentElement.dataset.theme = "night";
  }

  ensureChatForDate();
  bindEvents();
  render();
  startBreathCanvas();
  checkVoiceMode();
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  elements.dateInput.addEventListener("change", (event) => {
    stopVoiceSession();
    state.selectedDate = event.target.value;
    ensureChatForDate();
    render();
  });

  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = elements.messageInput.value.trim();
    if (!text) return;
    acceptUserVoiceText(text);
    elements.messageInput.value = "";
  });

  elements.voiceOrb.addEventListener("click", () => {
    if (state.voice.active) {
      finishVoiceSession();
    } else {
      startVoiceSession();
    }
  });

  elements.startVoice.addEventListener("click", startVoiceSession);
  elements.finishVoice.addEventListener("click", finishVoiceSession);
  elements.toggleTranscript.addEventListener("click", toggleTranscript);
  elements.generateSummary.addEventListener("click", () => draftSummary());
  elements.regenerateSummary.addEventListener("click", () => draftSummary(true));
  elements.saveSummary.addEventListener("click", saveSummary);
  elements.resetChat.addEventListener("click", resetChat);
  elements.compareYears.addEventListener("click", renderReflection);
  elements.seedDemoData.addEventListener("click", addDemoMemories);
  elements.timelineSeedDemoData.addEventListener("click", addDemoMemories);
  elements.themeToggle.addEventListener("click", toggleTheme);
}

function switchView(viewName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.view === viewName);
  });

  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-visible", view.id === `${viewName}View`);
  });

  if (viewName === "timeline") renderYearStack();
  if (viewName === "archive") renderArchive();
}

function render() {
  elements.dateInput.value = state.selectedDate;
  elements.dateHeading.textContent = formatLongDate(state.selectedDate);
  const entry = state.entries[state.selectedDate];
  elements.summaryEditor.value = entry?.summary || "";
  elements.reflectionBox.hidden = true;
  renderMessages();
  renderYearStack();
  renderArchive();
  updateVoiceUI("idle");
}

function renderMessages() {
  elements.messages.innerHTML = "";
  currentChat().forEach((message) => {
    const bubble = document.createElement("div");
    bubble.className = `message ${message.role}`;
    bubble.textContent = message.text;
    elements.messages.appendChild(bubble);
  });
  elements.messages.hidden = !state.voice.transcriptVisible;
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderYearStack() {
  const selected = parseLocalDate(state.selectedDate);
  const month = selected.getMonth();
  const day = selected.getDate();
  const selectedYear = selected.getFullYear();
  const years = Array.from({ length: 5 }, (_, index) => selectedYear - index);

  elements.yearStack.innerHTML = "";

  years.forEach((year) => {
    const date = toDateInputValue(new Date(year, month, day));
    const entry = state.entries[date];
    const card = document.createElement("article");
    card.className = `year-card ${year === selectedYear ? "current" : ""}`;

    const meta = document.createElement("div");
    meta.className = "year-meta";
    meta.innerHTML = `<span class="year-number">${year}</span><span>${entry ? "saved" : "empty"}</span>`;
    card.appendChild(meta);

    if (entry) {
      card.appendChild(linesToList(entry.summary));
    } else {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent =
        year === selectedYear
          ? "Speak today into five lines, then this year will appear here."
          : "No memory yet for this date.";
      card.appendChild(empty);
    }

    elements.yearStack.appendChild(card);
  });
}

function renderArchive() {
  const entries = Object.values(state.entries).sort((a, b) => b.date.localeCompare(a.date));
  elements.archiveList.innerHTML = "";

  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No saved days yet. Add demo memories or save today's five lines.";
    elements.archiveList.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const item = document.createElement("article");
    item.className = "archive-item";

    const meta = document.createElement("div");
    meta.className = "archive-meta";
    meta.innerHTML = `<span>${formatLongDate(entry.date)}</span><span>${entry.summary.split("\n").filter(Boolean).length} lines</span>`;

    const button = document.createElement("button");
    button.className = "secondary-button compact";
    button.type = "button";
    button.textContent = "Open date";
    button.addEventListener("click", () => {
      stopVoiceSession();
      state.selectedDate = entry.date;
      ensureChatForDate();
      switchView("timeline");
      render();
    });

    item.append(meta, linesToList(entry.summary), button);
    elements.archiveList.appendChild(item);
  });
}

async function checkVoiceMode() {
  try {
    const response = await fetch("/api/voice-status");
    if (!response.ok) return;
    const data = await response.json();
    state.voice.mode = data.mode || "browser-demo";
    if (data.realtimeReady) {
      elements.voiceHint.textContent =
        "Realtime voice is configured. Tap the orb to begin a live audio check-in.";
    }
  } catch {
    state.voice.mode = "browser-demo";
  }
}

function startVoiceSession() {
  if (state.voice.active) return;
  if (state.voice.mode === "openai-realtime") {
    startRealtimeVoiceSession();
    return;
  }

  state.voice.active = true;
  updateVoiceUI("speaking", "She is beginning softly");
  speakBot(nextPromptText());
}

function finishVoiceSession() {
  stopVoiceSession();
  draftSummary();
  updateVoiceUI("idle", "Five lines are ready to shape");
  flashButton(elements.finishVoice, "Drafted");
}

function stopVoiceSession() {
  state.voice.active = false;
  state.voice.listening = false;
  state.voice.speaking = false;
  window.speechSynthesis?.cancel();
  if (state.voice.recognition) {
    state.voice.recognition.onend = null;
    state.voice.recognition.stop();
    state.voice.recognition = null;
  }
  stopRealtimeVoiceSession();
}

function speakBot(text) {
  pushMessage("bot", text);
  updateVoiceUI("speaking", "She is speaking");

  if (!("speechSynthesis" in window)) {
    updateVoiceUI("listening", "Listening");
    startListening();
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.88;
  utterance.pitch = 1.08;
  utterance.volume = 0.9;

  const preferredVoice = window.speechSynthesis
    .getVoices()
    .find((voice) => /female|samantha|victoria|karen|moira|tessa|zira/i.test(voice.name));
  if (preferredVoice) utterance.voice = preferredVoice;

  utterance.onend = () => {
    state.voice.speaking = false;
    if (state.voice.active) {
      updateVoiceUI("listening", "Listening");
      startListening();
    }
  };

  utterance.onerror = () => {
    if (state.voice.active) {
      updateVoiceUI("listening", "Listening");
      startListening();
    }
  };

  state.voice.speaking = true;
  window.speechSynthesis.speak(utterance);
}

function startListening() {
  if (!state.voice.active || state.voice.listening) return;

  if (!SpeechRecognition) {
    updateVoiceUI(
      "idle",
      "Voice recognition is not available here",
      "Try this in Chrome, or use the hidden transcript input with a keyboard."
    );
    state.voice.active = false;
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = "en-US";
  state.voice.recognition = recognition;

  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    const text = result?.[0]?.transcript?.trim();
    if (text) {
      acceptUserVoiceText(text);
    }
  };

  recognition.onerror = () => {
    updateVoiceUI("idle", "The mic went quiet", "Tap the orb again when you are ready.");
    stopVoiceSession();
  };

  recognition.onend = () => {
    state.voice.listening = false;
    if (state.voice.active && !state.voice.speaking) {
      window.setTimeout(() => startListening(), 500);
    }
  };

  state.voice.listening = true;
  updateVoiceUI("listening", "Listening");
  recognition.start();
}

function acceptUserVoiceText(text) {
  pushMessage("user", text);
  if (state.voice.recognition) {
    state.voice.recognition.onend = null;
    state.voice.recognition.stop();
    state.voice.recognition = null;
  }
  state.voice.listening = false;

  if (!state.voice.active) return;

  const userCount = countUserMessages();
  const nextPrompt =
    userCount >= prompts.length
      ? "That feels like enough for today. When you are ready, I can turn this into five lines."
      : prompts[Math.min(userCount, prompts.length - 1)];

  updateVoiceUI("thinking", "Letting that settle");
  window.setTimeout(() => {
    if (state.voice.active) speakBot(nextPrompt);
  }, 850);
}

function pushMessage(role, text) {
  if (!text) return;
  currentChat().push({ role, text, at: new Date().toISOString() });
  persistChat();
  renderMessages();
}

async function startRealtimeVoiceSession() {
  if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
    state.voice.mode = "browser-demo";
    startVoiceSession();
    return;
  }

  state.voice.active = true;
  updateVoiceUI("thinking", "Opening the quiet room", "Your browser may ask for microphone access.");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const peerConnection = new RTCPeerConnection();
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");

    peerConnection.ontrack = (event) => {
      audio.srcObject = event.streams[0];
    };

    stream.getAudioTracks().forEach((track) => {
      peerConnection.addTrack(track, stream);
    });

    const dataChannel = peerConnection.createDataChannel("oai-events");
    const transcriptDrafts = new Map();

    dataChannel.addEventListener("open", () => {
      state.voice.realtime = { peerConnection, dataChannel, stream, audio, transcriptDrafts };
      updateVoiceUI("speaking", "She is beginning softly");
      sendRealtimeEvent({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Begin with one short, soft question: I'm here. What stayed with you from today?",
        },
      });
    });

    dataChannel.addEventListener("message", (event) => {
      handleRealtimeEvent(event.data, transcriptDrafts);
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const response = await fetch("/api/realtime-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const answerSdp = await response.text();
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });
  } catch (error) {
    console.warn("Realtime voice failed, falling back to browser voice.", error);
    stopVoiceSession();
    state.voice.mode = "browser-demo";
    updateVoiceUI("idle", "Realtime voice is not ready", "Using the browser demo voice for now.");
  }
}

function stopRealtimeVoiceSession() {
  const realtime = state.voice.realtime;
  if (!realtime) return;

  realtime.dataChannel?.close();
  realtime.peerConnection?.close();
  realtime.stream?.getTracks().forEach((track) => track.stop());
  realtime.audio?.remove();
  state.voice.realtime = null;
}

function sendRealtimeEvent(event) {
  const dataChannel = state.voice.realtime?.dataChannel;
  if (!dataChannel || dataChannel.readyState !== "open") return;
  dataChannel.send(JSON.stringify(event));
}

function handleRealtimeEvent(rawEvent, transcriptDrafts) {
  let event;
  try {
    event = JSON.parse(rawEvent);
  } catch {
    return;
  }

  if (event.type === "input_audio_buffer.speech_started") {
    updateVoiceUI("listening", "Listening");
    return;
  }

  if (event.type === "input_audio_buffer.speech_stopped") {
    updateVoiceUI("thinking", "Letting that settle");
    return;
  }

  if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
    updateVoiceUI("speaking", "She is speaking");
    return;
  }

  if (event.type === "response.done" || event.type === "response.audio.done") {
    updateVoiceUI("listening", "Listening");
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
    pushMessage("user", event.transcript.trim());
    return;
  }

  if (event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") {
    const key = event.response_id || event.item_id || "assistant";
    transcriptDrafts.set(key, `${transcriptDrafts.get(key) || ""}${event.delta || ""}`);
    return;
  }

  if (event.type === "response.audio_transcript.done" || event.type === "response.output_audio_transcript.done") {
    const key = event.response_id || event.item_id || "assistant";
    const text = event.transcript || transcriptDrafts.get(key) || "";
    transcriptDrafts.delete(key);
    pushMessage("bot", text.trim());
  }
}

function nextPromptText() {
  const userCount = countUserMessages();
  return prompts[Math.min(userCount, prompts.length - 1)];
}

function updateVoiceUI(status, label, hint) {
  elements.voiceStage.dataset.voiceState = status;
  const labels = {
    idle: "Ready when you are",
    listening: "Listening",
    thinking: "Letting that settle",
    speaking: "She is speaking",
  };
  elements.voiceState.textContent = label || labels[status] || labels.idle;
  elements.voiceHint.textContent =
    hint ||
    (status === "idle"
      ? "Tap the orb and speak naturally. She will listen, pause, and ask the next gentle question."
      : "No transcript is shown while you speak. The day is gathered quietly in the background.");
  elements.startVoice.textContent = state.voice.active ? "Live voice is open" : "Start live voice";
}

function toggleTranscript() {
  state.voice.transcriptVisible = !state.voice.transcriptVisible;
  elements.toggleTranscript.textContent = state.voice.transcriptVisible
    ? "Hide quiet transcript"
    : "Show quiet transcript";
  renderMessages();
}

function renderReflection() {
  const entries = getSameDateEntries();
  if (!entries.length) {
    elements.reflectionBox.hidden = false;
    elements.reflectionBox.textContent =
      "There is not enough saved here yet. Start with one five-line memory, and this date will gather meaning over time.";
    return;
  }

  const themes = inferThemes(entries.map((entry) => entry.summary).join(" "));
  const years = entries.map((entry) => parseLocalDate(entry.date).getFullYear()).join(", ");
  elements.reflectionBox.hidden = false;
  elements.reflectionBox.textContent = `Across ${years}, this date seems to hold ${themes}. The entries feel less like proof of progress and more like evidence that you kept meeting your life with attention.`;
}

function draftSummary(isRegeneration = false) {
  const userTexts = currentChat()
    .filter((message) => message.role === "user")
    .map((message) => message.text);

  if (!userTexts.length) {
    elements.summaryEditor.value =
      "Today was quiet enough to need no performance.\nI arrived with whatever energy I had.\nA small detail asked to be remembered.\nI let the day be imperfect and still mine.\nFuture-me can begin from here.";
    return;
  }

  const joined = userTexts.join(" ");
  const details = extractDetails(joined);
  const tone = inferTone(joined);
  const variant = isRegeneration ? 1 : 0;

  const lines = [
    `Today felt ${tone}.`,
    details.person
      ? `${details.person} shaped the day more than I expected.`
      : `${details.anchor} stayed with me.`,
    details.place
      ? `There was something about ${details.place} that made the memory easier to hold.`
      : "I noticed the texture of the day instead of rushing past it.",
    variant
      ? "I did not need to make the day bigger than it was."
      : "I tried to be honest about what I had enough energy for.",
    "These are the lines I want future-me to find again.",
  ];

  elements.summaryEditor.value = lines.join("\n");
}

function saveSummary() {
  const summary = normalizeFiveLines(elements.summaryEditor.value);
  if (!summary) return;

  state.entries[state.selectedDate] = {
    date: state.selectedDate,
    summary,
    conversation: currentChat(),
    updatedAt: new Date().toISOString(),
  };

  persistEntries();
  elements.summaryEditor.value = summary;
  renderYearStack();
  renderArchive();
  flashButton(elements.saveSummary, "Saved");
}

function resetChat() {
  stopVoiceSession();
  state.chat[state.selectedDate] = [];
  persistChat();
  renderMessages();
  elements.summaryEditor.value = "";
  updateVoiceUI("idle", "Ready when you are");
}

function addDemoMemories() {
  const selected = parseLocalDate(state.selectedDate);
  const month = selected.getMonth();
  const day = selected.getDate();
  const selectedYear = selected.getFullYear();

  demoEntries.forEach((entry, index) => {
    const date = toDateInputValue(new Date(selectedYear - index - 1, month, day));
    if (!state.entries[date]) {
      state.entries[date] = {
        ...entry,
        date,
        updatedAt: new Date(selectedYear - index - 1, month, day, 21, 12).toISOString(),
      };
    }
  });
  persistEntries();
  render();
  switchView("timeline");
}

function toggleTheme() {
  const isNight = document.documentElement.dataset.theme === "night";
  document.documentElement.dataset.theme = isNight ? "" : "night";
  localStorage.setItem(THEME_KEY, isNight ? "day" : "night");
}

function ensureChatForDate() {
  if (!state.chat[state.selectedDate]) {
    state.chat[state.selectedDate] = [];
    persistChat();
  }
}

function currentChat() {
  return state.chat[state.selectedDate] || [];
}

function countUserMessages() {
  return currentChat().filter((message) => message.role === "user").length;
}

function getSameDateEntries() {
  const selected = parseLocalDate(state.selectedDate);
  const monthDay = `${selected.getMonth() + 1}-${selected.getDate()}`;
  return Object.values(state.entries)
    .filter((entry) => {
      const date = parseLocalDate(entry.date);
      return `${date.getMonth() + 1}-${date.getDate()}` === monthDay;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function linesToList(summary) {
  const list = document.createElement("ol");
  list.className = "entry-lines";
  summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .forEach((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      list.appendChild(item);
    });
  return list;
}

function normalizeFiveLines(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join("\n");
}

function extractDetails(text) {
  const peopleMatch = text.match(/\b(mom|dad|friend|partner|sister|brother|team|client|boss|child|family)\b/i);
  const placeMatch = text.match(/\b(home|office|train|kitchen|park|street|cafe|school|studio|airport|room|garden|river|forest)\b/i);
  const lower = text.toLowerCase();

  let anchor = "A small ordinary moment";
  if (lower.includes("walk")) anchor = "The walk";
  else if (lower.includes("conversation") || lower.includes("talked") || lower.includes("message")) anchor = "The conversation";
  else if (lower.includes("work")) anchor = "The shape of the workday";
  else if (lower.includes("coffee") || lower.includes("tea")) anchor = "A small warm drink";
  else if (lower.includes("rain")) anchor = "The weather";
  else if (lower.includes("deploy") || lower.includes("build")) anchor = "The feeling of making something real";

  return {
    anchor,
    person: peopleMatch ? peopleMatch[0].toLowerCase() : "",
    place: placeMatch ? placeMatch[0].toLowerCase() : "",
  };
}

function inferTone(text) {
  const lower = text.toLowerCase();
  if (/(tired|heavy|sad|hard|lonely|anxious|worried|stress)/.test(lower)) return "heavy but still held";
  if (/(happy|good|sweet|grateful|calm|peace|soft|nice)/.test(lower)) return "soft and grateful";
  if (/(busy|work|deadline|meeting|running)/.test(lower)) return "full and a little stretched";
  if (/(new|begin|first|change|move|real|deploy|launch)/.test(lower)) return "new, uncertain, and alive";
  return "ordinary in a way that deserves remembering";
}

function inferThemes(text) {
  const lower = text.toLowerCase();
  const themes = [];
  if (/(home|family|mom|dad|sister|brother)/.test(lower)) themes.push("home and belonging");
  if (/(work|meeting|client|deadline|project|deploy|build)/.test(lower)) themes.push("work and becoming");
  if (/(tired|rest|sleep|energy|quiet)/.test(lower)) themes.push("energy and rest");
  if (/(friend|partner|message|conversation)/.test(lower)) themes.push("connection");
  if (/(new|begin|change|city|route)/.test(lower)) themes.push("change");
  return themes.length ? themes.slice(0, 3).join(", ") : "ordinary tenderness";
}

function startBreathCanvas() {
  const canvas = elements.breathCanvas;
  const context = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mouse = {
    targetX: 0,
    targetY: 0,
    currentX: 0,
    currentY: 0,
  };
  const camera = { fov: 430 };
  const dayPalette = ["#123527", "#2d7450", "#62ac70", "#8edfc0", "#e3fba8"];
  const nightPalette = ["#07130e", "#143a28", "#2d7650", "#7fcf8e", "#c9ef92"];

  let width = 0;
  let height = 0;
  let gridResolutionX = 0;
  let gridResolutionZ = 0;
  let particles = [];
  let lines = [];
  let lastFrameTime = 0;

  window.addEventListener("pointermove", (event) => {
    mouse.targetX = (event.clientX - window.innerWidth / 2) / (window.innerWidth / 2);
    mouse.targetY = -(event.clientY - window.innerHeight / 2) / (window.innerHeight / 2);
  });

  window.addEventListener("pointerleave", () => {
    mouse.targetX = 0;
    mouse.targetY = 0;
  });

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    initWaveSurface();
  }

  function initWaveSurface() {
    const isMobile = width <= 768;
    gridResolutionX = isMobile ? 28 : 48;
    gridResolutionZ = isMobile ? 26 : 38;
    const spreadX = isMobile ? 42 : 52;
    const spreadZ = isMobile ? 40 : 50;
    const grid = [];
    particles = [];
    lines = [];

    for (let x = 0; x < gridResolutionX; x += 1) {
      const row = [];
      for (let z = 0; z < gridResolutionZ; z += 1) {
        const particle = createWaveParticle(x, z, spreadX, spreadZ);
        particles.push(particle);
        row.push(particle);
      }
      grid.push(row);
    }

    for (let x = 0; x < gridResolutionX; x += 1) {
      for (let z = 0; z < gridResolutionZ; z += 1) {
        if (x < gridResolutionX - 1) lines.push([grid[x][z], grid[x + 1][z]]);
        if (z < gridResolutionZ - 1) lines.push([grid[x][z], grid[x][z + 1]]);
      }
    }
  }

  function createWaveParticle(gridX, gridZ, spreadX, spreadZ) {
    return {
      i: gridX,
      j: gridZ,
      baseX: (gridX - gridResolutionX / 2) * spreadX,
      baseZ: (gridZ - gridResolutionZ / 2) * spreadZ,
      noise: Math.sin(gridX * 1.73) * Math.cos(gridZ * 1.37) * 0.22,
      size: 0.8 + ((gridX * 7 + gridZ * 13) % 10) * 0.18,
      x2d: 0,
      y2d: 0,
      scale: 0,
      colorValue: 0,
      alpha: 0,
      distance: 0,
    };
  }

  function hexToRgb(hex) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    };
  }

  function waveColor(value, alpha, nightMode) {
    const palette = nightMode ? nightPalette : dayPalette;
    const safeValue = Math.max(0, Math.min(1, value));
    const position = safeValue * (palette.length - 1);
    const lowIndex = Math.floor(position);
    const highIndex = Math.min(palette.length - 1, lowIndex + 1);
    const mix = position - lowIndex;
    const low = hexToRgb(palette[lowIndex]);
    const high = hexToRgb(palette[highIndex]);
    const r = Math.round(low.r + (high.r - low.r) * mix);
    const g = Math.round(low.g + (high.g - low.g) * mix);
    const b = Math.round(low.b + (high.b - low.b) * mix);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function updateWaveParticle(particle, time) {
    const rippleCenterX = mouse.currentX * 520;
    const rippleCenterZ = mouse.currentY * 420;
    const dx = particle.baseX - rippleCenterX;
    const dz = particle.baseZ - rippleCenterZ;
    const distance = Math.sqrt(dx * dx + dz * dz);
    const stretchedDistance = Math.pow(distance, 0.93) * 1.48;
    const decay = Math.max(0, 1 - Math.pow(distance / 1540, 1.48));
    const amplitude = width <= 768 ? 150 : 230;
    const breathingWave = Math.sin(stretchedDistance * 0.0082 - time * 0.00145 + particle.noise);
    const crossWave = Math.sin(particle.baseX * 0.006 + time * 0.00062) * 0.28;
    const y3d = (breathingWave + crossWave) * amplitude * decay;

    const rotX = 1.05 + mouse.currentY * 0.18;
    const rotY = mouse.currentX * 0.18;
    const y1 = y3d * Math.cos(rotX) - particle.baseZ * Math.sin(rotX);
    const z1 = y3d * Math.sin(rotX) + particle.baseZ * Math.cos(rotX);
    const x2 = particle.baseX * Math.cos(rotY) + z1 * Math.sin(rotY);
    const z2 = -particle.baseX * Math.sin(rotY) + z1 * Math.cos(rotY);
    const finalZ = z2 + (width <= 768 ? 680 : 780);
    const scale = camera.fov / (camera.fov + finalZ);
    const heightOffset = width <= 768 ? height * 0.46 : height * 0.44;

    particle.x2d = x2 * scale + width / 2;
    particle.y2d = y1 * scale + heightOffset;
    particle.scale = scale;
    particle.distance = distance;
    particle.alpha = Math.max(0, Math.min(0.82, scale * 1.8 * decay));
    particle.colorValue = Math.max(0, Math.min(1, ((y3d + amplitude) / (amplitude * 2)) * (0.34 + decay * 0.66)));
  }

  function drawAmbientGlow(time, nightMode) {
    const breath = (Math.sin(time / 4200) + 1) / 2;
    const centerGlow = context.createRadialGradient(
      width * 0.5,
      height * 0.34,
      0,
      width * 0.5,
      height * 0.36,
      width * (0.34 + breath * 0.08)
    );
    centerGlow.addColorStop(0, nightMode ? "rgba(129, 196, 137, 0.16)" : "rgba(227, 251, 168, 0.22)");
    centerGlow.addColorStop(0.5, nightMode ? "rgba(114, 202, 187, 0.08)" : "rgba(134, 207, 192, 0.16)");
    centerGlow.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = centerGlow;
    context.fillRect(0, 0, width, height);

    const horizon = context.createLinearGradient(0, height * 0.1, width, height * 0.82);
    horizon.addColorStop(0, nightMode ? "rgba(201, 239, 146, 0.025)" : "rgba(227, 251, 168, 0.08)");
    horizon.addColorStop(0.46, nightMode ? "rgba(114, 202, 187, 0.08)" : "rgba(134, 207, 192, 0.11)");
    horizon.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = horizon;
    context.fillRect(0, 0, width, height);
  }

  function draw(time = 0) {
    if (!reduceMotion && time - lastFrameTime < 30) {
      requestAnimationFrame(draw);
      return;
    }

    lastFrameTime = time;
    const nightMode = document.documentElement.dataset.theme === "night";
    context.clearRect(0, 0, width, height);
    drawAmbientGlow(time, nightMode);

    mouse.currentX += (mouse.targetX - mouse.currentX) * 0.035;
    mouse.currentY += (mouse.targetY - mouse.currentY) * 0.035;
    particles.forEach((particle) => updateWaveParticle(particle, time));

    context.save();
    context.lineCap = "round";
    lines.forEach(([first, second]) => {
      if (first.alpha <= 0 || second.alpha <= 0) return;
      const dx = first.x2d - second.x2d;
      const dy = first.y2d - second.y2d;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > 38000) return;

      const averageValue = (first.colorValue + second.colorValue) / 2;
      const lineAlpha = Math.min(first.alpha, second.alpha) * (0.18 + averageValue * 0.58);
      if (lineAlpha < 0.018) return;

      const gradient = context.createLinearGradient(first.x2d, first.y2d, second.x2d, second.y2d);
      gradient.addColorStop(0, waveColor(first.colorValue, lineAlpha, nightMode));
      gradient.addColorStop(1, waveColor(second.colorValue, lineAlpha * 0.92, nightMode));

      context.beginPath();
      context.moveTo(first.x2d, first.y2d);
      context.quadraticCurveTo(
        (first.x2d + second.x2d) / 2,
        (first.y2d + second.y2d) / 2 + 28 * Math.min(first.scale, second.scale),
        second.x2d,
        second.y2d
      );
      context.lineWidth = 0.55 + Math.min(first.scale, second.scale) * (1 + averageValue * 2.6);
      context.strokeStyle = gradient;
      context.stroke();
    });
    context.restore();

    particles.forEach((particle) => {
      if (particle.alpha < 0.04) return;
      context.beginPath();
      context.arc(particle.x2d, particle.y2d, particle.size * particle.scale, 0, Math.PI * 2);
      context.fillStyle = waveColor(particle.colorValue, particle.alpha * 0.82, nightMode);
      context.fill();
    });

    if (!reduceMotion) requestAnimationFrame(draw);
  }

  resize();
  window.addEventListener("resize", resize);
  draw();
}

function loadEntries() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function loadChat() {
  try {
    return JSON.parse(localStorage.getItem(CHAT_KEY)) || {};
  } catch {
    return {};
  }
}

function persistEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
}

function persistChat() {
  localStorage.setItem(CHAT_KEY, JSON.stringify(state.chat));
}

function flashButton(button, text) {
  const original = button.textContent;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function parseLocalDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLongDate(value) {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(parseLocalDate(value));
}
