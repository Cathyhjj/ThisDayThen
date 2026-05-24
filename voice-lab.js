const fallbackVoices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];

const elements = {
  voiceList: document.querySelector("#voiceList"),
  stylePrompt: document.querySelector("#stylePrompt"),
  startSession: document.querySelector("#startSession"),
  stopSession: document.querySelector("#stopSession"),
  sessionStatus: document.querySelector("#sessionStatus"),
  monitorStatus: document.querySelector(".monitor-status"),
  transcriptFeed: document.querySelector("#transcriptFeed"),
};

const state = {
  voices: fallbackVoices,
  recommended: new Set(["marin", "cedar"]),
  selectedVoice: "alloy",
  peerConnection: null,
  dataChannel: null,
  stream: null,
  audio: null,
  draftNodes: new Map(),
  live: false,
};

init();

function init() {
  elements.startSession.addEventListener("click", startSession);
  elements.stopSession.addEventListener("click", () => stopSession("Stopped."));
  window.addEventListener("beforeunload", () => stopSession("", false));
  loadVoices();
  appendFeed("System", "Pick a voice, adjust the personality, then start a live Realtime test.");
}

async function loadVoices() {
  try {
    const response = await fetch("/api/realtime-voices");
    if (!response.ok) throw new Error("Could not load voices.");
    const data = await response.json();
    state.voices = Array.isArray(data.voices) && data.voices.length ? data.voices : fallbackVoices;
    state.recommended = new Set(Array.isArray(data.recommended) ? data.recommended : ["marin", "cedar"]);
    state.selectedVoice = state.voices.includes("alloy")
      ? "alloy"
      : state.voices.includes(data.defaultVoice)
        ? data.defaultVoice
        : state.voices[0];
  } catch (error) {
    console.warn("Using fallback Realtime voices.", error);
  }

  renderVoices();
}

function renderVoices() {
  elements.voiceList.innerHTML = "";

  state.voices.forEach((voice) => {
    const option = document.createElement("button");
    option.className = "voice-option";
    option.type = "button";
    option.role = "radio";
    option.dataset.voice = voice;
    option.setAttribute("aria-checked", String(voice === state.selectedVoice));

    const name = document.createElement("span");
    name.className = "voice-name";
    name.textContent = voice;
    option.appendChild(name);

    if (state.recommended.has(voice)) {
      const badge = document.createElement("span");
      badge.className = "voice-badge";
      badge.textContent = "Best";
      option.appendChild(badge);
    }

    option.addEventListener("click", () => selectVoice(voice));
    elements.voiceList.appendChild(option);
  });
}

function selectVoice(voice) {
  if (state.live) return;
  state.selectedVoice = voice;
  renderVoices();
}

