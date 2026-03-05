import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Script สำหรับอ่านข้อมูลหวยจากรูปภาพด้วย AI Vision (GitHub Models)
 *
 * รูปภาพอยู่ใน scripts/exp-images/:
 *   {id}_1.png = คำนวณหวยประจำวัน (3 ตัวบน, 2 ตัวล่าง, วิ่ง, รูด)
 *   {id}_2.png = สถิติจำนวนครั้งที่ออก (เลข 0-9)
 *   {id}_3.png = สถิติ 30 งวดล่าสุด (ตาราง 2 ตัวล่าง + 3 ตัวบน)
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_TOKENS = process.env.GITHUB_TOKENS;
const GITHUB_TOKEN_POOL = Array.from(
  new Set(
    [GITHUB_TOKEN, ...(GITHUB_TOKENS || "").split(/[,\s]+/)]
      .map((v) => (v || "").trim())
      .filter(Boolean)
  )
);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_MODELS_URL =
  "https://models.github.ai/inference/chat/completions";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const IMAGES_DIR = path.join(SCRIPT_DIR, "exp-images");
const CACHE_FILE = path.join(SCRIPT_DIR, ".vision-cache.json");
const PUBLIC_DIR = path.resolve(process.cwd(), "public");
const MAX_CONSECUTIVE_429_BEFORE_DISABLE = 5;
let consecutive429Count = 0;
let aiDisabledForRun = false;
let aiDisabledReason = "";
const CALC_AI_PER_RUN = Number(process.env.CALC_AI_PER_RUN || 5);
const HEAVY_AI_PER_RUN = Number(process.env.HEAVY_AI_PER_RUN || 1);
const MAX_AI_CALLS_PER_RUN = Number(process.env.MAX_AI_CALLS_PER_RUN || 6);
const MIN_AI_INTERVAL_MS = Number(process.env.MIN_AI_INTERVAL_MS || 30000);
const FULL_REFRESH_MODE = process.env.FULL_REFRESH_MODE === "1";
const FULL_REFRESH_MAX_WAIT_MINUTES = Number(
  process.env.FULL_REFRESH_MAX_WAIT_MINUTES || 720
);
const FAST_RUN_MODE = process.env.FAST_RUN_MODE === "1";
const FAST_RUN_MAX_MINUTES = Number(process.env.FAST_RUN_MAX_MINUTES || 5);
let aiCallCount = 0;
let nextAllowedAiAt = 0;
let runStartedAtMs = Date.now();
let githubTokenCursor = 0;
const githubTokenCooldownUntil = new Map();

// ===== รายชื่อหวย =====
// id = ค่าที่ใส่ใน JSON field "lottery" (ต้องตรงกับสคริปต์เก่า)
// imagePrefix = prefix ของชื่อรูปใน exp-images/ (เช่น gov_thai_1.png)
const LOTTERY_SOURCES = [
  {
    id: "thai_government",
    imagePrefix: "gov_thai",
    name: "หวยรัฐบาลไทย",
    sourceUrl: "https://exphuay.com/calculate/goverment",
    outputFile: "gov_thai.json",
  },
  {
    id: "lao_pattana",
    imagePrefix: "lao_pattana",
    name: "หวยลาวพัฒนา",
    sourceUrl: "https://exphuay.com/calculate/laosdevelops",
    outputFile: "lao_pattana.json",
  },
  {
    id: "malaysia",
    imagePrefix: "malaysia",
    name: "หวยมาเลย์",
    sourceUrl: "https://exphuay.com/calculate/magnum4d",
    outputFile: "malaysia.json",
  },
  {
    id: "baac",
    imagePrefix: "baac",
    name: "หวยธ.ก.ส.",
    sourceUrl: "https://exphuay.com/calculate/baac",
    outputFile: "baac.json",
  },
  {
    id: "gsb",
    imagePrefix: "gsb",
    name: "หวยออมสิน",
    sourceUrl: "https://exphuay.com/calculate/gsb",
    outputFile: "gsb.json",
  },
  {
    id: "hanoi_normal",
    imagePrefix: "hanoi_nor",
    name: "หวยฮานอยปกติ",
    sourceUrl: "https://exphuay.com/calculate/minhngoc",
    outputFile: "hanoi_normal.json",
  },
  {
    id: "hanoi_special",
    imagePrefix: "hanoi_spa",
    name: "หวยฮานอยพิเศษ",
    sourceUrl: "https://exphuay.com/calculate/xsthm",
    outputFile: "hanoi_special.json",
  },
  {
    id: "hanoi_vip",
    imagePrefix: "hanoi_vip",
    name: "หวยฮานอย VIP",
    sourceUrl: "https://exphuay.com/calculate/mlnhngo",
    outputFile: "hanoi_vip.json",
  },
];

