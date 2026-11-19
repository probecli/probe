import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isAddress, recoverMessageAddress, toHex, type PublicClient } from "viem";
import { loadConfig } from "./config.ts";
import { Store, toPublic } from "./db.ts";
import { Pipeline } from "./pipeline.ts";
import { publicClient, readJob, tokenMeta, formatUnitsShort, type OnchainJob } from "../shared/chain.ts";
import { specHash, validateSpec, type RegisteredJob } from "../shared/spec.ts";
import { caseTitle, contractNameOf } from "../shared/rules.ts";
import { isReportKey } from "../shared/crypto.ts";
import {
  JOB_REQUEST_FIELDS,
  JOB_REQUEST_STATUSES,
  registrationMessage,
  reportsMessage,
  requestHash,
  requestMessage,
  requestStatusMessage,
  requestsListMessage,
  sourceHash,
  submissionMessage,
  type JobRequestInput,
  type JobRequestStatus,
} from "../shared/messages.ts";
import { probeJobsAbi } from "../shared/artifacts.ts";
import { shortFp } from "../shared/forge.ts";
import { checkHook, POOL_MANAGERS, reportMessage, type HookReport } from "../shared/hookcheck.ts";
import { privateKeyToAccount } from "viem/accounts";
import type { JobView } from "../shared/api.ts";

const cfg = loadConfig();
const store = new Store(join(cfg.dataDir, "verifier.sqlite"));
const client: PublicClient = publicClient(cfg.rpcUrl, cfg.chainId);
const pipeline = new Pipeline(cfg, store, client);

// ------------------------------------------------------------------ helpers

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": cfg.corsOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request body is larger than 256 KB.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

// Simple fixed-window rate limit for writes.
const hits = new Map<string, { n: number; reset: number }>();
function rateLimit(req: IncomingMessage, max = 30) {
  // Behind Caddy every request comes from the proxy; use the client address it forwards.
  const fwd = req.headers["x-forwarded-for"];
  const key = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + 60_000 });
  else if (++h.n > max) throw new HttpError(429, "Too many requests. Try again in a minute.");
}

const stateCache = new Map<string, { at: number; state: OnchainJob }>();
async function jobState(job: RegisteredJob): Promise<OnchainJob> {
  const c = stateCache.get(job.slug);
  if (c && Date.now() - c.at < 4_000) return c.state;
  const state = await readJob(client, job.chain.contract, BigInt(job.chain.jobId));
  stateCache.set(job.slug, { at: Date.now(), state });
  return state;
}

async function view(job: RegisteredJob): Promise<JobView> {
  const s = await jobState(job);
  const open = s.status === 1 && BigInt(Math.floor(Date.now() / 1000)) <= s.deadline;
  return {
    ...job,
    state: {
      status: open ? "open" : "closed",
      budget: s.budget.toString(),
      funded: s.funded.toString(),
      rewardPerAccepted: s.rewardPerAccepted.toString(),
      accepted: s.accepted,
      deadline: Number(s.deadline),
      sponsor: s.sponsor,
      eligibilityToken: s.eligibilityToken,
      minHolding: s.minHolding.toString(),
    },
  };
}

function reportKeyHex(b64: string): `0x${string}` {
  return toHex(new Uint8Array(Buffer.from(b64, "base64")));
}

// ------------------------------------------------------------------ handlers

