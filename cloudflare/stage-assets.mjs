import { cp, copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { generateSW } from "workbox-build";

const root = resolve(".");
const output = resolve("cloudflare/assets");
const RELEASE = "v15";

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const excludedSkillsFiles = new Set([
  "firebase-config.js",
  "provider-register.html",
  "skills-enroll.html",
]);

// Keep these static aliases aligned with the explicitly served paths in worker.ts.
const pagesRouteRedirects = new Map([
  ["login", "/"],
  ["workspace", "/"],
  ["learn", "/student/"],
  ["my-account", "/profile.html"],
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
  ["workspace/education", "/education/"],
  ["workspace/clinic", "/clinic/"],
  ["workspace/farm", "/farm/"],
  ["workspace/mfi", "/mfi/"],
  ["school", "/secretary/"],
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

await copyFile(resolve(root, ".nojekyll"), resolve(output, ".nojekyll"));
await copyFile(resolve(root, "_nojekyll"), resolve(output, "_nojekyll"));

for (const [alias, target] of pagesRouteRedirects) {
  const aliasPage = resolve(output, alias, "index.html");
  await mkdir(dirname(aliasPage), { recursive: true });
  await writeFile(aliasPage, redirectPage(target), "utf8");
}

const sharedWorkboxOptions = {
  mode: "production",
  maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
  skipWaiting: true,
  clientsClaim: true,
  cleanupOutdatedCaches: true,
  inlineWorkboxRuntime: true,
  sourcemap: false,
};

await generateSW({
  ...sharedWorkboxOptions,
  cacheId: `appshule-offline-${RELEASE}`,
  globDirectory: root,
  globPatterns: [
    "index.html",
    "offline-manager.js",
    "manifest.json",
    "icons/icon-192.png",
    "icons/icon-512-maskable.png",
  ],
  swDest: resolve(root, "sw.js"),
  importScripts: ["/pwa-push-handlers.js"],
  navigateFallback: "/index.html",
  navigateFallbackDenylist: [/^\/api\//, /^\/reset-password\.html(?:$|\/)/],
  runtimeCaching: [
    {
      urlPattern: ({ url, request }) =>
        request.method === "GET" &&
        (url.origin === self.location.origin ||
          ["www.gstatic.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com", "i.ibb.co"].includes(url.hostname.toLowerCase())) &&
        !url.pathname.startsWith("/api/") &&
        !(url.pathname === "/reset-password.html" && url.searchParams.has("token")) &&
        request.mode !== "navigate" &&
        /\.(?:html?|css|js|mjs|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i.test(url.pathname),
      handler: "CacheFirst",
      options: {
        cacheName: `appshule-offline-${RELEASE}-shell`,
        expiration: { maxEntries: 120, maxAgeSeconds: 30 * 24 * 60 * 60 },
        plugins: [{
          cacheWillUpdate: async ({ response }) =>
            (response.ok || response.type === "opaque") && !response.headers.has("set-cookie") ? response : null,
        }],
      },
    },
    {
      urlPattern: ({ url, request }) =>
        request.method === "GET" &&
        url.origin === self.location.origin &&
        request.mode === "navigate" &&
        !(url.pathname === "/reset-password.html" && url.searchParams.has("token")),
      handler: "NetworkFirst",
      options: {
        cacheName: `appshule-offline-${RELEASE}-navigation`,
        networkTimeoutSeconds: 3,
        expiration: { maxEntries: 120, maxAgeSeconds: 30 * 24 * 60 * 60 },
        plugins: [{
          cacheWillUpdate: async ({ response }) =>
            (response.ok || response.type === "opaque") && !response.headers.has("set-cookie") ? response : null,
        }],
      },
    },
    {
      urlPattern: /^https:\/\/(?:firebasestorage\.googleapis\.com|storage\.googleapis\.com|appshule-app\.firebasestorage\.app)\//i,
      handler: "StaleWhileRevalidate",
      options: {
        cacheName: `appshule-offline-${RELEASE}-firebase-storage`,
        expiration: { maxEntries: 120, maxAgeSeconds: 30 * 24 * 60 * 60 },
      },
    },
    {
      urlPattern: /^https:\/\/firestore\.googleapis\.com\/(?:v1\/projects\/[^/]+\/databases\/|google\.firestore\.v1\.Firestore\/)/i,
      handler: "NetworkFirst",
      options: {
        cacheName: `appshule-offline-${RELEASE}-data`,
        networkTimeoutSeconds: 3,
        expiration: { maxEntries: 120, maxAgeSeconds: 7 * 24 * 60 * 60 },
      },
    },
  ],
});

await generateSW({
  ...sharedWorkboxOptions,
  cacheId: `apshule-cloudflare-shell-${RELEASE}`,
  globDirectory: output,
  globPatterns: ["**/*.{html,css,js,json,webmanifest,png,svg,ico,woff2}"],
  globIgnores: ["sw.js", "workbox-*.js"],
  swDest: resolve(output, "sw.js"),
  importScripts: ["/pwa-push-handlers.js"],
  navigateFallback: "/index.html",
  navigateFallbackDenylist: [/^\/api\//, /^\/reset-password\.html(?:$|\/)/],
  navigationPreload: true,
  runtimeCaching: [
    {
      urlPattern: ({ url, request }) =>
        request.method === "GET" &&
        url.origin === self.location.origin &&
        !url.pathname.startsWith("/api/") &&
        !(url.pathname === "/reset-password.html" && url.searchParams.has("token")),
      handler: "NetworkFirst",
      options: {
        cacheName: `apshule-cloudflare-shell-${RELEASE}-runtime`,
        networkTimeoutSeconds: 3,
        expiration: { maxEntries: 120, maxAgeSeconds: 30 * 24 * 60 * 60 },
        plugins: [{
          cacheWillUpdate: async ({ response }) =>
            response.ok && !response.headers.has("set-cookie") ? response : null,
        }],
      },
    },
  ],
});

console.log(`Staged Cloudflare assets in ${output}`);