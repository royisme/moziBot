/**
 * `mozi wechat login` — obtain an ilink bot token by scanning a QR code.
 *
 * Flow:
 *   1. GET ilink/bot/get_bot_qrcode  → qrcode cursor + qrcode_img_content URL
 *   2. Render QR code in terminal; user scans with WeChat
 *   3. Long-poll ilink/bot/get_qrcode_status until confirmed or expired
 *   4. Print bot_token + config snippet
 */

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const POLL_TIMEOUT_MS = 35_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_QR_REFRESHES = 3;

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const res = await fetch(url, {
    headers: { "iLink-App-ClientVersion": "1" },
  });
  if (!res.ok) {
    throw new Error(`get_bot_qrcode failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as QRCodeResponse;
}

async function pollStatus(baseUrl: string, qrcode: string): Promise<StatusResponse> {
  const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`get_qrcode_status failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as StatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

function renderQR(url: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const qrterm = require("qrcode-terminal") as {
      generate: (text: string, opts: { small: boolean }) => void;
    };
    qrterm.generate(url, { small: true });
  } catch {
    console.log(`\n  QR Code URL: ${url}\n`);
    console.log(
      "  (Open the URL above in a browser, then scan the resulting QR code with WeChat)\n",
    );
  }
}

export async function wechatLogin(opts: { baseUrl?: string }): Promise<void> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  console.log("\n🔐 WeChat ilink bot login\n");
  console.log(`  API: ${baseUrl}`);

  let qrData: QRCodeResponse;
  try {
    console.log("\n  Fetching QR code...");
    qrData = await fetchQRCode(baseUrl);
  } catch (err) {
    console.error(`\n  ❌ Failed to fetch QR code: ${String(err)}`);
    process.exit(1);
  }

  console.log(
    "\n  Scan the QR code below with WeChat (the bot account, not your personal account):\n",
  );
  renderQR(qrData.qrcode_img_content);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let currentQrcode = qrData.qrcode;
  let currentQrUrl = qrData.qrcode_img_content;
  let qrRefreshCount = 0;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    let status: StatusResponse;
    try {
      status = await pollStatus(baseUrl, currentQrcode);
    } catch (err) {
      console.error(`\n  ❌ Error polling QR status: ${String(err)}`);
      process.exit(1);
    }

    switch (status.status) {
      case "wait":
        process.stdout.write(".");
        break;

      case "scaned":
        if (!scannedPrinted) {
          process.stdout.write("\n\n  👀 QR scanned — confirm in WeChat...\n");
          scannedPrinted = true;
        }
        break;

      case "confirmed": {
        process.stdout.write("\n");
        if (!status.bot_token) {
          console.error("\n  ❌ Login confirmed but no bot_token returned.");
          process.exit(1);
        }
        const effectiveBaseUrl = status.baseurl ?? baseUrl;

        console.log("\n  ✅ Login successful!\n");
        console.log("  Add the following to your mozi config file:\n");
        console.log('  "channels": {');
        console.log('    "wechat": {');
        console.log('      "enabled": true,');
        console.log(`      "token": "${status.bot_token}",`);
        if (effectiveBaseUrl !== DEFAULT_BASE_URL) {
          console.log(`      "baseUrl": "${effectiveBaseUrl}",`);
        }
        console.log("    }");
        console.log("  }");

        if (status.ilink_user_id) {
          console.log(
            `\n  ℹ️  Your WeChat user ID (add to allowFrom if you want to restrict access):`,
          );
          console.log(`     ${status.ilink_user_id}`);
        }
        console.log("");
        return;
      }

      case "expired": {
        qrRefreshCount += 1;
        if (qrRefreshCount > MAX_QR_REFRESHES) {
          console.error(`\n\n  ❌ QR code expired ${MAX_QR_REFRESHES} times. Please try again.`);
          process.exit(1);
        }
        process.stdout.write(
          `\n\n  ⏳ QR code expired, refreshing (${qrRefreshCount}/${MAX_QR_REFRESHES})...\n`,
        );
        try {
          const newQr = await fetchQRCode(baseUrl);
          currentQrcode = newQr.qrcode;
          currentQrUrl = newQr.qrcode_img_content;
          scannedPrinted = false;
          console.log("\n  New QR code — scan with WeChat:\n");
          renderQR(currentQrUrl);
        } catch (err) {
          console.error(`\n  ❌ Failed to refresh QR code: ${String(err)}`);
          process.exit(1);
        }
        break;
      }
    }
  }

  console.error(`\n\n  ❌ Login timed out after ${LOGIN_TIMEOUT_MS / 1000}s. Please try again.`);
  process.exit(1);
}
