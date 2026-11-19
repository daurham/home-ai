/* Home AI Music Studio — library-first client. No external JS dependencies. */
"use strict";

const audio = new Audio();
audio.preload = "metadata";
audio.setAttribute("playsinline", "");
audio.volume = .85;

let libraryAssets = [];
let visibleAssets = [];
let activeJobs = [];
let labItems = [];
let labLoaded = false;
let current = null;
let playingKind = "wav";
let seeking = false;
let busy = false;
let lastActive = "";
let libraryRequest = 0;
let searchTimer = 0;
let previousFocus = null;

const $ = (id) => document.getElementById(id);
const stateLabels = {
  queued: "Waiting", running: "Generating", uploading: "Saving",
  completed: "Finished", local_ready: "Finished",
  cancelled: "Cancelled", failed: "Failed",
};
const categoryLabels = { cinematic: "Cinematic", ambient: "Ambient", synthwave: "Synthwave", other: "General" };

function el(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = String(text);
  return node;
}
function pad(n) { return String(n).padStart(2, "0"); }
function formatTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "0:00";
  const s = Math.floor(n);
  return Math.floor(s / 60) + ":" + pad(s % 60);
}
function shortDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function elapsed(value) {
  const start = Date.parse(value || "");
  if (!Number.isFinite(start)) return "";
  const delta = Math.max(0, Math.floor((Date.now() - start) / 1000));
  return formatTime(delta);
}
function titleOf(asset) {
  const raw = String(asset.prompt || "").replace(/\s+/g, " ").trim();
  if (!raw) return "Untitled track";
  const intro = raw.split(/[.!?]/)[0].trim();
  const words = intro.split(" ");
  const label = words.length > 9 ? words.slice(0, 9).join(" ") + "…" : intro;
  return label.length > 72 ? label.slice(0, 71).trim() + "…" : label;
}
function categoryOf(asset) { return categoryLabels[asset.genre] || "Music"; }
function soundFor(asset, kind) {
  const key = encodeURIComponent(asset.id);
  if (kind === "clean" && asset.local_clean) return "/audio/" + key + ".clean.wav";
  if (kind === "mp3" && asset.local_mp3) return "/audio/" + key + ".mp3";
  return "/audio/" + key;
}
function playbackDuration(asset, kind) {
  if (kind === "clean" && asset.clean_duration_seconds) return Number(asset.clean_duration_seconds);
  return Number(asset.duration_seconds) || 0;
}
function csrf() {
  const part = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith("studio_csrf="));
  return part ? decodeURIComponent(part.slice("studio_csrf=".length)) : "";
}
async function api(path, options) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
  const data = await response.json().catch(() => ({ ok: false, error: "Unexpected response from Music Studio." }));
  if (!response.ok || data.ok === false) {
    const details = Array.isArray(data.details) ? data.details.join(" ") : "";
    throw new Error(details || data.error || "Request failed");
  }
  return data;
}
function post(path, payload) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf() },
    body: JSON.stringify(payload),
  });
}
function message(text, bad = false) {
  $("form-status").textContent = text;
  $("form-status").classList.toggle("error", bad);
}
function toggleCompose(force) {
  const panel = $("composer-shell");
  const willOpen = typeof force === "boolean" ? force : panel.hidden;
  panel.hidden = !willOpen;
  $("toggle-compose").setAttribute("aria-expanded", String(willOpen));
  $("toggle-compose").innerHTML = willOpen
    ? '<span aria-hidden="true">×</span> Close creator'
    : '<span class="button-plus" aria-hidden="true">+</span> Create music';
  if (willOpen) {
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    $("prompt").focus({ preventScroll: true });
  }
}

