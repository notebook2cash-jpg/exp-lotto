import fs from "node:fs/promises";
import puppeteer from "puppeteer";

/**
 * Script สำหรับดึงข้อมูลการคำนวณหวยและสถิติ
 * รันวันละ 1 ครั้ง ตอน 08:00 น.
 * 
 * ข้อมูลที่ดึง:
 * - คำนวณหวยประจำวัน (3 ตัวบน, 2 ตัวล่าง, วิ่ง, รูด)
 * - สถิติจำนวนครั้งที่ออก (เลข 0-9)
 * - ตารางแสดงผลหวย 2 ตัวล่าง 30 งวดที่ผ่านมา
 * - ตารางแสดงผลหวย 3 ตัวบน 30 งวดที่ผ่านมา
 */

// รายชื่อหวยที่ต้องดึงข้อมูลการคำนวณ
const LOTTERY_SOURCES = [
  {
    id: "thai_government",
    name: "หวยรัฐบาลไทย",
    url: "https://exphuay.com/calculate/goverment",
    outputFile: "gov_thai.json"
  },
  {
    id: "lao_pattana",
    name: "หวยลาวพัฒนา",
    url: "https://exphuay.com/calculate/laosdevelops",
    outputFile: "lao_pattana.json"
  },
  {
    id: "malaysia",
    name: "หวยมาเลย์",
    url: "https://exphuay.com/calculate/magnum4d",
    outputFile: "malaysia.json"
  },
  {
    id: "baac",
    name: "หวยธ.ก.ส.",
    url: "https://exphuay.com/calculate/baac",
    outputFile: "baac.json"
  },
  {
    id: "gsb",
    name: "หวยออมสิน",
    url: "https://exphuay.com/calculate/gsb",
    outputFile: "gsb.json"
  }
];

function nowISO() {
  return new Date().toISOString();
}

/**
 * ดึงข้อมูลการคำนวณหวยจากหน้า calculate
 */
