import fs from "node:fs/promises";
import path from "node:path";

/**
 * Script สำหรับอ่านข้อมูลหวยจากรูปภาพด้วย AI Vision (GitHub Models)
 *
 * รูปภาพอยู่ใน scripts/exp-images/:
 *   {id}_1.png = คำนวณหวยประจำวัน (3 ตัวบน, 2 ตัวล่าง, วิ่ง, รูด)
 *   {id}_2.png = สถิติจำนวนครั้งที่ออก (เลข 0-9)
 *   {id}_3.png = สถิติ 30 งวดล่าสุด (ตาราง 2 ตัวล่าง + 3 ตัวบน)
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_MODELS_URL =
  "https://models.github.ai/inference/chat/completions";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const IMAGES_DIR = path.join(SCRIPT_DIR, "exp-images");

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

async function callGitHubModels(prompt, imageBase64, maxRetries = 3) {
  if (!GITHUB_TOKEN) throw new Error("No GITHUB_TOKEN");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(GITHUB_MODELS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
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
      if (attempt < maxRetries) {
        const wait = attempt * 15;
        console.log(`    ⏳ GitHub Models retry in ${wait}s (status ${res.status})...`);
        await delay(wait * 1000);
        continue;
      }
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GitHub Models ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from GitHub Models");

    return parseJSON(text);
  }

  throw new Error("GitHub Models: max retries exceeded");
}

async function callGemini(prompt, imageBase64, maxRetries = 3) {
  if (!GEMINI_API_KEY) throw new Error("No GEMINI_API_KEY");

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
  const base64 = (await fs.readFile(imagePath)).toString("base64");

  if (GITHUB_TOKEN) {
    try {
      return await callGitHubModels(prompt, base64);
    } catch (e) {
      console.log(`    ⚠️ GitHub Models failed: ${e.message.slice(0, 80)}`);
    }
  }

  if (GEMINI_API_KEY) {
    try {
      return await callGemini(prompt, base64);
    } catch (e) {
      console.log(`    ⚠️ Gemini failed: ${e.message.slice(0, 80)}`);
    }
  }

  throw new Error("ไม่มี AI service ใช้งานได้");
}

// ===== Process single lottery =====

async function processLottery(source) {
  const prefix = source.imagePrefix || source.id;
  const img1 = path.join(IMAGES_DIR, `${prefix}_1.png`);
  const img2 = path.join(IMAGES_DIR, `${prefix}_2.png`);
  const img3 = path.join(IMAGES_DIR, `${prefix}_3.png`);

  // ตรวจไฟล์
  for (const f of [img1, img2, img3]) {
    try {
      await fs.access(f);
    } catch {
      console.log(`  ⚠️ Missing: ${path.basename(f)} - skipping`);
      return null;
    }
  }

  // 1. อ่าน calc (คำนวณประจำวัน)
  console.log(`  📊 Reading ${prefix}_1.png (calc)...`);
  const calcData = await readImageAI(CALC_PROMPT, img1);
  console.log(
    `    ✅ top3: ${calcData.top3?.length || 0}, bottom2: ${calcData.bottom2?.length || 0}, วิ่ง: ${calcData.running_number}, รูด: ${calcData.full_set_number}`
  );

  await delay(5000);

  // 2. อ่าน digit frequency (สถิติเลข 0-9)
  console.log(`  📊 Reading ${prefix}_2.png (digit freq)...`);
  const digitFreq = await readImageAI(DIGIT_FREQ_PROMPT, img2);
  console.log(`    ✅ digit_frequency: ${digitFreq.data?.length || 0} entries`);

  await delay(5000);

  // 3. อ่าน stat 30 draws
  console.log(`  📊 Reading ${prefix}_3.png (stat 30)...`);
  const stat30 = await readImageAI(STAT_30_PROMPT, img3);
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

// ===== Main =====

async function main() {
  console.log("🎰 Starting lottery image reader...");
  console.log(`📅 ${nowISO()}\n`);

  // ตรวจ AI services
  console.log("🔑 AI Services:");
  if (GITHUB_TOKEN) console.log("  ✅ GitHub Models (GITHUB_TOKEN)");
  else console.log("  ❌ GitHub Models");
  if (GEMINI_API_KEY) console.log("  ✅ Gemini (GEMINI_API_KEY)");
  else console.log("  ❌ Gemini");

  if (!GITHUB_TOKEN && !GEMINI_API_KEY) {
    throw new Error("ต้องมี GITHUB_TOKEN หรือ GEMINI_API_KEY");
  }

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

  const allResults = [];
  const failedLotteries = [];

  for (const source of LOTTERY_SOURCES) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`📌 ${source.name} (${source.id})`);
    console.log("=".repeat(50));

    try {
      const result = await processLottery(source);

      if (result) {
        // เซฟไฟล์แยก
        const outPath = `public/${source.outputFile}`;
        await fs.writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
        console.log(`  💾 Saved: ${outPath}`);
        allResults.push(result);
      } else {
        failedLotteries.push({
          lottery: source.id,
          reason: "missing image files",
        });
      }
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}`);
      failedLotteries.push({
        lottery: source.id,
        reason: e.message,
      });
    }

    // delay ระหว่างหวย
    if (source !== LOTTERY_SOURCES[LOTTERY_SOURCES.length - 1]) {
      console.log("\n  ⏳ Waiting 10s before next lottery...");
      await delay(10000);
    }
  }

  if (allResults.length === 0) {
    console.log("\n❌ No lotteries were processed successfully.");
    if (failedLotteries.length > 0) {
      console.log("📉 Failures:");
      for (const f of failedLotteries) {
        console.log(`   - ${f.lottery}: ${f.reason}`);
      }
    }
    throw new Error("no successful lottery results; skip writing empty all_calculations.json");
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
