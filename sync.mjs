// sync.mjs
import fs from "node:fs";
import path from "node:path";
import 'dotenv/config';

const CROSSCHEX_BASE = process.env.CROSSCHEX_BASE;
const API_KEY = process.env.CROSSCHEX_API_KEY;
const API_SECRET = process.env.CROSSCHEX_API_SECRET;

const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_REFRESH_TOKEN = process.env.MS_REFRESH_TOKEN;
const ONEDRIVE_FOLDER = process.env.ONEDRIVE_FOLDER || "CrossChex";

const STATE_FILE = "state.json";
const OUT_CSV = "attendance.csv";

if (!API_KEY || !API_SECRET || !MS_CLIENT_ID || !MS_REFRESH_TOKEN) {
  throw new Error("Missing required env vars. Check GitHub Secrets.");
}

function isoNowUTC() {
  return new Date().toISOString();
}

function isoMinusDays(days) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  }
  // 최초는 최근 1일만
  return { last_sync_utc: isoMinusDays(1) };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// CrossChex 문서에서 흔히 쓰는 begin_time/end_time 포맷이 "YYYY-MM-DD HH:mm:ss"인 경우가 많아서 변환
function toCrossChexDateTime(iso) {
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  return json;
}

async function crossChexGetToken() {
  const body = {
    header: {
      nameSpace: "authorize.token",
      nameAction: "token",
      version: "1.0",
      requestId: "1",
      timestamp: "0",
    },
    payload: { api_key: API_KEY, api_secret: API_SECRET },
  };

  const data = await postJson(CROSSCHEX_BASE, body);

  const token =
    data?.payload?.token ||
    data?.payload?.access_token ||
    data?.token;

  if (!token) throw new Error(`CrossChex token not found. Response: ${JSON.stringify(data).slice(0, 800)}`);
  return token;
}

async function crossChexGetRecords(token, beginIso, endIso) {
  const begin_time = toCrossChexDateTime(beginIso);
  const end_time = toCrossChexDateTime(endIso);

  const per_page = 200;
  let page = 1;
  const all = [];

  while (true) {
    const body = {
      header: {
        nameSpace: "attendance.record",
        nameAction: "getrecord",
        version: "1.0",
        requestId: "1",
        timestamp: "0",
      },
      authorize: { type: "token", token },
      payload: { begin_time, end_time, page, per_page },
    };

    const data = await postJson(CROSSCHEX_BASE, body);

    const rows =
      data?.payload?.list ||
      data?.payload?.data ||
      data?.payload?.records ||
      [];

    if (!Array.isArray(rows)) {
      throw new Error(`Unexpected records payload. Response: ${JSON.stringify(data).slice(0, 800)}`);
    }

    all.push(...rows);

    if (rows.length < per_page) break;
    page += 1;
  }

  return all;
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function writeCsv(rows, filename) {
  // API 응답 구조가 계정마다 조금 달라서, 우선 “안전한 최소 컬럼 + raw_json”으로 저장
  const headers = ["user_id", "user_name", "device", "check_time", "status", "raw_json"];
  const lines = [headers.join(",")];

  for (const x of rows) {
    const row = {
      user_id: x.user_id ?? x.employee_id ?? x.id ?? "",
      user_name: x.user_name ?? x.name ?? "",
      device: x.device ?? x.device_name ?? "",
      check_time: x.check_time ?? x.time ?? x.datetime ?? "",
      status: x.status ?? x.type ?? "",
      raw_json: JSON.stringify(x),
    };
    lines.push(headers.map(h => csvEscape(row[h])).join(","));
  }

  fs.writeFileSync(filename, lines.join("\n"), "utf-8");
}

async function graphRefreshAccessToken() {
  const tokenUrl = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: MS_REFRESH_TOKEN,
    scope: "offline_access Files.ReadWrite",
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const text = await res.text();
  const json = JSON.parse(text);

  if (!res.ok) {
    throw new Error(`Graph token refresh failed: ${text}`);
  }

  return { access_token: json.access_token, refresh_token: json.refresh_token };
}

async function graphPutFile(accessToken, remotePath, localPath) {
  const url = `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURI(remotePath)}:/content`;
  const fileBuf = fs.readFileSync(localPath);

  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: fileBuf,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Graph upload failed (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

function todayUTC() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function main() {
  const state = loadState();
  const lastSync = state.last_sync_utc;
  const now = isoNowUTC();

  const ccToken = await crossChexGetToken();
  const records = await crossChexGetRecords(ccToken, lastSync, now);

  writeCsv(records, OUT_CSV);

  const { access_token, refresh_token: rotated } = await graphRefreshAccessToken();

  const day = todayUTC();
  const remoteCsv = path.posix.join(ONEDRIVE_FOLDER, `attendance_${day}.csv`);
  const remoteState = path.posix.join(ONEDRIVE_FOLDER, `state.json`);

  await graphPutFile(access_token, remoteCsv, OUT_CSV);

  state.last_sync_utc = now;
  saveState(state);
  await graphPutFile(access_token, remoteState, STATE_FILE);

  if (rotated && rotated !== MS_REFRESH_TOKEN) {
    console.log("NOTE: refresh_token rotated. Update GitHub Secret MS_REFRESH_TOKEN if uploads start failing later.");
  }

  console.log(`Synced ${records.length} records. Uploaded: ${remoteCsv}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});