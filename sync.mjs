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

const OUT_CSV = "attendance.csv";

if (!API_KEY || !API_SECRET || !MS_CLIENT_ID || !MS_REFRESH_TOKEN) {
  throw new Error("Missing required env vars. Check GitHub Secrets.");
}

const NY_TZ = "America/New_York";

/** UTC Date → { date: "YYYY-MM-DD", time: "HH:MM", ts: Date } in New York tz */
function toNY(dateInput) {
  const d = new Date(dateInput);
  const parts = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone: NY_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(d).forEach(({ type, value }) => (parts[type] = value));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    ts: d,
  };
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

async function crossChexGetRecords(token, beginTime, endTime) {
  const begin_time = beginTime;
  const end_time = endTime;

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
  const headers = ["Name", "Date", "Punch In", "Punch Out"];

  // 펀치 기록을 (직원, 날짜) 단위로 그룹핑 -- 뉴욕 시간 기준
  const groups = new Map();

  for (const x of rows) {
    const checkTime = x.checktime ?? x.check_time ?? x.time ?? x.datetime ?? "";
    if (!checkTime) continue;

    const emp      = x.employee ?? {};
    const userId   = emp.workno ?? x.user_id ?? x.employee_id ?? x.id ?? "";
    const userName = [emp.first_name, emp.last_name].filter(Boolean).join(" ") || (x.user_name ?? x.name ?? "");
    const dept     = emp.department ?? x.department ?? x.dept_name ?? "";
    const position = emp.job_title ?? x.position ?? "";

    const ny  = toNY(checkTime);
    const key = `${userId}||${ny.date}`;

    if (!groups.has(key)) {
      groups.set(key, {
        name: userName,
        employeeNo: userId,
        position,
        department: dept,
        date: ny.date,
        punches: [],
      });
    }
    groups.get(key).punches.push(ny);
  }

  // 날짜 내림차순, 같은 날짜면 Punch In 오름차순
  const sorted = [...groups.values()].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    const aIn = a.punches[0]?.time ?? "";
    const bIn = b.punches[0]?.time ?? "";
    return aIn.localeCompare(bIn);
  });

  const lines = [headers.join(",")];

  for (const g of sorted) {
    g.punches.sort((a, b) => a.ts - b.ts);
    const punchIn  = g.punches[0].time;
    const punchOut = g.punches.length > 1 ? g.punches[g.punches.length - 1].time : "";

    const row = [g.name, g.date, punchIn, punchOut];
    lines.push(row.map(v => csvEscape(v)).join(","));
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

/** 뉴욕 기준 어제 날짜의 시작/끝을 CrossChex 형식(뉴욕 로컬 시간)으로 반환 */
function yesterdayRangeNY() {
  const now = new Date();
  // 뉴욕 기준 "오늘" 날짜 문자열
  const nyDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: NY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now); // "YYYY-MM-DD"

  // 달력 연산으로 하루 빼기 (86400ms 고정값 대신 — DST 전환일에도 안전)
  const [y, m, d] = nyDateStr.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1));
  const yy = yesterday.getUTCFullYear();
  const mm = String(yesterday.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(yesterday.getUTCDate()).padStart(2, "0");
  const dateStr = `${yy}-${mm}-${dd}`;

  return {
    dateStr,
    begin: `${dateStr} 00:00:00`,
    end:   `${dateStr} 23:59:59`,
  };
}

async function main() {
  const { dateStr, begin, end } = yesterdayRangeNY();
  console.log(`Fetching attendance for ${dateStr} (NY time)...`);

  const ccToken = await crossChexGetToken();
  const records = await crossChexGetRecords(ccToken, begin, end);

  writeCsv(records, OUT_CSV);

  const { access_token, refresh_token: rotated } = await graphRefreshAccessToken();

  const remoteCsv = path.posix.join(ONEDRIVE_FOLDER, `attendance_${dateStr}.csv`);
  await graphPutFile(access_token, remoteCsv, OUT_CSV);

  if (rotated && rotated !== MS_REFRESH_TOKEN) {
    console.log("NOTE: refresh_token rotated. Update GitHub Secret MS_REFRESH_TOKEN if uploads start failing later.");
  }

  console.log(`Synced ${records.length} records. Uploaded: ${remoteCsv}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});