const moods = ["energetic", "dark", "upbeat", "calm", "cinematic", "tense", "hopeful", "playful"];
const selectedMoods = new Set();
const audio = new Audio();
audio.preload = "metadata";
audio.setAttribute("playsinline", "");
let current = null;
let jobSignature = "";
let libraryAssets = [];
let playingId = "";
let playingKind = "wav";
let seeking = false;
let busy = false;

const labels = {
  queued: "Queued",
  running: "Generating",
  uploading: "Saving",
  local_ready: "Completed",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function csrf() {
  const match = document.cookie.match(/(?:^|; )studio_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({ ok: false, error: "The studio returned an unreadable response." }));
  if (!response.ok || data.ok === false) {
    const detail = Array.isArray(data.details) ? data.details.join(" ") : "";
    throw new Error(detail || data.error || "Request failed");
  }
  return data;
}

function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf() },
    body: JSON.stringify(body),
  });
}

function titleOf(asset) {
  const text = (asset.prompt || "Untitled track").replace(/\s+/g, " ").trim();
  const sentence = text.split(/[.!?]/)[0];
  return sentence.length > 78 ? sentence.slice(0, 77).trim() + "…" : sentence;
}

function when(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function clockFrom(start, end) {
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return hours + ":" + String(minutes % 60).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  return minutes + ":" + String(seconds % 60).padStart(2, "0");
}

function clock(iso) {
  const start = Date.parse(iso);
  if (!iso || Number.isNaN(start)) return "";
  return clockFrom(start, Date.now());
}

function took(job) {
  const start = Date.parse(job.started_at || job.created_at || "");
  const end = Date.parse(job.finished_at || "");
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
  return "took " + clockFrom(start, end);
}

function activeJob(job) {
  return job.state === "queued" || job.state === "running" || job.state === "uploading";
}

function show(tab) {
  for (const name of ["generate", "queue", "library"]) {
    const section = document.getElementById(name);
    const open = name === tab;
    section.hidden = !open;
    section.classList.toggle("is-open", open);
  }
  document.querySelectorAll(".tabs button").forEach((button) => {
    const open = button.dataset.tab === tab;
    button.classList.toggle("active", open);
    button.setAttribute("aria-selected", open ? "true" : "false");
  });
  if (tab === "queue") loadJobs();
  if (tab === "library") loadLibrary();
}

function formStatus(message, bad) {
  const node = document.getElementById("form-status");
  node.textContent = message;
  node.className = "status " + (bad ? "error" : "ok");
}

function buildMoods() {
  const box = document.getElementById("moods");
  for (const mood of moods) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = mood;
    button.addEventListener("click", () => {
      if (selectedMoods.has(mood)) selectedMoods.delete(mood);
      else selectedMoods.add(mood);
      button.classList.toggle("on", selectedMoods.has(mood));
    });
    box.appendChild(button);
  }
}

async function submitGeneration(event) {
  event.preventDefault();
  if (busy) return;
  const prompt = document.getElementById("prompt").value.trim();
  const bpmText = document.getElementById("bpm").value.trim();
  if (prompt.length < 8) {
    formStatus("Describe the music in at least a few words.", true);
    return;
  }
  let bpm = null;
  if (bpmText) {
    bpm = Number(bpmText);
    if (!Number.isInteger(bpm) || bpm < 40 || bpm > 220) {
      formStatus("BPM needs to be a whole number from 40 to 220.", true);
      return;
    }
  }
  const seedText = document.getElementById("seed").value.trim();
  let seed = null;
  if (seedText) {
    seed = Number(seedText);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
      formStatus("Seed needs to be a whole number from 0 to 4294967295.", true);
      return;
    }
  }
  busy = true;
  document.getElementById("generate").disabled = true;
  formStatus("Sending to the local queue…");
  try {
    const data = await post("/api/jobs", {
      prompt,
      duration_seconds: Number(document.getElementById("duration").value),
      genre: document.getElementById("genre").value,
      bpm,
      seed,
      key_scale: document.getElementById("key").value,
      time_signature: document.getElementById("time").value,
      arrangement: document.getElementById("arrangement").checked,
      instrumental: document.getElementById("instrumental").checked,
      mood: [...selectedMoods],
    });
    formStatus(data.job.state === "queued" ? "Queued. This machine generates one track at a time." : "Request saved.");
    show("queue");
  } catch (error) {
    formStatus(error.message, true);
  } finally {
    busy = false;
    document.getElementById("generate").disabled = false;
  }
}

function chip(text, kind) {
  const node = document.createElement("span");
  node.className = "chip " + (kind || "");
  node.textContent = text;
  return node;
}