async function registerJob(body: unknown) {
  const { spec, jobId, signature } = (body ?? {}) as { spec?: unknown; jobId?: string; signature?: `0x${string}` };
  try {
    validateSpec(spec);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if (!isReportKey(spec.reportKey)) throw new HttpError(400, "reportKey must be a base64 X25519 public key (32 bytes).");
  if (!jobId || !/^\d+$/.test(jobId)) throw new HttpError(400, "jobId is required.");
  if (!signature) throw new HttpError(400, "signature is required.");
  const existing = store.getJob(spec.slug);
  if (existing && existing.job.chain.jobId !== jobId) throw new HttpError(409, `A job with slug ${spec.slug} is already registered.`);

  const hash = specHash(spec);
  const onchain = await readJob(client, cfg.contract, BigInt(jobId));
  if (onchain.status === 0) throw new HttpError(404, `Job ${jobId} does not exist on-chain.`);
  if (onchain.status !== 1) throw new HttpError(409, `Job ${jobId} is closed.`);
  if (onchain.specHash.toLowerCase() !== hash.toLowerCase()) throw new HttpError(409, "The on-chain spec hash does not match this spec.");
  if (onchain.verifier.toLowerCase() !== cfg.address.toLowerCase()) throw new HttpError(409, "The on-chain job names a different verifier.");
  if (onchain.reportKey.toLowerCase() !== reportKeyHex(spec.reportKey).toLowerCase()) throw new HttpError(409, "The on-chain report key does not match the spec.");
  const signer = await recoverMessageAddress({
    message: registrationMessage({ slug: spec.slug, specHash: hash, jobId, contract: cfg.contract, chainId: cfg.chainId }),
    signature,
  });
  if (signer.toLowerCase() !== onchain.sponsor.toLowerCase()) throw new HttpError(403, "Signature is not from the job's sponsor.");

  const meta = await tokenMeta(client, onchain.rewardToken);
  const job: RegisteredJob = {
    ...spec,
    specHash: hash,
    chain: {
      chainId: cfg.chainId,
      rpcUrl: cfg.publicRpcUrl,
      contract: cfg.contract,
      jobId,
      rewardToken: onchain.rewardToken,
      rewardSymbol: meta.symbol,
      rewardDecimals: meta.decimals,
      explorerUrl: cfg.explorerUrl,
    },
  };
  store.saveJob(job);
  try {
    await pipeline.prepareJob(job);
  } catch (e) {
    throw new HttpError(422, `Registered, but the workspace could not be prepared: ${(e as Error).message}`);
  }
  return view(job);
}

async function createSubmission(body: unknown) {
  const { slug, source, operator, nonce, signature } = (body ?? {}) as {
    slug?: string;
    source?: string;
    operator?: string;
    nonce?: number;
    signature?: `0x${string}`;
  };
  if (!slug || typeof source !== "string" || !operator || typeof nonce !== "number" || !signature) {
    throw new HttpError(400, "slug, source, operator, nonce and signature are required.");
  }
  if (!isAddress(operator)) throw new HttpError(400, "operator must be an address.");
  if (Math.abs(Date.now() - nonce) > 10 * 60_000) throw new HttpError(400, "nonce must be the current time in milliseconds (within 10 minutes).");
  const entry = store.getJob(slug);
  if (!entry) throw new HttpError(404, `No job named ${slug}.`);
  const hash = sourceHash(source);
  const signer = await recoverMessageAddress({ message: submissionMessage({ slug, sourceHash: hash, nonce }), signature });
  if (signer.toLowerCase() !== operator.toLowerCase()) throw new HttpError(403, "Signature does not match the operator address.");

  const caseName = contractNameOf(source) ?? "UnnamedCase";
  const id = randomUUID();
  try {
    store.insertSubmission({ id, slug, operator, nonce, caseName, title: caseTitle(source, caseName), source, sourceHash: hash });
  } catch {
    throw new HttpError(409, "This nonce was already used. Sign the submission again.");
  }
  pipeline.submit(id);
  return toPublic(store.getSubmission(id)!);
}

async function sponsorReports(slug: string, url: URL) {
  const entry = store.getJob(slug);
  if (!entry) throw new HttpError(404, `No job named ${slug}.`);
  const nonce = Number(url.searchParams.get("nonce"));
  const signature = url.searchParams.get("signature") as `0x${string}` | null;
  if (!signature || !nonce || Math.abs(Date.now() - nonce) > 10 * 60_000) throw new HttpError(400, "A fresh nonce and sponsor signature are required.");
  const signer = await recoverMessageAddress({ message: reportsMessage({ slug, nonce }), signature });
  const state = await jobState(entry.job);
  if (signer.toLowerCase() !== state.sponsor.toLowerCase()) throw new HttpError(403, "Only the job's sponsor can list its reports.");
  return store.reportsFor(slug).map((r) => ({ ...r, sealed: JSON.parse(r.sealed) }));
}

/** Jobs in the shape the website renders. */
async function feed() {
  const jobs = await Promise.all(store.listJobs().map(view));
  return jobs.map((j) => {
    const d = j.chain.rewardDecimals;
    const sym = j.chain.rewardSymbol;
    const reward = formatUnitsShort(BigInt(j.state.rewardPerAccepted), d);
    const budget = BigInt(j.state.budget);
    const subs = store.listSubmissions(j.slug, 50).filter((s) => s.status === "done");
    return {
      slug: j.slug,
      demo: false,
      sponsorAddress: j.state.sponsor,
      rewardAmount: `${reward} ${sym}`,
      rewardToken: j.chain.rewardToken,
      rewardSymbol: sym,
      rewardDecimals: d,
      budgetRaw: j.state.budget,
      status_onchain: j.state.status,
      chainId: j.chain.chainId,
      explorerUrl: j.chain.explorerUrl ?? null,
      deadline: j.state.deadline,
      title: j.title,
      summary: j.summary,
      status: j.state.status === "open" ? "open" : "completed",
      networkId: j.network.id,
      networkName: j.network.name,
      hook: j.hook,
      snapshot: j.snapshot,
      objective: j.objective,
      inScope: j.inScope,
      outOfScope: j.outOfScope,
      acceptanceRules: j.acceptanceRules,
      rewardModel: j.rewardModel,
      reward: {
        headline: `${reward} ${sym} per ${j.rewardModel === "coverage" ? "case that adds coverage" : "accepted case"}`,
        detail: `${j.reward.detail} Paid from the job's on-chain budget by the ProbeJobs contract.`,
      },
      funding: {
        status: j.state.status !== "open" ? "exhausted" : budget >= BigInt(j.state.rewardPerAccepted) ? "funded" : "exhausted",
        detail: `${formatUnitsShort(budget, d)} ${sym} left of ${formatUnitsShort(BigInt(j.state.funded), d)} ${sym} funded on-chain. ${j.state.accepted} accepted so far.`,
      },
      sponsor: j.sponsor,
      contract: j.chain.contract,
      chainJobId: j.chain.jobId,
      cases: subs.slice(0, 12).reverse().map((s) => ({
        id: s.id,
        title: s.title,
        result: s.verdict === "accepted" ? "accepted" : s.verdict === "duplicate" ? "duplicate" : "failed",
        verdict: s.reason ?? "",
        explanation:
          s.verdict === "accepted"
            ? `Reproduced twice on the pinned snapshot and paid ${s.reward ?? "the posted reward"} on-chain. The case and its trace were sent encrypted to the sponsor.`
            : s.verdict === "duplicate"
              ? "Reproduced, but it takes the same execution path as an accepted case, so it does not earn a second reward."
              : s.verdict === "ineligible"
                ? "Reproduced, but the operator did not meet the job's holding requirement, so no reward was paid."
                : `Did not qualify: ${s.reason}.`,
        fingerprint: s.fingerprint ? shortFp(s.fingerprint) : "none",
        txHash: s.txHash,
        operator: s.operator,
        finishedAt: s.finishedAt,
      })),
    };
  });
}

/** Network-wide totals, all read from chain state and the verifier's records. */
async function stats() {
  const jobs = await Promise.all(store.listJobs().map(view));
  const byToken = new Map<string, { symbol: string; decimals: number; funded: bigint; paid: bigint; available: bigint }>();
  let accepted = 0;
  let lastSettlementAt: number | null = null;
  for (const j of jobs) {
    const t = byToken.get(j.chain.rewardToken) ?? { symbol: j.chain.rewardSymbol, decimals: j.chain.rewardDecimals, funded: 0n, paid: 0n, available: 0n };
    t.funded += BigInt(j.state.funded);
    t.paid += BigInt(j.state.rewardPerAccepted) * BigInt(j.state.accepted);
    if (j.state.status === "open") t.available += BigInt(j.state.budget);
    byToken.set(j.chain.rewardToken, t);
    accepted += j.state.accepted;
    for (const s of store.accepted(j.slug)) if (s.finishedAt && (!lastSettlementAt || s.finishedAt > lastSettlementAt)) lastSettlementAt = s.finishedAt;
  }
  const block = await client.getBlockNumber();
  const gas = await client.getBalance({ address: cfg.address });
  return {
    ok: true,
    network: cfg.networkName,
    chainId: cfg.chainId,
    contract: cfg.contract,
    verifier: cfg.address,
    verifierGasWei: gas.toString(),
    block: block.toString(),
    jobsOpen: jobs.filter((j) => j.state.status === "open").length,
    jobsTotal: jobs.length,
    accepted,
    lastSettlementAt,
    tokens: [...byToken.entries()].map(([address, t]) => ({
      address,
      symbol: t.symbol,
      funded: formatUnitsShort(t.funded, t.decimals),
      paid: formatUnitsShort(t.paid, t.decimals),
      available: formatUnitsShort(t.available, t.decimals),
    })),
  };
}

// ------------------------------------------------------------------ job requests

const LIMITS: Record<keyof JobRequestInput, { max: number; required?: boolean }> = {
  team: { max: 80, required: true },
  hook: { max: 160, required: true },
  repo: { max: 300 },
  network: { max: 40 },
  pays: { max: 40 },
  budget: { max: 80 },
  scenarios: { max: 4000, required: true },
  valid: { max: 2000 },
  contact: { max: 160, required: true },
  login: { max: 160 },
};

function parseRequest(raw: unknown): JobRequestInput {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "Missing request.");
  const out = {} as JobRequestInput;
  for (const k of JOB_REQUEST_FIELDS) {
    const v = (raw as Record<string, unknown>)[k] ?? "";
    if (typeof v !== "string") throw new HttpError(400, `${k} must be text.`);
    const lim = LIMITS[k];
    if (lim.required && !v.trim()) throw new HttpError(400, `${k} is required.`);
    if (v.length > lim.max) throw new HttpError(400, `${k} is longer than ${lim.max} characters.`);
    out[k] = v;
  }
  if (out.repo && !/^https?:\/\/\S+$/.test(out.repo)) throw new HttpError(400, "repo must be an http(s) link.");
  return out;
}

