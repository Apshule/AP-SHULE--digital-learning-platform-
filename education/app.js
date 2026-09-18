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
  const reportTypes = {
    ncdc: { label: "O-Level NCDC", subtitle: "New curriculum · A1 / U1 / competency levels" },
    old: { label: "O-Level old curriculum", subtitle: "U1-U4 · term test · end-of-term assessment" },
    alevel: { label: "A-Level UACE", subtitle: "Formative / summative · division · project work" },
  };
  const secondaryViews = ["dashboard", "students", "report-cards", "report-detail", "marks", "print-settings", "attendance", "sms", "settings"];
  const state = {
    account: "primary",
    view: "dashboard",
    liveData: null,
    bursarStatement: null,
    bursarReceipt: null,
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

  function accessRequiredView() {
    const titleText = state.authState === "loading" ? "Loading authorized workspace" : "Secure sign-in required";
    const message = state.authState === "loading"
      ? "Checking your APSHULE account and institution scope."
      : state.authError || "Sign in with an authorized school account to load live records and actions.";
    return `<div class="panel access-required"><div class="access-required-icon">↗</div><h2>${titleText}</h2><p>${escapeHtml(message)}</p><a class="button primary compact" href="../">Open secure APSHULE login</a></div>`;
  }

  function unavailableView(titleText, message) {
    return `<div class="panel access-required"><div class="access-required-icon">i</div><h2>${escapeHtml(titleText)}</h2><p>${escapeHtml(message)}</p></div>`;
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

  function bursarMonthRange() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const lastDay = new Date(year, today.getMonth() + 1, 0).getDate();
    return { from: `${year}-${month}-01`, to: `${year}-${month}-${String(lastDay).padStart(2, "0")}`, month: `${year}-${month}` };
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
        <article class="panel"><div class="panel-heading"><h3>Bursar controls</h3><span>Institution scoped</span></div><div class="empty-state">Manual payment entry, verifiable receipts, date-range statements, and monthly close are enabled for this bursar account.</div></article>
      </div>`;
  }

  function bursarFeesView() {
    const accounts = Array.isArray(state.liveData?.bursar?.accounts) ? state.liveData.bursar.accounts : [];
    return `<div class="workspace-title"><div><h2>Fee accounts</h2><p class="muted">School fee balances from authorized billing records.</p></div><button class="button primary compact" type="button" data-action="open-bursar-payment">Record payment</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Account</th><th>Learner / payer</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead><tbody>${accounts.map((row) => `<tr><td>${escapeHtml(row.billReference || row.id || "—")}</td><td><strong>${escapeHtml(row.clientName || "—")}</strong></td><td>${escapeHtml(bursarMoney(row.totalAmount))}</td><td>${escapeHtml(bursarMoney(row.amountPaid))}</td><td>${escapeHtml(bursarMoney(row.balanceRemaining))}</td><td><span class="badge ${String(row.status).toLowerCase() === "paid" ? "green" : "gold"}">${escapeHtml(row.status || "unpaid")}</span></td></tr>`).join("") || '<tr><td colspan="6"><div class="empty-state">No authorized fee accounts are recorded yet.</div></td></tr>'}</tbody></table></div>`;
  }

  function bursarPaymentsView() {
    const payments = Array.isArray(state.liveData?.bursar?.payments) ? state.liveData.bursar.payments : [];
    return `<div class="workspace-title"><div><h2>Payments</h2><p class="muted">Payment transactions linked to this institution.</p></div><button class="button primary compact" type="button" data-action="open-bursar-payment">Record payment</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Reference</th><th>Payer</th><th>Amount</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>${payments.map((row) => `<tr><td>${escapeHtml(row.reference || row.billReference || row.id || "—")}</td><td><strong>${escapeHtml(row.clientName || "—")}</strong></td><td>${escapeHtml(bursarMoney(row.amountPaid))}</td><td><span class="badge ${String(row.status).toLowerCase() === "completed" ? "green" : "gold"}">${escapeHtml(row.status || "pending")}</span></td><td>${escapeHtml(row.paymentDate || "—")}</td><td>${row.id ? `<button class="button light compact" type="button" data-action="open-bursar-receipt" data-payment-id="${escapeHtml(row.id)}">Receipt</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="6"><div class="empty-state">No authorized payments are recorded yet.</div></td></tr>'}</tbody></table></div>`;
  }

  function bursarStatementsView() {
    const summary = state.liveData?.bursar?.summary || {};
    const range = bursarMonthRange();
    const statement = state.bursarStatement?.statement;
    const payments = Array.isArray(statement?.payments) ? statement.payments : [];
    return `<div class="workspace-title"><div><h2>Statements</h2><p class="muted">Generate an institution-scoped statement for a selected date range, then close a month when reconciliation is complete.</p></div><span class="eyebrow">Live · controlled</span></div>
      <div class="panel settings-card">
        <form id="bursarStatementForm">
          <div class="two-col"><label>From<input required name="from" type="date" value="${escapeHtml(state.bursarStatement?.from || range.from)}"></label><label>To<input required name="to" type="date" value="${escapeHtml(state.bursarStatement?.to || range.to)}"></label></div>
          <div class="modal-actions"><button class="button primary compact" type="submit">Generate statement</button></div>
        </form>
        <div class="statement-summary"><div><small>Total billed</small><strong>${escapeHtml(bursarMoney(summary.totalDue))}</strong></div><div><small>Total received</small><strong>${escapeHtml(bursarMoney(summary.totalPaid))}</strong></div><div><small>Outstanding</small><strong>${escapeHtml(bursarMoney(summary.outstandingBalance))}</strong></div></div>
      </div>
      ${statement ? `<div class="panel"><div class="panel-heading"><h3>${statement.paymentCount} payments · ${escapeHtml(statement.from)} to ${escapeHtml(statement.to)}</h3><span>${escapeHtml(bursarMoney(statement.totalAmount))}</span></div><div class="status-list">${Object.entries(statement.byMethod || {}).map(([method, amount]) => `<span><i class="online"></i>${escapeHtml(method)} <b>${escapeHtml(bursarMoney(amount))}</b></span>`).join("") || '<span>No payments in this range.</span>'}</div><div class="table-wrap"><table class="data-table"><thead><tr><th>Reference</th><th>Payer</th><th>Amount</th><th>Method</th><th>Date</th></tr></thead><tbody>${payments.map((row) => `<tr><td>${escapeHtml(row.reference || row.id)}</td><td>${escapeHtml(row.clientName || "—")}</td><td>${escapeHtml(bursarMoney(row.amountPaid))}</td><td>${escapeHtml(row.paymentMethod || "—")}</td><td>${escapeHtml(row.paymentDate || "—")}</td></tr>`).join("") || '<tr><td colspan="5"><div class="empty-state">No payments were recorded in this range.</div></td></tr>'}</tbody></table></div></div>` : ""}
      <div class="panel settings-card"><div class="panel-heading"><h3>Close monthly statement</h3><span>Locks later payment and reconciliation edits</span></div><form id="bursarCloseStatementForm"><div class="two-col"><label>Month<input required name="month" type="month" value="${escapeHtml(state.bursarStatement?.month || range.month)}"></label><div class="empty-state">Closing is institution-scoped and cannot be undone by this bursar workflow.</div></div><p id="bursarStatementStatus" class="modal-copy" aria-live="polite"></p><div class="modal-actions"><button class="button primary compact" type="submit">Close month</button></div></form></div>`;
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
    if (accountSwitcher) accountSwitcher.style.display = bursar || !liveEnabled() ? "none" : "";
    const mode = document.getElementById("workspaceModeBadge");
    if (mode) mode.innerHTML = `<i></i> ${state.authState === "checking" || state.authState === "loading" ? "Checking access" : liveEnabled() ? "Live" : "Sign in required"}`;
    const modeText = document.getElementById("educationDataMode");
    if (modeText) modeText.innerHTML = liveEnabled() ? `Live authorized school records · <a href="../">Return to APSHULE</a>` : `Live records require secure sign-in · <a href="../">Open APSHULE login</a>`;
    const description = document.getElementById("workspaceDescription");
    if (description) description.textContent = liveEnabled()
      ? bursar
        ? `Connected to ${schoolName}. Payments and daily reconciliation are scoped to the signed-in bursar account.`
        : `Connected to ${schoolName}. Records are read-only and scoped to the signed-in school account.`
      : "Live school records and actions are available after secure sign-in.";
    const notice = document.getElementById("workspaceNotice");
    if (notice) notice.innerHTML = liveEnabled()
      ? `<span class="notice-icon">✓</span><span><strong>${bursar ? "Live bursar workspace." : "Live school workspace."}</strong> ${escapeHtml(schoolName)} records are loaded through your authorized account.${bursar ? " Manual payment entry and daily reconciliation are enabled." : " Bursar and finance controls are not included here."}</span>`
      : `<span class="notice-icon">i</span><span><strong>${state.authState === "checking" || state.authState === "loading" ? "Checking secure access." : "Secure sign-in required."}</strong> ${state.authError ? escapeHtml(state.authError) : "No records are shown. Open secure login to load authorized school data."}</span>`;
    document.querySelectorAll("[data-account]").forEach((button) => {
      button.classList.toggle("active", button.dataset.account === state.account);
    });
  }

  function dashboardView() {
    if (isBursar()) return bursarDashboardView();
    if (liveEnabled()) return liveDashboardView(false);
    return accessRequiredView();
  }

  function secondaryDashboardView() {
    if (liveEnabled()) return liveDashboardView(true);
    return accessRequiredView();
  }

  function studentsView() {
    if (!liveEnabled()) return accessRequiredView();
    const query = state.query.toLowerCase();
    const rows = liveLearners("primary").map(liveRowValues).filter((student) => student.join(" ").toLowerCase().includes(query));
    return `
       <div class="workspace-title"><div><h2>Students</h2><p class="muted">Search and review the authorized school register.</p></div><button class="button primary compact" type="button" data-action="add-student" disabled>＋ Add learner</button></div>
      <div class="filter-row"><input id="studentSearch" type="search" value="${escapeHtml(state.query)}" placeholder="Search by name or admission number" aria-label="Search students"><select aria-label="Filter class"><option>All classes</option><option>P1</option><option>P4</option><option>P7</option></select><select aria-label="Filter status"><option>All statuses</option><option>Active</option><option>Inactive</option></select></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Admission</th><th>Name</th><th>Class</th><th>Section</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(([admission, name, studentClass, section, status]) => `<tr><td>${admission}</td><td><strong>${name}</strong></td><td>${studentClass}</td><td><span class="badge gold">${section}</span></td><td><span class="badge green">${status}</span></td><td><button class="button light compact" type="button" data-action="view-student">View</button></td></tr>`).join("") || '<tr><td colspan="6"><div class="empty-state">No learners match this search.</div></td></tr>'}</tbody></table></div>`;
  }

  function secondaryStudentsView() {
    if (!liveEnabled()) return accessRequiredView();
    const query = state.query.toLowerCase();
    const rows = liveLearners("secondary").map(liveRowValues).filter((student) => student.join(" ").toLowerCase().includes(query));
    return `
       <div class="workspace-title"><div><h2>Secondary students</h2><p class="muted">Review authorized S1-S6 learners, streams, and academic context.</p></div><button class="button primary compact" type="button" data-action="add-student" disabled>＋ Add learner</button></div>
      <div class="filter-row"><input id="studentSearch" type="search" value="${escapeHtml(state.query)}" placeholder="Search by name or admission number" aria-label="Search secondary students"><select aria-label="Filter secondary class"><option>All classes</option><option>S1</option><option>S3</option><option>S5</option><option>S6</option></select><select aria-label="Filter stream"><option>All streams</option><option>Blue</option><option>Green</option><option>Arts</option><option>Sciences</option></select></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Admission</th><th>Name</th><th>Class</th><th>Stream</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(([admission, name, studentClass, stream, status]) => `<tr><td>${admission}</td><td><strong>${name}</strong></td><td>${studentClass}</td><td><span class="badge gold">${stream}</span></td><td><span class="badge green">${status}</span></td><td><button class="button light compact" type="button" data-action="view-student">View</button></td></tr>`).join("") || '<tr><td colspan="6"><div class="empty-state">No secondary learners match this search.</div></td></tr>'}</tbody></table></div>`;
  }

  function idCardsView() {
    if (!liveEnabled()) return accessRequiredView();
    const learners = liveLearners(state.account);
    return `<div class="workspace-title"><div><h2>Student ID cards</h2><p class="muted">Authorized learners available for card preparation.</p></div><span class="eyebrow">${learners.length} learners loaded</span></div><div class="panel"><div class="panel-heading"><h3>Live learner register</h3><span>Institution scoped</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Admission</th><th>Name</th><th>Class</th><th>Stream</th><th>Status</th></tr></thead><tbody>${learners.map((row) => { const [admission, name, studentClass, stream, status] = liveRowValues(row); return `<tr><td>${escapeHtml(admission)}</td><td><strong>${escapeHtml(name)}</strong></td><td>${escapeHtml(studentClass)}</td><td>${escapeHtml(stream)}</td><td><span class="badge green">${escapeHtml(status)}</span></td></tr>`; }).join("") || '<tr><td colspan="5"><div class="empty-state">No authorized learners are available for ID cards.</div></td></tr>'}</tbody></table></div></div>`;
  }

  function primaryReportsView() {
    if (!liveEnabled()) return accessRequiredView();
    return liveRecordsView("Primary report cards", state.liveData.reports, "No live report-card records are available for this school yet.");
  }

  function secondaryReportsView() {
    if (!liveEnabled()) return accessRequiredView();
    return liveRecordsView("Secondary report cards", state.liveData.reports, "No live report-card records are available for this school yet.");
  }

  function secondaryReportDetailView() {
    if (!liveEnabled()) return accessRequiredView();
    return liveRecordsView("Secondary report details", state.liveData.reports, "No live report-card details are available for this school yet.");
  }

  function secondaryMarksView() {
    if (!liveEnabled()) return accessRequiredView();
    return liveRecordsView("Secondary marks", state.liveData.marks, "No live marks records are available for this school yet.");
  }

  function attendanceView() {
    if (!liveEnabled()) return accessRequiredView();
    const attendance = Array.isArray(state.liveData.attendance) ? state.liveData.attendance : [];
    return liveRecordsView(isSecondary() ? "Secondary attendance" : "Attendance dashboard", attendance, "No live attendance records are available for this school yet.");
  }

  function smsView() {
    if (!liveEnabled()) return accessRequiredView();
    return unavailableView("SMS messaging is not connected", "No SMS sending endpoint is connected to this workspace yet. The workspace will not display invented balances or pretend to send messages.");
  }

  function settingsView() {
    if (liveEnabled()) {
      const school = state.liveData.school || {};
      return `<div class="workspace-title"><div><h2>School account</h2><p class="muted">Institution details returned for the signed-in account.</p></div><span class="eyebrow">Live · read-only</span></div><div class="panel settings-card"><div class="form-field"><label>Account role</label><input value="${escapeHtml(state.liveData.role || "school")}" readonly></div><div class="form-field"><label>Institution</label><input value="${escapeHtml(school.name || "Authorized school")}" readonly></div><div class="form-field"><label>Location</label><input value="${escapeHtml(school.location || "Not recorded")}" readonly></div><p class="muted">Profile editing remains outside this read-only Education connection.</p></div>`;
    }
    return accessRequiredView();
  }

  function renderView() {
    const primaryViews = { dashboard: dashboardView, students: studentsView, "id-cards": idCardsView, reports: primaryReportsView, attendance: attendanceView, sms: smsView, settings: settingsView };
    const secondaryViews = { dashboard: secondaryDashboardView, students: secondaryStudentsView, "report-cards": secondaryReportsView, "report-detail": secondaryReportDetailView, marks: secondaryMarksView, "print-settings": secondaryReportsView, attendance: attendanceView, sms: smsView, settings: settingsView };
    const bursarViews = { dashboard: bursarDashboardView, fees: bursarFeesView, payments: bursarPaymentsView, statements: bursarStatementsView, settings: settingsView };
    const views = isBursar() ? bursarViews : isSecondary() ? secondaryViews : primaryViews;
    const labels = Object.fromEntries(getNavItems().map(([id, , label]) => [id, label]));
    title.textContent = state.view === "report-detail" ? `${reportTypes[state.reportType].label} details` : (labels[state.view] || "Dashboard");
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
      printSettingsContent.innerHTML = `<div class="print-setting-section"><h3>Choose report template</h3><p>Select a visual treatment for the ${reportTypes[state.reportType].label} report.</p><div class="template-grid">${[["classic", "Classic Dark"], ["official", "Official Report"], ["forest", "Forest Green"], ["maroon", "Maroon & Gold"], ["bw", "Black & White"]].map(([value, label]) => `<button type="button" class="template-option ${state.printSettings.template === value ? "selected" : ""}" data-print-template="${value}"><span class="template-swatch ${value}"></span><strong>${label}</strong><small>${value === "official" ? "Recommended" : "Print style"}</small></button>`).join("")}</div></div>`;
    } else if (state.printStep === 2) {
      printSettingsContent.innerHTML = `<div class="print-setting-section"><h3>Include student positions?</h3><p>Choose whether the learner’s position appears in the printed report.</p><label class="toggle-row"><input type="checkbox" data-print-positions ${state.printSettings.includePositions ? "checked" : ""}><span class="toggle-control"></span><strong>${state.printSettings.includePositions ? "Positions included" : "Positions hidden"}</strong></label></div>`;
    } else if (state.printStep === 3) {
      const activities = ["A1", "A2", "A3", "U1", "U2"];
      printSettingsContent.innerHTML = `<div class="print-setting-section"><h3>Select activities to show</h3><p>Choose the assessment activities that appear in the report.</p><div class="activity-checklist">${activities.map((activity) => `<label><input type="checkbox" data-print-activity="${activity}" ${state.printSettings.activities.includes(activity) ? "checked" : ""}><span>${activity}</span></label>`).join("")}</div><div class="validation-note">At least one activity must be selected.</div></div>`;
    } else if (state.printStep === 4) {
      printSettingsContent.innerHTML = `<div class="print-setting-section"><h3>Report details</h3><p>These details appear on the printed report header and signature lines.</p><label class="form-field"><span>Report title</span><input data-print-title value="${escapeHtml(state.printSettings.title)}" placeholder="e.g. MID TERM REPORT"></label><div class="two-column-fields"><label class="form-field"><span>Class teacher initials</span><input data-print-initials="classTeacher" value="${escapeHtml(state.printSettings.classTeacher)}" placeholder="e.g. JD"></label><label class="form-field"><span>Headteacher initials</span><input data-print-initials="headTeacher" value="${escapeHtml(state.printSettings.headTeacher)}" placeholder="e.g. AB"></label></div></div>`;
    } else {
      printSettingsContent.innerHTML = `<div class="print-review"><div class="review-check">✓</div><h3>Ready to print</h3><p>${reportTypes[state.reportType].label} · ${state.printSettings.title}</p><div class="review-list"><span>Template <b>${state.printSettings.template}</b></span><span>Positions <b>${state.printSettings.includePositions ? "Included" : "Hidden"}</b></span><span>Activities <b>${state.printSettings.activities.join(", ")}</b></span><span>Initials <b>${state.printSettings.classTeacher} / ${state.printSettings.headTeacher}</b></span></div></div>`;
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
      showToast("Learner creation is not enabled in this read-only workspace.");
    }
    if (action === "view-student") showToast(liveEnabled() ? "Learner record is authorized for this school account." : "Sign in to open authorized learner records.");
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
    if (action === "open-bursar-receipt" && target.dataset.paymentId) {
      const modal = document.getElementById("bursarReceiptModal");
      const receiptContent = document.getElementById("bursarReceiptContent");
      if (modal && receiptContent) {
        receiptContent.innerHTML = '<div class="empty-state">Loading receipt…</div>';
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
        bursarApi(`/api/school/bursar/receipts/${encodeURIComponent(target.dataset.paymentId)}`)
          .then((payload) => {
            state.bursarReceipt = payload.receipt;
            const receipt = payload.receipt;
            receiptContent.innerHTML = `<div class="receipt-verification ${receipt.verified ? "verified" : "warning"}"><strong>${receipt.verified ? "Verified receipt" : "Verification warning"}</strong><span>${escapeHtml(receipt.verification)}</span></div><div class="receipt-grid"><span>Receipt number<b>${escapeHtml(receipt.receiptId)}</b></span><span>Payment reference<b>${escapeHtml(receipt.reference || "—")}</b></span><span>Payer / learner<b>${escapeHtml(receipt.clientName || "—")}</b></span><span>Account<b>${escapeHtml(receipt.billReference || "—")}</b></span><span>Amount paid<b>${escapeHtml(bursarMoney(receipt.amountPaid))}</b></span><span>Payment method<b>${escapeHtml(receipt.paymentMethod || "—")}</b></span><span>Payment date<b>${escapeHtml(receipt.paymentDate || "—")}</b></span><span>Institution<b>${escapeHtml(receipt.institutionId)}</b></span></div><p class="muted">This receipt is verifiable against the server-issued SHA-256 transaction fingerprint.</p>`;
          })
          .catch((error) => {
            receiptContent.innerHTML = `<div class="empty-state">${escapeHtml(error?.message || "Receipt could not be loaded.")}</div>`;
          });
      }
    }
  });

  document.getElementById("sidebarToggle").addEventListener("click", () => shell.classList.toggle("menu-open"));
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
  content.addEventListener("submit", async (event) => {
    const form = event.target;
    if (form.id !== "bursarStatementForm" && form.id !== "bursarCloseStatementForm") return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const status = document.getElementById("bursarStatementStatus");
    if (status) status.textContent = form.id === "bursarStatementForm" ? "Generating statement…" : "Closing monthly statement…";
    try {
      if (form.id === "bursarStatementForm") {
        const payload = await bursarApi(`/api/school/bursar/statements?from=${encodeURIComponent(values.from)}&to=${encodeURIComponent(values.to)}`);
        state.bursarStatement = { ...payload, from: values.from, to: values.to, month: String(values.from).slice(0, 7) };
        renderView();
      } else {
        const payload = await bursarApi("/api/school/bursar/statements/close", {
          method: "POST",
          body: JSON.stringify({ month: values.month }),
        });
        state.bursarStatement = { ...(state.bursarStatement || {}), month: values.month, closed: payload.statement };
        renderView();
        showToast(payload.alreadyLocked ? "That month was already closed." : `Statement for ${values.month} closed.`);
      }
    } catch (error) {
      if (status) status.textContent = error?.message || "The statement action could not be completed.";
    }
  });
  const bursarReceiptModal = document.getElementById("bursarReceiptModal");
  document.querySelectorAll("[data-close-bursar-receipt]").forEach((button) => button.addEventListener("click", () => closeBursarModal(bursarReceiptModal)));
  bursarReceiptModal?.addEventListener("click", (event) => {
    if (event.target === bursarReceiptModal) closeBursarModal(bursarReceiptModal);
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
    showToast("Print-ready report prepared.");
  });

  async function bootLiveWorkspace() {
    if (!window.firebase || typeof firebase.auth !== "function") {
      state.authState = "error";
      render();
      return;
    }
    try {
      firebase.auth().onAuthStateChanged(async (user) => {
        if (!user) {
          state.liveData = null;
          state.authState = "signed_out";
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
          state.authState = "error";
          state.authError = error?.message || "Live school records could not be loaded.";
          render();
        }
      });
    } catch (error) {
      state.authState = "error";
      state.authError = "Secure sign-in is unavailable in this browser.";
      render();
    }
  }

  render();
  bootLiveWorkspace();
})();