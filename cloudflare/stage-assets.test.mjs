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
    "robots.txt",
    "sitemap.xml",
  ]) {
    assert.equal(await isFile(path), true, `Missing Pages asset: ${path}`);
  }
});

test("Pages bundle retains role aliases with redirects to sector workspaces", async () => {
  const aliases = new Map([
    ["login", "/"],
    ["workspace", "/"],
    ["workspace/admin", "/admin/"],
    ["workspace/student", "/education/"],
    ["workspace/teacher", "/education/"],
    ["workspace/head_teacher", "/education/"],
    ["workspace/secretary", "/education/"],
    ["workspace/bursar", "/education/"],
    ["workspace/parent", "/education/"],
    ["workspace/clinic", "/clinic/"],
    ["workspace/farm", "/farm/"],
    ["workspace/mfi", "/mfi/"],
    ["school", "/education/"],
    ["student", "/education/"],
    ["teacher", "/education/"],
  ]);

  for (const [alias, target] of aliases) {
    const page = await readFile(join(output, alias, "index.html"), "utf8");
    assert.match(page, new RegExp(`location\\.replace\\("${target.replaceAll("/", "\\/")}"`), `Incorrect redirect for /${alias}`);
  }
});

test("Pages bundle excludes archived Firebase and admission clients", async () => {
  for (const path of ["skills/firebase-config.js", "skills/provider-register.html", "skills/skills-enroll.html"]) {
    assert.equal(await isFile(path), false, `Archived client should not be staged: ${path}`);
  }
});

test("Pages assets do not require Firebase or Render at runtime", async () => {
  const contents = (await textFiles()).join("\n");
  assert.doesNotMatch(contents, /firebasejs|firebaseio\.com|firebaseapp\.com|firebase\.googleapis\.com|onrender\.com/i);
  assert.doesNotMatch(contents, /https:\/\/(?:www\.)?appshule\.com\/api\//i);
});