let ownerCache: { at: number; owner: string } | null = null;
async function contractOwner(): Promise<string> {
  if (ownerCache && Date.now() - ownerCache.at < 60_000) return ownerCache.owner;
  const owner = (await client.readContract({ address: cfg.contract, abi: probeJobsAbi, functionName: "owner" })) as string;
  ownerCache = { at: Date.now(), owner: owner.toLowerCase() };
  return ownerCache.owner;
}

function fresh(ts: number) {
  return Number.isFinite(ts) && Math.abs(Date.now() - ts) < 10 * 60_000;
}

async function createRequest(body: unknown) {
  const b = (body ?? {}) as { request?: unknown; issued?: unknown; signature?: unknown };
  const data = parseRequest(b.request);
  const issued = Number(b.issued);
  if (!fresh(issued)) throw new HttpError(400, "This request was signed too long ago. Submit it again.");
  if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(b.signature)) throw new HttpError(400, "A wallet signature is required.");
  const wallet = await recoverMessageAddress({
    message: requestMessage({ team: data.team, hash: requestHash(data), issued }),
    signature: b.signature as `0x${string}`,
  });
  if (store.countOpenRequests(wallet) >= 10) throw new HttpError(429, "You have 10 requests waiting for review. We will reply before you send more.");
  const id = `req_${randomUUID().slice(0, 8)}`;
  store.insertRequest({ id, wallet, data, signature: b.signature });
  console.log(`job request ${id} from ${wallet}: ${data.team} / ${data.hook}`);
  return { id, wallet, status: "new" };
}

