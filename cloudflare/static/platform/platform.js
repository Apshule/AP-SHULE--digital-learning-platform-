(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const state = { content: null, session: null, selectedClass: "", selectedSubject: "", saved: new Set(), loading: false };

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function get(object, ...keys) {
    if (!object || typeof object !== "object") return undefined;
    for (const key of keys) if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
    return undefined;
  }
  function str(object, ...keys) {
    const value = get(object, ...keys);
    return value === undefined ? "" : String(value);
  }
  function list(object, ...keys) {
    const value = get(object, ...keys);
    return Array.isArray(value) ? value : [];
  }
  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData) && !headers["content-type"]) headers["content-type"] = "application/json";
    const response = await fetch(path, { credentials: "same-origin", ...options, headers });
    let data;
    if (options.responseType === "blob") data = await response.blob();
    else data = await response.json().catch(() => ({}));
    if (!response.ok || (data && data.ok === false)) {
      const error = new Error(data && (data.error || data.message) || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function safeUrl(raw, httpsOnly = false) {
    if (!raw) return "";
    try {
      const parsed = new URL(String(raw), location.origin);
      if (httpsOnly && parsed.protocol !== "https:") return "";
      if (!["https:", "http:"].includes(parsed.protocol)) return "";
      return parsed.href;
    } catch { return ""; }
  }
  function setStatus(message, kind = "") {
    const node = $("#platform-status");
    node.textContent = message;
    node.className = `platform-status${kind ? ` ${kind}` : ""}`;
  }
  function showEmpty(container, title, copy) {
    const panel = make("div", "platform-empty");
    panel.append(make("strong", "", title), make("p", "", copy));
    container.replaceChildren(panel);
  }
  function displayDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
  }
  function ugx(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? `UGX ${new Intl.NumberFormat("en-UG", { maximumFractionDigits: 0 }).format(amount)}` : "";
  }
  function normalize(value) { return String(value || "").trim().toLocaleLowerCase(); }
  function videoMappings() { return list(state.content, "videoMappings", "video_mappings"); }
  function resources() { return list(state.content, "resources", "learningMaterials", "learning_materials"); }
  function events() { return list(state.content, "events"); }
  function classNames() {
    const names = [...videoMappings(), ...resources()]
      .map((item) => str(item, "className", "class_name", "class"))
      .filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }
  function subjectNames(className) {
    const chosen = normalize(className);
    return [...new Set([...videoMappings(), ...resources()]
      .filter((item) => normalize(str(item, "className", "class_name", "class")) === chosen)
      .map((item) => str(item, "subject", "subjectName", "subject_name"))
      .filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }
  function savedKey(item) {
    return str(item, "id", "lessonId", "lesson_id") ||
      [str(item, "className", "class_name"), str(item, "subject", "subjectName", "subject_name"), str(item, "youtubeUrl", "youtube_url")].join("|");
  }
  function updateSaved(key) {
    if (state.saved.has(key)) state.saved.delete(key);
    else state.saved.add(key);
    try { localStorage.setItem("apshule-platform-saved", JSON.stringify([...state.saved])); } catch {}
    renderSaved();
    renderLearning();
  }
  function normalizedVideo(item) {
    const raw = str(item, "youtubeUrl", "youtube_url", "url");
    const url = safeUrl(raw, true);
    if (!url) return "";
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com") ? url : "";
    } catch { return ""; }
  }
  function learningItem(item, type) {
    const row = make("article", "platform-learning-item");
    const title = str(item, "title", "name") || (type === "video" ? "YouTube Lesson" : "Learning material");
    row.append(make("strong", "", title));
    const className = str(item, "className", "class_name", "class");
    const subject = str(item, "subject", "subjectName", "subject_name");
    const meta = make("div", "platform-learning-meta");
    if (className) meta.append(make("span", "", `Class ${className}`));
    if (subject) meta.append(make("span", "", subject));
    const date = displayDate(get(item, "date", "createdAt", "created_at"));
    if (date) meta.append(make("span", "", date));
    if (meta.childElementCount) row.append(meta);
    const description = str(item, "description");
    if (description) row.append(make("p", "", description));
    if (type === "video") {
      const url = normalizedVideo(item);
      if (url) {
        const link = document.createElement("a");
        link.className = "platform-link";
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "YouTube Lesson";
        link.addEventListener("click", () => {
          const lessonId = str(item, "lessonId", "lesson_id", "id");
          if (lessonId) request(`/api/school/platform-views/${encodeURIComponent(lessonId)}`, { method: "POST" }).catch(() => {});
        });
        row.append(link);
      } else row.append(make("p", "", "This mapping does not have a valid HTTPS YouTube link."));
      const key = savedKey(item);
      const save = make("button", "platform-action", state.saved.has(key) ? "Remove from My List" : "Save to My List");
      save.type = "button";
      save.addEventListener("click", () => updateSaved(key));
      row.append(save);
    } else {
      const url = safeUrl(str(item, "url", "pdfUrl", "pdf_url"));
      if (url) {
        const link = document.createElement("a");
        link.className = "platform-link";
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open PDF material";
        row.append(link);
      } else row.append(make("p", "", "A valid material link is not available."));
    }
    return row;
  }
  function renderClassFlow() {
    const classRoot = $("#platform-classes");
    const subjectsRoot = $("#platform-subjects");
    const resultRoot = $("#platform-learning-results");
    const classes = classNames();
    $("#platform-hero-count").textContent = `${classes.length} ${classes.length === 1 ? "class" : "classes"} available`;
    if (state.selectedClass && !classes.includes(state.selectedClass)) state.selectedClass = "";
    if (!classes.length) {
      classRoot.replaceChildren();
      subjectsRoot.hidden = true;
      resultRoot.replaceChildren();
      showEmpty(classRoot, "No class materials yet", "Classes appear here when learning materials or video lessons have been mapped for them.");
      return;
    }
    const grid = make("div", "platform-class-grid");
    classes.forEach((className) => {
      const subjectCount = subjectNames(className).length;
      const card = make("button", "platform-class");
      card.type = "button";
      card.setAttribute("aria-pressed", String(state.selectedClass === className));
      card.append(make("small", "", "Select class"), make("strong", "", className), make("span", "", `${subjectCount} ${subjectCount === 1 ? "subject" : "subjects"}`));
      card.addEventListener("click", () => {
        state.selectedClass = className;
        state.selectedSubject = "";
        renderClassFlow();
      });
      grid.append(card);
    });
    classRoot.replaceChildren(grid);
    if (!state.selectedClass) {
      subjectsRoot.hidden = true;
      subjectsRoot.replaceChildren();
      resultRoot.replaceChildren();
      return;
    }
    const subjects = subjectNames(state.selectedClass);
    subjectsRoot.hidden = false;
    subjectsRoot.replaceChildren();
    subjects.forEach((subject) => {
      const button = make("button", "platform-subject", subject);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.selectedSubject === subject));
      button.addEventListener("click", () => {
        state.selectedSubject = state.selectedSubject === subject ? "" : subject;
        renderClassFlow();
      });
      subjectsRoot.append(button);
    });
    if (!subjects.length) {
      showEmpty(resultRoot, "No subjects in this class yet", "Learning materials are not mapped to a subject for this class.");
      return;
    }
    if (!state.selectedSubject) {
      showEmpty(resultRoot, "Choose a subject", `Select a subject for ${state.selectedClass} to see its YouTube lessons and PDF materials.`);
      return;
    }
    const chosenClass = normalize(state.selectedClass);
    const chosenSubject = normalize(state.selectedSubject);
    const mappings = videoMappings().filter((item) =>
      normalize(str(item, "className", "class_name", "class")) === chosenClass &&
      normalize(str(item, "subject", "subjectName", "subject_name")) === chosenSubject);
    const pdfs = resources().filter((item) =>
      normalize(str(item, "className", "class_name", "class")) === chosenClass &&
      normalize(str(item, "subject", "subjectName", "subject_name")) === chosenSubject);
    const results = [...mappings.map((item) => learningItem(item, "video")), ...pdfs.map((item) => learningItem(item, "pdf"))];
    if (!results.length) {
      showEmpty(resultRoot, "No lessons or materials yet", "There are no mapped lessons or PDF resources for this subject.");
      return;
    }
    resultRoot.replaceChildren(...results);
  }
  function eventCard(item) {
    const row = make("article", "platform-event");
    const rawDate = get(item, "eventDate", "event_date", "date");
    const date = rawDate ? new Date(rawDate) : null;
    const dateCard = make("div", "platform-event-date");
    if (date && !Number.isNaN(date.getTime())) {
      dateCard.append(make("strong", "", new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(date)), make("span", "", new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(date)));
    } else dateCard.append(make("strong", "", "—"), make("span", "", "Date TBC"));
    const main = make("div", "platform-event-main");
    main.append(make("strong", "", str(item, "title") || "Seminar or event"));
    const details = [displayDate(rawDate), str(item, "description")].filter(Boolean);
    if (details.length) main.append(make("p", "", details.join(" · ")));
    row.append(dateCard, main);
    const fee = get(item, "feeUgx", "fee_ugx");
    if (fee !== undefined) row.append(make("span", "platform-price", Number(fee) === 0 ? "No fee" : ugx(fee)));
    return row;
  }
  function renderEvents() {
    const records = events().slice().sort((a, b) => {
      const da = new Date(get(a, "eventDate", "event_date", "date") || 0).getTime();
      const db = new Date(get(b, "eventDate", "event_date", "date") || 0).getTime();
      return (Number.isNaN(da) ? Infinity : da) - (Number.isNaN(db) ? Infinity : db);
    });
    $("#home-events-count").textContent = `${records.length} ${records.length === 1 ? "event" : "events"}`;
    for (const container of [$("#platform-home-events"), $("#platform-alert-events")]) {
      if (!records.length) showEmpty(container, "No upcoming events", "New seminars and events will be listed here when published.");
      else {
        const wrap = make("div", "platform-events");
        records.forEach((item) => wrap.append(eventCard(item)));
        container.replaceChildren(wrap);
      }
    }
  }
  function renderResources() {
    const items = resources();
    $("#resources-count").textContent = `${items.length} ${items.length === 1 ? "resource" : "resources"}`;
    const container = $("#platform-resources");
    if (!items.length) {
      showEmpty(container, "No PDF materials yet", "Learning materials will appear here when a school publishes them.");
      return;
    }
    const grid = make("div", "platform-results");
    items.forEach((item) => grid.append(learningItem(item, "pdf")));
    container.replaceChildren(grid);
  }
  function renderPlans() {
    const area = $("#platform-plans");
    area.replaceChildren();
    const plans = list(state.content, "plans");
    if (!plans.length) {
      showEmpty(area, "Subscription plans are unavailable", "Plan details will appear here when they are available.");
      return;
    }
    plans.forEach((plan) => {
      const card = make("article", "platform-plan");
      card.append(
        make("span", "platform-plan-name", str(plan, "name") || "Learning plan"),
        make("strong", "platform-plan-price", ugx(get(plan, "amountUgx", "amount_ugx"))),
      );
      const days = Number(get(plan, "durationDays", "duration_days"));
      if (Number.isFinite(days) && days > 0) {
        card.append(make("small", "platform-plan-duration", `${days} ${days === 1 ? "day" : "days"}`));
      }
      const button = make("button", "", "Subscribe");
      button.type = "button";
      button.disabled = true;
      button.title = "Checkout is not connected. No payment can be made.";
      card.append(button);
      area.append(card);
    });
  }
  function renderLiveLessons() {
    const container = $("#platform-live-lessons");
    const lessons = list(state.content, "liveLessons", "live_lessons");
    if (!lessons.length) {
      showEmpty(container, "No live lessons scheduled", "Live lesson rooms will appear here when available.");
      return;
    }
    const listNode = make("div", "platform-live-list");
    lessons.forEach((lesson) => {
      const card = make("article", "platform-learning-item");
      card.append(make("strong", "", str(lesson, "title") || "Live lesson"));
      const meta = [str(lesson, "className", "class_name") && `Class ${str(lesson, "className", "class_name")}`, str(lesson, "subject", "subjectName", "subject_name")].filter(Boolean);
      if (meta.length) card.append(make("div", "platform-learning-meta", meta.join(" · ")));
      const joinUrl = safeUrl(str(lesson, "joinUrl", "join_url", "jitsiUrl", "jitsi_url", "url"), true);
      if (joinUrl) {
        const link = document.createElement("a");
        link.className = "platform-link";
        link.href = joinUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open public Jitsi room";
        card.append(link);
      } else card.append(make("p", "", "A room link is not available."));
      listNode.append(card);
    });
    container.replaceChildren(listNode);
  }
  function renderSaved() {
    const container = $("#platform-saved-list");
    const items = videoMappings().filter((item) => state.saved.has(savedKey(item)));
    if (!items.length) {
      showEmpty(container, "Your list is empty", "Save a YouTube lesson from the class and subject view to keep it here on this device.");
      return;
    }
    const grid = make("div", "platform-results");
    items.forEach((item) => grid.append(learningItem(item, "video")));
    container.replaceChildren(grid);
  }
  function renderAbout() {
    const about = get(state.content, "about") || {};
    const title = typeof about === "string" ? "" : str(about, "title");
    const body = typeof about === "string" ? about : str(about, "body", "content", "text");
    $("#platform-about-title").textContent = title || "APSHULE";
    $("#platform-about-body").textContent = body || "About information is not available yet.";
  }
  function showView(name) {
    const valid = ["home", "list", "alerts", "account", "about"].includes(name) ? name : "home";
    document.querySelectorAll(".platform-view").forEach((view) => { view.hidden = view.id !== `view-${valid}`; });
    document.querySelectorAll("[data-view-target]").forEach((button) => {
      if (button.dataset.viewTarget === valid) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    history.replaceState(null, "", `#${valid}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function showAuth() {
    const area = $("#platform-auth-state");
    const form = $("#platform-feedback-form");
    area.replaceChildren();
    if (state.session && state.session.authenticated !== false && get(state.session, "user")) {
      area.append(make("strong", "", "You are signed in to APSHULE."));
      const line = make("p", "platform-about", "Use the form below to share feedback with the platform team.");
      area.append(line);
      form.hidden = false;
    } else {
      form.hidden = true;
      area.append(make("strong", "", "Sign in to send feedback."));
      const link = document.createElement("a");
      link.className = "platform-link";
      link.href = "/#account-access";
      link.textContent = "Go to APSHULE sign in";
      area.append(link);
    }
  }
  function render() {
    $("#platform-loading").hidden = true;
    $("#platform-error").hidden = true;
    renderClassFlow();
    renderEvents();
    renderResources();
    renderPlans();
    renderLiveLessons();
    renderSaved();
    renderAbout();
    showAuth();
    $("#platform-state").textContent = "Learning content loaded";
    setStatus("Learning content is up to date.", "success");
    showView(location.hash.slice(1) || "home");
  }
  async function load() {
    if (state.loading) return;
    state.loading = true;
    $("#platform-refresh").disabled = true;
    $("#platform-state").textContent = "Loading platform…";
    setStatus("Loading classes, events and learning materials…");
    $("#platform-error").hidden = true;
    $("#platform-loading").hidden = false;
    try {
      const stored = (() => {
        try {
          const value = JSON.parse(localStorage.getItem("apshule-platform-saved") || "[]");
          return Array.isArray(value) ? value.map(String) : [];
        } catch { return []; }
      })();
      state.saved = new Set(stored);
      const [contentResult, sessionResult] = await Promise.all([
        request("/api/school/platform-content"),
        request("/api/auth/session").catch(() => null),
      ]);
      state.content = contentResult;
      state.session = sessionResult;
      render();
    } catch (error) {
      $("#platform-loading").hidden = true;
      $("#platform-state").textContent = "Content unavailable";
      setStatus(error.message || "Learning content could not be loaded.", "error");
      const panel = $("#platform-error");
      panel.hidden = false;
      panel.replaceChildren(make("strong", "", "Could not load the learning platform"), make("p", "", error.message || "Check your connection and try again."));
      const retry = make("button", "platform-action platform-retry", "Try again");
      retry.type = "button";
      retry.addEventListener("click", load);
      panel.append(retry);
      if (error.status === 401) {
        const signIn = make("a", "platform-link platform-sign-in", "Go to sign in");
        signIn.href = "/";
        panel.append(signIn);
      }
    } finally {
      state.loading = false;
      $("#platform-refresh").disabled = false;
    }
  }

  document.querySelectorAll("[data-view-target]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.viewTarget)));
  $("#platform-refresh").addEventListener("click", load);
  $("#platform-feedback-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $("button[type='submit']", form);
    const status = $("#platform-feedback-status");
    const message = $("#platform-feedback-message").value.trim();
    if (!message) { $("#platform-feedback-message").focus(); return; }
    submit.disabled = true;
    status.textContent = "Sending feedback…";
    try {
      await request("/api/school/platform-feedback", { method: "POST", body: JSON.stringify({ message }) });
      form.reset();
      status.textContent = "Thank you. Your feedback was sent.";
      status.className = "platform-status success";
    } catch (error) {
      status.textContent = error.message || "Feedback could not be sent.";
      status.className = "platform-status error";
    } finally { submit.disabled = false; }
  });
  const headerLogo = make("img");
  headerLogo.alt = "";
  headerLogo.width = 40;
  headerLogo.height = 40;
  headerLogo.style.cssText = "display:none;width:40px;height:40px;object-fit:contain;border-radius:13px;background:#fff";
  headerLogo.addEventListener("error", () => { headerLogo.hidden = true; });
  headerLogo.addEventListener("load", () => { headerLogo.style.display = "block"; $("#platform-brand-mark").hidden = true; });
  headerLogo.src = `/api/school/platform-logo?v=${Date.now()}`;
  $("#platform-brand-mark").after(headerLogo);
  load();
})();