function sortAndFilter(assets) {
  const query = $("search").value.trim().toLowerCase();
  const genre = $("filter-genre").value;
  const favorites = $("filter-favorite").checked;
  const matches = assets.filter((asset) => {
    if (genre && asset.genre !== genre) return false;
    if (favorites && !asset.favorite) return false;
    if (!query) return true;
    return [asset.prompt, asset.genre, asset.episode, asset.id, ...(asset.tags || [])].join(" ").toLowerCase().includes(query);
  });
  const sort = $("sort-tracks").value;
  matches.sort((a, b) => {
    if (sort === "name") return titleOf(a).localeCompare(titleOf(b));
    if (sort === "duration") return Number(a.duration_seconds || 0) - Number(b.duration_seconds || 0);
    if (sort === "duration-desc") return Number(b.duration_seconds || 0) - Number(a.duration_seconds || 0);
    const timeA = Date.parse(a.created_at || "") || 0;
    const timeB = Date.parse(b.created_at || "") || 0;
    return sort === "oldest" ? timeA - timeB : timeB - timeA;
  });
  return matches;
}
function selectedRow() {
  document.querySelectorAll("#tracks tr").forEach((row) => {
    const on = current && row.dataset.asset === current.id;
    row.classList.toggle("selected", Boolean(on));
    row.setAttribute("aria-selected", String(Boolean(on)));
    const btn = row.querySelector(".track-play");
    if (btn) {
      btn.textContent = on && !audio.paused ? "Ⅱ" : "▶";
      btn.setAttribute("aria-label", on && !audio.paused ? "Pause track" : "Play track");
    }
  });
}
function renderLibrary() {
  const box = $("tracks");
  box.replaceChildren();
  visibleAssets = sortAndFilter(libraryAssets);
  $("tracks-count").textContent = visibleAssets.length;
  $("library-message").hidden = visibleAssets.length > 0;
  if (!visibleAssets.length) {
    $("library-message").textContent = libraryAssets.length
      ? "No tracks match these filters. Try a different search."
      : "Your library is empty. Create your first track to get started.";
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const asset of visibleAssets) {
    const row = el("tr");
    row.tabIndex = 0;
    row.dataset.asset = asset.id;
    row.title = "Play " + titleOf(asset);
    const playCell = el("td");
    const playButton = el("button", "track-play", "▶");
    playButton.type = "button";
    playButton.setAttribute("aria-label", "Play " + titleOf(asset));
    playButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (current && current.id === asset.id && !audio.paused) audio.pause();
      else selectTrack(asset);
    });
    playCell.append(playButton);
    const nameCell = el("td");
    const name = el("span", "track-name", titleOf(asset));
    const sub = el("span", "track-secondary", asset.approval_status === "approved" ? "Approved for reuse" : "Generated audio");
    if (asset.favorite) sub.append(el("span", "favorite-star", "★"));
    nameCell.append(name, sub);
    const cat = el("td", "col-category");
    cat.append(el("span", "track-category", categoryOf(asset)));
    const date = el("td", "col-date");
    date.append(el("span", "track-date", shortDate(asset.created_at)));
    const len = el("td", "col-time", formatTime(asset.local_clean ? asset.clean_duration_seconds : asset.duration_seconds));
    const actions = el("td", "col-actions");
    const more = el("button", "track-more", "···");
    more.type = "button";
    more.setAttribute("aria-label", "Details for " + titleOf(asset));
    more.addEventListener("click", (event) => { event.stopPropagation(); openDetails(asset); });
    actions.append(more);
    row.append(playCell, nameCell, cat, date, len, actions);
    row.addEventListener("click", () => selectTrack(asset));
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectTrack(asset); }
    });
    fragment.append(row);
  }
  box.append(fragment);
  selectedRow();
}
async function loadLibrary() {
  const requestId = ++libraryRequest;
  try {
    const data = await api("/api/library");
    if (requestId !== libraryRequest) return;
    libraryAssets = data.assets || [];
    if (current && current.id) {
      const updated = libraryAssets.find((asset) => asset.id === current.id);
      if (updated) current = updated;
    }
    renderLibrary();
    paintPlayer();
  } catch (error) {
    if (requestId !== libraryRequest) return;
    $("library-message").hidden = false;
    $("library-message").textContent = "Couldn't load your library: " + error.message;
  }
}
function selectTrack(asset, kind = null) {
  const newKind = kind || (asset.local_clean ? "clean" : "wav");
  const sameAsset = current && current.id === asset.id;
  const sameKind = sameAsset && newKind === playingKind;
  if (sameKind && !audio.paused) {
    selectedRow();
    return;
  }
  const retainedTime = sameAsset && !sameKind ? audio.currentTime : 0;
  current = asset;
  playingKind = newKind;
  const nextSrc = new URL(soundFor(asset, newKind), location.href).href;
  if (audio.src !== nextSrc) {
    audio.src = nextSrc;
    audio.load();
    if (retainedTime > 0) {
      audio.addEventListener("loadedmetadata", function restore() {
        audio.removeEventListener("loadedmetadata", restore);
        audio.currentTime = Math.min(retainedTime, Number.isFinite(audio.duration) ? Math.max(0, audio.duration - .05) : retainedTime);
      });
    }
  }
  updatePlayer();
  audio.play().catch(() => updatePlayer());
  selectedRow();
}
function moveTrack(delta, autoplay = true) {
  if (current && current.external_kind) {
    if (current.external_kind !== "lab" || !labItems.length) return;
    const index = labItems.findIndex((item) => item.id === current.id);
    const next = labItems[index + delta];
    if (next && next.available) playLab(next);
    return;
  }
  if (!visibleAssets.length) return;
  const i = current ? visibleAssets.findIndex((a) => a.id === current.id) : -1;
  const next = visibleAssets[Math.max(0, Math.min(visibleAssets.length - 1, i < 0 ? 0 : i + delta))];
  if (!next) return;
  if (autoplay) selectTrack(next);
  else { current = next; updatePlayer(); }
}
function paintPlayer() {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration : current ? playbackDuration(current, playingKind) : 0;
  $("elapsed").textContent = formatTime(audio.currentTime);
  $("duration-display").textContent = formatTime(duration);
  if (!seeking) $("now-seek").value = duration > 0 ? String(Math.min(1000, Math.round((audio.currentTime / duration) * 1000))) : "0";
}
function updatePlayer() {
  const enabled = Boolean(current);
  for (const id of ["now-play", "now-prev", "now-next", "now-seek", "now-title"]) $(id).disabled = !enabled;
  $("now-title").textContent = current ? titleOf(current) : "Nothing playing";
  $("now-sub").textContent = current && audio.error ? "Audio playback failed" : current
    ? current.external_kind === "lab" ? "Quality lab · Not in library"
      : current.external_kind === "reference" ? "Private reference · Not used for generation"
      : categoryOf(current) + " · " + (playingKind === "clean" ? "Cleaned audio" : "Original audio")
    : "Choose a track from your library";
  $("now-play").textContent = audio.paused ? "▶" : "Ⅱ";
  $("now-play").setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  $("now-play").title = audio.paused ? "Play" : "Pause";
  const dl = $("now-download");
  if (enabled && !current.external_kind) {
    dl.href = soundFor(current, playingKind) + "?download=1";
    dl.setAttribute("download", "");
    dl.setAttribute("aria-disabled", "false");
  } else {
    dl.removeAttribute("download");
    dl.href = "#";
    dl.setAttribute("aria-disabled", "true");
  }
  paintPlayer();
  selectedRow();
  if (enabled && "mediaSession" in navigator && "MediaMetadata" in window) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: titleOf(current), artist: "Home AI Music Studio", album: current.external_kind ? "Quality lab" : categoryOf(current) });
    navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
  }
}
function div(label, value) {
  const wrap = el("div");
  wrap.append(el("dt", "", label), el("dd", "", String(value == null || value === "" ? "Auto" : value)));
  return wrap;
}
function section(title) {
  const block = el("section", "drawer-section");
  block.append(el("h3", "", title));
  return block;
}
function control(label, handler, style = "") {
  const b = el("button", "button " + style, label);
  b.type = "button";
  b.addEventListener("click", handler);
  return b;
}
function downloadLink(text, src) {
  const a = el("a", "", text);
  a.href = src + "?download=1";
  a.setAttribute("download", "");
  return a;
}
function closeDetails() {
  if ($("drawer-layer").hidden) return;
  $("drawer-layer").hidden = true;
  document.body.style.overflow = "";
  if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
}
function openDetails(asset) {
  const currentAsset = libraryAssets.find((a) => a.id === asset.id) || asset;
  if ($("drawer-layer").hidden) previousFocus = document.activeElement;
  $("drawer-layer").hidden = false;
  document.body.style.overflow = "hidden";
  const root = $("details");
  root.replaceChildren();
  root.append(el("h2", "drawer-title", titleOf(currentAsset)));
  root.append(el("p", "drawer-meta", [categoryOf(currentAsset), formatTime(currentAsset.duration_seconds), shortDate(currentAsset.created_at)].join(" · ")));
  const primary = el("div", "drawer-actions");
  primary.append(control("▶ Play", () => selectTrack(currentAsset), "button-primary"));
  primary.append(control(currentAsset.favorite ? "★ Favorited" : "☆ Favorite", async () => {
    await changeAsset(currentAsset, "/favorite", { favorite: !currentAsset.favorite });
  }));
  root.append(primary);
  if (currentAsset.local_clean) {
    const version = section("Listening version");
    const options = el("div", "drawer-actions");
    options.append(
      control("Original · " + formatTime(currentAsset.duration_seconds), () => selectTrack(currentAsset, "wav")),
      control("Cleaned · " + formatTime(currentAsset.clean_duration_seconds), () => selectTrack(currentAsset, "clean"))
    );
    version.append(options, el("p", "help-text", "The cleaned file only removes detected trailing silence. Your original is preserved."));
    root.append(version);
  }
  const prompt = section("Full generation prompt");
  prompt.append(el("p", "drawer-prompt", currentAsset.prompt || "No prompt recorded."));
  root.append(prompt);
  const info = section("Track information");
  const grid = el("dl", "detail-grid");
  grid.append(
    div("Model", currentAsset.model || "Unknown"),
    div("Seed", currentAsset.seed || "Random"),
    div("Tempo", currentAsset.bpm ? currentAsset.bpm + " BPM" : ""),
    div("Key", currentAsset.musical_key || ""),
    div("Time", currentAsset.time_signature ? ({ "4": "4/4", "3": "3/4", "2": "2/4", "6": "6/8" }[currentAsset.time_signature] || currentAsset.time_signature) : ""),
    div("Created", shortDate(currentAsset.created_at)),
    div("Original length", formatTime(currentAsset.duration_seconds)),
    div("Status", currentAsset.approval_status === "approved" ? "Approved for reuse" : "Not approved for reuse"),
  );
  info.append(grid);
  if (currentAsset.silence_start_seconds != null) {
    info.append(el("p", "drawer-note", "Detected quiet ending from " + Number(currentAsset.silence_start_seconds).toFixed(1) + "s to " + Number(currentAsset.silence_end_seconds).toFixed(1) + "s. The original file is unchanged."));
  }
  root.append(info);
  const actions = section("Actions");
  const buttons = el("div", "drawer-actions");
  buttons.append(control("Use this prompt", () => {
    $("prompt").value = (currentAsset.prompt || "").replace(/\s*Instrumental only, no vocals\.?\s*$/i, "").trim();
    $("genre").value = currentAsset.genre || "other";
    const seconds = String(Math.round(currentAsset.duration_seconds || 30));
    if (Array.from($("duration").options).some((x) => x.value === seconds)) $("duration").value = seconds;
    toggleCompose(true);
    closeDetails();
    $("prompt").focus();
  }));
  buttons.append(control(currentAsset.approval_status === "approved" ? "Revoke reuse approval" : "Approve for reuse", async () => {
    await changeAsset(currentAsset, "/approval", { approved: currentAsset.approval_status !== "approved" });
  }));
  if (currentAsset.approval_status === "approved") {
    buttons.append(control("Reuse audio (no generation)", async () => {
      try {
        await post("/api/jobs", { reuse_asset_id: currentAsset.id, prompt: currentAsset.prompt, genre: currentAsset.genre, duration_seconds: currentAsset.duration_seconds });
        closeDetails();
        await loadJobs();
      } catch (error) { showDetailError(error.message); }
    }));
  }
  actions.append(buttons);
  const links = el("div", "drawer-links");
  links.append(downloadLink("Download original WAV", soundFor(currentAsset, "wav")));
  if (currentAsset.local_clean) links.append(downloadLink("Download cleaned WAV", soundFor(currentAsset, "clean")));
  if (currentAsset.local_mp3) links.append(downloadLink("Download MP3", soundFor(currentAsset, "mp3")));
  actions.append(links);
  root.append(actions);
  if (currentAsset.sha256) root.append(el("p", "help-text", "Original SHA-256: " + currentAsset.sha256));
  $("drawer").focus({ preventScroll: true });
}
function showDetailError(text) { $("details").prepend(el("p", "drawer-notice", text)); }
async function changeAsset(asset, suffix, data) {
  try {
    const updated = await post("/api/library/" + encodeURIComponent(asset.id) + suffix, data);
    libraryAssets = libraryAssets.map((a) => a.id === asset.id ? updated.asset : a);
    if (current && current.id === asset.id) current = updated.asset;
    renderLibrary();
    openDetails(updated.asset);
  } catch (error) { showDetailError(error.message); }
}