function jobCard(job) {
  const card = document.createElement("article");
  card.className = "card";
  const top = document.createElement("div");
  top.className = "card-top";
  const heading = document.createElement("h2");
  heading.textContent = titleOf({ prompt: job.prompt || labels[job.state] || "Audio job" });
  top.append(heading, chip(labels[job.state] || job.state, job.state));
  const meta = document.createElement("p");
  meta.className = "meta";
  const prefix = [job.genre, job.duration_seconds ? job.duration_seconds + "s" : ""].filter(Boolean).join(" · ");
  const live = activeJob(job);
  if (live) {
    meta.dataset.live = "1";
    meta.dataset.start = job.started_at || job.created_at || "";
    meta.dataset.prefix = prefix;
  }
  const timing = live ? "elapsed " + clock(meta.dataset.start) : took(job);
  meta.textContent = [prefix, timing].filter(Boolean).join(" · ");
  card.append(top, meta);
  if (job.prompt) {
    const prompt = document.createElement("p");
    prompt.className = "excerpt";
    prompt.textContent = job.prompt;
    card.append(prompt);
  }
  if (live || job.state === "failed") {
    const bar = document.createElement("div");
    bar.className = "bar" + (job.state === "failed" ? " bad" : "");
    bar.append(document.createElement("span"));
    card.append(bar);
  }
  const note = document.createElement("p");
  note.className = "note";
  if (live) {
    note.textContent = job.state === "uploading"
      ? "Saving the finished audio."
      : "Loading and generating. The model does not report a percentage.";
  } else if (job.error) {
    note.className = "error";
    note.textContent = job.error;
  }
  if (note.textContent) card.append(note);
  if (job.state === "queued" || job.state === "running") {
    const actions = document.createElement("div");
    actions.className = "actions";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Cancel";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await post("/api/jobs/" + job.job_id + "/cancel", {});
        loadJobs();
      } catch (error) {
        note.textContent = error.message;
        note.className = "error";
        button.disabled = false;
      }
    });
    actions.append(button);
    card.append(actions);
  }
  return card;
}

async function loadJobs() {
  const box = document.getElementById("jobs");
  try {
    const data = await api("/api/jobs");
    const signature = data.jobs.map((job) => job.job_id + ":" + job.state + ":" + (job.error || "")).join("|");
    if (signature === jobSignature) {
      box.querySelectorAll("[data-live='1']").forEach((node) => {
        if (!node.dataset.start) return;
        node.textContent = [node.dataset.prefix, "elapsed " + clock(node.dataset.start)].filter(Boolean).join(" · ");
      });
      return;
    }
    jobSignature = signature;
    box.replaceChildren();
    if (!data.jobs.length) {
      const empty = document.createElement("p");
      empty.className = "note";
      empty.textContent = "No jobs yet.";
      box.append(empty);
      return;
    }
    for (const job of data.jobs) box.append(jobCard(job));
  } catch (error) {
    box.textContent = error.message;
  }
}

function sourceFor(asset, kind) {
  if (kind === "clean" && asset.local_clean) return "/audio/" + asset.id + ".clean.wav";
  if (kind === "mp3" && asset.local_mp3) return "/audio/" + asset.id + ".mp3";
  return "/audio/" + asset.id;
}

function knownDuration(asset, kind) {
  if (kind === "clean" && asset.clean_duration_seconds) return Number(asset.clean_duration_seconds);
  return Number(asset.duration_seconds) || 0;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
}

function play(asset, kind) {
  current = asset;
  const nextKind = kind || "wav";
  const next = sourceFor(asset, nextKind);
  const url = new URL(next, location.href).href;
  playingId = asset.id;
  playingKind = nextKind;
  if (audio.src !== url) {
    audio.src = next;
    audio.playbackRate = 1;
    const speed = document.getElementById("now-speed");
    if (speed) speed.value = "1";
  }
  showPlayer();
  audio.play().then(showPlayer).catch(showPlayer);
}

function showPlayer() {
  const bar = document.getElementById("now-playing");
  if (!current) {
    bar.hidden = true;
    document.body.classList.remove("has-player");
    return;
  }
  bar.hidden = false;
  document.body.classList.add("has-player");
  document.getElementById("now-title").textContent = titleOf(current);
  document.getElementById("now-sub").textContent = current.genre || (playingKind === "clean" ? "Cleaned" : "Original");
  document.getElementById("now-play").textContent = audio.paused ? "Play" : "Pause";
  const kinds = document.getElementById("now-kinds");
  kinds.hidden = !current.local_clean;
  kinds.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("on", button.dataset.kind === playingKind);
  });
  paintPlayer();
}

function paintPlayer() {
  if (!current) return;
  const duration = Number.isFinite(audio.duration) ? audio.duration : knownDuration(current, playingKind);
  document.getElementById("now-time").textContent = formatTime(audio.currentTime) + " / " + formatTime(duration);
  if (!seeking && duration > 0) {
    document.getElementById("now-seek").value = String(Math.round((audio.currentTime / duration) * 1000));
  }
}

