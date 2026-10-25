import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareCloudflare } from "./prepare-cloudflare.mjs";

const accountId = "1".repeat(32);
const token = "test-deployment-token";
const database = { name: "mahoraga-halal-db", uuid: "11111111-1111-4111-8111-111111111111" };
const namespace = { title: "mahoraga-halal-cache", id: "2".repeat(32) };
const bucket = { name: "mahoraga-halal-artifacts" };
const ok = (result, extra = {}) => new Response(JSON.stringify({ success: true, result, ...extra }));

function api(existing = true) {
  const calls = [];
  let dbExists = existing;
  let kvExists = existing;
  let bucketExists = existing;
  const fetcher = async (input, options) => {
    const url = new URL(input);
    const path = url.pathname.replace(`/client/v4/accounts/${accountId}`, "");
    calls.push({ path, method: options.method });
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    if (path === "/d1/database") {
      if (options.method === "GET") return ok(dbExists ? [database] : []);
      dbExists = true;
      return ok(database);
    }
    if (path === "/storage/kv/namespaces") {
      if (options.method === "GET") return ok(kvExists ? [namespace] : []);
      kvExists = true;
      return ok(namespace);
    }
    if (path === `/r2/buckets/${bucket.name}`) return bucketExists ? ok(bucket) : new Response("not found", { status: 404 });
    if (path === "/r2/buckets" && options.method === "POST") {
      bucketExists = true;
      return ok(bucket);
    }
    throw new Error(`Unexpected request ${options.method} ${path}`);
  };
  return { calls, fetcher };
}

test("reuses resources and generates a combined dashboard/Worker config without credentials", async () => {
  const { fetcher, calls } = api();
  const config = await prepareCloudflare({ accountId, token, fetcher });
  assert.equal(config.d1_databases[0].database_id, database.uuid);
  assert.equal(config.kv_namespaces[0].id, namespace.id);
  assert.equal(config.vars.ALPACA_PAPER, "true");
  assert.equal(config.assets.directory, "./dashboard/dist");
  assert(config.assets.run_worker_first.includes("/api/*"));
  assert(!JSON.stringify(config).includes(token));
  assert(calls.every((call) => call.method === "GET"));
});

test("creates missing resources once and reuses them on the next deployment", async () => {
  const { fetcher, calls } = api(false);
  await prepareCloudflare({ accountId, token, fetcher });
  await prepareCloudflare({ accountId, token, fetcher });
  assert.equal(calls.filter((call) => call.method === "POST").length, 3);
});

test("stops on permission failures instead of attempting resource creation", async () => {
  let requests = 0;
  await assert.rejects(prepareCloudflare({ accountId, token, fetcher: async () => {
    requests++;
    return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
  } }), /Authentication error/);
  assert.equal(requests, 1);
});

test("rejects missing credentials before contacting Cloudflare", async () => {
  await assert.rejects(prepareCloudflare({ accountId, token: "", fetcher: () => assert.fail("must not contact API") }), /Actions secrets/);
});

test("reads all KV pages before creating a namespace", async () => {
  const base = api();
  const config = await prepareCloudflare({ accountId, token, fetcher: async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/storage/kv/namespaces")) {
      assert.equal(options.method, "GET");
      return url.searchParams.get("page") === "1"
        ? ok(Array.from({ length: 100 }, (_, i) => ({ title: `other-${i}`, id: String(i) })), { result_info: { total_pages: 2 } })
        : ok([namespace]);
    }
    return base.fetcher(input, options);
  } });
  assert.equal(config.kv_namespaces[0].id, namespace.id);
});
