(() => {
  const navItems = [
    ["dashboard", "▦", "Dashboard"],
    ["students", "♙", "Students"],
    ["id-cards", "▣", "ID cards"],
    ["reports", "◫", "Report cards"],
    ["attendance", "◌", "Attendance"],
    ["sms", "✉", "Send SMS"],
    ["settings", "⚙", "Settings"],
  ];
  const sampleStudents = [
    ["ADM20260001", "Jane Nakato", "P4", "Day Scholar", "Active"],
    ["ADM20260006", "Kakooza Abdul", "P1", "Day Scholar", "Active"],
    ["ADM20260008", "Kawoya Moses", "P1", "Day Scholar", "Active"],
    ["0123345", "Kisakye Michael", "P4", "Boarding", "Active"],
  ];
  const state = { view: "dashboard", query: "" };
  const nav = document.getElementById("workspaceNav");
  const content = document.getElementById("workspaceContent");
  const title = document.getElementById("viewTitle");
  const shell = document.querySelector(".app-shell");
  const toast = document.getElementById("toast");

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[character]));

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2800);
  }

  function renderNav() {
    nav.innerHTML = navItems.map(([id, icon, label]) =>
      `<button class="side-link ${state.view === id ? "active" : ""}" type="button" data-view="${id}"><span class="icon">${icon}</span><span>${label}</span></button>`
    ).join("");
  }

  function dashboardView() {
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

  function studentsView() {
    const query = state.query.toLowerCase();
    const rows = sampleStudents.filter((student) => student.join(" ").toLowerCase().includes(query));
    return `
      <div class="workspace-title"><div><h2>Students</h2><p class="muted">Search and review the school register.</p></div><button class="button primary compact" type="button" data-action="add-student">＋ Add learner</button></div>
      <div class="filter-row"><input id="studentSearch" type="search" value="${escapeHtml(state.query)}" placeholder="Search by name or admission number" aria-label="Search students"><select aria-label="Filter class"><option>All classes</option><option>P1</option><option>P4</option><option>P7</option></select><select aria-label="Filter status"><option>All statuses</option><option>Active</option><option>Inactive</option></select></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Admission</th><th>Name</th><th>Class</th><th>Section</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(([admission, name, studentClass, section, status]) => `<tr><td>${admission}</td><td><strong>${name}</strong></td><td>${studentClass}</td><td><span class="badge gold">${section}</span></td><td><span class="badge green">${status}</span></td><td><button class="button light compact" type="button" data-action="view-student">View</button></td></tr>`).join("") || '<tr><td colspan="6"><div class="empty-state">No learners match this search.</div></td></tr>'}</tbody></table></div>`;
  }

  function idCardsView() {
    return `<div class="workspace-title"><div><h2>Student ID cards</h2><p class="muted">A clear three-step path from class selection to print.</p></div></div><div class="action-grid"><article class="action-card"><span class="eyebrow">Step 01</span><strong>Choose a class</strong><p>Load the learners you want to prepare.</p><button class="button primary compact" data-action="preview-action">Choose class</button></article><article class="action-card"><span class="eyebrow">Step 02</span><strong>Select learners</strong><p>Review the list before creating cards.</p><button class="button light compact" data-action="preview-action">Select learners</button></article><article class="action-card"><span class="eyebrow">Step 03</span><strong>Choose a theme</strong><p>Use a school-ready card design.</p><button class="button light compact" data-action="preview-action">Choose theme</button></article><article class="action-card"><span class="eyebrow">Ready</span><strong>Print or save</strong><p>Prepare a clean PDF for the school office.</p><button class="button light compact" data-action="preview-action">Print cards</button></article></div>`;
  }

  function reportsView() {
    return `<div class="workspace-title"><div><h2>Primary report cards</h2><p class="muted">Keep marking, remarks, and report generation in one flow.</p></div><button class="button primary compact" data-action="preview-action">Generate reports</button></div><div class="workspace-grid"><article class="stat-card"><small>Students with marks</small><strong>10</strong></article><article class="stat-card green"><small>Reports generated</small><strong>4</strong></article><article class="stat-card orange"><small>Pending remarks</small><strong>1</strong></article><article class="stat-card violet"><small>Completion rate</small><strong>65%</strong></article></div><div class="action-grid"><article class="action-card"><strong>01 · Mark entry</strong><p>Capture term marks by class and subject.</p><button class="button light compact" data-action="preview-action">Enter marks</button></article><article class="action-card"><strong>02 · Grade & rank</strong><p>Review grades before sharing reports.</p><button class="button light compact" data-action="preview-action">Grade & rank</button></article><article class="action-card"><strong>03 · Remarks</strong><p>Add class-teacher and school remarks.</p><button class="button light compact" data-action="preview-action">Add remarks</button></article><article class="action-card"><strong>04 · View reports</strong><p>Preview, print, or save the final report.</p><button class="button light compact" data-action="preview-action">View reports</button></article></div>`;
  }

  function attendanceView() {
    return `<div class="workspace-title"><div><h2>Attendance dashboard</h2><p class="muted">A simple daily picture for the school office.</p></div><span class="eyebrow">Today · Preview</span></div><div class="workspace-grid"><article class="stat-card"><small>Total today</small><strong>10</strong></article><article class="stat-card green"><small>Present</small><strong>10</strong></article><article class="stat-card orange"><small>Late</small><strong>0</strong></article><article class="stat-card violet"><small>Absent</small><strong>0</strong></article></div><div class="panel"><div class="panel-heading"><h3>Attendance follow-up</h3><span>Nothing urgent</span></div><div class="empty-state"><strong>All learners are accounted for</strong>The live workspace will connect this view to class attendance records after secure sign-in.</div></div>`;
  }

  function smsView() {
    return `<div class="workspace-title"><div><h2>SMS management</h2><p class="muted">Keep school communication visible and deliberate.</p></div><button class="button primary compact" data-action="preview-action">Compose message</button></div><div class="workspace-grid"><article class="stat-card"><small>Current balance</small><strong>1</strong></article><article class="stat-card orange"><small>Balance remaining</small><strong>50%</strong></article><article class="stat-card violet"><small>This month</small><strong>0</strong></article><article class="stat-card green"><small>Total sent</small><strong>9</strong></article></div><div class="panel"><div class="panel-heading"><h3>Send a school message</h3><span>Preview workflow</span></div><div class="filter-row"><select aria-label="Recipients"><option>Parents of a class</option><option>All parents</option><option>Teaching staff</option></select><input placeholder="Message subject"><button class="button primary compact" data-action="preview-action">Continue</button></div></div>`;
  }

  function settingsView() {
    return `<div class="workspace-title"><div><h2>My profile</h2><p class="muted">Institution details remain controlled by secure account settings.</p></div></div><div class="panel settings-card"><div class="form-field"><label>Display name</label><input value="School Secretary" aria-label="Display name"></div><div class="form-field"><label>Institution</label><input value="Apshule Primary School" aria-label="Institution" readonly></div><div class="form-field"><label>Account email</label><input value="Use your APSHULE account" aria-label="Account email" readonly></div><button class="button primary" data-action="preview-action">Save preview changes</button></div>`;
  }

  function renderView() {
    const views = { dashboard: dashboardView, students: studentsView, "id-cards": idCardsView, reports: reportsView, attendance: attendanceView, sms: smsView, settings: settingsView };
    const labels = Object.fromEntries(navItems.map(([id, , label]) => [id, label]));
    title.textContent = labels[state.view] || "Dashboard";
    content.innerHTML = (views[state.view] || dashboardView)();
  }

  function render() {
    renderNav();
    renderView();
  }

  nav.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    state.view = button.dataset.view;
    state.query = "";
    render();
    shell.classList.remove("menu-open");
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
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "add-student") document.getElementById("studentModal").classList.add("open");
    if (action === "view-student") showToast("Learner profile preview — sign in to open live records.");
    if (action === "preview-action") showToast("This workflow is ready for the secure APSHULE workspace.");
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

  render();
})();