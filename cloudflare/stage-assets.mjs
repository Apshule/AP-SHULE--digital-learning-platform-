import { cp, copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const root = resolve(".");
const output = resolve("cloudflare/assets");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const excludedSkillsFiles = new Set([
  "firebase-config.js",
  "join-provider.html",
  "provider-register.html",
  "skills-enroll.html",
]);

// Keep this list aligned with WORKSPACE_PAGE_FALLBACKS in worker.ts.
// These HTML redirects let GitHub Pages serve the same role-entry URLs.
const pagesRouteRedirects = new Map([
  ["login", "/"],
  ["workspace", "/"],
  ["workspace/admin", "/admin/"],
  ["workspace/student", "/education/"],
  ["workspace/individual", "/education/"],
  ["workspace/learner", "/education/"],
  ["workspace/teacher", "/education/"],
  ["workspace/head_teacher", "/education/"],
  ["workspace/headteacher", "/education/"],
  ["workspace/secretary", "/education/"],
  ["workspace/bursar", "/education/"],
  ["workspace/parent", "/education/"],
  ["workspace/education", "/education/"],
  ["workspace/clinic", "/clinic/"],
  ["workspace/farm", "/farm/"],
  ["workspace/mfi", "/mfi/"],
  ["school", "/education/"],
  ["student", "/education/"],
  ["teacher", "/education/"],
]);

function redirectPage(target) {
  const targetJson = JSON.stringify(target);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="0;url=${target}">
  <link rel="canonical" href="${target}">
  <title>Opening APSHULE</title>
</head>
<body>
  <p>Opening your APSHULE workspace… <a href="${target}">Continue</a></p>
  <script>location.replace(${targetJson} + location.search + location.hash);</script>
</body>
</html>
`;
}

async function copySkills(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    const relativePath = relative(resolve(root, "skills"), from).replaceAll("\\", "/");
    if (excludedSkillsFiles.has(entry.name) || relativePath.startsWith("firebase/")) continue;
    if (entry.isDirectory()) await copySkills(from, to);
    else if (entry.isFile()) {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }
}

await copySkills(resolve(root, "skills"), resolve(output, "skills"));
await cp(resolve(root, "icons"), resolve(output, "icons"), { recursive: true });
await cp(resolve(root, ".well-known"), resolve(output, ".well-known"), { recursive: true });
await cp(resolve(root, "cloudflare/static"), output, { recursive: true });
await copyFile(resolve(output, "manifest.webmanifest"), resolve(output, "manifest.json"));

const rootFiles = new Set(await readdir(root));
for (const filename of ["CNAME", "robots.txt", "sitemap.xml"]) {
  if (rootFiles.has(filename)) await copyFile(resolve(root, filename), resolve(output, filename));
}

await writeFile(resolve(output, ".nojekyll"), "");

for (const [alias, target] of pagesRouteRedirects) {
  const aliasPage = resolve(output, alias, "index.html");
  await mkdir(dirname(aliasPage), { recursive: true });
  await writeFile(aliasPage, redirectPage(target), "utf8");
}

console.log(`Staged Cloudflare assets in ${output}`);