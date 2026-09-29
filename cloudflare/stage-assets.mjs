import { cp, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const root = resolve(".");
const output = resolve("cloudflare/assets");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const excludedSkillsFiles = new Set([
  "firebase-config.js",
  "join-provider.html",
  "provider-register.html",
]);

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

console.log(`Staged Cloudflare assets in ${output}`);