function activityJob(job) {
  const row = el("div", "activity-job");
  const text = el("div", "activity-copy");
  text.append(el("span", "activity-title", titleOf({prompt: job.prompt || "New track"})));
  const stage = stateLabels[job.state] || job.state;
  const info = el("span", "activity-meta");
  info.dataset.stage = stage;
  info.dataset.start = job.started_at || job.created_at || "";
  info.textContent = stage + " · " + (job.started_at ? "elapsed " + elapsed(job.started_at) : "waiting");
  text.append(info);
  row.append(text);
  if (job.state === "queued" || job.state === "running") {
    const button = el("button", "activity-cancel", "Cancel");
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await post("/api/jobs/" + job.job_id + "/cancel", {}); await loadJobs(); }
      catch (error) { info.textContent = error.message; button.disabled = false; }
    });
    row.append(button);
  }
  const meter = el("div", "activity-meter");
  meter.setAttribute("role", "progressbar");
  meter.setAttribute("aria-label", stage + " — progress not available");
  meter.removeAttribute("aria-valuenow");
  meter.append(el("span"));
  row.append(meter);
  return row;
}
function renderHistory(jobs) {
  const recent = jobs.slice(0, 8);
  $("history-count").textContent = recent.length ? "(" + recent.length + ")" : "";
  const box = $("history-jobs");
  box.replaceChildren();
  for (const job of recent) {
    const row = el("div", "history-entry" + (job.state === "failed" ? " error" : ""));
    row.append(el("strong", "", titleOf({ prompt: job.prompt || job.state })), el("small", "", stateLabels[job.state] || job.state));
    if (job.error) row.title = job.error;
    box.append(row);
  }
  if (!recent.length) box.append(el("span", "help-text", "No recent activity."));
}
async function loadJobs() {
  try {
    const data = await api("/api/jobs");
    const jobs = data.jobs || [];
    activeJobs = jobs.filter((job) => ["queued", "running", "uploading"].includes(job.state));
    const ids = activeJobs.map((job) => job.job_id + ":" + job.state).join("|");
    const activeSection = $("activity");
    activeSection.hidden = activeJobs.length === 0;
    $("activity-count").textContent = activeJobs.length + (activeJobs.length === 1 ? " job" : " jobs");
    const live = $("active-jobs");
    if (live.dataset.signature !== ids) {
      live.dataset.signature = ids;
      live.replaceChildren();
      activeJobs.forEach((job) => live.append(activityJob(job)));
    } else {
      live.querySelectorAll("[data-start]").forEach((node) => {
        const start = node.dataset.start;
        node.textContent = node.dataset.stage + " · " + (start ? "elapsed " + elapsed(start) : "waiting");
      });
    }
    renderHistory(jobs);
    if (lastActive && lastActive !== ids) await loadLibrary();
    lastActive = ids;
  } catch (error) {
    if (activeJobs.length) $("activity-title").textContent = "Connection to generator interrupted";
  }
}
async function submitGeneration(event) {
  event.preventDefault();
  if (busy) return;
  const prompt = $("prompt").value.trim();
  if (prompt.length < 8) return message("Please describe the music in at least a few words.", true);
  const bpm = $("bpm").value.trim();
  const seed = $("seed").value.trim();
  if (bpm && (!Number.isInteger(Number(bpm)) || Number(bpm) < 40 || Number(bpm) > 220)) {
    return message("Tempo should be between 40 and 220 BPM, or left blank.", true);
  }
  if (seed && (!Number.isInteger(Number(seed)) || Number(seed) < 0 || Number(seed) > 4294967295)) {
    return message("Seed should be a whole number from 0 to 4294967295.", true);
  }
  busy = true;
  $("generate-submit").disabled = true;
  message("Adding to your local generation queue…");
  try {
    const result = await post("/api/jobs", {
      prompt, duration_seconds: Number($("duration").value),
      genre: $("genre").value,
      mood: [],
      instrumental: true,
      bpm: bpm ? Number(bpm) : null,
      seed: seed ? Number(seed) : null,
      key_scale: $("key").value,
      time_signature: $("time").value,
      arrangement: $("arrangement").checked,
    });
    message(result.job.state === "queued" ? "Queued. It will appear in the library when finished." : "Request saved.");
    toggleCompose(false);
    await loadJobs();
  } catch (error) {
    message(error.message, true);
  } finally {
    busy = false;
    $("generate-submit").disabled = false;
  }
}
function bindPlayer() {
  $("now-play").addEventListener("click", () => {
    if (!current) return;
    if (audio.paused) audio.play().catch(updatePlayer);
    else audio.pause();
  });
  $("now-prev").addEventListener("click", () => moveTrack(-1));
  $("now-next").addEventListener("click", () => moveTrack(1));
  $("now-title").addEventListener("click", () => {
    if (!current) return;
    if (current.external_kind) toggleLab(true);
    else { toggleLab(false); openDetails(current); }
  });
  $("now-volume").addEventListener("input", (event) => { audio.volume = Number(event.target.value) / 100; });
  $("now-download").addEventListener("click", (event) => { if (!current) event.preventDefault(); });
  const seek = $("now-seek");
  seek.addEventListener("pointerdown", () => { seeking = true; });
  seek.addEventListener("input", () => {
    if (!current) return;
    seeking = true;
    const duration = Number.isFinite(audio.duration) ? audio.duration : playbackDuration(current, playingKind);
    if (duration > 0) audio.currentTime = duration * (Number(seek.value) / 1000);
    paintPlayer();
  });
  seek.addEventListener("pointerup", () => { seeking = false; });
  seek.addEventListener("change", () => { seeking = false; });
  audio.addEventListener("timeupdate", paintPlayer);
  audio.addEventListener("loadedmetadata", paintPlayer);
  audio.addEventListener("play", updatePlayer);
  audio.addEventListener("pause", updatePlayer);
  audio.addEventListener("ended", () => {
    if (current && current.external_kind) {
      const index = labItems.findIndex((item) => item.id === current.id);
      if (current.external_kind === "lab" && index !== -1 && index < labItems.length - 1) moveTrack(1);
      else updatePlayer();
      return;
    }
    const index = visibleAssets.findIndex((asset) => current && asset.id === current.id);
    if (index !== -1 && index < visibleAssets.length - 1) moveTrack(1);
    else updatePlayer();
  });
  audio.addEventListener("error", () => {
    if (current) {
      $("now-sub").textContent = "This audio couldn't be loaded. Try its MP3 download.";
      updatePlayer();
    }
  });
}
function bindUI() {
  $("toggle-lab").addEventListener("click", () => toggleLab($("lab").hidden));
  $("reference-form").addEventListener("submit", saveReference);
  $("toggle-compose").addEventListener("click", () => toggleCompose());
  $("close-compose").addEventListener("click", () => toggleCompose(false));
  $("compose").addEventListener("submit", submitGeneration);
  $("refresh-library").addEventListener("click", loadLibrary);
  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderLibrary, 180);
  });
  ["filter-genre", "sort-tracks", "filter-favorite"].forEach((id) => $(id).addEventListener("change", renderLibrary));
  $("close-details").addEventListener("click", closeDetails);
  $("drawer-backdrop").addEventListener("click", closeDetails);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("drawer-layer").hidden) closeDetails();
    if (event.key === " " && event.target === document.body && current) {
      event.preventDefault();
      if (audio.paused) audio.play().catch(updatePlayer);
      else audio.pause();
    }
  });
  bindPlayer();
  updatePlayer();
  loadLibrary();
  loadJobs();
  setInterval(loadJobs, 3500);
}
bindUI();


