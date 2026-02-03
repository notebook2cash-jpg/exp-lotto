import fs from "node:fs/promises";
import puppeteer from "puppeteer";

const TARGET_URL = "https://exphuay.com/";

function nowISO() {
  return new Date().toISOString();
}

/**
 * ดึงข้อมูลผลหวยทั้งหมดจากหน้า exphuay.com
 */
async function scrapeAllLotteryResults(url) {
  console.log("🌐 Opening browser...");
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const page = await browser.newPage();

  // ตั้ง User-Agent
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  await page.setViewport({ width: 1920, height: 1080 });

  console.log(`📄 Loading ${url}...`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

  // รอให้ JavaScript render เสร็จ
  console.log("⏳ Waiting for JavaScript to render...");
  await new Promise((r) => setTimeout(r, 8000));

  // Scroll ทั้งหน้าเพื่อให้ lazy load ทำงาน
  console.log("📜 Scrolling page...");
  await page.evaluate(async () => {
    for (let i = 0; i < 15; i++) {
      window.scrollBy(0, 600);
      await new Promise((r) => setTimeout(r, 400));
    }
    window.scrollTo(0, 0);
  });

  await new Promise((r) => setTimeout(r, 3000));

  // ดึงข้อมูลหวยทั้งหมด
  const results = await page.evaluate(() => {
    const lotteryResults = [];

    // ฟังก์ชันช่วย: แปลงวันที่ไทยเป็น ISO format
    function parseThaiDate(thaiDateStr) {
      if (!thaiDateStr) return null;
      
      const thaiMonths = {
        'มกราคม': '01', 'กุมภาพันธ์': '02', 'มีนาคม': '03',
        'เมษายน': '04', 'พฤษภาคม': '05', 'มิถุนายน': '06',
        'กรกฎาคม': '07', 'สิงหาคม': '08', 'กันยายน': '09',
        'ตุลาคม': '10', 'พฤศจิกายน': '11', 'ธันวาคม': '12'
      };

      // pattern: งวดวันที่ DD เดือน YYYY หรือ ประจำงวดวันที่ DD เดือน YYYY
      const match = thaiDateStr.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
      if (match) {
        const day = match[1].padStart(2, '0');
        const month = thaiMonths[match[2]] || '01';
        let year = parseInt(match[3]);
        // แปลงปี พ.ศ. เป็น ค.ศ. (ถ้าปี > 2500)
        if (year > 2500) {
          year = year - 543;
        }
        return `${year}-${month}-${day}`;
      }
      return null;
    }

    // หา cards หวยทั้งหมด (ปรับ selector ตามโครงสร้างจริงของเว็บ)
    // โดยมองหา pattern ของการ์ดหวย
    const bodyText = document.body.innerText;
    const allElements = document.querySelectorAll('*');

    // ============ ดึงหวยฮานอย (แบบตาราง) ============
    // หาส่วนที่มี "ผลสามนอย" หรือ "ฮานอย"
    const hanoiSection = bodyText.match(/ผลสามนอย[\s\S]*?ประจำ.*?วันที่\s*(\d{1,2}\s+\S+\s+\d{4})/);
    if (hanoiSection) {
      const hanoiDate = parseThaiDate(hanoiSection[0]);
      
      // หา pattern: ฮานอยพิเศษ HH:MM XXX YY
      const hanoiTypes = [
        { name: 'ฮานอยพิเศษ', pattern: /ฮานอยพิเศษ\s*(\d{1,2}:\d{2})\s*(\d{3})\s*(\d{2})/ },
        { name: 'ฮานอยปกติ', pattern: /ฮานอยปกติ\s*(\d{1,2}:\d{2})\s*(\d{3})\s*(\d{2})/ },
        { name: 'ฮานอย VIP', pattern: /ฮานอย\s*VIP\s*(\d{1,2}:\d{2})\s*(\d{3})\s*(\d{2})/ }
      ];

      for (const hType of hanoiTypes) {
        const match = bodyText.match(hType.pattern);
        if (match) {
          lotteryResults.push({
            lottery_type: 'hanoi',
            lottery_name: hType.name,
            draw_date: hanoiDate,
            draw_time: match[1],
            results: {
              top3: match[2],
              bottom2: match[3]
            }
          });
        }
      }
    }

    // ============ ดึงหวยแบบการ์ด (หวยรัฐบาลไทย, มาเลย์, ออมสิน, ธกส, ลาว) ============
    const lotteryPatterns = [
      {
        id: 'thai_government',
        namePattern: /ผลหวยรัฐบาลไทย/,
        resultDigits: 6
      },
      {
        id: 'malaysia',
        namePattern: /ผลหวยมาเลย์/,
        resultDigits: 4
      },
      {
        id: 'gsb',
        namePattern: /ผลหวยออมสิน/,
        resultDigits: 3
      },
      {
        id: 'baac',
        namePattern: /ผลหวยธ\.?ก\.?ส\.?/,
        resultDigits: 3
      },
      {
        id: 'lao_pattana',
        namePattern: /ผลหวยลาวพัฒนา/,
        resultDigits: 6
      },
      {
        id: 'lao_hd',
        namePattern: /ผลหวยลาว HD/,
        resultDigits: 6
      },
      {
        id: 'lao_star',
        namePattern: /ผลหวยลาวสตาร์/,
        resultDigits: 6
      }
    ];

    // แยก sections ตามหวยแต่ละประเภท
    const sections = bodyText.split(/(?=ผลหวย)/);

    for (const section of sections) {
      for (const lp of lotteryPatterns) {
        if (lp.namePattern.test(section)) {
          // หาวันที่
          const dateMatch = section.match(/งวด.*?วันที่\s*(\d{1,2}\s+\S+\s+\d{4})/);
          const drawDate = dateMatch ? parseThaiDate(dateMatch[0]) : null;

          // หาผลรางวัลหลัก (ตัวเลขตามจำนวน digits ที่กำหนด)
          const resultPattern = new RegExp(`ผลรางวัล[\\s\\S]*?(\\d{${lp.resultDigits}})`);
          const resultMatch = section.match(resultPattern);
          const fullResult = resultMatch ? resultMatch[1] : null;

          // หา 3 ตัวบน
          const top3Match = section.match(/3\s*ตัวบน[\s\S]*?(\d{3})/);
          const top3 = top3Match ? top3Match[1] : null;

          // หา 2 ตัวล่าง
          const bottom2Match = section.match(/2\s*ตัวล่าง[\s\S]*?(\d{2})/);
          const bottom2 = bottom2Match ? bottom2Match[1] : null;

          if (fullResult || top3 || bottom2) {
            // ตรวจสอบว่ายังไม่มีข้อมูลหวยประเภทนี้
            const exists = lotteryResults.find(l => l.lottery_type === lp.id);
            if (!exists) {
              lotteryResults.push({
                lottery_type: lp.id,
                lottery_name: section.match(lp.namePattern)?.[0] || lp.id,
                draw_date: drawDate,
                results: {
                  full_number: fullResult,
                  top3: top3,
                  bottom2: bottom2
                }
              });
            }
          }
        }
      }
    }

    return lotteryResults;
  });

  // Alternative: ใช้วิธีดึงจาก DOM โดยตรงถ้าวิธีแรกไม่ได้ผล
  const resultsFromDom = await page.evaluate(() => {
    const results = [];
    
    // หาการ์ดหวยทั้งหมด - ลองหลาย selectors
    const possibleCardSelectors = [
      '[class*="card"]',
      '[class*="lottery"]',
      '[class*="result"]',
      'div[class*="bg-"]'
    ];

    // ดึง full body text สำหรับ debug
    const bodyText = document.body.innerText;
    
    // ใช้ regex เพื่อดึงข้อมูลจาก text โดยตรง
    const lotteryData = [];

    // Pattern สำหรับหวยแต่ละประเภท
    const patterns = [
      {
        id: 'thai_government',
        name: 'หวยรัฐบาลไทย',
        mainPattern: /ผลหวยรัฐบาลไทย[\s\S]*?งวด.*?วันที่\s*(\d{1,2}\s+\S+\s+\d{4})[\s\S]*?ผลรางวัล[\s\S]*?(\d{6})[\s\S]*?3\s*ตัวบน[\s\S]*?(\d{3})[\s\S]*?2\s*ตัวล่าง[\s\S]*?(\d{2})/
      },
      {
        id: 'malaysia',
        name: 'หวยมาเลย์',
        mainPattern: /ผลหวยมาเลย์[\s\S]*?งวด.*?วันที่\s*(\d{1,2}\s+\S+\s+\d{4})[\s\S]*?ผลรางวัล[\s\S]*?(\d{4})[\s\S]*?3\s*ตัวบน[\s\S]*?(\d{3})[\s\S]*?2\s*ตัวล่าง[\s\S]*?(\d{2})/
      },
      {
        id: 'gsb',
        name: 'หวยออมสิน',
        mainPattern: /ผลหวยออมสิน[\s\S]*?งวด.*?วันที่\s*(\d{1,2}\s+\S+\s+\d{4})[\s\S]*?ผลรางวัล[\s\S]*?(\d{3})[\s\S]*?3\s*ตัวบน[\s\S]*?(\d{3})[\s\S]*?2\s*ตัวล่าง[\s\S]*?(\d{2})/
      },
      {
        id: 'baac',
        name: 'หวยธ.ก.ส.',
        mainPattern: /ผลหวยธ\.?ก\.?ส\.?[\s\S]*?งวด.*?วันที่\s*(\d{1,2}\s+\S+\s+\d{4})[\s\S]*?ผลรางวัล[\s\S]*?(\d{3})[\s\S]*?3\s*ตัวบน[\s\S]*?(\d{3})[\s\S]*?2\s*ตัวล่าง[\s\S]*?(\d{2})/
      },
      {
        id: 'lao_pattana',
        name: 'หวยลาวพัฒนา',
        mainPattern: /ผลหวยลาวพัฒนา[\s\S]*?งวด.*?วันที่\s*(\d{1,2}\s+\S+\s+\d{4})[\s\S]*?ผลรางวัล[\s\S]*?(\d{6})[\s\S]*?3\s*ตัวบน[\s\S]*?(\d{3})[\s\S]*?2\s*ตัวล่าง[\s\S]*?(\d{2})/
      }
    ];

    for (const p of patterns) {
      const match = bodyText.match(p.mainPattern);
      if (match) {
        lotteryData.push({
          lottery_type: p.id,
          lottery_name: p.name,
          raw_date: match[1],
          full_number: match[2],
          top3: match[3],
          bottom2: match[4]
        });
      }
    }

    // หาหวยฮานอย (รูปแบบตาราง)
    const hanoiPattern = /ประจำ.*?งวด.*?วันที่\s*(\d{1,2}\s+\S+\s+\d{4})/;
    const hanoiDateMatch = bodyText.match(hanoiPattern);
    
    const hanoiTypes = [
      { id: 'hanoi_special', name: 'ฮานอยพิเศษ', pattern: /ฮานอยพิเศษ\s*(\d{1,2}:\d{2})\s*(\d{3})\s*(\d{2})/ },
      { id: 'hanoi_normal', name: 'ฮานอยปกติ', pattern: /ฮานอยปกติ\s*(\d{1,2}:\d{2})\s*(\d{3})\s*(\d{2})/ },
      { id: 'hanoi_vip', name: 'ฮานอย VIP', pattern: /ฮานอย\s*VIP\s*(\d{1,2}:\d{2})\s*(\d{3})\s*(\d{2})/ }
    ];

    for (const h of hanoiTypes) {
      const match = bodyText.match(h.pattern);
      if (match) {
        lotteryData.push({
          lottery_type: h.id,
          lottery_name: h.name,
          raw_date: hanoiDateMatch ? hanoiDateMatch[1] : null,
          draw_time: match[1],
          top3: match[2],
          bottom2: match[3]
        });
      }
    }

    return {
      extracted: lotteryData,
      bodyTextLength: bodyText.length,
      bodyPreview: bodyText.slice(0, 3000)
    };
  });

  // Save screenshot for debug
  await page.screenshot({ path: "debug-exphuay.png", fullPage: true });
  console.log("📸 Screenshot saved to debug-exphuay.png");

  await browser.close();
  
  // รวมผลลัพธ์
  const combinedResults = results.length > 0 ? results : [];
  
  // ถ้า results ว่าง ใช้ resultsFromDom
  if (combinedResults.length === 0 && resultsFromDom.extracted) {
    return {
      lotteries: resultsFromDom.extracted,
      debug: {
        bodyTextLength: resultsFromDom.bodyTextLength,
        bodyPreview: resultsFromDom.bodyPreview
      }
    };
  }

  return {
    lotteries: combinedResults,
    debug: {
      bodyTextLength: resultsFromDom.bodyTextLength,
      bodyPreview: resultsFromDom.bodyPreview
    }
  };
}

/**
 * แปลงวันที่ไทยเป็น ISO format
 */
function parseThaiDateToISO(thaiDateStr) {
  if (!thaiDateStr) return null;
  
  const thaiMonths = {
    'มกราคม': '01', 'กุมภาพันธ์': '02', 'มีนาคม': '03',
    'เมษายน': '04', 'พฤษภาคม': '05', 'มิถุนายน': '06',
    'กรกฎาคม': '07', 'สิงหาคม': '08', 'กันยายน': '09',
    'ตุลาคม': '10', 'พฤศจิกายน': '11', 'ธันวาคม': '12'
  };

  const match = thaiDateStr.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = thaiMonths[match[2]] || '01';
    let year = parseInt(match[3]);
    if (year > 2500) {
      year = year - 543;
    }
    return `${year}-${month}-${day}`;
  }
  return null;
}

