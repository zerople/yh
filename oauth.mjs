import 'dotenv/config';

const CLIENT_ID = process.env.MS_CLIENT_ID;
if (!CLIENT_ID) {
  console.error("MS_CLIENT_ID is missing. Set it in env first.");
  process.exit(1);
}

const SCOPES = "offline_access Files.ReadWrite";
const DEVICE_CODE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return json;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // 1) device code 발급
  const dc = await postForm(DEVICE_CODE_URL, {
    client_id: CLIENT_ID,
    scope: SCOPES,
  });

  console.log(dc.message); // 여기 URL + 코드로 로그인
  const device_code = dc.device_code;
  const intervalMs = (dc.interval ?? 5) * 1000;
  const expiresAt = Date.now() + (dc.expires_in ?? 900) * 1000;

  // 2) 토큰 폴링
  while (Date.now() < expiresAt) {
    try {
      const tok = await postForm(TOKEN_URL, {
        client_id: CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code,
      });

      // ✅ 여기서 refresh_token이 나옵니다
      console.log("\n=== SUCCESS ===");
      console.log("ACCESS_TOKEN (starts):", tok.access_token.slice(0, 40) + "...");
      console.log("REFRESH_TOKEN:\n", tok.refresh_token);
      console.log("\nPut this in your .env as MS_REFRESH_TOKEN=...");

      return;
    } catch (e) {
      const msg = String(e.message || e);
      // 승인 대기 중이면 계속 폴링
      if (msg.includes("authorization_pending") || msg.includes("slow_down")) {
        await sleep(intervalMs);
        continue;
      }
      throw e;
    }
  }

  throw new Error("Timed out waiting for authorization. Try again.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});