function nowISO() {
  return new Date().toISOString();
}

// ===== Prompts =====

const CALC_PROMPT = `Read this Thai lottery calculation image. Return JSON ONLY:
{
  "top3": ["043", "682", "430", "830", "482"],
  "top3_recommended": ["043", "430", "830"],
  "bottom2": ["76", "44", "39", "08", "46", "03"],
  "bottom2_recommended": ["44", "46"],
  "running_number": "4",
  "full_set_number": "3"
}
Rules:
- "top3": ALL 3-digit numbers under "3 ตัวบน" (left to right)
- "top3_recommended": ONLY those with GREEN background
- "bottom2": ALL 2-digit numbers under "2 ตัวล่าง" (left to right)
- "bottom2_recommended": ONLY those with GREEN background
- "running_number": the single digit under "วิ่ง"
- "full_set_number": the single digit under "รูด"
- All values MUST be strings. Read EVERY number.`;

const DIGIT_FREQ_PROMPT = `Read this digit frequency table image. Return JSON ONLY:
{
  "data": [
    {"digit": "0", "top3_count": 12, "bottom2_count": 6, "total": 18},
    {"digit": "1", "top3_count": 9, "bottom2_count": 6, "total": 15}
  ]
}
Rules:
- Read the table with columns: เลข (digit 0-9), 3 ตัวบน (top3_count), 2 ตัวล่าง (bottom2_count), รวม (total)
- digit is string, all counts are integers
- Must have exactly 10 rows (digits 0-9)
- Read EVERY row carefully`;

const STAT_30_PROMPT = `Read this lottery statistics table image showing 30 recent draws. Return JSON ONLY:
{
  "bottom2": [
    {"number": "45", "count": 2},
    {"number": "64", "count": 2}
  ],
  "top3": [
    {"number": "440", "count": 1},
    {"number": "145", "count": 1}
  ]
}
Rules:
- LEFT table = "2 ตัวล่าง": Read ALL rows (number as string, count as integer)
- RIGHT table = "3 ตัวบน": Read ALL rows (number as string, count as integer)
- Read EVERY single row in both tables, do not skip any`;

// ===== AI Vision Call =====

function getRetryDelaySeconds(res, attempt) {
  if (FAST_RUN_MODE) {
    // โหมดสปีดสูง: retry สั้นเพื่อให้สลับ token ต่อเนื่องและจบรันไว
    return Math.min(20, 2 * attempt);
  }
  const retryAfter = res.headers.get("retry-after");
  const asNumber = Number(retryAfter);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return Math.max(5, Math.ceil(asNumber));
  }
  return Math.min(900, 15 * 2 ** (attempt - 1));
}

function pickGithubToken() {
  if (GITHUB_TOKEN_POOL.length === 0) {
    return { token: null, waitMs: 0 };
  }

  const now = Date.now();
  let bestToken = GITHUB_TOKEN_POOL[0];
  let bestWaitMs = Number.POSITIVE_INFINITY;

  for (let i = 0; i < GITHUB_TOKEN_POOL.length; i++) {
    const idx = (githubTokenCursor + i) % GITHUB_TOKEN_POOL.length;
    const token = GITHUB_TOKEN_POOL[idx];
    const cooldownUntil = githubTokenCooldownUntil.get(token) || 0;
    const waitMs = Math.max(0, cooldownUntil - now);

    if (waitMs === 0) {
      githubTokenCursor = (idx + 1) % GITHUB_TOKEN_POOL.length;
      return { token, waitMs: 0 };
    }

    if (waitMs < bestWaitMs) {
      bestWaitMs = waitMs;
      bestToken = token;
    }
  }

  return { token: bestToken, waitMs: bestWaitMs };
}