async function listRequests(url: URL) {
  const nonce = Number(url.searchParams.get("nonce"));
  const signature = url.searchParams.get("signature") as `0x${string}` | null;
  if (!signature || !fresh(nonce)) throw new HttpError(400, "A fresh nonce and wallet signature are required.");
  const signer = (await recoverMessageAddress({ message: requestsListMessage({ nonce }), signature })).toLowerCase();
  const isOwner = signer === (await contractOwner());
  return { wallet: signer, isOwner, requests: store.listRequests(isOwner ? undefined : signer) };
}

async function updateRequest(id: string, body: unknown) {
  const b = (body ?? {}) as { status?: unknown; note?: unknown; nonce?: unknown; signature?: unknown };
  const status = String(b.status) as JobRequestStatus;
  if (!JOB_REQUEST_STATUSES.includes(status)) throw new HttpError(400, "Unknown status.");
  const nonce = Number(b.nonce);
  if (typeof b.signature !== "string" || !fresh(nonce)) throw new HttpError(400, "A fresh nonce and owner signature are required.");
  const signer = (await recoverMessageAddress({ message: requestStatusMessage({ id, status, nonce }), signature: b.signature as `0x${string}` })).toLowerCase();
  if (signer !== (await contractOwner())) throw new HttpError(403, "Only the protocol owner can update requests.");
  const note = typeof b.note === "string" && b.note.trim() ? b.note.slice(0, 1000) : null;
  if (!store.setRequestStatus(id, status, note)) throw new HttpError(404, "No request with that id.");
  return { id, status, note };
}

