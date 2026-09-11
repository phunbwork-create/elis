/**
 * ====================================================================
 *  ELIS - Certificate Verification & Auto-Approval Script
 * ====================================================================
 *  Mô tả:
 *  - Truy cập trang Learning Manage
 *  - Đọc dữ liệu từng dòng trong bảng
 *  - Click View → mở ảnh chứng chỉ trong tab mới
 *  - OCR ảnh chứng chỉ để trích xuất: Tên sinh viên, Tên khóa học
 *  - Kiểm tra 3 logic:
 *      1. Submit date nằm trong năm 2026
 *      2. Employee Name/Email trùng với tên trên chứng chỉ
 *      3. Tên khóa học trùng với tên trên chứng chỉ
 *  - Nếu khớp → Approve
 *  - Nếu không khớp → Ghi lại lý do
 *  - Lưu log kết quả ra file JSON
 * ====================================================================
 */

const { chromium } = require('playwright');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

// ===== CONFIG =====
const PAGE_URL = 'https://phunbwork-create.github.io/elis/';
const LOG_DIR = path.join(__dirname, 'logs');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'screenshots');
const HEADLESS = false; // false để xem browser chạy

// ===== HELPERS =====

/**
 * Chuẩn hóa chuỗi: lowercase, bỏ dấu tiếng Việt, bỏ khoảng trắng thừa
 */
function normalize(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')    // bỏ dấu
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .replace(/[^a-z0-9\s]/gi, ' ')      // bỏ ký tự đặc biệt
        .replace(/\s+/g, ' ')               // gộp khoảng trắng
        .trim();
}

/**
 * Kiểm tra tên nhân viên có khớp với tên trên chứng chỉ không
 * So sánh linh hoạt: tên tiếng Việt (Nguyễn Bá Phú) vs tên trên cert (Phu Nguyen Ba PhuNB2)
 */
function isNameMatch(employeeName, employeeEmail, certText) {
    const normalizedCert = normalize(certText);
    const normalizedName = normalize(employeeName);

    // Tách từng từ trong tên nhân viên và kiểm tra xuất hiện trong cert
    const nameWords = normalizedName.split(' ').filter(w => w.length > 1);
    const matchedWords = nameWords.filter(word => normalizedCert.includes(word));
    const nameMatchRatio = matchedWords.length / nameWords.length;

    // Kiểm tra email prefix có xuất hiện trong cert không
    const emailPrefix = employeeEmail.split('@')[0].toLowerCase();
    const emailInCert = normalizedCert.includes(emailPrefix.toLowerCase());

    // Cần ít nhất 50% từ trong tên khớp HOẶC email prefix khớp
    const matched = nameMatchRatio >= 0.5 || emailInCert;

    return {
        matched,
        details: {
            employeeName,
            employeeEmail,
            nameWords,
            matchedWords,
            nameMatchRatio: Math.round(nameMatchRatio * 100) + '%',
            emailPrefix,
            emailInCert,
        }
    };
}

/**
 * Kiểm tra tên khóa học có khớp không
 */
function isCourseMatch(courseName, certText) {
    const normalizedCert = normalize(certText);
    const normalizedCourse = normalize(courseName);

    // Tách từng từ quan trọng trong tên khóa học
    const courseWords = normalizedCourse.split(' ').filter(w => w.length > 1);
    const matchedWords = courseWords.filter(word => normalizedCert.includes(word));
    const matchRatio = matchedWords.length / courseWords.length;

    // Cần ít nhất 70% từ khớp
    const matched = matchRatio >= 0.7;

    return {
        matched,
        details: {
            courseName,
            courseWords,
            matchedWords,
            matchRatio: Math.round(matchRatio * 100) + '%',
        }
    };
}

/**
 * Kiểm tra submit date có trong năm 2026 không
 */
function isDateValid(submitDate) {
    const matched = submitDate.includes('2026');
    return {
        matched,
        details: {
            submitDate,
            expectedYear: '2026',
            found: matched
        }
    };
}

/**
 * Tạo timestamp cho tên file
 */
