import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const output = resolve(fileURLToPath(new URL("./assets/", import.meta.url)));

async function isFile(relativePath) {
  try {
    return (await stat(join(output, relativePath))).isFile();
  } catch {
    return false;
  }
}

async function textFiles(directory = output) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await textFiles(fullPath));
    else if (/\.(?:html|js|json|css|webmanifest|txt)$/i.test(entry.name)) {
      files.push(await readFile(fullPath, "utf8"));
    }
  }
  return files;
}

test("Pages bundle includes the public site and all core workspaces", async () => {
  for (const path of [
    "index.html",
    "education/index.html",
    "clinic/index.html",
    "farm/index.html",
    "mfi/index.html",
    "admin/index.html",
    "platform/index.html",
    "skills/index.html",
    "tech/index.html",
    "profile.html",
    "reset-password.html",
    "manifest.json",
    "manifest.webmanifest",
    "sw.js",
    "icons/icon-192.png",
    ".well-known/assetlinks.json",
    ".nojekyll",
    "CNAME",
    "robots.txt",
    "sitemap.xml",
  ]) {
    assert.equal(await isFile(path), true, `Missing Pages asset: ${path}`);
  }
  assert.equal((await readFile(join(output, "CNAME"), "utf8")).trim(), "appshule.com");
});

test("Pages bundle routes role aliases to their distinct workspaces", async () => {
  const aliases = new Map([
    ["login", "/"],
    ["workspace", "/"],
    ["workspace/admin", "/admin/"],
    ["workspace/student", "/student/"],
    ["workspace/individual", "/student/"],
    ["workspace/learner", "/student/"],
    ["workspace/teacher", "/teacher/"],
    ["workspace/head_teacher", "/secretary/"],
    ["workspace/headteacher", "/secretary/"],
    ["workspace/secretary", "/secretary/"],
    ["workspace/bursar", "/bursar/"],
    ["workspace/parent", "/parent/"],
    ["workspace/clinic", "/clinic/"],
    ["workspace/farm", "/farm/"],
    ["workspace/mfi", "/mfi/"],
    ["school", "/secretary/"],
  ]);

  for (const [alias, target] of aliases) {
    const page = await readFile(join(output, alias, "index.html"), "utf8");
    assert.match(page, new RegExp(`location\\.replace\\("${target.replaceAll("/", "\\/")}"`), `Incorrect redirect for /${alias}`);
  }
});

test("Pages bundle keeps each role dashboard as a real page, not an alias redirect", async () => {
  for (const [role, path] of [
    ["student", "student/index.html"],
    ["teacher", "teacher/index.html"],
    ["secretary", "secretary/index.html"],
    ["bursar", "bursar/index.html"],
    ["parent", "parent/index.html"],
  ]) {
    const page = await readFile(join(output, path), "utf8");
    assert.match(page, new RegExp(`data-role="${role}"`), `Missing ${role} workspace`);
    assert.match(page, /role-workspace\.css/);
    assert.match(page, /role-workspace\.js/);
  }
  const studentPage = await readFile(join(output, "student/index.html"), "utf8");
  const workspaceScript = await readFile(join(output, "role-workspace.js"), "utf8");
  assert.match(studentPage, /Sync Now/);
  assert.match(studentPage, /Online · Not synced yet/);
  assert.match(workspaceScript, /My subjects/);
  assert.match(workspaceScript, /WEAK/);
  assert.match(workspaceScript, /YouTube Lesson/);
});

test("Pages bundle excludes archived Firebase and admission clients", async () => {
  for (const path of ["skills/firebase-config.js", "skills/provider-register.html", "skills/skills-enroll.html"]) {
    assert.equal(await isFile(path), false, `Archived client should not be staged: ${path}`);
  }
});

test("Pages bundle includes D1-backed provider onboarding", async () => {
  const path = "skills/join-provider.html";
  assert.equal(await isFile(path), true, `Provider onboarding should be staged: ${path}`);
  const page = await readFile(join(output, path), "utf8");
  assert.match(page, /api\/auth\/request-login-otp/);
  assert.match(page, /api\/skills\/providers\/register/);
  assert.doesNotMatch(page, /firebase|firestore|firebasestorage/i);
});

test("Pages bundle includes password sign-in, verified signup, and teacher review", async () => {
  const page = await readFile(join(output, "index.html"), "utf8");
  assert.match(page, /id="password-login-form"/);
  assert.match(page, /api\/auth\/login/);
  assert.match(page, /api\/auth\/request-signup-verification/);
  assert.match(page, /api\/auth\/verify-signup/);
  assert.match(page, /teacher_staff/);
  const admin = await readFile(join(output, "admin", "index.html"), "utf8");
  assert.match(admin, /api\/admin\/teacher-applications/);
  assert.match(admin, /Approve/);
  assert.match(admin, /Reject/);
});

test("Pages assets do not require Firebase or Render at runtime", async () => {
  const contents = (await textFiles()).join("\n");
  assert.doesNotMatch(contents, /firebasejs|firebaseio\.com|firebaseapp\.com|firebase\.googleapis\.com|onrender\.com/i);
  assert.doesNotMatch(contents, /https:\/\/(?:www\.)?appshule\.com\/api\//i);
});