// ------------------------------------------------------------------ hook checks

const signerAccount = privateKeyToAccount(cfg.privateKey);
const running = new Map<string, Promise<unknown>>();

/** Reproduce the standard checks for a hook at a block and sign the result. */
async function createHookCheck(body: unknown) {
  const b = (body ?? {}) as { hook?: unknown; block?: unknown };
  if (typeof b.hook !== "string" || !isAddress(b.hook)) throw new HttpError(400, "hook must be an address.");
  if (!POOL_MANAGERS[cfg.chainId]) throw new HttpError(400, `This verifier's chain (${cfg.chainId}) has no known Uniswap v4 PoolManager.`);
  const hook = b.hook.toLowerCase();
  const latest = await client.getBlockNumber();
  let block = latest;
  if (b.block !== undefined) {
    if (typeof b.block !== "string" || !/^\d+$/.test(b.block)) throw new HttpError(400, "block must be a block number.");
    block = BigInt(b.block);
    if (block > latest) throw new HttpError(400, `Block ${block} is in the future. The chain is at ${latest}.`);
  }
  // A recent signed check of the same hook is returned instead of running again.
  const prev = store.latestHookCheck(hook);
  if (prev && b.block === undefined && Date.now() - prev.createdAt < 10 * 60_000) return prev;
  if (prev && prev.report.block === block.toString()) return prev;

  const key = `${hook}:${block}`;
  if (!running.has(key)) {
    running.set(
      key,
      (async () => {
        let report: HookReport;
        try {
          report = await checkHook(client, hook, { chainId: cfg.chainId, block, poolScanBlocks: 40_000_000n });
        } catch (e) {
          const m = (e as Error).message;
          throw new HttpError(/missing trie node|historical state|not available/i.test(m) ? 400 : 502, /missing trie node|historical state/i.test(m) ? `The RPC has no state for block ${block}. Check a more recent block.` : `The check could not run: ${m.split("\n")[0]}`);
        }
        const signature = await signerAccount.signMessage({ message: reportMessage(report) });
        return store.insertHookCheck({ id: randomUUID(), report, signature, signer: cfg.address });
      })().finally(() => running.delete(key)),
    );
  }
  return running.get(key)!;
}

function hookCheckView(hook: string) {
  const latest = store.latestHookCheck(hook);
  if (!latest) throw new HttpError(404, "This hook has not been checked yet.");
  return { ...latest, message: reportMessage(latest.report), history: store.hookCheckHistory(hook) };
}