function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ===== MAIN SCRIPT =====
async function main() {
    // Tạo thư mục output
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const timestamp = getTimestamp();
    const results = [];

    console.log('='.repeat(60));
    console.log('  ELIS - Certificate Verification & Auto-Approval');
    console.log('  Thời gian chạy:', new Date().toLocaleString('vi-VN'));
    console.log('='.repeat(60));

    // Khởi tạo browser
    console.log('\n🚀 Khởi tạo browser...');
    const browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 }
    });
    const page = await context.newPage();

    try {
        // 1. Truy cập trang
        console.log(`\n📄 Truy cập: ${PAGE_URL}`);
        await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
        await page.waitForSelector('table.data-table tbody tr', { timeout: 10000 });

        // Chụp ảnh trang tổng quan
        await page.screenshot({
            path: path.join(SCREENSHOT_DIR, `${timestamp}_01_overview.png`),
            fullPage: true
        });
        console.log('📸 Đã chụp ảnh trang tổng quan');

        // 2. Đọc tất cả dòng trong bảng
        const rows = await page.$$('table.data-table tbody tr');
        console.log(`\n📊 Tìm thấy ${rows.length} dòng dữ liệu cần xử lý\n`);

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            console.log(`${'─'.repeat(50)}`);
            console.log(`📋 Xử lý dòng ${i + 1}/${rows.length}`);

            // 2a. Đọc dữ liệu từ bảng
            const cells = await row.$$('td');
            const rowData = {
                id: (await cells[0].textContent()).trim(),
                employeeName: (await cells[1].textContent()).trim(),
                employeeEmail: (await cells[2].textContent()).trim(),
                companyName: (await cells[3].textContent()).trim(),
                duration: (await cells[4].textContent()).trim(),
                courseName: (await cells[5].textContent()).trim(),
                status: (await cells[6].textContent()).trim(),
                submitDate: (await cells[7].textContent()).trim(),
            };

            console.log(`   👤 Nhân viên: ${rowData.employeeName} (${rowData.employeeEmail})`);
            console.log(`   📚 Khóa học:  ${rowData.courseName}`);
            console.log(`   📅 Ngày nộp:  ${rowData.submitDate}`);
            console.log(`   🏷️  Status:    ${rowData.status}`);

            // Bỏ qua nếu đã xử lý (không phải WAITING)
            if (!rowData.status.includes('WAITING')) {
                console.log(`   ⏭️  Bỏ qua - Status không phải WAITING`);
                results.push({
                    row: i + 1,
                    ...rowData,
                    action: 'SKIPPED',
                    reason: 'Status is not WAITING'
                });
                continue;
            }

            // 2b. Trích xuất URL ảnh chứng chỉ từ nút View
            console.log(`   🔍 Đang trích xuất URL chứng chỉ...`);

            const viewLink = await cells[11].$('.action-link');
            if (!viewLink) {
                console.log(`   ❌ Không tìm thấy nút View`);
                results.push({
                    row: i + 1,
                    ...rowData,
                    action: 'ERROR',
                    reason: 'View button not found'
                });
                continue;
            }

            // Lấy URL ảnh từ thuộc tính onclick
            const onclickAttr = await viewLink.getAttribute('onclick');
            const urlMatch = onclickAttr.match(/window\.open\('([^']+)'/);
            if (!urlMatch) {
                console.log(`   ❌ Không trích xuất được URL ảnh`);
                results.push({
                    row: i + 1,
                    ...rowData,
                    action: 'ERROR',
                    reason: 'Cannot extract cert image URL from onclick'
                });
                continue;
            }

            // Tạo URL đầy đủ - xử lý cả blob URL và relative path
            let certImageUrl = urlMatch[1];
            if (certImageUrl.startsWith('blob:')) {
                // Blob URL không truy cập được từ bên ngoài → dùng URL ảnh hosted
                certImageUrl = PAGE_URL + 'assets/cert_phunb2.jpg';
                console.log(`   ⚠️  Blob URL detected, sử dụng ảnh hosted thay thế`);
            } else if (!certImageUrl.startsWith('http')) {
                certImageUrl = new URL(certImageUrl, PAGE_URL).href;
            }
            console.log(`   🔗 URL chứng chỉ: ${certImageUrl}`);

            // Mở tab mới, truy cập trực tiếp URL ảnh
            const newPage = await context.newPage();
            await newPage.goto(certImageUrl, { waitUntil: 'load' });
            await newPage.waitForTimeout(2000); // Chờ ảnh load xong

            // 2c. Chụp screenshot ảnh chứng chỉ
            const certScreenshotPath = path.join(
                SCREENSHOT_DIR,
                `${timestamp}_cert_row${i + 1}.png`
            );
            await newPage.screenshot({ path: certScreenshotPath, fullPage: true });
            console.log(`   📸 Đã chụp ảnh chứng chỉ`);

            // 2d. OCR ảnh chứng chỉ
            console.log(`   🔤 Đang OCR ảnh chứng chỉ...`);
            let ocrText = '';
            try {
                const { data } = await Tesseract.recognize(certScreenshotPath, 'eng', {
                    logger: () => {} // tắt log verbose
                });
                ocrText = data.text;
                console.log(`   ✅ OCR thành công. Nội dung trích xuất:`);
                console.log(`      "${ocrText.replace(/\n/g, ' ').substring(0, 120)}..."`);
            } catch (ocrErr) {
                console.log(`   ❌ OCR thất bại: ${ocrErr.message}`);
                results.push({
                    row: i + 1,
                    ...rowData,
                    action: 'ERROR',
                    reason: `OCR failed: ${ocrErr.message}`
                });
                await newPage.close();
                continue;
            }

            // Đóng tab chứng chỉ
            await newPage.close();

            // 2e. Kiểm tra 3 logic
            console.log(`\n   🔎 KIỂM TRA 3 TIÊU CHÍ:`);

            // Logic 1: Submit date năm 2026
            const dateCheck = isDateValid(rowData.submitDate);
            console.log(`   ${dateCheck.matched ? '✅' : '❌'} [1] Submit date trong 2026: ${dateCheck.matched ? 'ĐẠT' : 'KHÔNG ĐẠT'} (${rowData.submitDate})`);

            // Logic 2: Tên nhân viên khớp chứng chỉ
            const nameCheck = isNameMatch(rowData.employeeName, rowData.employeeEmail, ocrText);
            console.log(`   ${nameCheck.matched ? '✅' : '❌'} [2] Tên nhân viên khớp cert: ${nameCheck.matched ? 'ĐẠT' : 'KHÔNG ĐẠT'} (${nameCheck.details.nameMatchRatio} từ khớp, email: ${nameCheck.details.emailInCert ? 'có' : 'không'})`);

            // Logic 3: Tên khóa học khớp
            const courseCheck = isCourseMatch(rowData.courseName, ocrText);
            console.log(`   ${courseCheck.matched ? '✅' : '❌'} [3] Tên khóa học khớp cert: ${courseCheck.matched ? 'ĐẠT' : 'KHÔNG ĐẠT'} (${courseCheck.details.matchRatio} từ khớp)`);

            const allPassed = dateCheck.matched && nameCheck.matched && courseCheck.matched;

            // 2f. Ra quyết định
            if (allPassed) {
                console.log(`\n   ✅✅✅ TẤT CẢ TIÊU CHÍ ĐẠT → BẤM APPROVE`);

                // Click Approve
                const approveLink = await cells[12].$('.approve-link');
                if (approveLink) {
                    await approveLink.click();
                    await page.waitForTimeout(500);

                    // Xử lý modal Approve
                    const approveBtn = await page.$('.btn-approve-confirm');
                    if (approveBtn) {
                        await approveBtn.click();
                        await page.waitForTimeout(1000);
                        console.log(`   🎉 Đã Approve thành công!`);
                    }
                }

                // Chụp ảnh sau khi approve
                await page.screenshot({
                    path: path.join(SCREENSHOT_DIR, `${timestamp}_approved_row${i + 1}.png`),
                    fullPage: true
                });

                results.push({
                    row: i + 1,
                    ...rowData,
                    action: 'APPROVED',
                    ocrTextExtracted: ocrText.replace(/\n/g, ' ').trim(),
                    checks: {
                        dateValid: dateCheck,
                        nameMatch: nameCheck,
                        courseMatch: courseCheck
                    }
                });
            } else {
                // Không khớp → ghi lại lý do
                const reasons = [];
                if (!dateCheck.matched) reasons.push(`Submit date không thuộc năm 2026 (${rowData.submitDate})`);
                if (!nameCheck.matched) reasons.push(`Tên nhân viên không khớp với chứng chỉ (tên: ${rowData.employeeName}, cert words matched: ${nameCheck.details.nameMatchRatio})`);
                if (!courseCheck.matched) reasons.push(`Tên khóa học không khớp với chứng chỉ (khóa: ${rowData.courseName}, cert words matched: ${courseCheck.details.matchRatio})`);

                console.log(`\n   ❌ KHÔNG ĐẠT → KHÔNG APPROVE`);
                reasons.forEach(r => console.log(`      ⚠️  ${r}`));

                results.push({
                    row: i + 1,
                    ...rowData,
                    action: 'REJECTED',
                    reasons,
                    ocrTextExtracted: ocrText.replace(/\n/g, ' ').trim(),
                    checks: {
                        dateValid: dateCheck,
                        nameMatch: nameCheck,
                        courseMatch: courseCheck
                    }
                });
            }
        }

        // 3. Lưu log kết quả
        const logFile = path.join(LOG_DIR, `verification_${timestamp}.json`);
        const logData = {
            runAt: new Date().toISOString(),
            pageUrl: PAGE_URL,
            totalRows: rows.length,
            approved: results.filter(r => r.action === 'APPROVED').length,
            rejected: results.filter(r => r.action === 'REJECTED').length,
            skipped: results.filter(r => r.action === 'SKIPPED').length,
            errors: results.filter(r => r.action === 'ERROR').length,
            results
        };

        fs.writeFileSync(logFile, JSON.stringify(logData, null, 2), 'utf-8');
        console.log(`\n${'='.repeat(60)}`);
        console.log('  📊 KẾT QUẢ TỔNG HỢP');
        console.log(`${'='.repeat(60)}`);
        console.log(`  ✅ Approved:  ${logData.approved}`);
        console.log(`  ❌ Rejected:  ${logData.rejected}`);
        console.log(`  ⏭️  Skipped:   ${logData.skipped}`);
        console.log(`  ⚠️  Errors:    ${logData.errors}`);
        console.log(`  📁 Log file:  ${logFile}`);
        console.log(`  📸 Screenshots: ${SCREENSHOT_DIR}`);
        console.log(`${'='.repeat(60)}\n`);

    } catch (error) {
        console.error('\n💥 Lỗi nghiêm trọng:', error.message);
        console.error(error.stack);
    } finally {
        await browser.close();
        console.log('🏁 Browser đã đóng. Hoàn tất.');
    }
}

// Chạy
main().catch(console.error);