function canContinueFullRefreshWait() {
  const elapsedMin = (Date.now() - runStartedAtMs) / 60000;
  const limit = FAST_RUN_MODE
    ? Math.min(FULL_REFRESH_MAX_WAIT_MINUTES, FAST_RUN_MAX_MINUTES)
    : FULL_REFRESH_MAX_WAIT_MINUTES;
  return elapsedMin < limit;
}

async function callGitHubModels(prompt, imageBase64, maxRetries = 6) {
  if (GITHUB_TOKEN_POOL.length === 0) throw new Error("No GITHUB_TOKEN");
  if (aiDisabledForRun) {
    throw new Error(aiDisabledReason || "AI disabled for this run");
  }

  for (let attempt = 1; ; attempt++) {
    if (!FULL_REFRESH_MODE && attempt > maxRetries) {
      break;
    }
    if (FULL_REFRESH_MODE && !canContinueFullRefreshWait()) {
      throw new Error(
        `Full refresh wait exceeded ${FULL_REFRESH_MAX_WAIT_MINUTES} minutes`
      );
    }

    const tokenPick = pickGithubToken();
    if (!tokenPick.token) throw new Error("No available GitHub token");
    if (tokenPick.waitMs > 0) {
      const waitMs = tokenPick.waitMs;
      const waitSec = Math.ceil(waitMs / 1000);
      console.log(`    ⏳ GitHub token pool cooling down ${waitSec}s...`);
      await delay(waitMs);
    }
    const selectedToken = pickGithubToken().token;

    const res = await fetch(GITHUB_MODELS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${selectedToken}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${imageBase64}` },
              },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 4000,
      }),
    });

    if (res.status === 429 || res.status >= 500) {
      if (res.status === 429) {
        if (!FULL_REFRESH_MODE) {
          consecutive429Count += 1;
        }
        if (
          !FULL_REFRESH_MODE &&
          consecutive429Count >= MAX_CONSECUTIVE_429_BEFORE_DISABLE
        ) {
          aiDisabledForRun = true;
          aiDisabledReason =
            `AI disabled for this run after ${consecutive429Count} consecutive 429 responses`;
          console.log(`    🛑 ${aiDisabledReason}`);
          throw new Error(aiDisabledReason);
        }
      } else {
        consecutive429Count = 0;
      }

      const wait = getRetryDelaySeconds(res, attempt);
      if (res.status === 429) {
        githubTokenCooldownUntil.set(
          selectedToken,
          Math.max(githubTokenCooldownUntil.get(selectedToken) || 0, Date.now() + wait * 1000)
        );
      }
      console.log(`    ⏳ GitHub Models retry in ${wait}s (status ${res.status})...`);
      // ถ้ามี token อื่นที่พร้อม ใช้ทันทีไม่ต้องรอ
      const nextPick = pickGithubToken();
      if (!nextPick.token || nextPick.waitMs > 0) {
        await delay(wait * 1000);
      }
      continue;
    }
    if (!res.ok) {
      consecutive429Count = 0;
      const errText = await res.text();
      throw new Error(`GitHub Models ${res.status}: ${errText.slice(0, 300)}`);
    }

    consecutive429Count = 0;
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from GitHub Models");

    return parseJSON(text);
  }

  throw new Error("GitHub Models: max retries exceeded");
}

async function callGemini(prompt, imageBase64, maxRetries = 3) {
  if (!GEMINI_API_KEY) throw new Error("No GEMINI_API_KEY");
  if (aiDisabledForRun) {
    throw new Error(aiDisabledReason || "AI disabled for this run");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: "image/png", data: imageBase64 } },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const wait = attempt * 15;
      console.log(`    ⏳ Rate limited, retrying in ${wait}s...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Empty response from Gemini");
    return parseJSON(text);
  }
  throw new Error("Gemini: max retries exceeded");
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) return JSON.parse(m[1].trim());
    const obj = text.match(/\{[\s\S]*\}/);
    if (obj) return JSON.parse(obj[0]);
    throw new Error(`Cannot parse JSON: ${text.slice(0, 300)}`);
  }
}

