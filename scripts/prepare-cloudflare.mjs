import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function prepareCloudflare({ accountId, token, workerName = "mahoraga-halal", fetcher = fetch }) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "")) throw new Error("Set CLOUDFLARE_ACCOUNT_ID to your Cloudflare account ID");
  if (!token?.trim()) throw new Error("Add CLOUDFLARE_API_TOKEN to this repository's Actions secrets");
  if (!/^[a-z][a-z0-9-]{1,45}$/.test(workerName)) throw new Error("Invalid CLOUDFLARE_WORKER_NAME");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  async function request(path, { method = "GET", body, allowMissing = false } = {}) {
    const response = await fetcher(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (allowMissing && response.status === 404) return null;
    const data = await response.json();
    if (!response.ok || data.success !== true) {
      throw new Error(`Cloudflare ${method} ${path}: ${data.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") || response.status}`);
    }
    return data;
  }
  async function list(path) {
    const results = [];
    for (let page = 1; page <= 100; page++) {
      const data = await request(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(data.result)) throw new Error(`Invalid resource list: ${path}`);
      results.push(...data.result);
      if (data.result.length < 100 || page >= (data.result_info?.total_pages ?? Infinity)) return results;
    }
    throw new Error(`Resource pagination limit exceeded: ${path}`);
  }
  const dbName = `${workerName}-db`;
  const namespaceTitle = `${workerName}-cache`;
  const bucketName = `${workerName}-artifacts`;
  const databases = (await list("/d1/database")).filter((database) => database.name === dbName);
  if (databases.length > 1) throw new Error(`Multiple databases named ${dbName}; refusing to select one`);
  const database = databases[0] ?? (await request("/d1/database", { method: "POST", body: { name: dbName } })).result;
  if (!/^[a-f0-9-]{36}$/.test(database?.uuid ?? "")) throw new Error("Cloudflare returned an invalid D1 identifier");
  const namespaces = (await list("/storage/kv/namespaces")).filter((namespace) => namespace.title === namespaceTitle);
  if (namespaces.length > 1) throw new Error(`Multiple namespaces named ${namespaceTitle}; refusing to select one`);
  const namespace = namespaces[0] ?? (await request("/storage/kv/namespaces", { method: "POST", body: { title: namespaceTitle } })).result;
  if (!/^[a-f0-9]{32}$/.test(namespace?.id ?? "")) throw new Error("Cloudflare returned an invalid KV identifier");
  const bucket = await request(`/r2/buckets/${bucketName}`, { allowMissing: true });
  if (!bucket) await request("/r2/buckets", { method: "POST", body: { name: bucketName } });

  const config = JSON.parse(await readFile(new URL("../wrangler.deploy.template.json", import.meta.url), "utf8"));
  config.name = workerName;
  config.d1_databases = [{ binding: "DB", database_name: dbName, database_id: database.uuid, migrations_dir: "migrations" }];
  config.kv_namespaces = [{ binding: "CACHE", id: namespace.id }];
  config.r2_buckets = [{ binding: "ARTIFACTS", bucket_name: bucketName }];
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = await prepareCloudflare({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN, workerName: process.env.CLOUDFLARE_WORKER_NAME || "mahoraga-halal" });
    await writeFile("wrangler.deploy.generated.json", `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Cloudflare resources ready for ${config.name}; paper trading remains configured`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
