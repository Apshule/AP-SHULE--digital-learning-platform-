import assert from "node:assert/strict";
import test from "node:test";
import type { AuthEnv, AuthUser } from "./backend-types";
import { handleProfileFileRoute } from "./profile-files";

type ProfileRow = { active_key: string; content_type: string } | null;

class MemoryDatabase {
  photo: ProfileRow = null;
  placeholderKey = "legacy/placeholder-avatar.jpg";

  prepare(sql: string) {
    let values: unknown[] = [];
    return {
      bind: (...args: unknown[]) => {
        values = args;
        return this.prepareBound(sql, () => values);
      },
      all: async <T = Record<string, unknown>>() => this.all<T>(sql, values),
      run: async () => this.run(sql, values),
    };
  }

  private prepareBound(sql: string, args: () => unknown[]) {
    return {
      bind: (...values: unknown[]) => {
        args = () => values;
        return this.prepareBound(sql, args);
      },
      all: async <T = Record<string, unknown>>() => this.all<T>(sql, args()),
      run: async () => this.run(sql, args()),
    };
  }

  async batch() {
    return [];
  }

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    if (sql.includes("SELECT active_key")) {
      return { rows: this.photo ? [this.photo as unknown as T] : [] };
    }
    if (sql.includes("FROM public.storage_migration_manifest")) {
      return {
        rows: [{
          object_key: this.placeholderKey,
          content_type: "image/jpeg",
        } as unknown as T],
      };
    }
    if (sql.includes("INSERT INTO profile_photos")) {
      this.photo = { active_key: String(values[1]), content_type: String(values[2]) };
    }
    return { rows: [] };
  }

  private async all<T>(sql: string, values: unknown[]): Promise<{ results: T[] }> {
    if (sql.includes("SELECT active_key")) {
      return { results: this.photo ? [this.photo as T] : [] };
    }
    if (sql.includes("SELECT object_key")) {
      return { results: [{ object_key: this.placeholderKey, content_type: "image/jpeg" } as T] };
    }
    return { results: [] };
  }

  private async run(sql: string, values: unknown[]) {
    if (sql.includes("INSERT INTO profile_photos")) {
      this.photo = { active_key: String(values[1]), content_type: String(values[2]) };
    }
    return {};
  }
}

class MemoryFiles {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  putKeys: string[] = [];

  async put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
    this.putKeys.push(key);
    this.objects.set(key, {
      bytes: new Uint8Array(value.slice(0)),
      contentType: options?.httpMetadata?.contentType || "application/octet-stream",
    });
    return {};
  }

  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = stored.bytes;
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      httpMetadata: { contentType: stored.contentType },
    };
  }
}

const user: AuthUser = {
  uid: "account/id-42",
  email: "person@example.com",
  displayName: "Example User",
  role: "teacher",
  schoolId: "school-1",
  institutionId: "institution-1",
  sessionVersion: 1,
};

function environment(db = new MemoryDatabase(), files = new MemoryFiles()) {
  const placeholderBytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
  files.objects.set(db.placeholderKey, { bytes: placeholderBytes, contentType: "image/jpeg" });
  return {
    DB: db,
    PG: { query: db.query.bind(db) } as unknown as NonNullable<AuthEnv["PG"]>,
    FILES: files,
    PUBLIC_SITE_URL: "https://appshule.com",
    placeholderBytes,
  };
}

test("serves a manifest placeholder until the user has a profile photo", async () => {
  const env = environment();
  const response = await handleProfileFileRoute(
    new Request("https://appshule.com/api/profile/photo"),
    env,
    user,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), env.placeholderBytes);
});

test("stores and serves a photo under a server-derived, opaque account key", async () => {
  const env = environment();
  const originalPlaceholder = env.FILES.objects.get(env.DB.placeholderKey);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x10, 0x20]);
  const upload = await handleProfileFileRoute(
    new Request("https://appshule.com/api/profile/photo", {
      method: "POST",
      headers: { origin: "https://appshule.com", "content-type": "image/jpeg" },
      body: jpeg,
    }),
    env,
    user,
  );

  assert.equal(upload.status, 200);
  const uploadBody = await upload.json() as Record<string, unknown>;
  assert.equal(uploadBody.ok, true);
  assert.equal(uploadBody.contentType, "image/jpeg");
  assert.equal(uploadBody.sizeBytes, jpeg.byteLength);
  assert.equal(typeof uploadBody.updatedAt, "string");
  assert.equal(env.FILES.putKeys.length, 1);
  assert.ok(env.FILES.putKeys[0].startsWith("profile/"));
  assert.equal(env.FILES.putKeys[0].includes(user.uid), false);

  const served = await handleProfileFileRoute(
    new Request("https://appshule.com/api/profile/photo"),
    env,
    user,
  );
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), jpeg);
  assert.deepEqual(env.FILES.objects.get(env.DB.placeholderKey), originalPlaceholder);
});

test("rejects cross-site uploads and image bodies that do not match their declared type", async () => {
  const env = environment();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
  const crossSite = await handleProfileFileRoute(
    new Request("https://appshule.com/api/profile/photo", {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "image/jpeg" },
      body: jpeg,
    }),
    env,
    user,
  );
  assert.equal(crossSite.status, 403);

  const mismatch = await handleProfileFileRoute(
    new Request("https://appshule.com/api/profile/photo", {
      method: "POST",
      headers: { origin: "https://appshule.com", "content-type": "image/png" },
      body: jpeg,
    }),
    env,
    user,
  );
  assert.equal(mismatch.status, 415);
  assert.equal(env.FILES.putKeys.length, 0);
});