/* Quality Lab is intentionally separate from the approved music library.
   Its sources come only from allowlisted local server endpoints. */
function toggleLab(showLab) {
  $("lab").hidden = !showLab;
  $("library-workspace").hidden = showLab;
  const button = $("toggle-lab");
  button.setAttribute("aria-pressed", String(showLab));
  button.textContent = showLab ? "← Back to library" : "Quality lab";
  if (showLab) {
    if (!labLoaded) void loadLab();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
    void loadLibrary();
  }
}
function safeLabSource(source, type) {
  if (typeof source !== "string") return "";
  if (type === "lab" && /^\/quality-lab\/phase5-[abc]$/.test(source)) return source;
  if (type === "reference" && /^\/references\/ref_[0-9a-f]{16}$/.test(source)) return source;
  return "";
}
function playExternal(source, item, type) {
  const src = safeLabSource(source, type);
  if (!src) return;
  current = {
    id: item.id,
    prompt: type === "lab" ? item.title : item.original_name || "Reference recording",
    genre: "other",
    duration_seconds: type === "lab" ? Number(item.duration_seconds) || 30 : Number(item.seconds) || 0,
    external_src: src,
    external_kind: type,
    local_clean: false,
  };
  playingKind = "wav";
  if (audio.src !== new URL(src, location.href).href) {
    audio.src = src;
    audio.load();
  }
  updatePlayer();
  audio.play().catch(updatePlayer);
}
function playLab(item) { if (item && item.available) playExternal(item.audio, item, "lab"); }
function playReference(item) { if (item && item.audio) playExternal(item.audio, item, "reference"); }
async function loadLab() {
  const box = $("lab-items");
  try {
    const data = await api("/api/quality-lab");
    labItems = data.items || [];
    labLoaded = true;
    box.replaceChildren();
    $("lab-compare").replaceChildren();
    if (!labItems.length) {
      box.append(el("p", "help-text", "No saved comparison recordings were found."));
    }
    for (const item of labItems) {
      const card = el("article", "lab-card");
      card.append(el("span", "lab-tag", item.planner ? "PLANNER TEST" : "TURBO TEST"));
      card.append(el("h2", "", item.title || item.id));
      card.append(el("p", "lab-description", item.summary || ""));
      const metadata = [item.model, item.seed ? "Seed " + item.seed : "",
        item.generation_seconds ? Math.round(item.generation_seconds) + "s generation" : "",
        item.peak_rss_bytes ? (item.peak_rss_bytes / 1e9).toFixed(1) + " GB peak RAM" : ""].filter(Boolean);
      card.append(el("p", "", metadata.join(" · ")));
      const button = control(item.available ? "▶ Play recording" : "Recording unavailable", () => playLab(item));
      button.disabled = !item.available;
      card.append(button);
      box.append(card);
      if (item.available) {
        const quick = el("button", "", "Play " + item.id.split("-").pop().toUpperCase());
        quick.type = "button";
        quick.addEventListener("click", () => playLab(item));
        $("lab-compare").append(quick);
      }
    }
    await loadReferences();
  } catch (error) {
    box.replaceChildren(el("p", "drawer-notice", "Quality lab unavailable: " + error.message));
  }
}
async function loadReferences() {
  const box = $("references");
  try {
    const data = await api("/api/references");
    box.replaceChildren();
    const rows = data.references || [];
    if (!rows.length) { box.append(el("p", "help-text", "No reference recordings saved.")); return; }
    for (const item of rows) {
      const row = el("div", "reference-row");
      const info = el("div");
      info.append(el("div", "reference-title", item.original_name || item.id));
      info.append(el("div", "reference-meta", formatTime(item.seconds) + " · Not used for generation"));
      row.append(info, control("▶ Play", () => playReference(item)));
      box.append(row);
    }
  } catch (error) {
    box.replaceChildren(el("p", "drawer-notice", "References unavailable: " + error.message));
  }
}
async function saveReference(event) {
  event.preventDefault();
  const file = $("reference-file").files[0];
  const status = $("reference-status");
  if (!file) { status.textContent = "Choose a WAV file."; return; }
  if (!$("reference-rights").checked) { status.textContent = "Confirm you have the recording rights."; return; }
  if (file.size > 12000000) { status.textContent = "A reference must be 12 MB or smaller."; return; }
  const button = $("save-reference");
  button.disabled = true;
  status.textContent = "Saving privately on the Beelink…";
  try {
    const bytes = await file.arrayBuffer();
    await api("/api/references", {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-CSRF-Token": csrf(),
        "X-Reference-Rights": "yes",
        "X-Reference-Name": file.name,
      },
      body: bytes,
    });
    $("reference-form").reset();
    status.textContent = "Saved. Generate will not use this reference.";
    await loadReferences();
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
}