async function readImageAI(prompt, imagePath) {
  if (aiDisabledForRun) {
    throw new Error(aiDisabledReason || "AI disabled for this run");
  }
  if (!FULL_REFRESH_MODE && aiCallCount >= MAX_AI_CALLS_PER_RUN) {
    aiDisabledForRun = true;
    aiDisabledReason = `AI disabled for this run after reaching MAX_AI_CALLS_PER_RUN=${MAX_AI_CALLS_PER_RUN}`;
    throw new Error(aiDisabledReason);
  }

  const now = Date.now();
  if (nextAllowedAiAt > now) {
    const waitMs = nextAllowedAiAt - now;
    const waitSec = Math.ceil(waitMs / 1000);
    console.log(`    ⏱️ Throttle: waiting ${waitSec}s before next AI call...`);
    await delay(waitMs);
  }
  nextAllowedAiAt = Date.now() + MIN_AI_INTERVAL_MS;
  aiCallCount += 1;

  const base64 = (await fs.readFile(imagePath)).toString("base64");
  const errors = [];

  if (GITHUB_TOKEN_POOL.length > 0) {
    try {
      return await callGitHubModels(prompt, base64);
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push(`GitHub: ${msg}`);
      console.log(`    ⚠️ GitHub Models failed: ${msg.slice(0, 120)}`);
    }
  }

  if (GEMINI_API_KEY) {
    try {
      return await callGemini(prompt, base64);
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push(`Gemini: ${msg}`);
      console.log(`    ⚠️ Gemini failed: ${msg.slice(0, 120)}`);
    }
  }

  throw new Error(`ไม่มี AI service ใช้งานได้ (${errors.join(" | ") || "unknown"})`);
}

function getDayOfYear(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  const now = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const diff = now - start;
  return Math.floor(diff / 86400000);
}

function isSelectedForToday(sourceIndex, limitPerRun, totalSources) {
  if (limitPerRun >= totalSources) return true;
  const day = getDayOfYear();
  const start = day % totalSources;
  const distance = (sourceIndex - start + totalSources) % totalSources;
  return distance < limitPerRun;
}

function shouldTryAIForSegment({
  sourceIndex,
  segmentName,
  hasPreviousData,
  totalSources,
}) {
  if (FULL_REFRESH_MODE) return true;

  // ถ้าไม่มีข้อมูลเก่า ต้องยิง AI เพื่อ seed ครั้งแรก
  if (!hasPreviousData) return true;

  if (segmentName === "calc") {
    return isSelectedForToday(sourceIndex, CALC_AI_PER_RUN, totalSources);
  }

  return isSelectedForToday(sourceIndex, HEAVY_AI_PER_RUN, totalSources);
}

// ===== Process single lottery =====