async function scrapeCalculationData(browser, source) {
  console.log(`\n📊 Scraping ${source.name} from ${source.url}...`);
  
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  await page.setViewport({ width: 1920, height: 1080 });

  try {
    await page.goto(source.url, { waitUntil: "networkidle2", timeout: 120000 });

    // รอให้ JavaScript render เสร็จ
    console.log("⏳ Waiting for JavaScript to render...");
    await new Promise((r) => setTimeout(r, 10000));

    // Scroll ทั้งหน้าเพื่อให้ lazy load ทำงาน
    console.log("📜 Scrolling page...");
    await page.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        window.scrollBy(0, 500);
        await new Promise((r) => setTimeout(r, 400));
      }
      window.scrollTo(0, 0);
    });

    await new Promise((r) => setTimeout(r, 3000));

    // ดึงข้อมูลจากหน้าเว็บ
    const data = await page.evaluate((lotteryName) => {
      const bodyText = document.body.innerText;
      const result = {
        daily_calculation: {
          top3: [],
          top3_recommended: [],
          bottom2: [],
          bottom2_recommended: [],
          running_number: null,
          full_set_number: null
        },
        digit_frequency: {
          data: []
        },
        statistics_30_draws: {
          bottom2: [],
          top3: []
        }
      };

      // ============ 1. ดึงคำนวณหวยประจำวัน ============
      const sections = bodyText.split(/\n+/);
      
      let inTop3Section = false;
      let inBottom2Section = false;
      let inRunningSection = false;
      let inFullSetSection = false;
      let currentSection = null;

      // ฟังก์ชันดึงตัวเลข
      const extractNumbers = (text, digits) => {
        const regex = new RegExp(`\\b\\d{${digits}}\\b`, "g");
        const matches = text.match(regex) || [];
        return matches.filter(n => n !== "0".repeat(digits));
      };

      for (const line of sections) {
        const trimmed = line.trim();

        // ตรวจหา section headers
        if (trimmed.includes("3 ตัวบน") && !trimmed.includes("ตาราง")) {
          inTop3Section = true;
          inBottom2Section = false;
          inRunningSection = false;
          inFullSetSection = false;
          continue;
        }
        if (trimmed.includes("2 ตัวล่าง") && !trimmed.includes("ตาราง")) {
          inTop3Section = false;
          inBottom2Section = true;
          inRunningSection = false;
          inFullSetSection = false;
          continue;
        }
        if (trimmed === "วิ่ง" || trimmed.includes("เลขวิ่ง")) {
          inTop3Section = false;
          inBottom2Section = false;
          inRunningSection = true;
          inFullSetSection = false;
          continue;
        }
        if (trimmed === "รูด" || trimmed.includes("เลขรูด")) {
          inTop3Section = false;
          inBottom2Section = false;
          inRunningSection = false;
          inFullSetSection = true;
          continue;
        }

        // ดึงตัวเลขจากแต่ละ section
        if (inTop3Section) {
          const nums = extractNumbers(trimmed, 3);
          result.daily_calculation.top3.push(...nums);
        }
        if (inBottom2Section) {
          const nums = extractNumbers(trimmed, 2);
          result.daily_calculation.bottom2.push(...nums);
        }
        if (inRunningSection && /^\d$/.test(trimmed)) {
          result.daily_calculation.running_number = trimmed;
          inRunningSection = false;
        }
        if (inFullSetSection && /^\d$/.test(trimmed)) {
          result.daily_calculation.full_set_number = trimmed;
          inFullSetSection = false;
        }
      }

      // ลบ duplicates
      result.daily_calculation.top3 = [...new Set(result.daily_calculation.top3)].slice(0, 15);
      result.daily_calculation.bottom2 = [...new Set(result.daily_calculation.bottom2)].slice(0, 15);

      // ============ 2. ดึงสถิติจำนวนครั้งที่ออก (เลข 0-9) ============
      const freqMatch = bodyText.match(
        /เลข\s+3\s*ตัวบน\s+2\s*ตัวล่าง\s+รวม([\s\S]*?)(?:สถิติ|ตาราง|$)/i
      );
      
      if (freqMatch) {
        const freqText = freqMatch[1];
        const rows = freqText.trim().split("\n");
        for (const row of rows) {
          const parts = row.trim().split(/\s+/);
          if (parts.length >= 4 && /^[0-9]$/.test(parts[0])) {
            result.digit_frequency.data.push({
              digit: parts[0],
              top3_count: parseInt(parts[1]) || 0,
              bottom2_count: parseInt(parts[2]) || 0,
              total: parseInt(parts[3]) || 0
            });
          }
        }
      }

      // ============ 3. ดึงตาราง 2 ตัวล่าง 30 งวด ============
      const bottom2TableMatch = bodyText.match(
        /ตารางแสดงผล.*?2\s*ตัวล่าง[\s\S]*?เลขที่ออก\s+จำนวนครั้งที่ออก([\s\S]*?)(?:ตารางแสดงผล|คำนวณ|สถิติ.*?3\s*ตัวบน|$)/i
      );
      
      if (bottom2TableMatch) {
        const rows = bottom2TableMatch[1].trim().split("\n");
        for (const row of rows) {
          const parts = row.trim().split(/\s+/);
          if (parts.length >= 2 && /^\d{2}$/.test(parts[0])) {
            result.statistics_30_draws.bottom2.push({
              number: parts[0],
              count: parseInt(parts[1]) || 0
            });
          }
        }
      }

      // ============ 4. ดึงตาราง 3 ตัวบน 30 งวด ============
      const top3TableMatch = bodyText.match(
        /ตารางแสดงผล.*?3\s*ตัวบน[\s\S]*?เลขที่ออก\s+จำนวนครั้งที่ออก([\s\S]*?)(?:ตารางแสดงผล|คำนวณ|$)/i
      );
      
      if (top3TableMatch) {
        const rows = top3TableMatch[1].trim().split("\n");
        for (const row of rows) {
          const parts = row.trim().split(/\s+/);
          if (parts.length >= 2 && /^\d{3}$/.test(parts[0])) {
            result.statistics_30_draws.top3.push({
              number: parts[0],
              count: parseInt(parts[1]) || 0
            });
          }
        }
      }

      return {
        ...result,
        _debug: {
          bodyTextLength: bodyText.length,
          foundTop3: result.daily_calculation.top3.length,
          foundBottom2: result.daily_calculation.bottom2.length,
          foundDigitFreq: result.digit_frequency.data.length,
          foundStats30Bottom2: result.statistics_30_draws.bottom2.length,
          foundStats30Top3: result.statistics_30_draws.top3.length,
          bodyPreview: bodyText.slice(0, 2000)
        }
      };
    }, source.name);

    // Save screenshot for debugging
    await page.screenshot({ 
      path: `debug-${source.id}.png`, 
      fullPage: true 
    });

    await page.close();

    console.log(`✅ ${source.name} scraped successfully`);
    console.log(`   - Top3: ${data._debug.foundTop3} numbers`);
    console.log(`   - Bottom2: ${data._debug.foundBottom2} numbers`);
    console.log(`   - Digit Frequency: ${data._debug.foundDigitFreq} rows`);
    console.log(`   - Stats 30 Bottom2: ${data._debug.foundStats30Bottom2} rows`);
    console.log(`   - Stats 30 Top3: ${data._debug.foundStats30Top3} rows`);

    return data;

  } catch (error) {
    console.error(`❌ Error scraping ${source.name}:`, error.message);
    await page.close();
    return null;
  }
}