function trackCard(asset) {
  const card = document.createElement("article");
  card.className = "card";
  const top = document.createElement("div");
  top.className = "card-top";
  const heading = document.createElement("h2");
  heading.textContent = titleOf(asset);
  top.append(heading, chip(formatTime(knownDuration(asset, "wav")), "completed"));
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = [
    asset.genre,
    asset.approval_status,
    asset.favorite ? "favorite" : "",
    when(asset.created_at),
  ].filter(Boolean).join(" · ");
  const prompt = document.createElement("p");
  prompt.className = "excerpt";
  prompt.textContent = asset.prompt || "";
  const actions = document.createElement("div");
  actions.className = "actions";
  const listen = document.createElement("button");
  listen.type = "button";
  listen.textContent = "Play";
  listen.addEventListener("click", () => play(asset, "wav"));
  const details = document.createElement("button");
  details.type = "button";
  details.textContent = "Details";
  details.addEventListener("click", () => openDetails(asset));
  actions.append(listen, details);
  card.append(top, meta, prompt, actions);
  return card;
}

async function loadLibrary() {
  const params = new URLSearchParams();
  const q = document.getElementById("search").value.trim();
  const genre = document.getElementById("filter-genre").value;
  if (q) params.set("q", q);
  if (genre) params.set("genre", genre);
  if (document.getElementById("filter-favorite").checked) params.set("favorite", "1");
  const box = document.getElementById("tracks");
  try {
    const data = await api("/api/library?" + params.toString());
    box.replaceChildren();
    libraryAssets = data.assets || [];
    if (!data.assets.length) {
      const empty = document.createElement("p");
      empty.className = "note";
      empty.textContent = "No tracks match.";
      box.append(empty);
      return;
    }
    for (const asset of data.assets) box.append(trackCard(asset));
  } catch (error) {
    box.textContent = error.message;
  }
}

function openDetails(asset) {
  current = asset;
  const panel = document.getElementById("details");
  panel.hidden = false;
  panel.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = titleOf(asset);
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = [
    asset.genre,
    (asset.mood || []).join(", "),
    "created " + when(asset.created_at),
  ].filter(Boolean).join(" · ");
  panel.append(heading, meta);
  const silence = document.createElement("p");
  silence.className = "note";
  if (asset.silence_start_seconds != null && asset.silence_end_seconds != null) {
    const start = Number(asset.silence_start_seconds).toFixed(2);
    const end = Number(asset.silence_end_seconds).toFixed(2);
    silence.textContent = asset.local_clean
      ? `Trailing silence detected from ${start}s to ${end}s. A separate cleaned copy is available. The original file is unchanged.`
      : `A quiet tail was measured from ${start}s to ${end}s and was left in the original. ${asset.listening_note || ""}`;
  } else {
    silence.textContent = asset.listening_note || "No separate cleaned copy for this track. The original is the file that was generated.";
  }
  panel.append(silence);
  const full = document.createElement("details");
  full.open = true;
  const summary = document.createElement("summary");
  summary.textContent = "Full prompt";
  const prompt = document.createElement("p");
  prompt.className = "prompt";
  prompt.textContent = asset.prompt || "";
  full.append(summary, prompt);
  const settings = document.createElement("p");
  settings.className = "meta";
  const metrics = (asset && {}) || {};
  settings.textContent = [
    "Model " + (asset.model || "unknown"),
    "Seed " + (asset.seed || "random"),
    asset.bpm ? asset.bpm + " BPM" : "",
    asset.musical_key || "",
    asset.time_signature ? ({ "2": "2/4", "3": "3/4", "4": "4/4", "6": "6/8" }[asset.time_signature] || asset.time_signature) : "",
    asset.arrangement === "song" ? "Section guidance" : "",
    "8 steps",
    "Fast Turbo",
    "Generator " + (asset.generator || ""),
    asset.duration_seconds ? "Stored duration " + asset.duration_seconds + "s" : "",
    asset.clean_duration_seconds ? "Cleaned duration " + Number(asset.clean_duration_seconds).toFixed(2) + "s" : "",
    asset.sha256 ? "SHA-256 " + asset.sha256.slice(0, 12) : "",
    asset.size_bytes ? asset.size_bytes + " bytes" : "",
  ].filter(Boolean).join(" · ");
  panel.append(full, settings);
  const others = libraryAssets.filter((item) => item.id !== asset.id);
  if (others.length) {
    const compare = document.createElement("div");
    compare.className = "actions";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Track to compare");
    for (const item of others) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = titleOf(item);
      select.append(option);
    }
    const playOther = document.createElement("button");
    playOther.type = "button";
    playOther.textContent = "Play comparison";
    playOther.addEventListener("click", () => {
      const chosen = libraryAssets.find((item) => item.id === select.value);
      if (chosen) play(chosen, "wav");
    });
    const playThis = document.createElement("button");
    playThis.type = "button";
    playThis.textContent = "Play this track";
    playThis.addEventListener("click", () => play(asset, "wav"));
    compare.append(select, playOther, playThis);
    panel.append(compare);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    linkButton("Download WAV", "/audio/" + asset.id + "?download=1"),
  );
  if (asset.local_mp3) actions.append(linkButton("Download MP3", "/audio/" + asset.id + ".mp3?download=1"));
  const approve = document.createElement("button");
  approve.type = "button";
  approve.textContent = asset.approval_status === "approved" ? "Approved for reuse" : "Approve for reuse";
  approve.addEventListener("click", () => changeAsset(asset, "/approval", { approved: asset.approval_status !== "approved" }));
  const favorite = document.createElement("button");
  favorite.type = "button";
  favorite.textContent = asset.favorite ? "Favorited" : "Favorite";
  favorite.addEventListener("click", () => changeAsset(asset, "/favorite", { favorite: !asset.favorite }));
  const reusePrompt = document.createElement("button");
  reusePrompt.type = "button";
  reusePrompt.textContent = "Use prompt";
  reusePrompt.addEventListener("click", () => {
    document.getElementById("prompt").value = asset.prompt || "";
    if (asset.genre) document.getElementById("genre").value = asset.genre;
    show("generate");
  });
  actions.append(approve, favorite, reusePrompt);
  if (asset.approval_status === "approved") {
    const reuse = document.createElement("button");
    reuse.type = "button";
    reuse.textContent = "Reuse this track";
    reuse.addEventListener("click", async () => {
      reuse.disabled = true;
      try {
        await post("/api/jobs", { reuse_asset_id: asset.id, prompt: asset.prompt, genre: asset.genre, duration_seconds: asset.duration_seconds });
        show("queue");
      } catch (error) {
        silence.textContent = error.message;
        reuse.disabled = false;
      }
    });
    actions.append(reuse);
  }
  panel.append(actions);
  const speedNote = document.createElement("p");
  speedNote.className = "note";
  speedNote.textContent = "1× plays the file as generated. Other speeds use the browser playback rate, which changes pitch and can sound thin or metallic. That is the player, not a fix for the recording.";
  panel.append(speedNote);
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  void metrics;
}