async function processLottery(source, sourceIndex, totalSources, cacheStore) {
  const prefix = source.imagePrefix || source.id;
  const img1 = path.join(IMAGES_DIR, `${prefix}_1.png`);
  const img2 = path.join(IMAGES_DIR, `${prefix}_2.png`);
  const img3 = path.join(IMAGES_DIR, `${prefix}_3.png`);
  const previousOutput = await readPreviousOutput(source.outputFile);

  // ตรวจไฟล์
  for (const f of [img1, img2, img3]) {
    try {
      await fs.access(f);
    } catch {
      console.log(`  ⚠️ Missing: ${path.basename(f)} - skipping`);
      return null;
    }
  }

  const readSegment = async ({ segmentName, prompt, imagePath, previousData }) => {
    const imageHash = await hashFile(imagePath);
    const cacheKey = `${source.id}:${segmentName}`;
    const cached = cacheStore[cacheKey];
    const shouldTryAI = shouldTryAIForSegment({
      sourceIndex,
      segmentName,
      hasPreviousData: Boolean(previousData),
      totalSources,
    });

    if (!FULL_REFRESH_MODE && cached?.hash === imageHash && cached?.data) {
      console.log(`    ♻️ Using cache for ${path.basename(imagePath)} (${segmentName})`);
      return { data: cached.data, source: "cache" };
    }

    if (!shouldTryAI && previousData) {
      console.log(`    ⏭️ Skip AI for ${segmentName} (daily budget), using previous data`);
      cacheStore[cacheKey] = { hash: imageHash, data: previousData, updated_at: nowISO() };
      return { data: previousData, source: "previous_scheduled" };
    }

    try {
      const data = await readImageAI(prompt, imagePath);
      cacheStore[cacheKey] = { hash: imageHash, data, updated_at: nowISO() };
      return { data, source: "ai" };
    } catch (e) {
      if (previousData) {
        console.log(
          `    ♻️ AI unavailable, using previous ${segmentName} from public/${source.outputFile}`
        );
        cacheStore[cacheKey] = { hash: imageHash, data: previousData, updated_at: nowISO() };
        return { data: previousData, source: "previous" };
      }
      throw e;
    }
  };

  // 1. อ่าน calc (คำนวณประจำวัน)
  console.log(`  📊 Reading ${prefix}_1.png (calc)...`);
  const calcSegment = await readSegment({
    segmentName: "calc",
    prompt: CALC_PROMPT,
    imagePath: img1,
    previousData: previousOutput?.daily_calculation || null,
  });
  const calcData = calcSegment.data;
  console.log(
    `    ✅ top3: ${calcData.top3?.length || 0}, bottom2: ${calcData.bottom2?.length || 0}, วิ่ง: ${calcData.running_number}, รูด: ${calcData.full_set_number}`
  );

  if (calcSegment.source === "ai" && !FAST_RUN_MODE) await delay(5000);

  // 2. อ่าน digit frequency (สถิติเลข 0-9)
  console.log(`  📊 Reading ${prefix}_2.png (digit freq)...`);
  const digitFreqSegment = await readSegment({
    segmentName: "digit_frequency",
    prompt: DIGIT_FREQ_PROMPT,
    imagePath: img2,
    previousData: previousOutput?.digit_frequency || null,
  });
  const digitFreq = digitFreqSegment.data;
  console.log(`    ✅ digit_frequency: ${digitFreq.data?.length || 0} entries`);

  if (digitFreqSegment.source === "ai" && !FAST_RUN_MODE) await delay(5000);

  // 3. อ่าน stat 30 draws
  console.log(`  📊 Reading ${prefix}_3.png (stat 30)...`);
  const stat30Segment = await readSegment({
    segmentName: "statistics_30_draws",
    prompt: STAT_30_PROMPT,
    imagePath: img3,
    previousData: previousOutput?.statistics_30_draws || null,
  });
  const stat30 = stat30Segment.data;
  console.log(
    `    ✅ bottom2: ${stat30.bottom2?.length || 0}, top3: ${stat30.top3?.length || 0}`
  );

  return {
    lottery: source.id,
    lottery_name: source.name,
    source_url: source.sourceUrl,
    fetched_at: nowISO(),
    window: { latest_n_draws: 30 },
    daily_calculation: {
      top3: calcData.top3 || [],
      top3_recommended: calcData.top3_recommended || [],
      bottom2: calcData.bottom2 || [],
      bottom2_recommended: calcData.bottom2_recommended || [],
      running_number: calcData.running_number ?? null,
      full_set_number: calcData.full_set_number ?? null,
    },
    digit_frequency: {
      data: digitFreq.data || [],
    },
    statistics_30_draws: {
      bottom2: stat30.bottom2 || [],
      top3: stat30.top3 || [],
    },
    blocked_by_cloudflare: false,
    notes: `ดึงข้อมูลจาก exphuay.com - รันเวลา 08:00 น.`,
  };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function hashFile(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}

async function readPreviousOutput(outputFile) {
  try {
    const raw = await fs.readFile(path.join(PUBLIC_DIR, outputFile), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readPreviousCombinedOutput() {
  try {
    const raw = await fs.readFile(path.join(PUBLIC_DIR, "all_calculations.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getFallbackLotteryResult(source, reason) {
  const byFile = await readPreviousOutput(source.outputFile);
  if (byFile) {
    console.log(`  ♻️ Fallback to previous cache: ${source.outputFile} (${reason})`);
    return byFile;
  }

  const combined = await readPreviousCombinedOutput();
  const byCombined = combined?.lotteries?.find((x) => x?.lottery === source.id) || null;
  if (byCombined) {
    console.log(`  ♻️ Fallback to previous all_calculations for ${source.id} (${reason})`);
    return byCombined;
  }
  return null;
}

async function loadCacheStore() {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveCacheStore(cacheStore) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cacheStore, null, 2), "utf8");
}

// ===== Main =====

async function main() {
  console.log("🎰 Starting lottery image reader...");
  console.log(`📅 ${nowISO()}\n`);

  // ตรวจ AI services
  console.log("🔑 AI Services:");
  if (GITHUB_TOKEN_POOL.length > 0) {
    console.log(`  ✅ GitHub Models (${GITHUB_TOKEN_POOL.length} token${GITHUB_TOKEN_POOL.length > 1 ? "s" : ""})`);
  }
  else console.log("  ❌ GitHub Models");
  if (GEMINI_API_KEY) console.log("  ✅ Gemini (GEMINI_API_KEY)");
  else console.log("  ❌ Gemini");
  console.log(
    `  🚦 Mode: ${FULL_REFRESH_MODE ? "FULL_REFRESH (read all images)" : "SMART_CACHE"}`
  );
  if (FAST_RUN_MODE) {
    console.log(`  ⚡ Fast run mode: ON (target <= ${FAST_RUN_MAX_MINUTES} minutes)`);
  }
  if (FULL_REFRESH_MODE) {
    console.log(
      `  🕒 Full refresh max wait: ${FULL_REFRESH_MAX_WAIT_MINUTES} minutes`
    );
  }
  console.log(
    `  🎯 Daily AI budget: calc=${CALC_AI_PER_RUN}, heavy=${HEAVY_AI_PER_RUN}`
  );
  console.log(
    `  🛡️ Run protection: max_calls=${MAX_AI_CALLS_PER_RUN}, min_interval_ms=${MIN_AI_INTERVAL_MS}\n`
  );

  if (GITHUB_TOKEN_POOL.length === 0 && !GEMINI_API_KEY) {
    throw new Error("ต้องมี GITHUB_TOKEN หรือ GEMINI_API_KEY");
  }

  runStartedAtMs = Date.now();

  // ตรวจ images folder
  try {
    await fs.access(IMAGES_DIR);
  } catch {
    throw new Error(`ไม่พบ folder: ${IMAGES_DIR}`);
  }

  const files = await fs.readdir(IMAGES_DIR);
  console.log(`\n📁 Images folder: ${files.length} files`);
  console.log(`📋 Lotteries: ${LOTTERY_SOURCES.length}\n`);

  await fs.mkdir("public", { recursive: true });
  const cacheStore = await loadCacheStore();

  const allResults = [];
  const failedLotteries = [];

  for (const [sourceIndex, source] of LOTTERY_SOURCES.entries()) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`📌 ${source.name} (${source.id})`);
    console.log("=".repeat(50));

    try {
      const result = await processLottery(
        source,
        sourceIndex,
        LOTTERY_SOURCES.length,
        cacheStore
      );

      if (result) {
        // เซฟไฟล์แยก
        const outPath = `public/${source.outputFile}`;
        await fs.writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
        console.log(`  💾 Saved: ${outPath}`);
        allResults.push(result);
      } else {
        const fallback = await getFallbackLotteryResult(source, "missing image files");
        if (fallback) {
          const outPath = `public/${source.outputFile}`;
          await fs.writeFile(outPath, JSON.stringify(fallback, null, 2), "utf8");
          console.log(`  💾 Saved fallback: ${outPath}`);
          allResults.push(fallback);
          failedLotteries.push({
            lottery: source.id,
            reason: "missing image files (used previous cache)",
          });
        } else {
          failedLotteries.push({
            lottery: source.id,
            reason: "missing image files",
          });
        }
      }
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}`);
      const fallback = await getFallbackLotteryResult(source, e.message);
      if (fallback) {
        const outPath = `public/${source.outputFile}`;
        await fs.writeFile(outPath, JSON.stringify(fallback, null, 2), "utf8");
        console.log(`  💾 Saved fallback: ${outPath}`);
        allResults.push(fallback);
        failedLotteries.push({
          lottery: source.id,
          reason: `${e.message} (used previous cache)`,
        });
      } else {
        failedLotteries.push({
          lottery: source.id,
          reason: e.message,
        });
      }
    }

    // delay ระหว่างหวย
    if (source !== LOTTERY_SOURCES[LOTTERY_SOURCES.length - 1]) {
      if (!FAST_RUN_MODE) {
        console.log("\n  ⏳ Waiting 10s before next lottery...");
        await delay(10000);
      }
    }
  }

  await saveCacheStore(cacheStore);

  if (allResults.length === 0) {
    console.log("\n❌ No lotteries were processed successfully.");
    if (failedLotteries.length > 0) {
      console.log("📉 Failures:");
      for (const f of failedLotteries) {
        console.log(`   - ${f.lottery}: ${f.reason}`);
      }
    }
    const prevCombined = await readPreviousCombinedOutput();
    if (prevCombined?.lotteries?.length > 0) {
      const combined = {
        fetched_at: nowISO(),
        total_lotteries: prevCombined.lotteries.length,
        scheduled_time: "08:00",
        lotteries: prevCombined.lotteries,
        failures: failedLotteries,
        notes:
          "fallback ทั้งรอบ: ใช้ข้อมูล cache เดิม เพราะอ่านรอบล่าสุดไม่สำเร็จ",
      };
      await fs.writeFile(
        "public/all_calculations.json",
        JSON.stringify(combined, null, 2),
        "utf8"
      );
      console.log("\n💾 Saved fallback: public/all_calculations.json");
      return;
    }
    throw new Error("no successful lottery results and no previous cache available");
  }

  // เซฟไฟล์รวม
  const combined = {
    fetched_at: nowISO(),
    total_lotteries: allResults.length,
    scheduled_time: "08:00",
    lotteries: allResults,
    failures: failedLotteries,
    notes: "ข้อมูลการคำนวณหวยและสถิติ - รันวันละ 1 ครั้ง",
  };

  await fs.writeFile(
    "public/all_calculations.json",
    JSON.stringify(combined, null, 2),
    "utf8"
  );
  console.log("\n💾 Saved: public/all_calculations.json");

  // สรุป
  console.log("\n" + "=".repeat(50));
  console.log("📊 SUMMARY");
  console.log("=".repeat(50));

  for (const r of allResults) {
    console.log(`\n📌 ${r.lottery_name}`);
    console.log(
      `   3 ตัวบน: ${r.daily_calculation.top3.join(", ") || "N/A"}`
    );
    console.log(
      `   2 ตัวล่าง: ${r.daily_calculation.bottom2.join(", ") || "N/A"}`
    );
    console.log(`   วิ่ง: ${r.daily_calculation.running_number || "N/A"}`);
    console.log(`   รูด: ${r.daily_calculation.full_set_number || "N/A"}`);
    console.log(
      `   Digit freq: ${r.digit_frequency.data.length} entries`
    );
    console.log(
      `   Stats 30: bottom2=${r.statistics_30_draws.bottom2.length}, top3=${r.statistics_30_draws.top3.length}`
    );
  }

  if (failedLotteries.length > 0) {
    console.log("\n⚠️ Failed lotteries:");
    for (const f of failedLotteries) {
      console.log(`   - ${f.lottery}: ${f.reason}`);
    }
  }

  console.log(`\n✅ All done! Processed ${allResults.length}/${LOTTERY_SOURCES.length} lotteries`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