/**
 * Main function
 */
async function main() {
  console.log("🎰 Starting lottery calculation scraper...");
  console.log(`📅 Fetched at: ${nowISO()}`);
  console.log(`📋 Total sources: ${LOTTERY_SOURCES.length}`);

  // เปิด browser
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  // สร้างโฟลเดอร์ output
  await fs.mkdir("public", { recursive: true });

  const allResults = [];

  // ดึงข้อมูลแต่ละหวย
  for (const source of LOTTERY_SOURCES) {
    const data = await scrapeCalculationData(browser, source);
    
    if (data) {
      const result = {
        lottery: source.id,
        lottery_name: source.name,
        source_url: source.url,
        fetched_at: nowISO(),
        window: { latest_n_draws: 30 },
        daily_calculation: data.daily_calculation,
        digit_frequency: data.digit_frequency,
        statistics_30_draws: data.statistics_30_draws,
        notes: `ดึงข้อมูลจาก exphuay.com - รันเวลา 08:00 น.`
      };

      // เซฟไฟล์แยกสำหรับแต่ละหวย
      const outputPath = `public/${source.outputFile}`;
      await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
      console.log(`💾 Saved: ${outputPath}`);

      allResults.push(result);
    }
  }

  // เซฟไฟล์รวมทั้งหมด
  const combinedResult = {
    fetched_at: nowISO(),
    total_lotteries: allResults.length,
    scheduled_time: "08:00",
    lotteries: allResults,
    notes: "ข้อมูลการคำนวณหวยและสถิติ - รันวันละ 1 ครั้ง"
  };

  await fs.writeFile(
    "public/all_calculations.json",
    JSON.stringify(combinedResult, null, 2),
    "utf8"
  );
  console.log("\n💾 Saved: public/all_calculations.json");

  await browser.close();

  // แสดงสรุป
  console.log("\n" + "=".repeat(50));
  console.log("📊 SUMMARY");
  console.log("=".repeat(50));
  
  for (const result of allResults) {
    console.log(`\n📌 ${result.lottery_name}`);
    console.log(`   3 ตัวบน: ${result.daily_calculation.top3.join(", ") || "N/A"}`);
    console.log(`   2 ตัวล่าง: ${result.daily_calculation.bottom2.join(", ") || "N/A"}`);
    console.log(`   วิ่ง: ${result.daily_calculation.running_number || "N/A"}`);
    console.log(`   รูด: ${result.daily_calculation.full_set_number || "N/A"}`);
  }

  console.log("\n✅ All done!");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  console.error(err.stack);
  process.exit(1);
});
