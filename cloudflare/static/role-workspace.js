(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const role = document.body.dataset.role || "";
  const roleNames = {
    student: "Student", teacher: "Teacher", secretary: "Secretary",
    bursar: "Bursar", parent: "Parent",
  };
  const roleAliases = {
    student: ["student", "learner", "individual"],
    teacher: ["teacher", "teacher_staff", "teacher_independent"],
    secretary: ["secretary", "headteacher", "head_teacher", "school", "school_admin"],
    bursar: ["bursar", "accountant"],
    parent: ["parent", "guardian"],
  };
  const state = { session: null, workspace: null, syncAt: "", loading: false };
  const content = $("#workspace-content");
  const statusNode = $("#workspace-status");
  const syncButton = $("#sync-now");

  function value(obj, ...keys) {
    if (!obj || typeof obj !== "object") return undefined;
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
    }
    return undefined;
  }
  function text(obj, ...keys) {
    const result = value(obj, ...keys);
    return result === undefined ? "" : String(result);
  }
  function array(...keys) {
    const root = state.workspace || {};
    const sources = [root, root.finance, root.workspace, root.workspace && root.workspace.finance];
    for (const source of sources) {
      for (const key of keys) {
        const found = value(source, key);
        if (Array.isArray(found)) return found;
      }
    }
    return [];
  }
  function normalizeRole(input) {
    return String(input || "").trim().toLowerCase().replace(/[ -]+/g, "_");
  }
  function matchesRole(input) {
    const normalized = normalizeRole(input);
    return (roleAliases[role] || [role]).includes(normalized);
  }
  function setStatus(message, kind = "") {
    statusNode.textContent = message;
    statusNode.className = kind;
  }
  function safeDate(input) {
    if (!input) return "";
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? String(input) : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
  }
  function money(input) {
    if (input === undefined || input === null || input === "") return "";
    const number = Number(input);
    return Number.isFinite(number)
      ? `UGX ${new Intl.NumberFormat("en-UG", { maximumFractionDigits: 0 }).format(number)}`
      : String(input);
  }
  function el(tag, className, contentText) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (contentText !== undefined && contentText !== null) node.textContent = String(contentText);
    return node;
  }
  function button(label, className = "rw-button", handler) {
    const node = el("button", className, label);
    node.type = "button";
    if (handler) node.addEventListener("click", handler);
    return node;
  }
  function section(title, subtitle, items, renderItem, emptyTitle = "Nothing to show yet", emptyCopy = "Records will appear here when they are available.") {
    const wrap = el("section", "rw-section");
    const heading = el("div", "rw-section-heading");
    const titleWrap = document.createElement("div");
    titleWrap.append(el("h2", "", title));
    if (subtitle) titleWrap.append(el("p", "", subtitle));
    heading.append(titleWrap, el("span", "rw-count", `${items.length} ${items.length === 1 ? "record" : "records"}`));
    wrap.append(heading);
    if (!items.length) {
      const empty = el("div", "rw-empty");
      empty.append(el("strong", "", emptyTitle), el("p", "", emptyCopy));
      wrap.append(empty);
      return wrap;
    }
    const list = el("div", "rw-list");
    items.slice(0, 150).forEach((item) => list.append(renderItem(item)));
    wrap.append(list);
    return wrap;
  }
  function record(title, meta = [], badge = "", badgeClass = "", detail = "") {
    const row = el("article", "rw-record");
    const main = el("div", "rw-record-main");
    main.append(el("strong", "rw-record-title", title || "School record"));
    const info = meta.filter(Boolean);
    if (info.length) {
      const line = el("div", "rw-record-meta");
      info.forEach((part) => line.append(el("span", "", part)));
      main.append(line);
    }
    if (detail) main.append(el("p", "rw-record-detail", detail));
    row.append(main);
    if (badge) row.append(el("span", `rw-badge ${badgeClass}`.trim(), badge));
    return row;
  }
  function scoreOf(item) {
    const raw = value(item, "score", "mark", "scoreValue", "score_value", "marks");
    return raw === undefined ? NaN : Number(raw);
  }
  function markRecord(item) {
    const score = scoreOf(item);
    const title = text(item, "subject", "subjectName", "subject_name", "title") || "Academic mark";
    const meta = [text(item, "term", "termName", "term_name"), safeDate(value(item, "date", "createdAt", "created_at"))].filter(Boolean);
    const badge = Number.isFinite(score) ? `${score}%${score < 50 ? " · WEAK" : ""}` : text(item, "grade", "gradeName", "grade_name");
    const row = record(title, meta, badge, Number.isFinite(score) && score < 50 ? "weak" : "");
    return row;
  }
  function attendanceRecord(item) {
    const status = text(item, "status", "attendanceStatus", "attendance_status");
    const className = text(item, "className", "class_name");
    return record(className ? `Attendance · ${className}` : "Attendance", [safeDate(value(item, "date", "attendanceDate", "attendance_date"))], status, normalizeRole(status));
  }
  function financeRecord(item, kind) {
    const title = text(item, "description", "title", "period", "reference", "receiptNumber", "receipt_number", "name")
      || `${kind} record`;
    const amount = value(item, "amount", "balance", "total", "openingBalance", "opening_balance");
    const date = safeDate(value(item, "date", "dueDate", "due_date", "createdAt", "created_at", "period"));
    const status = text(item, "status", "paymentStatus", "payment_status");
    return record(title, [amount !== undefined ? money(amount) : "", date].filter(Boolean), status, normalizeRole(status));
  }
  function assignmentRecord(item) {
    const cls = text(item, "className", "class_name", "class");
    const subject = text(item, "subject", "subjectName", "subject_name");
    return record(subject || cls || "Teaching assignment", [cls && subject ? `Class ${cls}` : "", text(item, "teacherName", "teacher_name")].filter(Boolean));
  }
  function studentLabel(student) {
    return text(student, "name", "studentName", "student_name", "fullName", "full_name") || "Learner";
  }
  function studentRecord(student) {
    return record(studentLabel(student), [
      text(student, "studentNumber", "student_number") ? `No. ${text(student, "studentNumber", "student_number")}` : "",
      text(student, "className", "class_name") ? `Class ${text(student, "className", "class_name")}` : "",
      text(student, "id") ? `ID ${text(student, "id")}` : "",
    ].filter(Boolean));
  }
  function verifiedYoutubeUrl(raw) {
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.toLowerCase();
      return parsed.protocol === "https:" && (
        host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")
      ) ? parsed.href : "";
    } catch { return ""; }
  }
  function lessonRecord(item) {
    const title = text(item, "title", "name") || "Lesson";
    const subject = text(item, "subject", "subjectName", "subject_name");
    const className = text(item, "className", "class_name");
    const youtubeUrl = verifiedYoutubeUrl(text(item, "youtubeUrl", "youtube_url"));
    const row = record(title, [
      subject ? `Subject: ${subject}` : "",
      className ? `Class: ${className}` : "",
      text(item, "date", "createdAt", "created_at") ? safeDate(value(item, "date", "createdAt", "created_at")) : "",
    ].filter(Boolean), youtubeUrl ? "YouTube Lesson" : "", youtubeUrl ? "video" : "", text(item, "description"));
    const main = $(".rw-record-main", row);
    if (youtubeUrl) {
      const link = document.createElement("a");
      link.className = "rw-inline-link";
      link.href = youtubeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open YouTube Lesson";
      main.append(link);
    }
    const files = value(item, "files");
    if (Array.isArray(files) && files.length) {
      const fileList = el("div", "rw-record-meta");
      files.forEach((file) => {
        const fileName = text(file, "fileName", "file_name", "name") || "Lesson resource";
        const contentType = text(file, "contentType", "content_type", "mimeType", "mime_type").toLowerCase();
        const isPdf = contentType.includes("pdf") || fileName.toLowerCase().endsWith(".pdf");
        if (isPdf && value(item, "id") && value(file, "id")) {
          const link = document.createElement("a");
          link.href = `/api/school/lessons/${encodeURIComponent(value(item, "id"))}/files/${encodeURIComponent(value(file, "id"))}`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = `PDF · ${fileName}`;
          fileList.append(link);
        } else {
          fileList.append(el("span", "", fileName));
        }
      });
      main.append(fileList);
    }
    if (role === "teacher" && value(item, "id")) main.append(fileUploadForm(item));
    return row;
  }
  function setAuthState(title, copy, linkText = "Go to sign in") {
    content.replaceChildren();
    const panel = el("section", "rw-auth-state");
    panel.setAttribute("aria-labelledby", "access-state-title");
    panel.append(el("h2", "", title), el("p", "", copy));
    const link = document.createElement("a");
    link.className = "rw-button";
    link.href = "/#account-access";
    link.textContent = linkText;
    panel.append(link);
    content.append(panel);
    $("#role-badge").textContent = "Access check";
  }
  function showLoading() {
    content.replaceChildren();
    const short = el("div", "rw-skeleton short");
    const grid = el("div", "rw-grid");
    grid.append(el("div", "rw-skeleton"), el("div", "rw-skeleton"));
    content.append(short, grid);
  }
  function renderStats(entries) {
    const grid = el("div", "rw-grid three");
    entries.forEach(({ label, value: number, note }) => {
      const card = el("article", "rw-card rw-stat");
      card.append(el("span", "rw-stat-label", label), el("strong", "rw-stat-value", number), el("span", "rw-stat-note", note || ""));
      grid.append(card);
    });
    return grid;
  }
  function fieldCard(title, subtitle, inner) {
    const card = el("section", "rw-card");
    const header = el("div", "rw-card-header");
    const copy = document.createElement("div");
    copy.append(el("h3", "", title));
    if (subtitle) copy.append(el("p", "rw-card-subtitle", subtitle));
    header.append(copy);
    card.append(header, inner);
    return card;
  }
  function listInside(items, renderer, emptyMessage = "No records are available.") {
    if (!items.length) {
      const empty = el("div", "rw-empty");
      empty.append(el("strong", "", "No records yet"), el("p", "", emptyMessage));
      return empty;
    }
    const list = el("div", "rw-list");
    items.slice(0, 60).forEach((item) => list.append(renderer(item)));
    return list;
  }

  function renderStudent() {
    const student = value(state.workspace, "student", "learner");
    const marks = array("marks", "academicRecords", "academic_records", "academicMarks", "academic_marks");
    const attendance = array("attendance", "attendanceRecords", "attendance_records");
    const fees = array("fees", "feeRecords", "fee_records");
    const statements = array("statements", "feeStatements", "fee_statements");
    const subjects = array("subjects");
    const lessons = array("lessons");
    const name = student ? studentLabel(student) : "Student";
    const className = student ? text(student, "className", "class_name") : "";
    content.replaceChildren();
    content.append(renderStats([
      { label: "My class", value: className || "Not linked", note: student ? "Your current class record" : "Ask school staff to link your learner record" },
      { label: "Academic records", value: String(marks.length), note: "Marks available to you" },
      { label: "Attendance records", value: String(attendance.length), note: "Recorded school days" },
    ]));
    const identity = student ? [studentRecord(student)] : [];
    content.append(section("My school record", "Your linked learner profile", identity, (item) => item, "Learner record not linked", "This account is not linked to a student record yet. Ask your school secretary to connect your account."));
    content.append(section("My marks", "Academic progress by subject and term", marks, markRecord, "No marks recorded yet", "Marks will appear here when your school records them."));
    content.append(section("My attendance", "Your recorded attendance", attendance, attendanceRecord));
    content.append(section("My subjects", "Subjects available in your school workspace", subjects, (item) => {
      const subject = text(item, "name", "subject", "subjectName", "subject_name") || "Subject";
      const subjectClass = text(item, "className", "class_name", "class");
      return record(subject, subjectClass ? [`Class ${subjectClass}`] : []);
    }, "No subject records yet", "Your subjects will appear here when your school records them."));
    content.append(section("Lessons", "Class learning and shared resources", lessons, lessonRecord));
    const finance = el("div", "rw-grid");
    finance.append(fieldCard("My fees", "School charges and balances", listInside(fees, (item) => financeRecord(item, "Fee"), "Your fee records will appear here when available.")));
    finance.append(fieldCard("My statements", "Fee statement records", listInside(statements, (item) => financeRecord(item, "Statement"), "Your statements will appear here when available.")));
    content.append(finance);
    $("#workspace-title").textContent = student ? `Welcome, ${name}` : "Your learning space";
  }

  function renderTeacher() {
    const assignments = array("teacherAssignments", "teacher_assignments", "assignments");
    const lessons = array("lessons");
    const classes = array("classes");
    const subjects = array("subjects");
    content.replaceChildren();
    const assignGrid = el("div", "rw-grid");
    assignGrid.append(fieldCard("Assigned classes and subjects", "Only the class and subject pairs linked to your account are available for lesson creation.", listInside(assignments, assignmentRecord)));
    const classList = classes.length ? classes.map((item) => text(item, "name", "className", "class_name")).filter(Boolean) : [...new Set(assignments.map((item) => text(item, "className", "class_name")).filter(Boolean))];
    const subjectList = subjects.length ? subjects.map((item) => text(item, "name", "subject", "subjectName", "subject_name")).filter(Boolean) : [...new Set(assignments.map((item) => text(item, "subject", "subjectName", "subject_name")).filter(Boolean))];
    assignGrid.append(fieldCard("Class and subject directory", `${classList.length} classes · ${subjectList.length} subjects`, (() => {
      const area = el("div", "rw-list");
      [...classList.map((name) => ["Class", name]), ...subjectList.map((name) => ["Subject", name])].forEach(([kind, name]) => area.append(record(name, [kind])));
      if (!classList.length && !subjectList.length) area.append(el("div", "rw-empty", "No class or subject records are available yet."));
      return area;
    })()));
    content.append(assignGrid);
    content.append(teacherLessonForm(assignments));
    const teacherActions = el("div", "rw-grid");
    if (hasCapability("marks.manage")) {
      const classChoices = [...new Set(assignments.map((item) => text(item, "className", "class_name")).filter(Boolean))];
      const subjectChoices = [...new Set(assignments.map((item) => text(item, "subject", "subjectName", "subject_name")).filter(Boolean))];
      teacherActions.append(genericForm("Record a mark", "Save mark", "/api/school/academic/marks", [
        { name: "learnerId", label: "Learner ID or student number", required: true, maxLength: 160 },
        { name: "className", label: "Assigned class", type: "select", required: true, options: classChoices },
        { name: "subject", label: "Assigned subject", type: "select", required: true, options: subjectChoices },
        { name: "score", label: "Score (%)", type: "number", required: true, min: 0, max: 100, step: "0.01" },
        { name: "term", label: "Term", required: false, maxLength: 80 },
      ], (values) => ({ ...values, score: Number(values.score) })));
    }
    if (hasCapability("attendance.manage")) {
      const classChoices = [...new Set(assignments.map((item) => text(item, "className", "class_name")).filter(Boolean))];
      teacherActions.append(genericForm("Record attendance", "Save attendance", "/api/school/attendance", [
        { name: "learnerId", label: "Learner ID or student number", required: true, maxLength: 160 },
        { name: "className", label: "Assigned class", type: "select", required: true, options: classChoices },
        { name: "date", label: "Date", type: "date", required: true },
        { name: "status", label: "Status", type: "select", required: true, options: ["present", "absent", "late", "excused"] },
      ]));
    }
    if (teacherActions.childElementCount) content.append(teacherActions);
    content.append(section("Lessons and PDF resources", "Lessons created for your assigned learning groups", lessons, lessonRecord, "No lessons available yet", assignments.length ? "Create a lesson above to share class details and PDF resources." : "No teaching assignment is linked to this account yet. Ask your school administrator to assign a class and subject."));
    $("#workspace-title").textContent = "Your teaching desk";
  }

  function teacherLessonForm(assignments) {
    const options = [...new Map(assignments.map((item) => {
      const className = text(item, "className", "class_name");
      const subject = text(item, "subject", "subjectName", "subject_name");
      return [`${className}\u0000${subject}`, { className, subject }];
    }).filter(([, item]) => item.className && item.subject))];
    const card = el("section", "rw-card");
    const header = el("div", "rw-card-header");
    const copy = document.createElement("div");
    copy.append(el("h3", "", "Create a lesson"), el("p", "rw-card-subtitle", "Choose one of your assigned class and subject pairs."));
    header.append(copy);
    card.append(header);
    if (!options.length) {
      card.append(el("div", "rw-empty", "Lesson creation becomes available after your class and subject assignment is linked."));
      return card;
    }
    const form = el("form", "rw-form");
    const title = field("Lesson title", "title", "text", true);
    title.input.maxLength = 180;
    const pair = field("Assigned class and subject", "pair", "select", true);
    const initial = document.createElement("option");
    initial.value = "";
    initial.textContent = "Choose assignment";
    pair.input.append(initial);
    options.forEach(([key, assignment]) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = `${assignment.className} · ${assignment.subject}`;
      pair.input.append(option);
    });
    const description = field("Description", "description", "textarea", false);
    description.input.maxLength = 3000;
    const youtube = field("YouTube URL (optional)", "youtubeUrl", "url", false);
    youtube.input.placeholder = "https://www.youtube.com/watch?v=…";
    const file = field("PDF resource (optional)", "file", "file", false);
    file.input.accept = "application/pdf,.pdf";
    const help = el("span", "rw-help", "PDF upload is attached after the lesson is created. You can also add a PDF to an existing lesson.");
    file.wrap.append(help);
    [title.wrap, pair.wrap, description.wrap, youtube.wrap, file.wrap].forEach((node) => form.append(node));
    const actions = el("div", "rw-form-actions");
    const submit = el("button", "rw-button", "Create lesson");
    submit.type = "submit";
    const feedback = el("span", "rw-help");
    feedback.setAttribute("role", "status");
    actions.append(submit, feedback);
    form.append(actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const chosen = options.find(([key]) => key === pair.input.value)?.[1];
      if (!chosen) { pair.input.focus(); feedback.textContent = "Choose an assigned class and subject."; return; }
      const rawYoutubeUrl = youtube.input.value.trim();
      if (rawYoutubeUrl && !verifiedYoutubeUrl(rawYoutubeUrl)) {
        youtube.input.focus();
        feedback.textContent = "Use a valid HTTPS link from YouTube.";
        return;
      }
      submit.disabled = true;
      feedback.textContent = "Saving lesson…";
      try {
        const created = await request("/api/school/lessons", {
          method: "POST",
          body: JSON.stringify({
            title: title.input.value.trim(),
            description: description.input.value.trim(),
            className: chosen.className,
            subject: chosen.subject,
            youtubeUrl: rawYoutubeUrl,
          }),
        });
        const container = value(created, "lesson", "data") || created;
        const lesson = value(container, "lesson", "data") || container;
        const lessonId = value(lesson, "id", "lessonId", "lesson_id");
        if (file.input.files && file.input.files[0]) {
          if (!lessonId) throw new Error("Lesson was created, but the response did not include its ID. Add the PDF from the lesson list after refreshing.");
          await uploadLessonFile(lessonId, file.input.files[0]);
        }
        form.reset();
        feedback.textContent = "Lesson saved.";
        await loadWorkspace(false);
      } catch (error) {
        feedback.textContent = error.message || "The lesson could not be saved.";
      } finally { submit.disabled = false; }
    });
    card.append(form);
    return card;
  }
  function field(labelText, name, type, required) {
    const wrap = el("div", "rw-field");
    if (name === "description" || name === "file") wrap.classList.add("full");
    const label = el("label", "", labelText);
    const input = type === "textarea" ? document.createElement("textarea") : type === "select" ? document.createElement("select") : document.createElement("input");
    input.name = name;
    input.id = `rw-${name}-${Math.random().toString(36).slice(2, 8)}`;
    input.required = required;
    if (type !== "textarea" && type !== "select") input.type = type;
    label.htmlFor = input.id;
    wrap.append(label, input);
    return { wrap, input };
  }
  async function uploadLessonFile(lessonId, file) {
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") throw new Error("Choose a PDF file.");
    const payload = new FormData();
    payload.append("file", file);
    await request(`/api/school/lessons/${encodeURIComponent(lessonId)}/files`, { method: "POST", body: payload });
  }
  function fileUploadForm(lesson) {
    const form = el("form", "rw-form");
    form.style.marginTop = "10px";
    const file = field("Add PDF", "file", "file", true);
    file.input.accept = "application/pdf,.pdf";
    const actions = el("div", "rw-form-actions");
    const submit = el("button", "rw-button secondary", "Upload PDF");
    submit.type = "submit";
    const feedback = el("span", "rw-help");
    feedback.setAttribute("role", "status");
    actions.append(submit, feedback);
    form.append(file.wrap, actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!file.input.files || !file.input.files[0]) { file.input.focus(); return; }
      submit.disabled = true;
      feedback.textContent = "Uploading…";
      try {
        await uploadLessonFile(value(lesson, "id"), file.input.files[0]);
        feedback.textContent = "PDF uploaded.";
        await loadWorkspace(false);
      } catch (error) { feedback.textContent = error.message || "Upload failed."; }
      finally { submit.disabled = false; }
    });
    return form;
  }

  function renderSecretary() {
    const learners = array("students", "learners");
    const classes = array("classes");
    const subjects = array("subjects");
    const attendance = array("attendance", "attendanceRecords", "attendance_records");
    const marks = array("marks", "academicRecords", "academic_records");
    const links = array("parentLinks", "parent_links");
    content.replaceChildren();
    content.append(renderStats([
      { label: "Learners", value: String(learners.length), note: "Student records in this school scope" },
      { label: "Classes", value: String(classes.length), note: "School class directory" },
      { label: "Parent links", value: String(links.length), note: "Guardian access links" },
    ]));
    content.append(parentLinkManager(learners, links));
    const actions = el("div", "rw-grid");
    if (hasCapability("students.manage") || hasCapability("students.secondary.manage")) {
      actions.append(genericForm("Add learner", "Add learner", "/api/school/learners", [
        { name: "name", label: "Learner name", required: true, maxLength: 160 },
        { name: "studentNumber", label: "Student number", required: true, maxLength: 80 },
        { name: "className", label: "Class", required: false, maxLength: 100 },
        { name: "studentEmail", label: "Student account email (optional)", type: "email", required: false, maxLength: 200 },
      ]));
    }
    if (hasCapability("classes.manage") || normalizeRole(value(state.workspace, "role")) === "secretary") {
      actions.append(genericForm("Add class", "Add class", "/api/school/classes", [
        { name: "name", label: "Class name", required: true, maxLength: 100 },
        { name: "level", label: "Level", required: false, maxLength: 80 },
        { name: "academicYear", label: "Academic year", required: false, maxLength: 40 },
      ]));
    }
    if (hasCapability("subjects.manage") || normalizeRole(value(state.workspace, "role")) === "secretary") {
      actions.append(genericForm("Add subject", "Add subject", "/api/school/subjects", [
        { name: "name", label: "Subject", required: true, maxLength: 120 },
        { name: "code", label: "Subject code", required: false, maxLength: 40 },
        { name: "className", label: "Class", required: false, maxLength: 100 },
      ]));
    }
    if (hasCapability("attendance.manage")) {
      actions.append(genericForm("Record attendance", "Save attendance", "/api/school/attendance", [
        { name: "learnerId", label: "Learner ID or student number", required: true, maxLength: 160 },
        { name: "className", label: "Class", required: true, maxLength: 100 },
        { name: "date", label: "Date", type: "date", required: true },
        { name: "status", label: "Status", type: "select", required: true, options: ["present", "absent", "late", "excused"] },
      ]));
    }
    if (hasCapability("marks.manage")) {
      actions.append(genericForm("Record a mark", "Save mark", "/api/school/academic/marks", [
        { name: "learnerId", label: "Learner ID or student number", required: true, maxLength: 160 },
        { name: "className", label: "Class", required: false, maxLength: 100 },
        { name: "subject", label: "Subject", required: true, maxLength: 120 },
        { name: "score", label: "Score (%)", type: "number", required: true, min: 0, max: 100, step: "0.01" },
        { name: "term", label: "Term", required: false, maxLength: 80 },
      ], (values) => ({ ...values, score: Number(values.score) })));
    }
    if (actions.childElementCount) content.append(actions);
    const grid = el("div", "rw-grid");
    grid.append(fieldCard("Learners", "Student identity and class placement", listInside(learners, studentRecord)));
    grid.append(fieldCard("Classes and subjects", `${classes.length} classes · ${subjects.length} subjects`, (() => {
      const list = el("div", "rw-list");
      classes.forEach((item) => list.append(record(text(item, "name", "className", "class_name") || "Class", [text(item, "level", "academicYear", "academic_year")].filter(Boolean))));
      subjects.forEach((item) => list.append(record(text(item, "name", "subject", "subjectName", "subject_name") || "Subject", [text(item, "code", "className", "class_name")].filter(Boolean))));
      if (!classes.length && !subjects.length) list.append(el("div", "rw-empty", "No class or subject records are available."));
      return list;
    })()));
    content.append(grid);
    content.append(section("Attendance records", "School attendance activity", attendance, attendanceRecord));
    content.append(section("Academic records", "Marks recorded for learners", marks, markRecord));
    $("#workspace-title").textContent = "School operations";
  }
  function parentLinkManager(learners, links) {
    const card = el("section", "rw-card");
    const header = el("div", "rw-card-header");
    const copy = document.createElement("div");
    copy.append(el("h3", "", "Parent–child links"), el("p", "rw-card-subtitle", "Connect a guardian account to a learner record in this school."));
    header.append(copy);
    card.append(header);
    const form = el("form", "rw-form");
    const email = field("Parent email address", "parentEmail", "email", true);
    email.input.maxLength = 320;
    let learnerField;
    if (learners.length) {
      learnerField = field("Learner", "learnerId", "select", true);
      const prompt = document.createElement("option");
      prompt.value = "";
      prompt.textContent = "Choose learner";
      learnerField.input.append(prompt);
      learners.forEach((learner) => {
        const id = value(learner, "id", "learnerId", "learner_id");
        if (id === undefined) return;
        const option = document.createElement("option");
        option.value = String(id);
        option.textContent = `${studentLabel(learner)}${text(learner, "studentNumber", "student_number") ? ` · ${text(learner, "studentNumber", "student_number")}` : ""}`;
        learnerField.input.append(option);
      });
    } else {
      learnerField = field("Learner ID", "learnerId", "text", true);
      learnerField.input.maxLength = 160;
    }
    const relationship = field("Relationship", "relationship", "text", true);
    relationship.input.maxLength = 80;
    relationship.input.placeholder = "Parent, guardian, caregiver";
    const action = el("div", "rw-form-actions");
    const submit = el("button", "rw-button", "Create parent link");
    submit.type = "submit";
    const feedback = el("span", "rw-help");
    feedback.setAttribute("role", "status");
    action.append(submit, feedback);
    form.append(email.wrap, learnerField.wrap, relationship.wrap, action);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      feedback.textContent = "Saving link…";
      try {
        await request("/api/school/parent-links", {
          method: "POST",
          body: JSON.stringify({
            parentEmail: email.input.value.trim(),
            learnerId: learnerField.input.value.trim(),
            relationship: relationship.input.value.trim(),
          }),
        });
        form.reset();
        feedback.textContent = "Parent link created.";
        await loadWorkspace(false);
      } catch (error) { feedback.textContent = error.message || "The parent link could not be saved."; }
      finally { submit.disabled = false; }
    });
    card.append(form);
    const linkSection = section("Current parent links", "", links, (item) => {
      const parentEmail = text(item, "parentEmail", "parent_email");
      const learnerId = text(item, "learnerId", "learner_id");
      const learner = learners.find((entry) => String(value(entry, "id", "learnerId", "learner_id")) === learnerId);
      const row = record(parentEmail || "Parent link", [
        learner ? studentLabel(learner) : learnerId ? `Learner ID ${learnerId}` : "",
        text(item, "relationship"),
      ].filter(Boolean), text(item, "status"), normalizeRole(text(item, "status")));
      const linkId = value(item, "id");
      if (linkId !== undefined) {
        const remove = button("Remove", "rw-button danger");
        remove.addEventListener("click", async () => {
          if (!window.confirm("Remove this parent–child link?")) return;
          remove.disabled = true;
          try {
            await request(`/api/school/parent-links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
            await loadWorkspace(false);
          } catch (error) { setStatus(error.message || "Unable to remove parent link.", "error"); remove.disabled = false; }
        });
        row.append(remove);
      }
      return row;
    }, "No parent links yet", "Add a link above to connect a guardian with a learner.");
    card.append(linkSection);
    return card;
  }

  function renderBursar() {
    const fees = array("fees", "feeRecords", "fee_records");
    const payments = array("payments");
    const statements = array("statements", "feeStatements", "fee_statements");
    const reconciliations = array("reconciliations", "reconciliation");
    const amountTotal = (items, ...keys) => items.reduce((total, item) => {
      const amount = Number(value(item, ...keys));
      return Number.isFinite(amount) ? total + amount : total;
    }, 0);
    content.replaceChildren();
    content.append(renderStats([
      { label: "Fee records", value: String(fees.length), note: "Charges in the available school records" },
      { label: "Payments", value: String(payments.length), note: "Recorded payment entries" },
      { label: "Payments recorded", value: money(amountTotal(payments, "amount", "total")) || "UGX 0", note: "Sum of amounts currently returned by the workspace" },
    ]));
    const finance = el("div", "rw-grid");
    finance.append(fieldCard("Fees", "Fee records and due dates", listInside(fees, (item) => financeRecord(item, "Fee"))));
    finance.append(fieldCard("Payments", "Payment and receipt activity", listInside(payments, (item) => financeRecord(item, "Payment"))));
    finance.append(fieldCard("Statements", "Learner account statements", listInside(statements, (item) => financeRecord(item, "Statement"))));
    finance.append(fieldCard("Reconciliation", "Reconciliation notes and records", listInside(reconciliations, (item) => financeRecord(item, "Reconciliation"))));
    content.append(finance);
    const financeActions = el("div", "rw-grid");
    if (hasCapability("fees.manage")) {
      financeActions.append(genericForm("Add fee record", "Save fee", "/api/school/bursar/fees", [
        { name: "learnerId", label: "Learner ID", required: true, maxLength: 160 },
        { name: "description", label: "Fee description", required: true, maxLength: 160 },
        { name: "amount", label: "Amount (UGX)", type: "number", required: true, min: 1, step: "1" },
        { name: "dueDate", label: "Due date", type: "date", required: true },
      ], (values) => ({ ...values, amount: Number(values.amount) })));
    }
    if (hasCapability("payments.manage")) {
      financeActions.append(genericForm("Record a pending payment", "Record payment", "/api/school/bursar/payments", [
        { name: "amount", label: "Amount (UGX)", type: "number", required: true, min: 1, step: "1" },
        { name: "idempotencyKey", label: "Receipt or unique reference", required: true, maxLength: 200 },
      ], (values) => ({ ...values, amount: Number(values.amount) })));
    }
    if (hasCapability("statements.manage")) {
      financeActions.append(genericForm("Create statement", "Save statement", "/api/school/bursar/statements", [
        { name: "learnerId", label: "Learner ID", required: true, maxLength: 160 },
        { name: "period", label: "Statement period", required: true, maxLength: 80 },
        { name: "openingBalance", label: "Opening balance (UGX)", type: "number", required: true, min: 0, step: "1" },
        { name: "balance", label: "Closing balance (UGX)", type: "number", required: true, min: 0, step: "1" },
      ], (values) => ({ ...values, openingBalance: Number(values.openingBalance), balance: Number(values.balance) })));
    }
    if (hasCapability("reconciliation.manage")) {
      financeActions.append(genericForm("Add reconciliation note", "Save note", "/api/school/bursar/reconciliation", [
        { name: "title", label: "Title", required: true, maxLength: 160 },
        { name: "reference", label: "Statement or receipt reference", required: true, maxLength: 160 },
        { name: "notes", label: "Notes", type: "textarea", required: false, maxLength: 1000 },
      ]));
    }
    if (financeActions.childElementCount) content.append(financeActions);
    $("#workspace-title").textContent = "Fees and accounts";
  }

  function hasCapability(capability) {
    const capabilities = value(state.workspace, "capabilities");
    return Array.isArray(capabilities) && capabilities.some((item) => item === capability || item === "*");
  }
  function genericForm(title, submitText, endpoint, definitions, mapper) {
    const card = el("section", "rw-card");
    const header = el("div", "rw-card-header");
    const copy = document.createElement("div");
    copy.append(el("h3", "", title), el("p", "rw-card-subtitle", "Submitted to the APSHULE school workspace."));
    header.append(copy);
    card.append(header);
    const form = el("form", "rw-form");
    const controls = {};
    definitions.forEach((definition) => {
      const control = field(definition.label, definition.name, definition.type || "text", definition.required !== false);
      if (definition.type === "textarea") control.input.maxLength = definition.maxLength || 2000;
      else if (definition.type === "select") {
        const prompt = document.createElement("option");
        prompt.value = "";
        prompt.textContent = "Choose an option";
        control.input.append(prompt);
        (definition.options || []).forEach((entry) => {
          const option = document.createElement("option");
          if (typeof entry === "string") {
            option.value = entry;
            option.textContent = entry[0].toUpperCase() + entry.slice(1);
          } else {
            option.value = entry.value;
            option.textContent = entry.label;
          }
          control.input.append(option);
        });
      } else {
        if (definition.maxLength) control.input.maxLength = definition.maxLength;
        if (definition.min !== undefined) control.input.min = String(definition.min);
        if (definition.max !== undefined) control.input.max = String(definition.max);
        if (definition.step !== undefined) control.input.step = String(definition.step);
      }
      if (definition.full) control.wrap.classList.add("full");
      controls[definition.name] = control.input;
      form.append(control.wrap);
    });
    const actions = el("div", "rw-form-actions");
    const submit = el("button", "rw-button", submitText);
    submit.type = "submit";
    const feedback = el("span", "rw-help");
    feedback.setAttribute("role", "status");
    actions.append(submit, feedback);
    form.append(actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = {};
      definitions.forEach((definition) => {
        const current = controls[definition.name].value.trim();
        values[definition.name] = definition.type === "number" && current !== "" ? Number(current) : current;
      });
      submit.disabled = true;
      feedback.textContent = "Saving…";
      try {
        await request(endpoint, { method: "POST", body: JSON.stringify(mapper ? mapper(values) : values) });
        form.reset();
        feedback.textContent = "Saved.";
        await loadWorkspace(false);
      } catch (error) {
        feedback.textContent = error.message || "The record could not be saved.";
      } finally { submit.disabled = false; }
    });
    card.append(form);
    return card;
  }

  function renderParent() {
    const children = array("children");
    content.replaceChildren();
    if (!children.length) {
      const empty = el("section", "rw-section");
      empty.append(el("div", "rw-empty"));
      $(".rw-empty", empty).append(el("strong", "", "No linked children found"), el("p", "", "When a school links your parent account to a learner, their progress and school records will appear here."));
      content.append(empty);
      $("#workspace-title").textContent = "Your family overview";
      return;
    }
    const allMarks = children.flatMap((child) => value(child, "marks", "academicRecords", "academic_records") || []);
    const allAttendance = children.flatMap((child) => value(child, "attendance", "attendanceRecords", "attendance_records") || []);
    content.append(renderStats([
      { label: "Linked learners", value: String(children.length), note: "Children connected to your account" },
      { label: "Academic records", value: String(allMarks.length), note: "Marks across linked learner records" },
      { label: "Attendance records", value: String(allAttendance.length), note: "Recorded days across linked learners" },
    ]));
    children.forEach((child) => {
      const student = value(child, "student", "learner") || {};
      const panel = el("article", "rw-child");
      const header = el("header", "rw-child-head");
      const copy = document.createElement("div");
      const name = studentLabel(student);
      copy.append(el("h3", "", name));
      copy.append(el("p", "", [
        text(student, "studentNumber", "student_number") ? `No. ${text(student, "studentNumber", "student_number")}` : "",
        text(student, "className", "class_name") ? `Class ${text(student, "className", "class_name")}` : "",
        text(child, "relationship") ? text(child, "relationship") : "",
      ].filter(Boolean).join(" · ") || "Linked learner"));
      header.append(copy);
      panel.append(header);
      const rows = el("div", "rw-child-sections");
      const childSections = [
        ["Marks", value(child, "marks", "academicRecords", "academic_records") || [], markRecord],
        ["Attendance", value(child, "attendance", "attendanceRecords", "attendance_records") || [], attendanceRecord],
        ["Fees", value(child, "fees", "feeRecords", "fee_records") || [], (item) => financeRecord(item, "Fee")],
        ["Statements", value(child, "statements", "feeStatements", "fee_statements") || [], (item) => financeRecord(item, "Statement")],
        ["Lessons", value(child, "lessons") || [], lessonRecord],
      ];
      childSections.forEach(([title, items, renderer]) => {
        const subsection = el("section", "rw-subsection");
        subsection.append(el("h4", "", title));
        if (items.length) {
          const list = el("div", "rw-list");
          items.slice(0, 40).forEach((item) => list.append(renderer(item)));
          subsection.append(list);
        } else subsection.append(el("p", "rw-help", `No ${String(title).toLowerCase()} available.`));
        rows.append(subsection);
      });
      panel.append(rows);
      content.append(panel);
    });
    $("#workspace-title").textContent = "Your family overview";
  }

  function updateSyncIndicator(mode = "online") {
    const buttonLabel = syncButton.querySelector(".rw-sync-label");
    const dot = syncButton.querySelector(".rw-sync-dot");
    syncButton.classList.toggle("is-offline", mode === "offline");
    syncButton.classList.toggle("is-error", mode === "error");
    if (dot) dot.setAttribute("aria-label", mode);
    if (buttonLabel) buttonLabel.textContent = `${mode === "offline" ? "Offline" : mode === "error" ? "Sync issue" : "Online"} · ${state.syncAt ? `Last sync ${state.syncAt}` : "Not synced yet"}`;
  }
  function renderWorkspace() {
    const dataRole = value(state.workspace, "role");
    const sessionRole = value(state.session?.user, "role") || value(state.session, "role");
    $("#role-badge").textContent = roleNames[role] || "Workspace";
    $("#workspace-school").textContent = text(state.workspace, "schoolName", "school_name", "institutionName", "institution_name") || "School workspace";
    const scope = [value(state.workspace, "schoolId", "school_id"), value(state.workspace, "institutionId", "institution_id")].filter(Boolean).join(" · ");
    $("#workspace-scope").textContent = scope || "Records are limited to your authorized school scope.";
    $("#workspace-title").textContent = `Your ${roleNames[role].toLowerCase()} workspace`;
    if (dataRole && !matchesRole(dataRole)) {
      setAuthState("This workspace is for another role", `Your account is registered as ${String(dataRole)}. Open the workspace assigned to your account or contact your school administrator.`, "Return to APSHULE");
      setStatus("Role check does not match this route.", "error");
      return;
    }
    if (sessionRole && !matchesRole(sessionRole)) {
      setAuthState("This workspace is for another role", `Your signed-in account has the ${String(sessionRole)} role, not ${roleNames[role]}.`, "Return to APSHULE");
      setStatus("Role check does not match this route.", "error");
      return;
    }
    if (role === "student") renderStudent();
    if (role === "teacher") renderTeacher();
    if (role === "secretary") renderSecretary();
    if (role === "bursar") renderBursar();
    if (role === "parent") renderParent();
    setStatus("Workspace data loaded from APSHULE.", "success");
  }
  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData) && !headers["content-type"]) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", ...options, headers });
    } catch (error) {
      error.offline = true;
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || payload.message || `Request failed (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
  function unpackWorkspace(payload) {
    if (payload && payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) return payload.data;
    if (payload && payload.workspace && typeof payload.workspace === "object" && !Array.isArray(payload.workspace)) return payload.workspace;
    return payload || {};
  }
  function reportError(error) {
    const status = Number(error.status);
    if (status === 401) {
      setAuthState("Sign in to continue", "Your APSHULE session is not active. Sign in with your account to open this school workspace.");
      setStatus("Signed out · authentication is required.", "error");
      $("#role-badge").textContent = "Signed out";
      return;
    }
    if (status === 403) {
      setAuthState("Access not authorized", "Your account is signed in, but the school workspace did not authorize this request. Contact an administrator if you believe this is an error.", "Return to APSHULE");
      setStatus("The server denied access to this workspace.", "error");
      $("#role-badge").textContent = "Not authorized";
      return;
    }
    if (error.offline || !navigator.onLine || error instanceof TypeError) {
      updateSyncIndicator("offline");
      setStatus("Unable to reach APSHULE. You are offline or the connection is unavailable. No changes are queued.", "error");
      const panel = el("section", "rw-auth-state");
      panel.append(el("h2", "", "Connection unavailable"), el("p", "", "Your school records have not been refreshed. Try Sync Now when your connection is available."));
      panel.append(button("Try again", "rw-button", () => loadWorkspace(true)));
      content.replaceChildren(panel);
      return;
    }
    if (status >= 500) {
      setStatus("APSHULE is temporarily unable to load this workspace. Try again shortly.", "error");
    } else {
      setStatus(error.message || "The workspace could not be loaded.", "error");
    }
    const panel = el("section", "rw-auth-state");
    panel.append(el("h2", "", "Workspace could not be loaded"), el("p", "", error.message || "The server returned an unexpected response."));
    panel.append(button("Retry", "rw-button", () => loadWorkspace(true)));
    content.replaceChildren(panel);
  }
  async function loadWorkspace(isSync) {
    if (state.loading) return;
    state.loading = true;
    syncButton.disabled = true;
    if (!isSync) showLoading();
    setStatus(isSync ? "Refreshing your session and school records…" : "Checking your session and loading school records…");
    try {
      const session = await request("/api/auth/session", { method: "GET" });
      const sessionUser = value(session, "user");
      if (session.authenticated === false || session.ok === false || (sessionUser && sessionUser.authenticated === false)) {
        const error = new Error("Sign in is required.");
        error.status = 401;
        throw error;
      }
      state.session = session;
      const payload = await request("/api/school/education-workspace", { method: "GET" });
      state.workspace = unpackWorkspace(payload);
      if (!state.workspace.role && sessionUser && sessionUser.role) state.workspace.role = sessionUser.role;
      state.syncAt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());
      updateSyncIndicator("online");
      renderWorkspace();
    } catch (error) {
      reportError(error);
    } finally {
      state.loading = false;
      syncButton.disabled = false;
    }
  }

  syncButton.addEventListener("click", () => loadWorkspace(true));
  $("#sign-out").addEventListener("click", async () => {
    const signOut = $("#sign-out");
    signOut.disabled = true;
    try { await request("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }); }
    catch { /* The signed-out destination still ends the local session view. */ }
    location.assign("/");
  });
  window.addEventListener("online", () => {
    if (state.workspace) updateSyncIndicator("online");
  });
  window.addEventListener("offline", () => updateSyncIndicator("offline"));
  updateSyncIndicator(navigator.onLine ? "online" : "offline");
  loadWorkspace(false);
})();