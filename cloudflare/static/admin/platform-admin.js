(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const panel = $("#platform-admin-content");
  const statusNode = $("#platform-admin-status");
  let current = null;
  let busy = false;

  function el(tag, className, text) {
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
  function arr(object, ...keys) {
    const value = get(object, ...keys);
    return Array.isArray(value) ? value : [];
  }
  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData) && !headers["content-type"]) headers["content-type"] = "application/json";
    const response = await fetch(path, { credentials: "same-origin", ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  }
  function setStatus(message, kind = "") {
    statusNode.textContent = message;
    statusNode.className = `platform-admin-notice${kind ? ` ${kind}` : ""}`;
  }
  function verifiedUrl(raw, youtube = false) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "https:") return "";
      if (youtube) {
        const host = parsed.hostname.toLowerCase();
        if (!(host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com"))) return "";
      }
      return parsed.href;
    } catch { return ""; }
  }
  function button(label, className, onClick) {
    const node = el("button", `button ${className || ""}`.trim(), label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }
  function card(title, description, wide = false) {
    const node = el("section", `platform-admin-card${wide ? " wide" : ""}`);
    node.append(el("h3", "", title));
    if (description) node.append(el("p", "", description));
    return node;
  }
  function empty(message) { return el("div", "platform-admin-empty", message); }
  function recordList(records, titleFor, detailFor, actionFor) {
    const list = el("div", "platform-admin-list");
    if (!records.length) {
      list.append(empty("No records are available yet."));
      return list;
    }
    records.slice(0, 150).forEach((item) => {
      const row = el("article", "platform-admin-record");
      const main = el("div", "platform-admin-record-main");
      main.append(el("strong", "", titleFor(item) || "Platform record"));
      const detail = detailFor(item);
      if (detail) main.append(el("small", "", detail));
      row.append(main);
      const actions = actionFor ? actionFor(item) : null;
      if (actions) row.append(actions);
      list.append(row);
    });
    return list;
  }
  function field(labelText, name, type = "text", options = {}) {
    const label = el("label", "", labelText);
    let input;
    if (type === "textarea") input = document.createElement("textarea");
    else if (type === "select") input = document.createElement("select");
    else input = document.createElement("input");
    input.name = name;
    input.id = `platform-admin-${name}-${Math.random().toString(36).slice(2, 9)}`;
    if (type !== "textarea" && type !== "select") input.type = type;
    if (options.required) input.required = true;
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.accept) input.accept = options.accept;
    if (options.min !== undefined) input.min = String(options.min);
    if (options.step !== undefined) input.step = String(options.step);
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.full) label.classList.add("full");
    label.htmlFor = input.id;
    if (type === "select") {
      const prompt = document.createElement("option");
      prompt.value = "";
      prompt.textContent = "Choose a status";
      input.append(prompt);
      (options.choices || []).forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        input.append(option);
      });
    }
    label.append(input);
    return { label, input };
  }
  function form(fields, submitText, submitHandler, className = "platform-admin-form") {
    const node = el("form", className);
    const controls = {};
    fields.forEach((definition) => {
      const control = field(definition.label, definition.name, definition.type || "text", definition);
      controls[definition.name] = control.input;
      if (definition.value !== undefined) control.input.value = definition.value;
      node.append(control.label);
    });
    const actions = el("div", "button-row");
    const submit = el("button", "button", submitText);
    submit.type = "submit";
    actions.append(submit);
    node.append(actions);
    node.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!node.reportValidity()) return;
      submit.disabled = true;
      setStatus(`${submitText}…`);
      try {
        const values = Object.fromEntries(Object.entries(controls).map(([name, control]) => [name, control.value.trim()]));
        await submitHandler(values, controls);
        node.reset();
        await load(true);
        setStatus(`${submitText} completed.`, "success");
      } catch (error) {
        setStatus(error.message || "The platform update could not be saved.", "error");
      } finally {
        submit.disabled = false;
      }
    });
    return node;
  }
  async function postJson(path, body, method = "POST") {
    return request(path, { method, body: JSON.stringify(body) });
  }
  function inlineEdit(item, endpoint, definitions) {
    const id = get(item, "id");
    if (id === undefined) return null;
    const fields = definitions.map((definition) => ({
      ...definition,
      value: str(item, ...(definition.keys || [definition.name])),
    }));
    const editor = form(fields, "Save changes", (values) =>
      postJson(`${endpoint}/${encodeURIComponent(id)}`, values, "PATCH"),
    "platform-admin-form platform-inline-edit");
    const cancel = button("Cancel", "secondary", () => { editor.hidden = true; });
    editor.querySelector(".button-row")?.append(cancel);
    editor.hidden = true;
    const wrapper = el("div", "platform-inline-editor");
    const edit = button("Edit", "secondary", () => { editor.hidden = !editor.hidden; });
    wrapper.append(edit, editor);
    return wrapper;
  }
  function schoolCard() {
    const section = card("School registry", "Add a school record. To create the school login, use the existing Create a user form below; it sends the password-reset flow and does not set a password here.", true);
    const formNode = form([
      { name: "name", label: "School name", required: true, maxLength: 180 },
      { name: "contact", label: "School contact", required: true, maxLength: 180 },
      { name: "location", label: "Location", required: true, maxLength: 180 },
      { name: "logoUrl", label: "School logo URL (optional)", type: "url", maxLength: 1000, full: true },
    ], "Add school", async (values) => {
      const result = await postJson("/api/admin/platform/schools", values);
      const schoolId = get(result, "schoolId", "school_id");
      const institutionId = get(result, "institutionId", "institution_id");
      const schoolInput = $("#schoolId");
      const institutionInput = $("#institutionId");
      if (schoolInput && schoolId) schoolInput.value = String(schoolId);
      if (institutionInput && institutionId) institutionInput.value = String(institutionId);
      if ($("#role")) $("#role").value = "secretary";
      setStatus(`School added. Its IDs are ready in the existing Create a user form below. Create the school account there to request a password reset.`, "success");
    });
    section.append(formNode);
    section.append(recordList(arr(current, "schools"), (item) => str(item, "name", "schoolName", "school_name"), (item) => [
      str(item, "location"),
      str(item, "contact"),
      str(item, "schoolId", "school_id", "id") && `School ID: ${str(item, "schoolId", "school_id", "id")}`,
      str(item, "institutionId", "institution_id") && `Institution ID: ${str(item, "institutionId", "institution_id")}`,
    ].filter(Boolean).join(" · "), (item) => {
      const schoolId = get(item, "schoolId", "school_id");
      if (schoolId === undefined) return null;
      const container = el("div", "platform-school-actions");
      const editor = document.createElement("form");
      editor.className = "platform-admin-form platform-school-edit-form";
      editor.hidden = true;
      const values = {
        name: str(item, "name", "schoolName", "school_name"),
        contact: str(item, "contact"),
        location: str(item, "location"),
        logoUrl: str(item, "logoUrl", "logo_url"),
      };
      const controls = {};
      [
        ["School name", "name", "text"],
        ["Contact", "contact", "text"],
        ["Location", "location", "text"],
        ["Logo URL", "logoUrl", "url"],
      ].forEach(([label, name, type]) => {
        const control = field(label, name, type, {});
        control.input.value = values[name];
        controls[name] = control.input;
        editor.append(control.label);
      });
      const actions = el("div", "button-row");
      const save = el("button", "button", "Save changes");
      save.type = "submit";
      const cancel = button("Cancel", "secondary", () => { editor.hidden = true; });
      actions.append(save, cancel);
      editor.append(actions);
      editor.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!editor.reportValidity()) return;
        save.disabled = true;
        try {
          await postJson(`/api/admin/platform/schools/${encodeURIComponent(schoolId)}`,
            Object.fromEntries(Object.entries(controls).map(([name, control]) => [name, control.value.trim()])), "PATCH");
          await load(true);
        } catch (error) {
          setStatus(error.message || "School details could not be saved.", "error");
          save.disabled = false;
        }
      });
      const edit = button("Edit details", "secondary", () => {
        editor.hidden = !editor.hidden;
      });
      container.append(edit, editor);
      return container;
    }));
    return section;
  }
  function logoCard() {
    const section = card("Brand logo", "Upload the image served to students by the platform logo endpoint.");
    const formNode = document.createElement("form");
    formNode.className = "platform-admin-form";
    const fileField = field("Choose image file", "file", "file", { required: true, accept: "image/png,image/jpeg,image/webp" });
    const actions = el("div", "button-row");
    const submit = el("button", "button", "Upload logo");
    submit.type = "submit";
    actions.append(submit);
    formNode.append(fileField.label, actions);
    formNode.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!formNode.reportValidity()) return;
      const file = fileField.input.files && fileField.input.files[0];
      if (!file) return;
      submit.disabled = true;
      setStatus("Uploading brand logo…");
      try {
        const payload = new FormData();
        payload.append("file", file);
        await request("/api/admin/platform/brand-logo", { method: "POST", body: payload });
        await load(true);
        setStatus("Brand logo uploaded.", "success");
      } catch (error) { setStatus(error.message || "Logo upload failed.", "error"); }
      finally { submit.disabled = false; }
    });
    section.append(formNode);
    const preview = document.createElement("img");
    preview.className = "platform-logo-preview";
    preview.alt = "Current APSHULE brand logo";
    preview.src = `/api/school/platform-logo?refresh=${Date.now()}`;
    preview.addEventListener("error", () => { preview.hidden = true; });
    section.append(preview);
    return section;
  }
  function eventCard() {
    const section = card("Events and seminars", "Publish upcoming events, then archive or restore them as needed.");
    section.append(form([
      { name: "title", label: "Event title", required: true, maxLength: 180 },
      { name: "eventDate", label: "Event date", type: "date", required: true },
      { name: "feeUgx", label: "Fee (UGX)", type: "number", required: true, min: 0, step: 1 },
      { name: "description", label: "Description", type: "textarea", maxLength: 2000, full: true },
    ], "Add event", (values) => postJson("/api/admin/platform/events", {
      ...values,
      feeUgx: Number(values.feeUgx),
    })));
    section.append(recordList(arr(current, "events"), (item) => str(item, "title"), (item) => [
      str(item, "eventDate", "event_date"),
      get(item, "feeUgx", "fee_ugx") !== undefined ? `UGX ${String(get(item, "feeUgx", "fee_ugx"))}` : "",
      str(item, "description"),
      str(item, "status") === "archived" ? "Archived" : "",
    ].filter(Boolean).join(" · "), (item) => {
      const id = get(item, "id");
      if (id === undefined) return null;
      const actions = el("div", "platform-row-actions");
      actions.append(inlineEdit(item, "/api/admin/platform/events", [
        { name: "title", label: "Event title", required: true, maxLength: 180, keys: ["title"] },
        { name: "eventDate", label: "Event date", type: "date", required: true, keys: ["eventDate", "event_date"] },
        { name: "feeUgx", label: "Fee (UGX)", type: "number", required: true, min: 0, step: 1, keys: ["feeUgx", "fee_ugx"] },
        { name: "description", label: "Description", type: "textarea", maxLength: 2000, full: true, keys: ["description"] },
      ]));
      actions.append(button(str(item, "status") === "archived" ? "Restore" : "Archive", "secondary", async (event) => {
        const control = event.currentTarget;
        control.disabled = true;
        try {
          const archived = str(item, "status") === "archived";
          await postJson(`/api/admin/platform/events/${encodeURIComponent(id)}`, archived ? { status: "published" } : {}, archived ? "PATCH" : "DELETE");
          await load(true);
        } catch (error) { setStatus(error.message || "Event status could not be changed.", "error"); control.disabled = false; }
      }));
      return actions;
    }));
    return section;
  }
  function resourceCard() {
    const section = card("PDF learning materials", "Add secure PDF links for classes and subjects, then remove or restore links.");
    section.append(form([
      { name: "title", label: "PDF title", required: true, maxLength: 180 },
      { name: "url", label: "PDF URL", type: "url", required: true, maxLength: 2000, placeholder: "https://…" },
      { name: "className", label: "Class", maxLength: 100 },
      { name: "subject", label: "Subject", maxLength: 120 },
    ], "Add PDF link", (values) => {
      const url = verifiedUrl(values.url);
      if (!url) throw new Error("Use a valid HTTPS PDF link.");
      return postJson("/api/admin/platform/resources", { ...values, url });
    }));
    section.append(recordList(arr(current, "resources"), (item) => str(item, "title"), (item) => [
      str(item, "className", "class_name") && `Class ${str(item, "className", "class_name")}`,
      str(item, "subject", "subjectName", "subject_name"),
      str(item, "url"),
      Number(get(item, "active") ?? 1) === 0 ? "Hidden" : "",
    ].filter(Boolean).join(" · "), (item) => {
      const id = get(item, "id");
      if (id === undefined) return null;
      const actions = el("div", "platform-row-actions");
      actions.append(inlineEdit(item, "/api/admin/platform/resources", [
        { name: "title", label: "PDF title", required: true, maxLength: 180, keys: ["title"] },
        { name: "url", label: "PDF URL", type: "url", required: true, maxLength: 2000, keys: ["url"] },
        { name: "className", label: "Class", maxLength: 100, keys: ["className", "class_name"] },
        { name: "subject", label: "Subject", maxLength: 120, keys: ["subject"] },
      ]));
      actions.append(button(Number(get(item, "active") ?? 1) === 0 ? "Restore" : "Remove", "secondary", async (event) => {
        const control = event.currentTarget;
        control.disabled = true;
        try {
          const active = Number(get(item, "active") ?? 1) === 0;
          await postJson(`/api/admin/platform/resources/${encodeURIComponent(id)}`, active ? { active: true } : {}, active ? "PATCH" : "DELETE");
          await load(true);
        } catch (error) { setStatus(error.message || "PDF link status could not be changed.", "error"); control.disabled = false; }
      }));
      return actions;
    }));
    section.append(el("h3", "", "Teacher-uploaded PDFs"));
    section.append(recordList(arr(current, "educationFiles"), (item) => str(item, "title", "filename") || "Learning material", (item) => [
      str(item, "className", "class_name") && `Class ${str(item, "className", "class_name")}`,
      str(item, "subject"),
    ].filter(Boolean).join(" · "), (item) => {
      const url = str(item, "url");
      if (!url) return null;
      const link = document.createElement("a");
      link.className = "platform-admin-link";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open PDF";
      return link;
    }));
    return section;
  }
  function youtubeCard() {
    const section = card("YouTube lesson mapping", "Connect a YouTube lesson to its class and subject, then remove or restore mappings.");
    section.append(form([
      { name: "className", label: "Class", required: true, maxLength: 100 },
      { name: "subject", label: "Subject", required: true, maxLength: 120 },
      { name: "youtubeUrl", label: "YouTube URL", type: "url", required: true, maxLength: 1000, full: true },
    ], "Save mapping", (values) => {
      const youtubeUrl = verifiedUrl(values.youtubeUrl, true);
      if (!youtubeUrl) throw new Error("Use a valid HTTPS YouTube URL.");
      return postJson("/api/admin/platform/video-mappings", { ...values, youtubeUrl });
    }));
    section.append(recordList(arr(current, "videoMappings", "video_mappings"), (item) => str(item, "subject", "title") || "YouTube mapping", (item) => [
      str(item, "className", "class_name") && `Class ${str(item, "className", "class_name")}`,
      str(item, "youtubeUrl", "youtube_url"),
      Number(get(item, "active") ?? 1) === 0 ? "Hidden" : "",
    ].filter(Boolean).join(" · "), (item) => {
      const id = get(item, "id");
      if (id === undefined) return null;
      const actions = el("div", "platform-row-actions");
      actions.append(inlineEdit(item, "/api/admin/platform/video-mappings", [
        { name: "className", label: "Class", required: true, maxLength: 100, keys: ["className", "class_name"] },
        { name: "subject", label: "Subject", required: true, maxLength: 120, keys: ["subject"] },
        { name: "youtubeUrl", label: "YouTube URL", type: "url", required: true, maxLength: 1000, full: true, keys: ["youtubeUrl", "youtube_url"] },
      ]));
      actions.append(button(Number(get(item, "active") ?? 1) === 0 ? "Restore" : "Remove", "secondary", async (event) => {
        const control = event.currentTarget;
        control.disabled = true;
        try {
          const active = Number(get(item, "active") ?? 1) === 0;
          await postJson(`/api/admin/platform/video-mappings/${encodeURIComponent(id)}`, active ? { active: true } : {}, active ? "PATCH" : "DELETE");
          await load(true);
        } catch (error) { setStatus(error.message || "Video mapping status could not be changed.", "error"); control.disabled = false; }
      }));
      return actions;
    }));
    section.append(el("h3", "", "Published Education lessons"));
    section.append(recordList(arr(current, "educationLessonVideos"), (item) => str(item, "title", "subject") || "Lesson", (item) => [
      str(item, "className", "class_name") && `Class ${str(item, "className", "class_name")}`,
      str(item, "subject"),
      str(item, "youtubeUrl", "youtube_url"),
    ].filter(Boolean).join(" · "), (item) => {
      const url = verifiedUrl(str(item, "youtubeUrl", "youtube_url"), true);
      if (!url) return null;
      const link = document.createElement("a");
      link.className = "platform-admin-link";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open lesson";
      return link;
    }));
    return section;
  }
  function analyticsCard() {
    const section = card("Global analytics", "Platform-wide usage and most-watched learning videos.", true);
    const analytics = get(current, "analytics") || {};
    const metricCandidates = [
      ["Total users", get(analytics, "totalUsers", "total_users", "users")],
      ["Schools", get(analytics, "schoolCount", "school_count", "schools")],
      ["Video views", get(analytics, "videoViews", "video_views", "totalViews", "total_views")],
    ].filter(([, value]) => value !== undefined && (typeof value === "number" || /^\d+$/.test(String(value))));
    if (metricCandidates.length) {
      const grid = el("div", "platform-metric-grid");
      metricCandidates.forEach(([label, value]) => {
        const metric = el("div", "platform-metric");
        metric.append(el("span", "", label), el("strong", "", new Intl.NumberFormat().format(Number(value))));
        grid.append(metric);
      });
      section.append(grid);
    } else section.append(empty("No aggregate analytics are available yet."));
    const mostWatched = arr(analytics, "mostWatchedVideos", "most_watched_videos", "mostWatched", "most_watched")
      .concat(arr(current, "mostWatchedVideos", "most_watched_videos"));
    section.append(el("h3", "", "Most-watched videos"));
    section.append(recordList(mostWatched, (item) => str(item, "title", "name", "subject") || "Video", (item) => [
      str(item, "className", "class_name") && `Class ${str(item, "className", "class_name")}`,
      str(item, "subject"),
      get(item, "views", "viewCount", "view_count") !== undefined ? `${String(get(item, "views", "viewCount", "view_count"))} views` : "",
    ].filter(Boolean).join(" · ")));
    return section;
  }
  function feedbackCard() {
    const section = card("Feedback moderation", "Review platform feedback and update its moderation status.", true);
    const items = arr(current, "feedback");
    if (!items.length) {
      section.append(empty("No feedback has been submitted."));
      return section;
    }
    const tableWrap = el("div", "table-wrap");
    const table = el("table", "platform-admin-table");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Feedback", "Status", "Moderation"].forEach((value) => headRow.append(el("th", "", value)));
    head.append(headRow);
    table.append(head);
    const body = document.createElement("tbody");
    items.forEach((item) => {
      const row = document.createElement("tr");
      const id = get(item, "id", "feedbackId", "feedback_id");
      row.append(el("td", "", str(item, "message", "body", "text")));
      const status = str(item, "status") || "new";
      row.append(el("td", "", status === "read" ? "Reviewed" : status === "resolved" ? "Resolved" : "New"));
      const actionCell = document.createElement("td");
      const actions = el("div", "platform-row-actions");
      if (id !== undefined) {
        const reviewed = button("Mark reviewed", "secondary", async () => {
          reviewed.disabled = true;
          try { await postJson(`/api/admin/platform/feedback/${encodeURIComponent(id)}`, { status: "read" }, "PATCH"); await load(true); }
          catch (error) { setStatus(error.message || "Feedback status could not be changed.", "error"); reviewed.disabled = false; }
        });
        const reopen = button("Reopen", "secondary", async () => {
          reopen.disabled = true;
          try { await postJson(`/api/admin/platform/feedback/${encodeURIComponent(id)}`, { status: "new" }, "PATCH"); await load(true); }
          catch (error) { setStatus(error.message || "Feedback status could not be changed.", "error"); reopen.disabled = false; }
        });
        const resolve = button("Mark resolved", "secondary", async () => {
          resolve.disabled = true;
          try { await postJson(`/api/admin/platform/feedback/${encodeURIComponent(id)}`, { status: "resolved" }, "PATCH"); await load(true); }
          catch (error) { setStatus(error.message || "Feedback status could not be changed.", "error"); resolve.disabled = false; }
        });
        actions.append(reviewed, resolve, reopen);
      } else actions.append(el("small", "", "No feedback ID returned"));
      actionCell.append(actions);
      row.append(actionCell);
      body.append(row);
    });
    table.append(body);
    tableWrap.append(table);
    section.append(tableWrap);
    return section;
  }
  function aboutCard() {
    const about = get(current, "about") || {};
    return card("About page text", "Update the title and body displayed on the student platform.", true).appendChild(
      form([
        { name: "title", label: "About title", required: true, maxLength: 180, value: typeof about === "string" ? "" : str(about, "title") },
        { name: "body", label: "About text", type: "textarea", required: true, maxLength: 5000, full: true, value: typeof about === "string" ? about : str(about, "body", "content", "text") },
      ], "Save About content", (values) => postJson("/api/admin/platform/about", values, "PUT")),
    ).parentElement;
  }
  function liveCard() {
    const section = card("Live lessons", "Start and end public Jitsi rooms. Anyone with a room link can join; the rooms are not admission-controlled.", true);
    const warning = el("p", "platform-warning", "Important: a live lesson opens a public Jitsi room. Anyone with the room link can join. Do not use the room for private or admission-controlled sessions.");
    section.append(warning);
    section.append(form([
      { name: "title", label: "Lesson title", required: true, maxLength: 180 },
      { name: "className", label: "Class", required: true, maxLength: 100 },
      { name: "subject", label: "Subject", required: true, maxLength: 120 },
    ], "Start live lesson", async (values) => {
      await postJson("/api/admin/platform/live-lessons", values);
    }));
    const records = arr(current, "liveLessons", "live_lessons");
    const list = el("div", "platform-admin-list");
    if (!records.length) list.append(empty("No live lessons are currently listed."));
    records.forEach((lesson) => {
      const row = el("article", "platform-admin-record");
      const main = el("div", "platform-admin-record-main");
      main.append(el("strong", "", str(lesson, "title") || "Live lesson"));
      main.append(el("small", "", [str(lesson, "className", "class_name"), str(lesson, "subject"), str(lesson, "status")].filter(Boolean).join(" · ")));
      row.append(main);
      const id = get(lesson, "id", "lessonId", "lesson_id");
      if (id !== undefined && !["ended", "complete", "completed"].includes(str(lesson, "status").toLowerCase())) {
        const end = button("End lesson", "danger", async () => {
          end.disabled = true;
          try {
            await request(`/api/admin/platform/live-lessons/${encodeURIComponent(id)}/end`, { method: "POST" });
            await load(true);
            setStatus("Live lesson ended.", "success");
          } catch (error) { setStatus(error.message || "The live lesson could not be ended.", "error"); end.disabled = false; }
        });
        row.append(end);
      }
      const joinUrl = str(lesson, "joinUrl", "join_url", "jitsiUrl", "jitsi_url", "url");
      const verifiedJoin = verifiedUrl(joinUrl);
      if (verifiedJoin) {
        const link = document.createElement("a");
        link.className = "platform-admin-link";
        link.href = verifiedJoin;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open public room";
        row.append(link);
      }
      list.append(row);
    });
    section.append(list);
    return section;
  }
  function plansCard() {
    const section = card("Student subscription plans", "Read-only pricing published to the student learning platform.");
    const records = arr(current, "plans");
    section.append(recordList(records, (item) => str(item, "name", "title") || "Plan", (item) => {
      const amount = get(item, "amountUgx", "amount_ugx", "priceUgx", "price_ugx", "amount", "price");
      return amount === undefined ? "" : `UGX ${String(amount)}`;
    }));
    return section;
  }
  function render() {
    panel.replaceChildren(
      schoolCard(),
      logoCard(),
      analyticsCard(),
      eventCard(),
      resourceCard(),
      youtubeCard(),
      feedbackCard(),
      aboutCard(),
      liveCard(),
      plansCard(),
    );
  }
  async function load(silent = false) {
    if (busy) return;
    busy = true;
    $("#platform-admin-refresh").disabled = true;
    if (!silent) setStatus("Loading platform administration data…");
    try {
      current = await request("/api/admin/platform");
      render();
      setStatus("Platform administration data is current.", "success");
    } catch (error) {
      setStatus(error.message || "Platform administration data could not be loaded.", "error");
      if (!current) {
        panel.replaceChildren(empty("Platform administration is unavailable. Check your administrator access and try again."));
        panel.firstElementChild.append(button("Retry", "secondary", () => load(false)));
      }
    } finally {
      busy = false;
      $("#platform-admin-refresh").disabled = false;
    }
  }
  $("#platform-admin-refresh").addEventListener("click", () => load(false));
  load();
})();