function badgeSvg(hook: string) {
  const latest = store.latestHookCheck(hook);
  const s = latest?.report.summary;
  const right = !s ? "not checked" : s.failed ? `${s.failed} failed` : `${s.passed} of ${s.total} passed`;
  const color = !s ? "#5F5D57" : s.failed ? "#C2311D" : s.warnings ? "#4A4945" : "#1F7A4D";
  const left = "PROBE check";
  const w = (t: string) => Math.round(t.length * 6.6 + 16);
  const lw = w(left) + 14;
  const rw = w(right);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${left}: ${right}">
<title>${left}: ${right}</title>
<clipPath id="r"><rect width="${lw + rw}" height="20" rx="4"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#141413"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/></g>
<g transform="translate(6 4) scale(0.375)" fill="none"><path d="M4.5 5.5 L16 13.4 M4.5 26.5 L16 18.6" stroke="#EDEBE4" stroke-width="5"/><circle cx="24.5" cy="16" r="4.25" fill="#E83F28"/></g>
<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-rendering="geometricPrecision">
<text x="${20 + (lw - 20) / 2}" y="14" text-anchor="middle">${left}</text>
<text x="${lw + rw / 2}" y="14" text-anchor="middle">${right}</text></g></svg>`;
}

// ------------------------------------------------------------------ status page

const SITE_URL = process.env.PUBLIC_SITE_URL ?? "https://probecli.com";
const esc = (v: unknown) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Human-facing page for anyone who opens the verifier URL in a browser. */
async function statusPage(res: ServerResponse) {
  let s: Awaited<ReturnType<typeof stats>> | null = null;
  try {
    s = await stats();
  } catch {
    s = null;
  }
  const up = Boolean(s);
  const ex = cfg.explorerUrl;
  const addr = (a: string) => (ex ? `<a href="${esc(ex)}/address/${esc(a)}">${esc(short(a))}</a>` : esc(short(a)));
  const rows: [string, string][] = [
    ["Network", `${esc(cfg.networkName)} <span class="dim">chain ${esc(cfg.chainId)}</span>`],
    ["Contract", addr(cfg.contract)],
    ["Verifier", addr(cfg.address)],
    ["Latest block", s ? esc(Number(s.block).toLocaleString("en-US")) : "—"],
    ["Open jobs", s ? esc(s.jobsOpen) : "—"],
    ["Accepted results", s ? esc(s.accepted) : "—"],
  ];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PROBE verifier · ${up ? "Online" : "Reconnecting"}</title>
<meta http-equiv="refresh" content="30">
<style>
:root{--paper:#F7F6F2;--ink:#141413;--red:#E83F28;--dim:#6b6a66;--rule:#dedcd5}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px 16px}
main{width:100%;max-width:520px}
.mark{font-weight:900;letter-spacing:-.02em;font-size:28px;margin:0 0 28px}.mark i{color:var(--red);font-style:normal}
.state{display:flex;align-items:center;gap:12px;font-size:22px;font-weight:700;margin:0 0 6px}
.dot{width:12px;height:12px;border-radius:50%;background:${up ? "#1f9d55" : "var(--red)"};box-shadow:0 0 0 0 ${up ? "rgba(31,157,85,.5)" : "rgba(232,63,40,.5)"};animation:p 2s infinite}
@keyframes p{70%{box-shadow:0 0 0 10px rgba(0,0,0,0)}100%{box-shadow:0 0 0 0 rgba(0,0,0,0)}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
p.lead{color:var(--dim);margin:0 0 28px}
dl{margin:0;border-top:1px solid var(--rule)}div.r{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--rule)}
dt{color:var(--dim)}dd{margin:0;font-family:ui-monospace,"IBM Plex Mono",monospace;font-size:14px;text-align:right}
a{color:var(--ink);text-decoration-color:var(--red);text-underline-offset:3px}.dim{color:var(--dim)}
.cta{display:inline-block;margin-top:28px;background:var(--ink);color:var(--paper);padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:600}
footer{margin-top:20px;font-size:13px;color:var(--dim)}
</style></head><body><main>
<p class="mark">PROBE<i>.</i></p>
<p class="state"><span class="dot"></span>${up ? "Verifier online" : "Verifier reconnecting to the chain"}</p>
<p class="lead">${up ? "This service checks submitted test cases and records accepted results on-chain. It is running and connected." : "The service is running and will reconnect to the network on its own. Try again in a minute."}</p>
<dl>${rows.map(([k, v]) => `<div class="r"><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
<a class="cta" href="${esc(SITE_URL)}">Go to ${esc(SITE_URL.replace(/^https?:\/\//, ""))}</a>
<footer>Machine-readable status: <a href="/health">/health</a> · <a href="/stats">/stats</a> · refreshes every 30 seconds</footer>
</main></body></html>`;
  res.writeHead(up ? 200 : 503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

// ------------------------------------------------------------------ router

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  const parts = url.pathname.split("/").filter(Boolean);
  // Answer HEAD like GET (uptime monitors and badges use it). Node already omits the body for HEAD.
  if (req.method === "HEAD") req.method = "GET";
  try {
    if (req.method === "OPTIONS") return send(res, 204, null);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) return statusPage(res);
    if (req.method === "GET" && url.pathname === "/health") {
      const block = await client.getBlockNumber();
      return send(res, 200, { ok: true, verifier: cfg.address, chainId: cfg.chainId, contract: cfg.contract, block: block.toString(), network: cfg.networkName });
    }
    if (req.method === "GET" && url.pathname === "/feed/jobs") return send(res, 200, await feed());
    if (req.method === "GET" && url.pathname === "/stats") return send(res, 200, await stats());
    if (parts[0] === "jobs") {
      if (req.method === "GET" && parts.length === 1) return send(res, 200, await Promise.all(store.listJobs().map(view)));
      if (req.method === "POST" && parts.length === 1) {
        rateLimit(req, 10);
        return send(res, 201, await registerJob(await readBody(req)));
      }
      const entry = parts[1] ? store.getJob(parts[1]) : null;
      if (req.method === "GET" && parts.length === 2) {
        if (!entry) throw new HttpError(404, `No job named ${parts[1]}.`);
        return send(res, 200, await view(entry.job));
      }
      if (req.method === "GET" && parts[2] === "submissions") {
        if (!entry) throw new HttpError(404, `No job named ${parts[1]}.`);
        return send(res, 200, store.listSubmissions(parts[1]).map(toPublic));
      }
      if (req.method === "GET" && parts[2] === "reports") return send(res, 200, await sponsorReports(parts[1], url));
    }
    if (parts[0] === "requests") {
      if (req.method === "POST" && parts.length === 1) {
        rateLimit(req, 5);
        return send(res, 201, await createRequest(await readBody(req, 64 * 1024)));
      }
      if (req.method === "GET" && parts.length === 1) return send(res, 200, await listRequests(url));
      if (req.method === "POST" && parts.length === 3 && parts[2] === "status") {
        rateLimit(req, 30);
        return send(res, 200, await updateRequest(parts[1], await readBody(req)));
      }
    }
    if (parts[0] === "checks" && req.method === "POST" && parts.length === 1) {
      rateLimit(req, 6);
      return send(res, 201, await createHookCheck(await readBody(req, 4 * 1024)));
    }
    if (parts[0] === "hooks" && req.method === "GET") {
      if (parts.length === 1) return send(res, 200, store.listHookChecks().map((c) => ({ hook: c.report.hook, block: c.report.block, flags: c.report.flags, summary: c.report.summary, checkedAt: c.report.checkedAt })));
      if (!isAddress(parts[1] ?? "")) throw new HttpError(400, "Not an address.");
      if (parts.length === 2) return send(res, 200, hookCheckView(parts[1]));
      if (parts.length === 3 && parts[2] === "badge.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
        return res.end(badgeSvg(parts[1]));
      }
    }
    if (parts[0] === "submissions") {
      if (req.method === "POST" && parts.length === 1) {
        rateLimit(req, 30);
        return send(res, 202, await createSubmission(await readBody(req)));
      }
      if (req.method === "GET" && parts.length === 2) {
        const s = store.getSubmission(parts[1]);
        if (!s) throw new HttpError(404, "No submission with that id.");
        return send(res, 200, toPublic(s));
      }
    }
    // A browser that lands on an unknown path gets the status page instead of an error.
    if (req.method === "GET" && (req.headers.accept ?? "").includes("text/html")) {
      res.writeHead(302, { location: "/" });
      return res.end();
    }
    throw new HttpError(404, "Not found.");
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: "Internal verifier error." });
  }
});

// Resume anything interrupted by a restart.
for (const id of store.pendingSubmissions()) pipeline.submit(id);

server.listen(cfg.port, cfg.host, () => {
  console.log(`PROBE verifier ${cfg.address} on http://${cfg.host}:${cfg.port} (chain ${cfg.chainId}, ProbeJobs ${cfg.contract})`);
});