async function startSession() {
  if (state.live) return;

  if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
    setStatus("error", "This browser does not support live Realtime audio.");
    return;
  }

  setControls(true);
  setStatus("connecting", "Opening microphone...");

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    state.peerConnection = new RTCPeerConnection();
    state.audio = document.createElement("audio");
    state.audio.autoplay = true;
    state.audio.hidden = true;
    state.audio.setAttribute("playsinline", "true");
    document.body.appendChild(state.audio);

    state.peerConnection.ontrack = (event) => {
      state.audio.srcObject = event.streams[0];
      state.audio.play().catch((error) => {
        console.warn("Realtime playback was blocked.", error);
        appendFeed("System", "Connected, but the browser blocked autoplay. Keep the tab active and try speaking.");
      });
    };

    state.peerConnection.addEventListener("connectionstatechange", () => {
      if (state.peerConnection?.connectionState === "connected") {
        setStatus("live", "Connected. Just talk naturally.");
      }
      if (["failed", "disconnected", "closed"].includes(state.peerConnection?.connectionState)) {
        if (state.live) setStatus("error", "The Realtime connection closed.");
      }
    });

    state.stream.getAudioTracks().forEach((track) => {
      state.peerConnection.addTrack(track, state.stream);
    });

    state.dataChannel = state.peerConnection.createDataChannel("oai-events");
    state.dataChannel.addEventListener("open", () => {
      state.live = true;
      setControls(true);
      setStatus("live", `Live with ${state.selectedVoice}.`);
      appendFeed("System", `Started a ${state.selectedVoice} voice test.`);
      sendRealtimeEvent(createOpeningEvent());
    });
    state.dataChannel.addEventListener("message", (event) => handleRealtimeEvent(event.data));
    state.dataChannel.addEventListener("close", () => {
      if (state.live) setStatus("idle", "Session closed.");
    });

    const offer = await state.peerConnection.createOffer();
    await state.peerConnection.setLocalDescription(offer);

    const params = new URLSearchParams({
      voice: state.selectedVoice,
      mode: "lab",
    });
    const style = elements.stylePrompt.value.trim();
    if (style) params.set("style", style);

    const response = await fetch(`/api/realtime-session?${params.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });

    if (!response.ok) {
      throw new Error((await response.text()) || "Realtime session could not start.");
    }

    await state.peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    });
  } catch (error) {
    console.warn("Realtime voice lab failed.", error);
    stopSession("", false);
    setStatus("error", cleanError(error));
    appendFeed("System", cleanError(error));
  }
}

function stopSession(message = "Stopped.", resetStatus = true) {
  state.dataChannel?.close();
  state.peerConnection?.close();
  state.stream?.getTracks().forEach((track) => track.stop());
  state.audio?.remove();

  state.peerConnection = null;
  state.dataChannel = null;
  state.stream = null;
  state.audio = null;
  state.live = false;
  state.draftNodes.clear();

  setControls(false);
  if (resetStatus) setStatus("idle", "Ready");
  if (message) appendFeed("System", message);
}

function createOpeningEvent() {
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      max_output_tokens: 120,
      instructions:
        `You are using the ${state.selectedVoice} voice. Start with one short, friendly greeting and ask what the tester wants to try with this voice.`,
    },
  };
}

function sendRealtimeEvent(event) {
  if (state.dataChannel?.readyState !== "open") return;
  state.dataChannel.send(JSON.stringify(event));
}

function handleRealtimeEvent(rawEvent) {
  let event;
  try {
    event = JSON.parse(rawEvent);
  } catch {
    return;
  }

  if (event.type === "error") {
    const message = event.error?.message || "Realtime returned an error.";
    setStatus("error", message);
    appendFeed("System", message);
    return;
  }

  if (event.type === "session.created") {
    setStatus("live", "Session ready.");
    return;
  }

  if (event.type === "input_audio_buffer.speech_started") {
    setStatus("live", "Listening...");
    return;
  }

  if (event.type === "input_audio_buffer.speech_stopped") {
    setStatus("connecting", "Thinking...");
    return;
  }

  if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
    setStatus("live", "Speaking...");
    return;
  }

  if (event.type === "response.done" || event.type === "response.audio.done") {
    setStatus("live", "Listening.");
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
    finalizeDraft(`you:${event.item_id || "latest"}`, "You", event.transcript.trim());
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
    updateDraft(`you:${event.item_id || "latest"}`, "You", event.delta, true);
    return;
  }

  if (event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") {
    updateDraft(event.response_id || event.item_id || "assistant", "AI", event.delta || "", true);
    return;
  }

  if (event.type === "response.audio_transcript.done" || event.type === "response.output_audio_transcript.done") {
    finalizeDraft(event.response_id || event.item_id || "assistant", "AI", event.transcript || "");
    return;
  }

  if (event.type === "response.output_item.done") {
    appendAssistantItem(event.item);
  }
}

function updateDraft(key, role, delta, shouldAppend = false) {
  if (!delta) return;
  let draft = state.draftNodes.get(key);
  if (!draft) {
    const item = createFeedItem(role, "");
    item.classList.add("is-draft");
    elements.transcriptFeed.appendChild(item);
    draft = {
      item,
      textNode: item.querySelector(".feed-text"),
      text: "",
    };
    state.draftNodes.set(key, draft);
  }

  draft.text = shouldAppend ? `${draft.text}${delta}` : delta;
  draft.textNode.textContent = draft.text;
  scrollFeed();
}

function finalizeDraft(key, role, fallbackText = "") {
  const draft = state.draftNodes.get(key);
  const text = (fallbackText || draft?.text || "").trim();
  if (!text) return;

  if (draft) {
    draft.item.classList.remove("is-draft");
    draft.textNode.textContent = text;
    state.draftNodes.delete(key);
  } else {
    appendFeed(role, text);
  }
}

function appendAssistantItem(item) {
  if (item?.role !== "assistant" || !Array.isArray(item.content)) return;
  const text = item.content
    .map((content) => content?.transcript || content?.text || "")
    .join(" ")
    .trim();
  if (text) appendFeed("AI", text);
}

function appendFeed(role, text) {
  const cleanText = String(text || "").trim();
  if (!cleanText) return;
  const last = elements.transcriptFeed.lastElementChild;
  if (
    last?.querySelector(".feed-role")?.textContent === role &&
    last?.querySelector(".feed-text")?.textContent === cleanText
  ) {
    return;
  }
  elements.transcriptFeed.appendChild(createFeedItem(role, cleanText));
  scrollFeed();
}

function createFeedItem(role, text) {
  const item = document.createElement("article");
  item.className = "feed-item";

  const roleNode = document.createElement("div");
  roleNode.className = "feed-role";
  roleNode.textContent = role;

  const textNode = document.createElement("div");
  textNode.className = "feed-text";
  textNode.textContent = text;

  item.append(roleNode, textNode);
  return item;
}

function setControls(isConnectingOrLive) {
  elements.startSession.disabled = isConnectingOrLive;
  elements.stopSession.disabled = !isConnectingOrLive;
  elements.stylePrompt.disabled = isConnectingOrLive;
  elements.voiceList.querySelectorAll("button").forEach((button) => {
    button.disabled = isConnectingOrLive;
  });
}

function setStatus(status, text) {
  elements.monitorStatus.dataset.state = status;
  elements.sessionStatus.textContent = text;
}

function scrollFeed() {
  elements.transcriptFeed.scrollTop = elements.transcriptFeed.scrollHeight;
}

function cleanError(error) {
  const message = String(error?.message || error || "Realtime session failed.").trim();
  if (message.includes("OPENAI_API_KEY")) {
    return "OpenAI is not configured on this server yet.";
  }
  if (message.includes("unsupported")) {
    return "This voice is not supported by the current Realtime model.";
  }
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}
