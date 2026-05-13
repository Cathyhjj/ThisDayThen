const STORAGE_KEY = "this-day-then.entries.v1";
const CHAT_KEY = "this-day-then.chat.v1";
const THEME_KEY = "this-day-then.theme.v1";

const state = {
  selectedDate: toDateInputValue(new Date()),
  entries: loadEntries(),
  chat: loadChat(),
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
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  elements.dateInput.addEventListener("change", (event) => {
    state.selectedDate = event.target.value;
    ensureChatForDate();
    render();
  });

  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = elements.messageInput.value.trim();
    if (!text) return;

    currentChat().push({ role: "user", text, at: new Date().toISOString() });
    elements.messageInput.value = "";
    const nextPrompt = prompts[Math.min(countUserMessages(), prompts.length - 1)];
    currentChat().push({ role: "bot", text: nextPrompt, at: new Date().toISOString() });
    persistChat();
    renderMessages();
  });

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
}

function renderMessages() {
  elements.messages.innerHTML = "";
  currentChat().forEach((message) => {
    const bubble = document.createElement("div");
    bubble.className = `message ${message.role}`;
    bubble.textContent = message.text;
    elements.messages.appendChild(bubble);
  });
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
          ? "Write today, then save the five lines here."
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
      state.selectedDate = entry.date;
      ensureChatForDate();
      switchView("timeline");
      render();
    });

    item.append(meta, linesToList(entry.summary), button);
    elements.archiveList.appendChild(item);
  });
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
  state.chat[state.selectedDate] = [
    { role: "bot", text: prompts[0], at: new Date().toISOString() },
  ];
  persistChat();
  renderMessages();
}

function addDemoMemories() {
  demoEntries.forEach((entry) => {
    if (!state.entries[entry.date]) state.entries[entry.date] = entry;
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
    state.chat[state.selectedDate] = [
      { role: "bot", text: prompts[0], at: new Date().toISOString() },
    ];
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
  const placeMatch = text.match(/\b(home|office|train|kitchen|park|street|cafe|school|studio|airport|room)\b/i);
  const lower = text.toLowerCase();

  let anchor = "A small ordinary moment";
  if (lower.includes("walk")) anchor = "The walk";
  else if (lower.includes("conversation") || lower.includes("talked") || lower.includes("message")) anchor = "The conversation";
  else if (lower.includes("work")) anchor = "The shape of the workday";
  else if (lower.includes("coffee")) anchor = "A small coffee moment";
  else if (lower.includes("rain")) anchor = "The weather";

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
  if (/(new|begin|first|change|move)/.test(lower)) return "new, uncertain, and alive";
  return "ordinary in a way that deserves remembering";
}

function inferThemes(text) {
  const lower = text.toLowerCase();
  const themes = [];
  if (/(home|family|mom|dad|sister|brother)/.test(lower)) themes.push("home and belonging");
  if (/(work|meeting|client|deadline|project)/.test(lower)) themes.push("work and becoming");
  if (/(tired|rest|sleep|energy|quiet)/.test(lower)) themes.push("energy and rest");
  if (/(friend|partner|message|conversation)/.test(lower)) themes.push("connection");
  if (/(new|begin|change|city|route)/.test(lower)) themes.push("change");
  return themes.length ? themes.slice(0, 3).join(", ") : "ordinary tenderness";
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