/**
 * จัดรูปแบบผลลัพธ์ให้สวยงาม
 */
function formatResults(rawData) {
  const formattedLotteries = [];

  for (const lottery of rawData.lotteries) {
    const formatted = {
      lottery_type: lottery.lottery_type,
      lottery_name: lottery.lottery_name,
      draw_date: lottery.draw_date || parseThaiDateToISO(lottery.raw_date),
      draw_date_thai: lottery.raw_date || null,
      results: {}
    };

    // เพิ่มเวลาถ้ามี
    if (lottery.draw_time) {
      formatted.draw_time = lottery.draw_time;
    }

    // เพิ่มผลรางวัล
    if (lottery.results) {
      formatted.results = lottery.results;
    } else {
      if (lottery.full_number) {
        formatted.results.full_number = lottery.full_number;
      }
      if (lottery.top3) {
        formatted.results.top3 = lottery.top3;
      }
      if (lottery.bottom2) {
        formatted.results.bottom2 = lottery.bottom2;
      }
    }

    formattedLotteries.push(formatted);
  }

  return formattedLotteries;
}

async function main() {
  console.log("🎰 Starting lottery results scraper...");
  console.log(`📅 Fetched at: ${nowISO()}`);

  const rawData = await scrapeAllLotteryResults(TARGET_URL);
  
  console.log("\n📊 Raw data extracted:");
  console.log(`Found ${rawData.lotteries.length} lottery types`);

  const formattedLotteries = formatResults(rawData);

  const result = {
    source_url: TARGET_URL,
    fetched_at: nowISO(),
    total_lotteries: formattedLotteries.length,
    lotteries: formattedLotteries,
    notes: "ดึงข้อมูลผลหวยจาก exphuay.com โดยตรง"
  };

  // สร้างโฟลเดอร์ public ถ้ายังไม่มี
  await fs.mkdir("public", { recursive: true });

  // เซฟไฟล์ JSON
  const outputPath = "public/lottery_results.json";
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
  
  console.log(`\n✅ Results saved to ${outputPath}`);
  console.log("\n📋 Summary:");
  
  for (const lottery of formattedLotteries) {
    console.log(`  - ${lottery.lottery_name}: ${lottery.results.full_number || lottery.results.top3 || 'N/A'}`);
  }

  // แสดง debug info ถ้าจำเป็น
  if (formattedLotteries.length === 0) {
    console.log("\n⚠️ No results found. Debug info:");
    console.log("Body text length:", rawData.debug?.bodyTextLength);
    console.log("Body preview:", rawData.debug?.bodyPreview?.slice(0, 1000));
  }

  console.log("\n📄 Full JSON output:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  console.error(err.stack);
  process.exit(1);
});
