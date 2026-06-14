import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import {
  buildClearanceData,
  formatDate,
  formatNaira,
  listSessions,
  verifyClearanceToken,
} from "../../services/examClearanceService.js";

function titleCaseSemester(semester) {
  return semester === "FIRST" ? "FIRST SEMESTER" : "SECOND SEMESTER";
}

function logoPath() {
  return path.join(process.cwd(), "app/web/public/img/logo.png");
}

function drawTableRow(doc, y, cols, opts = {}) {
  const { bold = false, fill = null } = opts;

  if (fill) {
    doc.rect(40, y - 4, 515, 20).fill(fill);
  }

  doc
    .fillColor("#111")
    .font(bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(8);

  doc.text(String(cols[0] || ""), 45, y, { width: 65 });
  doc.text(String(cols[1] || ""), 112, y, { width: 100 });
  doc.text(String(cols[2] || ""), 215, y, { width: 205 });
  doc.text(String(cols[3] || ""), 425, y, { width: 75, align: "right" });
  doc.text(String(cols[4] || ""), 505, y, { width: 45 });

  doc.moveTo(40, y + 16).lineTo(555, y + 16).strokeColor("#dddddd").stroke();
}

export async function examClearancePage(req, res, next) {
  try {
    const sessions = await listSessions();

    const selectedSessionId = req.query.sessionId || "";
    const selectedSemester = req.query.semester || "";
    let result = null;
    let error = "";

    if (selectedSessionId && selectedSemester) {
      try {
        result = await buildClearanceData({
          req,
          sessionId: selectedSessionId,
          semester: selectedSemester,
        });
      } catch (e) {
        error = e.message || "Unable to process exam clearance.";
      }
    }

    res.render("student/exam-clearance", {
      title: "Print Exam Clearance",
      pageTitle: "Print Exam Clearance",
      sessions,
      selectedSessionId,
      selectedSemester,
      result,
      error,
      formatNaira,
      formatDate,
    });
  } catch (err) {
    next(err);
  }
}

export async function examClearancePdf(req, res, next) {
  try {
    const data = await buildClearanceData({
      req,
      sessionId: req.query.sessionId,
      semester: req.query.semester,
    });

    if (!data.eligible) {
      req.flash?.(
        "error",
        "You are not yet eligible to print exam clearance for the selected session/semester."
      );
      return res.redirect(
        `/student/exams/clearance/print?sessionId=${encodeURIComponent(
          req.query.sessionId || ""
        )}&semester=${encodeURIComponent(req.query.semester || "")}`
      );
    }

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const filename = `exam-clearance-${data.student.matricNumber || "student"}-${data.session.name}-${data.semester}.pdf`
      .replace(/[^\w.-]+/g, "-")
      .toLowerCase();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    doc.pipe(res);

    const logo = logoPath();
    const hasLogo = fs.existsSync(logo);

    if (hasLogo) {
      doc.opacity(0.06).image(logo, 165, 210, { width: 260 });
      doc.opacity(1);
      doc.image(logo, 45, 35, { width: 70 });
    }

    doc
      .fillColor("#8b0000")
      .font("Helvetica-Bold")
      .fontSize(13)
      .text("EKITI STATE COLLEGE OF HEALTH SCIENCES AND TECHNOLOGY, IJERO", 125, 38, {
        align: "center",
        width: 390,
      });

    doc
      .fillColor("#333")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("Student Examination Clearance Certificate", 125, 60, {
        align: "center",
        width: 390,
      });

    doc.moveTo(40, 95).lineTo(555, 95).strokeColor("#8b0000").lineWidth(1.5).stroke();

    doc
      .fillColor("#8b0000")
      .font("Helvetica-Bold")
      .fontSize(16)
      .text(
        `EXAM CLEARANCE FOR ${data.session.name} / ${titleCaseSemester(data.semester)}`,
        40,
        110,
        { align: "center", width: 515 }
      );

    const qrDataUrl = await QRCode.toDataURL(data.verifyUrl, { margin: 1, width: 120 });
    const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");
    doc.image(qrBuffer, 455, 140, { width: 80 });
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#555")
      .text("Scan to verify", 455, 222, { width: 80, align: "center" });

    let y = 145;

    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#111")
      .text("Student Details", 40, y);

    y += 18;
    doc.font("Helvetica").fontSize(9).fillColor("#111");
    doc.text(`Full Name: ${data.student.fullName}`, 40, y);
    doc.text(`Matric Number: ${data.student.matricNumber}`, 40, y + 16);
    doc.text(`Department: ${data.student.department || "N/A"}`, 40, y + 32);
    doc.text(`Programme: ${data.student.programme || "N/A"}`, 40, y + 48);
    doc.text(`Level: ${data.student.level || "N/A"}`, 40, y + 64);

    y += 100;

    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#111")
      .text("Payment Eligibility Summary", 40, y);

    y += 18;
    doc.font("Helvetica").fontSize(9);
    doc.text(`Total Payable for Selected Session: ${formatNaira(data.totalPayable)}`, 40, y);
    doc.text(`Total Successful Payments Counted: ${formatNaira(data.totalPaid)}`, 40, y + 16);
    doc.text(`Required Amount for ${titleCaseSemester(data.semester)}: ${formatNaira(data.requiredAmount)}`, 40, y + 32);
    doc.text(`Eligibility Status: CLEARED`, 40, y + 48);

    y += 85;

    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#111")
      .text("Successful Payment Breakdown", 40, y);

    y += 20;
    drawTableRow(doc, y, ["Date", "RRR", "Payment/Purpose", "Amount", "Status"], {
      bold: true,
      fill: "#f5dddd",
    });

    y += 20;

    for (const p of data.successfulPayments) {
      if (y > 680) {
        doc.addPage();
        y = 50;
        drawTableRow(doc, y, ["Date", "RRR", "Payment/Purpose", "Amount", "Status"], {
          bold: true,
          fill: "#f5dddd",
        });
        y += 20;
      }

      drawTableRow(doc, y, [
        formatDate(p.paidAt),
        p.rrr || "N/A",
        p.purpose || "Payment",
        formatNaira(p.amount),
        "PAID",
      ]);
      y += 20;
    }

    y += 20;

    if (y > 650) {
      doc.addPage();
      y = 60;
    }

    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#111")
      .text(
        `This is to certify that the holder of this clearance has paid the eligible fees required for his/her department, session and semester, in accordance with the amount payable for the programme. The student should therefore be allowed to sit for the stated examination without hindrance.`,
        45,
        y,
        { width: 505, align: "justify", lineGap: 3 }
      );

    y += 95;

    doc
      .moveTo(70, y)
      .lineTo(230, y)
      .moveTo(365, y)
      .lineTo(525, y)
      .strokeColor("#222")
      .stroke();

    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .text("Bursar Signature", 95, y + 8, { width: 120, align: "center" })
      .text("HOD Signature", 390, y + 8, { width: 120, align: "center" });

    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#666")
      .text(`Generated: ${data.generatedAt.toLocaleString("en-GB")}`, 40, 780)
      .text(`Verification Ref: ${data.token.slice(0, 24)}...`, 260, 780, {
        width: 290,
        align: "right",
      });

    doc.end();
  } catch (err) {
    next(err);
  }
}

export async function verifyExamClearance(req, res) {
  const payload = verifyClearanceToken(req.params.token);

  if (!payload || payload.kind !== "EXAM_CLEARANCE") {
    return res.status(400).send(`
      <h2>Invalid Exam Clearance</h2>
      <p>This exam clearance verification token is invalid or has been altered.</p>
    `);
  }

  return res.send(`
    <!doctype html>
    <html>
      <head>
        <title>Exam Clearance Verification</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body{font-family:Arial,sans-serif;background:#f6f6f6;padding:30px;}
          .card{max-width:720px;margin:auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 8px 28px rgba(0,0,0,.08);}
          .ok{color:#0a7a2f;font-weight:700;}
          .bad{color:#b00020;font-weight:700;}
          h1{margin-top:0;color:#8b0000;}
          table{width:100%;border-collapse:collapse;margin-top:15px;}
          td{padding:8px;border-bottom:1px solid #eee;}
          td:first-child{font-weight:700;width:35%;}
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Exam Clearance Verification</h1>
          <p class="${payload.eligible ? "ok" : "bad"}">
            ${payload.eligible ? "VALID / CLEARED" : "NOT CLEARED"}
          </p>
          <table>
            <tr><td>Student Name</td><td>${payload.studentName || ""}</td></tr>
            <tr><td>Matric Number</td><td>${payload.matricNumber || ""}</td></tr>
            <tr><td>Session</td><td>${payload.sessionName || ""}</td></tr>
            <tr><td>Semester</td><td>${payload.semester || ""}</td></tr>
            <tr><td>Total Payable</td><td>${formatNaira(payload.totalPayable)}</td></tr>
            <tr><td>Total Paid</td><td>${formatNaira(payload.totalPaid)}</td></tr>
            <tr><td>Required Amount</td><td>${formatNaira(payload.requiredAmount)}</td></tr>
            <tr><td>Generated At</td><td>${payload.generatedAt || ""}</td></tr>
          </table>
        </div>
      </body>
    </html>
  `);
}

export async function examClearanceException(req, res) {
  req.flash?.("info", "Exam clearance exception request is not yet enabled.");
  return res.redirect("/student/exams/clearance/print");
}
