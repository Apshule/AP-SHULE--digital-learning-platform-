(() => {
  const primaryNavItems = [
    ["dashboard", "▦", "Dashboard"],
    ["students", "♙", "Students"],
    ["id-cards", "▣", "ID cards"],
    ["reports", "◫", "Report cards"],
    ["attendance", "◌", "Attendance"],
    ["sms", "✉", "Send SMS"],
    ["settings", "⚙", "Settings"],
  ];
  const secondaryNavItems = [
    ["dashboard", "▦", "Dashboard"],
    ["students", "♙", "Students"],
    ["report-cards", "◫", "Report cards"],
    ["marks", "✎", "Mark entry"],
    ["print-settings", "▣", "Print settings"],
    ["attendance", "◌", "Attendance"],
    ["sms", "✉", "Send SMS"],
    ["settings", "⚙", "Settings"],
  ];
  const bursarNavItems = [
    ["dashboard", "▦", "Bursar dashboard"],
    ["fees", "▤", "Fee accounts"],
    ["payments", "↗", "Payments"],
    ["statements", "▥", "Statements"],
    ["settings", "⚙", "Settings"],
  ];
  const sampleStudents = [
    ["ADM20260001", "Jane Nakato", "P4", "Day Scholar", "Active"],
    ["ADM20260006", "Kakooza Abdul", "P1", "Day Scholar", "Active"],
    ["ADM20260008", "Kawoya Moses", "P1", "Day Scholar", "Active"],
    ["0123345", "Kisakye Michael", "P4", "Boarding", "Active"],
  ];
  const secondaryStudents = [
    ["ADM20260021", "Preview Learner A", "S1", "Blue", "Active"],
    ["ADM20260024", "Preview Learner B", "S3", "Green", "Active"],
    ["ADM20260031", "Preview Learner C", "S5", "Arts", "Active"],
    ["ADM20260033", "Preview Learner D", "S6", "Sciences", "Active"],
  ];
  const reportTypes = {
    ncdc: { label: "O-Level NCDC", subtitle: "New curriculum · A1 / U1 / competency levels" },
    old: { label: "O-Level old curriculum", subtitle: "U1-U4 · term test · end-of-term assessment" },
    alevel: { label: "A-Level UACE", subtitle: "Formative / summative · division · project work" },
  };
  const reportRows = {
    ncdc: [
      ["Biology", "3.0", "3.0", "3.0", "100", "A", "Exceptional"],
      ["Agriculture", "2.0", "2.0", "2.0", "66.7", "C", "Average"],
      ["Mathematics", "2.5", "2.0", "2.3", "83.3", "B", "Very good"],
    ],
    old: [
      ["Biology", "2.4", "2.2", "2.6", "2.4", "2.4", "16", "17", "60", "77", "A", "Excellent"],
      ["Chemistry", "1.9", "2.0", "2.1", "2.0", "2.0", "13", "15", "55", "68", "B", "Very good"],
      ["Mathematics", "2.1", "2.2", "2.0", "2.1", "2.1", "14", "14", "54", "68", "B", "Very good"],
    ],
    alevel: [
      ["P530", "Biology", "2.0", "2.6", "3.0", "2.5", "16.9", "60", "46.4", "63.3", "C", "Satisfactory", "B.S."],
      ["P525", "Chemistry", "1.3", "2.0", "2.3", "1.9", "12.7", "78", "60.4", "73.1", "B", "Outstanding", "N.E."],
      ["P425", "Mathematics", "1.9", "2.1", "2.8", "2.3", "15.3", "60", "51.6", "66.9", "C", "Satisfactory", "Y.T."],
    ],
  };
  const previewParams = new URLSearchParams(window.location.search);
  const initialAccount = previewParams.get("account") === "secondary" ? "secondary" : "primary";
  const secondaryViews = ["dashboard", "students", "report-cards", "report-detail", "marks", "print-settings", "attendance", "sms", "settings"];
  const state = {
    account: initialAccount,
    view: initialAccount === "secondary" && secondaryViews.includes(previewParams.get("view") ?? "") ? previewParams.get("view") : "dashboard",
    liveData: null,
    authState: "checking",
    authError: "",
    query: "",
    reportType: "ncdc",
    printStep: 1,
    printSettings: {
      template: "official",
      includePositions: true,
      activities: ["A1", "U1"],
      title: "END OF TERM REPORT",
      classTeacher: "JD",
      headTeacher: "AB",
    },
  };
  const nav = document.getElementById("workspaceNav");
  const content = document.getElementById("workspaceContent");
  const title = document.getElementById("viewTitle");
  const shell = document.querySelector(".app-shell");
  const toast = document.getElementById("toast");
  const printModal = document.getElementById("printSettingsModal");
  const printSettingsContent = document.getElementById("printSettingsContent");
  const printStepper = document.getElementById("printStepper");

  function liveEnabled() {
    return Boolean(state.liveData?.live);
  }

  function isBursar() {
    return state.liveData?.workspace === "bursar" || state.liveData?.role === "bursar";
  }

  function liveLearners(account = state.account) {
    const rows = Array.isArray(state.liveData?.learners) ? state.liveData.learners : [];
    if (!liveEnabled()) return [];
    const level = account === "secondary" ? "secondary" : "primary";
    const matching = rows.filter((row) => row.educationLevel === level);
    return matching.length || !rows.length ? matching : rows;
  }

  function liveRowValues(row) {
    return [
      row.admissionNumber || row.id || "—",
      row.name || "Unnamed learner",
      row.className || "—",
      row.stream || "—",
      row.status || "Active",
    ];
  }

  function liveDashboardView(secondary) {
    const learners = liveLearners(secondary ? "secondary" : "primary");
    const classes = Array.isArray(state.liveData?.classes) ? state.liveData.classes : [];
    const subjects = Array.isArray(state.liveData?.subjects) ? state.liveData.subjects : [];
    const attendance = Array.isArray(state.liveData?.attendance) ? state.liveData.attendance : [];
    const classCounts = classes.reduce((counts, item) => {
      const label = item.name || item.className || item.classLevel || item.level;
      if (label) counts[label] = (counts[label] || 0) + 1;
      return counts;
    }, {});
    const schoolName = escapeHtml(state.liveData?.school?.name || "Authorized school");
    const roleLabel = escapeHtml(state.liveData?.role || "school");
    return `
      <div class="workspace-title"><div><h2>${secondary ? "Secondary dashboard" : "School dashboard"}</h2><p class="muted">${roleLabel} overview · ${schoolName}</p></div><span class="eyebrow">Live school data</span></div>
      <div class="workspace-grid">
        <article class="stat-card"><small>${secondary ? "Secondary learners" : "Authorized learners"}</small><strong>${learners.length}</strong></article>
        <article class="stat-card green"><small>Classes</small><strong>${classes.length}</strong></article>
        <article class="stat-card orange"><small>Attendance records</small><strong>${attendance.length}</strong></article>
        <article class="stat-card violet"><small>Subjects</small><strong>${subjects.length}</strong></article>
      </div>
      <div class="dashboard-columns">
        <article class="panel"><div class="panel-heading"><h3>Authorized school context</h3><span>Read-only</span></div><div class="status-list"><span><i class="online"></i>School profile <b>Loaded</b></span><span><i class="online"></i>Account role <b>${roleLabel}</b></span><span><i class="online"></i>Institution boundary <b>Enforced</b></span></div></article>
        <article class="panel"><div class="panel-heading"><h3>Class register</h3><span>${classes.length} classes</span></div><div class="bar-list">${Object.entries(classCounts).slice(0, 6).map(([name, count]) => `<div><div class="bar-label"><span>${escapeHtml(name)}</span><b>${count}</b></div><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, count * 10)}%"></div></div></div>`).join("") || '<div class="empty-state">No classes are recorded for this school yet.</div>'}</div></article>
      </div>`;
  }

  function bursarMoney(value) {
    return `UGX ${Number(value || 0).toLocaleString("en-UG")}`;
  }

  function bursarDashboardView() {
    const summary = state.liveData?.bursar?.summary || {};
    const schoolName = escapeHtml(state.liveData?.school?.name || "Authorized school");
    return `
      <div class="workspace-title"><div><h2>Bursar dashboard</h2><p class="muted">Fee collection overview · ${schoolName}</p></div><div class="workspace-title-actions"><button class="button light compact" type="button" data-action="open-bursar-reconciliation">Daily reconciliation</button><button class="button primary compact" type="button" data-action="open-bursar-payment">Record payment</button></div></div>
      <div class="workspace-grid">
        <article class="stat-card"><small>Fee accounts</small><strong>${Number(summary.accountCount || 0)}</strong></article>
        <article class="stat-card green"><small>Total collected</small><strong>${escapeHtml(bursarMoney(summary.totalPaid))}</strong></article>
        <article class="stat-card orange"><small>Outstanding balance</small><strong>${escapeHtml(bursarMoney(summary.outstandingBalance))}</strong></article>
        <article class="stat-card violet"><small>Pending payments</small><strong>${Number(summary.pendingPayments || 0)}</strong></article>
      </div>
      <div class="dashboard-columns">
        <article class="panel"><div class="panel-heading"><h3>Collection summary</h3><span>Institution scoped</span></div><div class="status-list"><span><i class="online"></i>Total billed <b>${escapeHtml(bursarMoney(summary.totalDue))}</b></span><span><i class="online"></i>Payments recorded <b>${Number(summary.paymentCount || 0)}</b></span><span><i class="online"></i>Payment total <b>${escapeHtml(bursarMoney(summary.paymentTotal))}</b></span></div></article>
        <article class="panel"><div class="panel-heading"><h3>Bursar controls</h3><span>Institution scoped</span></div><div class="empty-state">Manual payment entry and daily reconciliation are enabled for this bursar account. Provider settlement, receipt export, and month-end close remain separate controls.</div></article>
      </div>`;
  }

  function bursarFeesView() {
    const accounts = Array.isArray(state.liveData?.bursar?.accounts) ? state.liveData.bursar.accounts : [];
    return `<div class="workspace-title"><div><h2>Fee accounts</h2><p class="muted">School fee balances from authorized billing records.</p></div><button class="button primary compact" type="button" data-action="open-bursar-payment">Record payment</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Account</th><th>Learner / payer</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead><tbody>${accounts.map((row) => `<tr><td>${escapeHtml(row.billReference || row.id || "—")}</td><td><strong>${escapeHtml(row.clientName || "—")}</strong></td><td>${escapeHtml(bursarMoney(row.totalAmount))}</td><td>${escapeHtml(bursarMoney(row.amountPaid))}</td><td>${escapeHtml(bursarMoney(row.balanceRemaining))}</td><td><span class="badge ${String(row.status).toLowerCase() === "paid" ? "green" : "gold"}">${escapeHtml(row.status || "unpaid")}</span></td></tr>`).join("") || '<tr><td colspan="6"><div class="empty-state">No authorized fee accounts are recorded yet.</div></td></tr>'}</tbody></table></div>`;
  }

  function bursarPaymentsView() {
    const payments = Array.isArray(state.liveData?.bursar?.payments) ? state.liveData.bursar.payments : [];
    return `<div class="workspace-title"><div><h2>Payments</h2><p class="muted">Payment transactions linked to this institution.</p></div><button class="button primary compact" type="button" data-action="open-bursar-payment">Record payment</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Reference</th><th>Payer</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>${payments.map((row) => `<tr><td>${escapeHtml(row.reference || row.billReference || row.id || "—")}</td><td><strong>${escapeHtml(row.clientName || "—")}</strong></td><td>${escapeHtml(bursarMoney(row.amountPaid))}</td><td><span class="badge ${String(row.status).toLowerCase() === "completed" ? "green" : "gold"}">${escapeHtml(row.status || "pending")}</span></td><td>${escapeHtml(row.paymentDate || "—")}</td></tr>`).join("") || '<tr><td colspan="5"><div class="empty-state">No authorized payments are recorded yet.</div></td></tr>'}</tbody></table></div>`;
  }

  function bursarStatementsView() {
    const summary = state.liveData?.bursar?.summary || {};
    return `<div class="workspace-title"><div><h2>Statements</h2><p class="muted">Current institution-level statement summary.</p></div><span class="eyebrow">Live · read-only</span></div><div class="panel settings-card"><div class="form-field"><label>Total billed</label><input value="${escapeHtml(bursarMoney(summary.totalDue))}" readonly></div><div class="form-field"><label>Total received</label><input value="${escapeHtml(bursarMoney(summary.totalPaid))}" readonly></div><div class="form-field"><label>Outstanding</label><input value="${escapeHtml(bursarMoney(summary.outstandingBalance))}" readonly></div><p class="muted">Statement export and reconciliation remain a later bursar step.</p></div>`;
  }

  function liveRecordsView(titleText, records, emptyText) {
    const rows = Array.isArray(records) ? records : [];
    const columns = [
      ["learnerName", "Learner"],
      ["className", "Class"],
      ["subject", "Subject"],
      ["term", "Term"],
      ["score", "Score"],
      ["average", "Average"],
      ["grade", "Grade"],
      ["status", "Status"],
      ["remark", "Remark"],
    ].filter(([key]) => rows.some((row) => row[key] !== null && row[key] !== undefined && String(row[key]).trim() !== ""));
    const visibleColumns = columns.length ? columns.slice(0, 7) : [["id", "Record"]];
    const table = rows.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr>${visibleColumns.map(([, label]) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${rows.slice(0, 100).map((row) => `<tr>${visibleColumns.map(([key]) => `<td>${escapeHtml(row[key] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
      : `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
    return `<div class="workspace-title"><div><h2>${titleText}</h2><p class="muted">Only records authorized for ${escapeHtml(state.liveData?.school?.name || "this school")} are shown.</p></div><span class="eyebrow">Live · read-only</span></div><div class="panel"><div class="panel-heading"><h3>${rows.length ? `${rows.length} records` : "No records"}</h3><span>Institution scoped</span></div>${table}</div>`;
  }

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[character]));

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2800);
  }

  async function bursarApi(path, options = {}) {
    const user = window.firebase?.auth?.().currentUser;
    if (!user) throw new Error("Your secure school session has expired.");
    const token = await user.getIdToken();
    const base = String(window.APSHULE_API_BASE || "").replace(/\/+$/, "");
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || "The bursar action could not be completed.");
    return payload;
  }

  async function refreshLiveData() {
    const user = window.firebase?.auth?.().currentUser;
    if (!user) return;
    const token = await user.getIdToken();
    const base = String(window.APSHULE_API_BASE || "").replace(/\/+$/, "");
    const response = await fetch(`${base}/api/school/education-workspace`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok || !payload.live) throw new Error(payload.error || "Live records could not be refreshed.");
    state.liveData = payload;
    state.authState = "live";
    render();
  }

  function isSecondary() {
    return state.account === "secondary";
  }

  function getNavItems() {
    if (isBursar()) return bursarNavItems;
    return isSecondary() ? secondaryNavItems : primaryNavItems;
  }

  function renderNav() {
    nav.innerHTML = getNavItems().map(([id, icon, label]) =>
      `<button class="side-link ${state.view === id ? "active" : ""}" type="button" data-view="${id}"><span class="icon">${icon}</span><span>${label}</span></button>`
    ).join("");
  }

  function renderAccountContext() {
    const secondary = isSecondary();
    const bursar = isBursar();
    const schoolName = state.liveData?.school?.name || (secondary ? "Apshule Secondary School" : "Apshule Primary School");
    document.getElementById("toolbarKicker").textContent = bursar ? `Bursar · ${schoolName}` : schoolName;
    document.getElementById("toolbarAvatar").textContent = String(schoolName).trim().charAt(0).toUpperCase() || (secondary ? "H" : "S");
    document.getElementById("workspaceBrandContext").innerHTML = `APSHULE<small>${bursar ? "Bursar" : secondary ? "Secondary" : "Primary"}</small>`;
    const accountSwitcher = document.querySelector(".account-switcher");
    if (accountSwitcher) accountSwitcher.style.display = bursar ? "none" : "";
    const mode = document.getElementById("workspaceModeBadge");
    if (mode) mode.innerHTML = `<i></i> ${state.authState === "checking" ? "Checking access" : liveEnabled() ? "Live" : "Preview"}`;
    const modeText = document.getElementById("educationDataMode");
    if (modeText) modeText.innerHTML = liveEnabled() ? `Live authorized school records · <a href="../">Return to APSHULE</a>` : `Preview data only · <a href="../">Return to APSHULE</a>`;
    const description = document.getElementById("workspaceDescription");
    if (description) description.textContent = liveEnabled()
      ? bursar
        ? `Connected to ${schoolName}. Payments and daily reconciliation are scoped to the signed-in bursar account.`
        : `Connected to ${schoolName}. Records are read-only and scoped to the signed-in school account.`
      : "Use the preview to review the information architecture. Live records remain behind APSHULE’s existing secure sign-in.";
    const notice = document.getElementById("workspaceNotice");
    if (notice) notice.innerHTML = liveEnabled()
      ? `<span class="notice-icon">✓</span><span><strong>${bursar ? "Live bursar workspace." : "Live school workspace."}</strong> ${escapeHtml(schoolName)} records are loaded through your authorized account.${bursar ? " Manual payment entry and daily reconciliation are enabled." : " Bursar and finance controls are not included here."}</span>`
      : `<span class="notice-icon">i</span><span><strong>${state.authState === "checking" ? "Checking secure access." : "Preview mode."}</strong> ${state.authError ? escapeHtml(state.authError) : "The numbers and learner names below are sample content from the supplied prototype, not live school records."}</span>`;
    document.querySelectorAll("[data-account]").forEach((button) => {
      button.classList.toggle("active", button.dataset.account === state.account);
    });
  }

  function dashboardView() {
    if (isBursar()) return bursarDashboardView();
    if (liveEnabled()) return liveDashboardView(false);
    return `
      <div class="workspace-title"><div><h2>Dashboard</h2><p class="muted">Welcome back, Secretary · Apshule Primary</p></div><span class="eyebrow">School overview</span></div>
      <div class="workspace-grid">
        <article class="stat-card"><small>Total learners</small><strong>10</strong></article>
        <article class="stat-card green"><small>Active learners</small><strong>10</strong></article>
        <article class="stat-card orange"><small>Needs attention</small><strong>0</strong></article>
        <article class="stat-card violet"><small>Term completion</small><strong>65%</strong></article>
      </div>
      <div class="dashboard-columns">
        <article class="panel"><div class="panel-heading"><h3>Students by level</h3><span>Current term</span></div><div class="donut-row"><div class="donut"></div><div class="legend"><span><i></i>Nursery <b>1</b></span><span><i class="green"></i>Primary <b>9</b></span><span><i class="purple"></i>Secondary <b>0</b></span></div></div></article>
        <article class="panel"><div class="panel-heading"><h3>Class size distribution</h3><span>10 learners</span></div><div class="bar-list"><div><div class="bar-label"><span>P1</span><b>5</b></div><div class="bar-track"><div class="bar-fill" style="width:50%"></div></div></div><div><div class="bar-label"><span>P4</span><b>3</b></div><div class="bar-track"><div class="bar-fill green" style="width:30%"></div></div></div><div><div class="bar-label"><span>Baby Class</span><b>1</b></div><div class="bar-track"><div class="bar-fill orange" style="width:10%"></div></div></div><div><div class="bar-label"><span>P7</span><b>1</b></div><div class="bar-track"><div class="bar-fill orange" style="width:10%"></div></div></div></div></article>
      </div>
      <div class="dashboard-columns dashboard-secondary">
        <article class="panel"><div class="panel-heading"><h3>Gender distribution</h3><span>Current register</span></div><div class="gender-bars"><div><div class="bar-label"><span>Male</span><b>8 · 80%</b></div><div class="bar-track"><div class="bar-fill" style="width:80%"></div></div></div><div><div class="bar-label"><span>Female</span><b>1 · 10%</b></div><div class="bar-track"><div class="bar-fill pink" style="width:10%"></div></div></div><div><div class="bar-label"><span>Not recorded</span><b>1 · 10%</b></div><div class="bar-track"><div class="bar-fill violet" style="width:10%"></div></div></div></div></article>
        <article class="panel"><div class="panel-heading"><h3>System status & performance</h3><span>Operational</span></div><div class="status-list"><span><i class="online"></i>Database health <b>100%</b></span><span><i class="online"></i>API responsiveness <b>Good</b></span><span><i class="online"></i>Attendance sync <b>Ready</b></span></div><div class="performance-line"><span>Term activity</span><strong>65%</strong><div class="bar-track"><div class="bar-fill violet" style="width:65%"></div></div></div></article>
      </div>`;
  }

  function secondaryDashboardView() {
    if (liveEnabled()) return liveDashboardView(true);
    return `
      <div class="workspace-title"><div><h2>Secondary dashboard</h2><p class="muted">Headteacher overview · Apshule Secondary</p></div><span class="eyebrow">Preview data</span></div>
      <div class="workspace-grid">
        <article class="stat-card"><small>Total secondary learners</small><strong>124</strong></article>
        <article class="stat-card green"><small>O-Level learners</small><strong>92</strong></article>
        <article class="stat-card orange"><small>A-Level learners</small><strong>32</strong></article>
        <article class="stat-card violet"><small>Reports ready</small><strong>78%</strong></article>
      </div>
      <div class="dashboard-columns">
        <article class="panel"><div class="panel-heading"><h3>O-Level and A-Level</h3><span>Current term</span></div><div class="secondary-donut-row"><div class="secondary-donut"></div><div class="legend"><span><i></i>O-Level <b>92</b></span><span><i class="purple"></i>A-Level <b>32</b></span></div></div></article>
        <article class="panel"><div class="panel-heading"><h3>Students by class</h3><span>124 learners</span></div><div class="bar-list"><div><div class="bar-label"><span>S1</span><b>28</b></div><div class="bar-track"><div class="bar-fill" style="width:78%"></div></div></div><div><div class="bar-label"><span>S3</span><b>24</b></div><div class="bar-track"><div class="bar-fill green" style="width:67%"></div></div></div><div><div class="bar-label"><span>S5</span><b>18</b></div><div class="bar-track"><div class="bar-fill orange" style="width:50%"></div></div></div><div><div class="bar-label"><span>S6</span><b>14</b></div><div class="bar-track"><div class="bar-fill violet" style="width:39%"></div></div></div></div></article>
      </div>
      <div class="dashboard-columns dashboard-secondary">
        <article class="panel"><div class="panel-heading"><h3>Streams distribution</h3><span>Secondary register</span></div><div class="stream-pills"><span>Blue <b>42</b></span><span>Green <b>38</b></span><span>Arts <b>21</b></span><span>Sciences <b>23</b></span></div></article>
        <article class="panel"><div class="panel-heading"><h3>Academic readiness</h3><span>Current term</span></div><div class="status-list"><span><i class="online"></i>Marks entered <b>92%</b></span><span><i class="online"></i>Teacher remarks <b>81%</b></span><span><i class="online"></i>Reports approved <b>78%</b></span></div><div class="performance-line"><span>Term completion</span><strong>78%</strong><div class="bar-track"><div class="bar-fill violet" style="width:78%"></div></div></div></article>
      </div>`;
  }

  function studentsView() {
    const query = state.query.toLowerCase();
    const rows = liveEnabled()
      ? liveLearners("primary").map(liveRowValues).filter((student) => student.join(" ").toLowerCase().includes(query))
      : sampleStudents.filter((student) => student.join(" ").toLowerCase().includes(query));
    return `
       <div class="workspace-title"><div><h2>Students</h2><p class="muted">Search and review the school register.</p></div><button class="button primary compact" type="button" data-action="add-student" ${liveEnabled() ? "disabled" : ""}>＋ Add learner</button></div>
      <div class="filter-row"><input id="studentSearch" type="search" value="${escapeHtml(state.query)}" placeholder="Search by name or admission number" aria-label="Search students"><select aria-label="Filter class"><option>All classes</option><option>P1</option><option>P4</option><option>P7</option></select><select aria-label="Filter status"><option>All statuses</option><option>Active</option><option>Inactive</option></select></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Admission</th><th>Name</th><th>Class</th><th>Section</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(([admission, name, studentClass, section, status]) => `<tr><td>${admission}</td><td><strong>${name}</strong></td><td>${studentClass}</td><td><span class="badge gold">${section}</span></td><td><span class="badge green">${status}</span></td><td><button class="button light compact" type="button" data-action="view-student">View</button></td></tr>`).join("") || '<tr><td colspan="6"><div class="empty-state">No learners match this search.</div></td></tr>'}</tbody></table></div>`;
  }

  function secondaryStudentsView() {
    const query = state.query.toLowerCase();
    const rows = liveEnabled()
      ? liveLearners("secondary").map(liveRowValues).filter((student) => student.join(" ").toLowerCase().includes(query))
      : secondaryStudents.filter((student) => student.join(" ").toLowerCase().includes(query));
    return `
       <div class="workspace-title"><div><h2>Secondary students</h2><p class="muted">Review S1-S6 learners, streams, and academic context.</p></div><button class="button primary compact" type="button" data-action="preview-action" ${liveEnabled() ? "disabled" : ""}>＋ Add learner</button></div>
      <div class="filter-row"><input id="studentSearch" type="search" value="${escapeHtml(state.query)}" placeholder="Search by name or admission number" aria-label="Search secondary students"><select aria-label="Filter secondary class"><option>All classes</option><option>S1</option><option>S3</option><option>S5</option><option>S6</option></select><select aria-label="Filter stream"><option>All streams</option><option>Blue</option><option>Green</option><option>Arts</option><option>Sciences</option></select></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Admission</th><th>Name</th><th>Class</th><th>Stream</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(([admission, name, studentClass, stream, status]) => `<tr><td>${admission}</td><td><strong>${name}</strong></td><td>${studentClass}</td><td><span class="badge gold">${stream}</span></td><td><span class="badge green">${status}</span></td><td><button class="button light compact" type="button" data-action="view-student">View</button></td></tr>`).join("") || '<tr><td colspan="6"><div class="empty-state">No secondary learners match this search.</div></td></tr>'}</tbody></table></div>`;
  }

  function idCardsView() {
    return `<div class="workspace-title"><div><h2>Student ID cards</h2><p class="muted">A clear three-step path from class selection to print.</p></div></div><div class="action-grid"><article class="action-card"><span class="eyebrow">Step 01</span><strong>Choose a class</strong><p>Load the learners you want to prepare.</p><button class="button primary compact" data-action="preview-action">Choose class</button></article><article class="action-card"><span class="eyebrow">Step 02</span><strong>Select learners</strong><p>Review the list before creating cards.</p><button class="button light compact" data-action="preview-action">Select learners</button></article><article class="action-card"><span class="eyebrow">Step 03</span><strong>Choose a theme</strong><p>Use a school-ready card design.</p><button class="button light compact" data-action="preview-action">Choose theme</button></article><article class="action-card"><span class="eyebrow">Ready</span><strong>Print or save</strong><p>Prepare a clean PDF for the school office.</p><button class="button light compact" data-action="preview-action">Print cards</button></article></div>`;
  }

  function primaryReportsView() {
    if (liveEnabled()) return liveRecordsView("Primary report cards", state.liveData.reports, "No live report-card records are available for this school yet.");
    return `<div class="workspace-title"><div><h2>Primary report cards</h2><p class="muted">Keep marking, remarks, and report generation in one flow.</p></div><button class="button primary compact" data-action="preview-action">Generate reports</button></div><div class="workspace-grid"><article class="stat-card"><small>Students with marks</small><strong>10</strong></article><article class="stat-card green"><small>Reports generated</small><strong>4</strong></article><article class="stat-card orange"><small>Pending remarks</small><strong>1</strong></article><article class="stat-card violet"><small>Completion rate</small><strong>65%</strong></article></div><div class="action-grid"><article class="action-card"><strong>01 · Mark entry</strong><p>Capture term marks by class and subject.</p><button class="button light compact" data-action="preview-action">Enter marks</button></article><article class="action-card"><strong>02 · Grade & rank</strong><p>Review grades before sharing reports.</p><button class="button light compact" data-action="preview-action">Grade & rank</button></article><article class="action-card"><strong>03 · Remarks</strong><p>Add class-teacher and school remarks.</p><button class="button light compact" data-action="preview-action">Add remarks</button></article><article class="action-card"><strong>04 · View reports</strong><p>Preview, print, or save the final report.</p><button class="button light compact" data-action="preview-action">View reports</button></article></div>`;
  }

  function secondaryReportsView() {
    if (liveEnabled()) return liveRecordsView("Secondary report cards", state.liveData.reports, "No live report-card records are available for this school yet.");
    return `
      <div class="workspace-title"><div><h2>Secondary report cards</h2><p class="muted">Choose a curriculum format before entering marks or preparing a print-ready report.</p></div><span class="eyebrow">Preview workflow</span></div>
      <div class="preview-notice"><span class="notice-icon">i</span><span><strong>Secondary preview.</strong> These examples follow the supplied report-card references. Live marks and private learner records remain behind secure sign-in.</span></div>
      <div class="report-choice-grid">${Object.entries(reportTypes).map(([type, report]) => `<article class="report-choice-card"><span class="report-type-badge">${type === "alevel" ? "UACE" : type === "ncdc" ? "NCDC" : "OLD"}</span><h3>${report.label}</h3><p>${report.subtitle}</p><div class="report-choice-actions"><button class="button primary compact" data-action="open-report" data-report="${type}">Open preview</button><button class="button light compact" data-action="open-print-settings" data-report="${type}">Print settings</button></div></article>`).join("")}</div>
      <div class="panel secondary-boundary-panel"><div class="panel-heading"><h3>Secondary-only access boundary</h3><span>Preview</span></div><div class="boundary-grid"><span>✓ S1-S6 learner records</span><span>✓ O-Level and A-Level marks</span><span>✓ Teacher and headteacher remarks</span><span>✓ Report templates and print settings</span><span>× Primary report cards</span><span>× Finance and payroll</span></div></div>`;
  }

  function reportTable(type) {
    const rows = reportRows[type];
    if (type === "ncdc") {
      return `<div class="report-table-wrap"><table class="report-table"><thead><tr><th>Subject</th><th>A1</th><th>U1</th><th>Avg/3</th><th>/100</th><th>Grade</th><th>Level</th></tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    if (type === "old") {
      return `<div class="report-table-wrap"><table class="report-table wide"><thead><tr><th>Subject</th><th>U1</th><th>U2</th><th>U3</th><th>U4</th><th>AVE</th><th>Pts</th><th>Total/20</th><th>MT</th><th>EOT</th><th>Total 100%</th><th>Grade</th><th>Remark</th></tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    return `<div class="report-table-wrap"><table class="report-table wide"><thead><tr><th>Code</th><th>Subject</th><th>A1</th><th>A2</th><th>A3</th><th>AVG</th><th>20%</th><th>EOT</th><th>80%</th><th>100%</th><th>Grade</th><th>Comment</th><th>TR</th></tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function secondaryReportDetailView() {
    if (liveEnabled()) return liveRecordsView("Secondary report details", state.liveData.reports, "No live report-card details are available for this school yet.");
    const type = state.reportType;
    const report = reportTypes[type];
    const extra = type === "alevel"
      ? `<div class="report-detail-grid"><article class="report-summary-card"><small>Division</small><strong>Division 2</strong><span>Preview result from subject grades.</span></article><article class="report-summary-card"><small>Project work</small><strong>Apiculture · 85%</strong><span>Termly project result.</span></article><article class="report-summary-card"><small>Fees balance</small><strong>Ugx 200,000/=</strong><span>Next term: Ugx 450,000/=</span></article></div>`
      : `<div class="grading-note"><strong>${type === "ncdc" ? "NCDC grading scale" : "Old-curriculum totals"}</strong><span>${type === "ncdc" ? "A: 2.4-3.0 · B: 2.1-2.3 · C: 1.8-2.0 · D: 1.5-1.7 · E: 0.0-1.4" : "U1-U4, average, points, MT, EOT, Total 80%, Total 100%, grade, and remark are shown together."}</span></div>`;
    return `
      <div class="workspace-title"><div><h2>${report.label} preview</h2><p class="muted">${report.subtitle}</p></div><div class="workspace-title-actions"><button class="button light compact" data-action="back-to-reports">← All formats</button><button class="button primary compact" data-action="open-print-settings" data-report="${type}">Print settings</button></div></div>
      <div class="report-paper"><div class="report-paper-header"><div><span class="report-school-name">APSHULE SECONDARY SCHOOL</span><strong>${state.printSettings.title}</strong></div><span class="report-school-badge">A</span></div><div class="report-learner-meta"><span><small>Student</small>Preview Learner</span><span><small>Class</small>${type === "alevel" ? "S.5 SCI" : "S.3"}</span><span><small>Term</small>ONE · 2026</span><span><small>Position</small>${state.printSettings.includePositions ? "3 / 32" : "Hidden"}</span></div>${reportTable(type)}${extra}<div class="report-comments"><div><small>Class teacher's comment</small><p>Consistent effort and strong progress across the term.</p></div><div><small>Headteacher's comment</small><p>Keep developing your strengths and maintain the excellent work.</p></div></div><div class="report-paper-footer"><span>Class teacher: ${state.printSettings.classTeacher || "—"}</span><span>Headteacher: ${state.printSettings.headTeacher || "—"}</span></div></div>`;
  }

  function secondaryMarksView() {
    if (liveEnabled()) return liveRecordsView("Secondary marks", state.liveData.marks, "No live marks records are available for this school yet.");
    return `<div class="workspace-title"><div><h2>Mark entry</h2><p class="muted">Capture formative and summative marks before generating a report.</p></div><span class="eyebrow">Secondary preview</span></div><div class="filter-row"><select aria-label="Mark entry class"><option>S3 · Blue</option><option>S5 · Sciences</option><option>S6 · Arts</option></select><select aria-label="Mark entry subject"><option>Biology</option><option>Chemistry</option><option>Mathematics</option></select><button class="button primary compact" data-action="preview-action">Load register</button></div><div class="panel"><div class="panel-heading"><h3>Mark-entry table</h3><span>Draft only</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Learner</th><th>A1 / U1</th><th>A2 / U2</th><th>A3 / U3</th><th>Teacher remark</th></tr></thead><tbody><tr><td><strong>Preview Learner A</strong></td><td>3.0</td><td>2.8</td><td>3.0</td><td><span class="badge green">Ready</span></td></tr><tr><td><strong>Preview Learner B</strong></td><td>2.0</td><td>2.2</td><td>2.1</td><td><span class="badge gold">Needs remark</span></td></tr></tbody></table></div></div>`;
  }

  function attendanceView() {
    if (liveEnabled()) {
      const attendance = Array.isArray(state.liveData.attendance) ? state.liveData.attendance : [];
      return liveRecordsView(isSecondary() ? "Secondary attendance" : "Attendance dashboard", attendance, "No live attendance records are available for this school yet.");
    }
    return `<div class="workspace-title"><div><h2>${isSecondary() ? "Secondary attendance" : "Attendance dashboard"}</h2><p class="muted">A simple daily picture for the school office.</p></div><span class="eyebrow">Today · Preview</span></div><div class="workspace-grid"><article class="stat-card"><small>Total today</small><strong>${isSecondary() ? "124" : "10"}</strong></article><article class="stat-card green"><small>Present</small><strong>${isSecondary() ? "119" : "10"}</strong></article><article class="stat-card orange"><small>Late</small><strong>${isSecondary() ? "3" : "0"}</strong></article><article class="stat-card violet"><small>Absent</small><strong>${isSecondary() ? "2" : "0"}</strong></article></div><div class="panel"><div class="panel-heading"><h3>Attendance follow-up</h3><span>Nothing urgent</span></div><div class="empty-state"><strong>Preview attendance records</strong>The live workspace will connect this view to class attendance records after secure sign-in.</div></div>`;
  }

  function smsView() {
    return `<div class="workspace-title"><div><h2>SMS management</h2><p class="muted">Keep school communication visible and deliberate.</p></div><button class="button primary compact" data-action="preview-action">Compose message</button></div><div class="workspace-grid"><article class="stat-card"><small>Current balance</small><strong>1</strong></article><article class="stat-card orange"><small>Balance remaining</small><strong>50%</strong></article><article class="stat-card violet"><small>This month</small><strong>0</strong></article><article class="stat-card green"><small>Total sent</small><strong>9</strong></article></div><div class="panel"><div class="panel-heading"><h3>Send a school message</h3><span>Preview workflow</span></div><div class="filter-row"><select aria-label="Recipients"><option>Parents of a class</option><option>All parents</option><option>Teaching staff</option></select><input placeholder="Message subject"><button class="button primary compact" data-action="preview-action">Continue</button></div></div>`;
  }

  function settingsView() {
    if (liveEnabled()) {
      const school = state.liveData.school || {};
      return `<div class="workspace-title"><div><h2>School account</h2><p class="muted">Institution details returned for the signed-in account.</p></div><span class="eyebrow">Live · read-only</span></div><div class="panel settings-card"><div class="form-field"><label>Account role</label><input value="${escapeHtml(state.liveData.role || "school")}" readonly></div><div class="form-field"><label>Institution</label><input value="${escapeHtml(school.name || "Authorized school")}" readonly></div><div class="form-field"><label>Location</label><input value="${escapeHtml(school.location || "Not recorded")}" readonly></div><p class="muted">Profile editing remains outside this read-only Education connection.</p></div>`;
    }
    return `<div class="workspace-title"><div><h2>My profile</h2><p class="muted">Institution details remain controlled by secure account settings.</p></div></div><div class="panel settings-card"><div class="form-field"><label>Display name</label><input value="${isSecondary() ? "Headteacher Preview" : "School Secretary"}" aria-label="Display name"></div><div class="form-field"><label>Institution</label><input value="Apshule ${isSecondary() ? "Secondary" : "Primary"} School" aria-label="Institution" readonly></div><div class="form-field"><label>Account email</label><input value="Use your APSHULE account" aria-label="Account email" readonly></div><button class="button primary" data-action="preview-action">Save preview changes</button></div>`;
  }

  function renderView() {
    const primaryViews = { dashboard: dashboardView, students: studentsView, "id-cards": idCardsView, reports: primaryReportsView, attendance: attendanceView, sms: smsView, settings: settingsView };
    const secondaryViews = { dashboard: secondaryDashboardView, students: secondaryStudentsView, "report-cards": secondaryReportsView, "report-detail": secondaryReportDetailView, marks: secondaryMarksView, "print-settings": secondaryReportsView, attendance: attendanceView, sms: smsView, settings: settingsView };
    const bursarViews = { dashboard: bursarDashboardView, fees: bursarFeesView, payments: bursarPaymentsView, statements: bursarStatementsView, settings: settingsView };
    const views = isBursar() ? bursarViews : isSecondary() ? secondaryViews : primaryViews;
    const labels = Object.fromEntries(getNavItems().map(([id, , label]) => [id, label]));
    title.textContent = state.view === "report-detail" ? `${reportTypes[state.reportType].label} preview` : (labels[state.view] || "Dashboard");
    content.innerHTML = (views[state.view] || (isSecondary() ? secondaryDashboardView : dashboardView))();
  }

  function render() {
    renderAccountContext();
    renderNav();
    renderView();
  }

  function openPrintSettings(reportType = state.reportType) {
    state.reportType = reportType;
    state.printStep = 1;
    printModal.classList.add("open");
    printModal.setAttribute("aria-hidden", "false");
    renderPrintSettings();
  }

  function closePrintSettings() {
    printModal.classList.remove("open");
    printModal.setAttribute("aria-hidden", "true");
  }

  function renderPrintSettings() {
    const steps = ["Template", "Positions", "Activities", "Details", "Review"];
    printStepper.innerHTML = steps.map((step, index) => `<span class="${index + 1 === state.printStep ? "active" : index + 1 < state.printStep ? "complete" : ""}"><b>${index + 1}</b>${step}</span>`).join("");
    if (state.printStep === 1) {
      printSettingsContent.innerHTML = `<div class="print-setting-section"><h3>Choose report template</h3><p>Select a visual treatment for the ${reportTypes[state.reportType].label} report.</p><div class="template-grid">${[["classic", "Classic Dark"], ["official", "Official Report"], ["forest", "Forest Green"], ["maroon", "Maroon & Gold"], ["bw", "Black & White"]].map(([value, label]) => `<button type="button" class="template-option ${state.printSettings.template === value ? "selected" : ""}" data-print-template="${value}"><span class="template-swatch ${value}"></span><strong>${label}</strong><small>${value === "official" ? "Recommended" : "Preview style"}</small></button>`).join("")}</div></div>`;
    } else if (state.printStep === 2) {
      printSettingsContent.innerHTML = `<div class="print-setting-section"><h3>Include student positions?</h3><p>Choose whether the learner’s position appears in the printed report.</p><label class="toggle-row"><input type="checkbox" data-print-positions ${state.printSettings.includePositions ? "checked" : ""}><span class="toggle-control"></span><strong>${state.printSettings.includePositions ? "Positions included" : "Positions hidden"}</strong></label></div>`;
    } else if (state.printStep === 3) {
      const activities = ["A1", "A2", "A3", "U1", "U2"];
      printSettingsContent.innerHTML = `<div class="print-setting-section"><h3>Select activities to show</h3><p>Choose the assessment activities that appear in the report.</p><div class="activity-checklist">${activities.map((activity) => `<label><input type="checkbox" data-print-activity="${activity}" ${state.printSettings.activities.includes(activity) ? "checked" : ""}><span>${activity}</span></label>`).join("")}</div><div class="validation-note">At least one activity must be selected.</div></div>`;
    } else if (state.printStep === 4) {
      printSettingsContent.innerHTML = `<div class="print-setting-section"><h3>Report details</h3><p>These details appear on the printed report header and signature lines.</p><label class="form-field"><span>Report title</span><input data-print-title value="${escapeHtml(state.printSettings.title)}" placeholder="e.g. MID TERM REPORT"></label><div class="two-column-fields"><label class="form-field"><span>Class teacher initials</span><input data-print-initials="classTeacher" value="${escapeHtml(state.printSettings.classTeacher)}" placeholder="e.g. JD"></label><label class="form-field"><span>Headteacher initials</span><input data-print-initials="headTeacher" value="${escapeHtml(state.printSettings.headTeacher)}" placeholder="e.g. AB"></label></div></div>`;
    } else {
      printSettingsContent.innerHTML = `<div class="print-review"><div class="review-check">✓</div><h3>Ready to preview and print</h3><p>${reportTypes[state.reportType].label} · ${state.printSettings.title}</p><div class="review-list"><span>Template <b>${state.printSettings.template}</b></span><span>Positions <b>${state.printSettings.includePositions ? "Included" : "Hidden"}</b></span><span>Activities <b>${state.printSettings.activities.join(", ")}</b></span><span>Initials <b>${state.printSettings.classTeacher} / ${state.printSettings.headTeacher}</b></span></div></div>`;
    }
    document.querySelector("[data-print-back]").disabled = state.printStep === 1;
    document.querySelector("[data-print-next]").textContent = state.printStep === 5 ? "Confirm & print" : "Continue";
  }

  nav.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    state.view = button.dataset.view;
    state.query = "";
    render();
    shell.classList.remove("menu-open");
  });

  document.querySelector(".account-switcher").addEventListener("click", (event) => {
    const button = event.target.closest("[data-account]");
    if (!button || button.dataset.account === state.account) return;
    state.account = button.dataset.account;
    state.view = "dashboard";
    state.query = "";
    render();
  });

  content.addEventListener("input", (event) => {
    if (event.target.id !== "studentSearch") return;
    state.query = event.target.value;
    renderView();
    const search = document.getElementById("studentSearch");
    search?.focus();
    search?.setSelectionRange(state.query.length, state.query.length);
  });

  content.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    const action = target?.dataset.action;
    if (action === "add-student") {
      if (liveEnabled()) showToast("Learner creation is not enabled in this read-only workspace.");
      else document.getElementById("studentModal").classList.add("open");
    }
    if (action === "view-student") showToast(liveEnabled() ? "Learner record is authorized for this school account." : "Learner profile preview — sign in to open live records.");
    if (action === "preview-action") showToast(liveEnabled() ? "This live workspace is read-only for now." : "This workflow is ready for the secure APSHULE workspace.");
    if (action === "open-bursar-payment") {
      const modal = document.getElementById("bursarPaymentModal");
      if (modal) {
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
        document.querySelector("#bursarPaymentForm [name=billReference]")?.focus();
      }
    }
    if (action === "open-bursar-reconciliation") {
      const modal = document.getElementById("bursarReconciliationModal");
      if (modal) {
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
        const date = document.querySelector("#bursarReconciliationForm [name=date]");
        if (date && !date.value) date.value = new Date().toISOString().slice(0, 10);
      }
    }
    if (action === "open-report") {
      state.reportType = target.dataset.report;
      state.view = "report-detail";
      render();
    }
    if (action === "open-print-settings") openPrintSettings(target.dataset.report);
    if (action === "back-to-reports") {
      state.view = "report-cards";
      render();
    }
  });

  document.getElementById("sidebarToggle").addEventListener("click", () => shell.classList.toggle("menu-open"));
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => document.getElementById("studentModal").classList.remove("open")));
  document.getElementById("studentModal").addEventListener("click", (event) => {
    if (event.target.id === "studentModal") event.currentTarget.classList.remove("open");
  });
  document.getElementById("studentForm").addEventListener("submit", (event) => {
    event.preventDefault();
    document.getElementById("studentModal").classList.remove("open");
    showToast("Preview learner saved locally for this session.");
  });
  const bursarPaymentModal = document.getElementById("bursarPaymentModal");
  const bursarReconciliationModal = document.getElementById("bursarReconciliationModal");
  const closeBursarModal = (modal) => {
    modal?.classList.remove("open");
    modal?.setAttribute("aria-hidden", "true");
  };
  document.querySelectorAll("[data-close-bursar-payment]").forEach((button) => button.addEventListener("click", () => closeBursarModal(bursarPaymentModal)));
  document.querySelectorAll("[data-close-bursar-reconciliation]").forEach((button) => button.addEventListener("click", () => closeBursarModal(bursarReconciliationModal)));
  bursarPaymentModal?.addEventListener("click", (event) => {
    if (event.target === bursarPaymentModal) closeBursarModal(bursarPaymentModal);
  });
  bursarReconciliationModal?.addEventListener("click", (event) => {
    if (event.target === bursarReconciliationModal) closeBursarModal(bursarReconciliationModal);
  });
  document.getElementById("bursarPaymentForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.getElementById("bursarPaymentStatus");
    status.textContent = "Recording payment…";
    const values = Object.fromEntries(new FormData(form).entries());
    if (!values.reference) delete values.reference;
    try {
      const payload = await bursarApi("/api/school/bursar/payments", {
        method: "POST",
        body: JSON.stringify({ ...values, amountPaid: Number(values.amountPaid) }),
      });
      closeBursarModal(bursarPaymentModal);
      form.reset();
      showToast(`Payment ${payload.payment?.reference || "recorded"} successfully.`);
      await refreshLiveData();
    } catch (error) {
      status.textContent = error?.message || "Payment could not be recorded.";
    }
  });
  document.getElementById("bursarReconciliationForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.getElementById("bursarReconciliationStatus");
    status.textContent = "Saving reconciliation…";
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await bursarApi("/api/school/bursar/reconciliation", {
        method: "POST",
        body: JSON.stringify({
          ...values,
          cashInHand: Number(values.cashInHand),
          mobileMoney: Number(values.mobileMoney),
          bank: Number(values.bank),
        }),
      });
      closeBursarModal(bursarReconciliationModal);
      form.reset();
      showToast("Daily reconciliation saved.");
    } catch (error) {
      status.textContent = error?.message || "Reconciliation could not be saved.";
    }
  });
  document.querySelector("[data-close-print-settings]").addEventListener("click", closePrintSettings);
  printModal.addEventListener("click", (event) => {
    if (event.target === printModal) closePrintSettings();
  });
  printModal.addEventListener("click", (event) => {
    const template = event.target.closest("[data-print-template]");
    if (template) {
      state.printSettings.template = template.dataset.printTemplate;
      renderPrintSettings();
    }
  });
  printModal.addEventListener("change", (event) => {
    if (event.target.matches("[data-print-positions]")) state.printSettings.includePositions = event.target.checked;
    if (event.target.matches("[data-print-activity]")) {
      const activity = event.target.dataset.printActivity;
      state.printSettings.activities = event.target.checked
        ? [...new Set([...state.printSettings.activities, activity])]
        : state.printSettings.activities.filter((item) => item !== activity);
    }
    renderPrintSettings();
  });
  printModal.addEventListener("input", (event) => {
    if (event.target.matches("[data-print-title]")) state.printSettings.title = event.target.value;
    if (event.target.matches("[data-print-initials]")) state.printSettings[event.target.dataset.printInitials] = event.target.value.toUpperCase();
  });
  document.querySelector("[data-print-back]").addEventListener("click", () => {
    if (state.printStep > 1) {
      state.printStep -= 1;
      renderPrintSettings();
    }
  });
  document.querySelector("[data-print-next]").addEventListener("click", () => {
    if (state.printStep === 3 && state.printSettings.activities.length === 0) {
      showToast("Select at least one activity before continuing.");
      return;
    }
    if (state.printStep === 4 && (!state.printSettings.title.trim() || !state.printSettings.classTeacher.trim())) {
      showToast("Add a report title and class-teacher initials.");
      return;
    }
    if (state.printStep < 5) {
      state.printStep += 1;
      renderPrintSettings();
      return;
    }
    closePrintSettings();
    state.view = "report-detail";
    render();
    window.setTimeout(() => window.print(), 0);
    showToast("Print-ready preview prepared for this session.");
  });

  async function bootLiveWorkspace() {
    if (!window.firebase || typeof firebase.auth !== "function") {
      state.authState = "preview";
      render();
      return;
    }
    try {
      firebase.auth().onAuthStateChanged(async (user) => {
        if (!user) {
          state.liveData = null;
          state.authState = "preview";
          state.authError = "";
          render();
          return;
        }
        state.authState = "loading";
        state.authError = "";
        render();
        try {
          const token = await user.getIdToken();
          const base = String(window.APSHULE_API_BASE || "").replace(/\/+$/, "");
          const response = await fetch(`${base}/api/school/education-workspace`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload.ok || !payload.live) {
            throw new Error(payload.error || "This account is not authorized for a school workspace.");
          }
          state.liveData = payload;
          state.authState = "live";
          state.authError = "";
          if (payload.workspace === "bursar") {
            state.view = "dashboard";
          }
          if (payload.account !== "both") state.account = payload.account === "secondary" ? "secondary" : "primary";
          if (state.account === "secondary" && !secondaryViews.includes(state.view)) state.view = "dashboard";
          render();
        } catch (error) {
          state.liveData = null;
          state.authState = "preview";
          state.authError = error?.message || "Live school records could not be loaded.";
          render();
        }
      });
    } catch (error) {
      state.authState = "preview";
      state.authError = "Secure sign-in is unavailable in this browser.";
      render();
    }
  }

  render();
  bootLiveWorkspace();
})();