function linkButton(text, href) {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = text;
  return link;
}

async function changeAsset(asset, suffix, body) {
  try {
    const data = await post("/api/library/" + asset.id + suffix, body);
    openDetails(data.asset);
    loadLibrary();
  } catch (error) {
    const panel = document.getElementById("details");
    const note = document.createElement("p");
    note.className = "error";
    note.textContent = error.message;
    panel.append(note);
  }
}

function bindPlayer() {
  document.getElementById("now-play").addEventListener("click", () => {
    if (!current) return;
    if (audio.paused) play(current, playingKind);
    else {
      audio.pause();
      showPlayer();
    }
  });
  document.getElementById("now-title").addEventListener("click", () => {
    if (!current) return;
    show("library");
    openDetails(current);
  });
  document.getElementById("now-kinds").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || !current) return;
    play(current, button.dataset.kind);
  });
  document.getElementById("now-speed").addEventListener("change", (event) => {
    audio.playbackRate = Number(event.target.value);
  });
  const seek = document.getElementById("now-seek");
  seek.addEventListener("pointerdown", () => { seeking = true; });
  seek.addEventListener("input", () => {
    seeking = true;
    const duration = Number.isFinite(audio.duration) ? audio.duration : knownDuration(current || {}, playingKind);
    if (duration > 0) audio.currentTime = duration * (Number(seek.value) / 1000);
    paintPlayer();
  });
  seek.addEventListener("change", () => { seeking = false; });
  seek.addEventListener("pointerup", () => { seeking = false; });
  audio.ontimeupdate = paintPlayer;
  audio.onloadedmetadata = paintPlayer;
  audio.onplay = showPlayer;
  audio.onpause = showPlayer;
  audio.onended = showPlayer;
}

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => show(button.dataset.tab));
});
document.getElementById("compose").addEventListener("submit", submitGeneration);
document.getElementById("search").addEventListener("input", () => loadLibrary());
document.getElementById("filter-genre").addEventListener("change", () => loadLibrary());
document.getElementById("filter-favorite").addEventListener("change", () => loadLibrary());
buildMoods();
bindPlayer();
loadLibrary();
setInterval(() => {
  if (!document.getElementById("queue").hidden) loadJobs();
}, 2500);
