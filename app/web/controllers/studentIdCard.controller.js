import XLSX from "xlsx";
import path from "node:path";
import {
  cardQrDataUrl,
  exportRows,
  getStudentCardByCode,
  getStudentCardById,
  institutionDetails,
  labelledQrSvg,
  listStudentCards,
  safeFilenamePart,
  verificationUrl,
} from "../../services/studentIdCardService.js";

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function studentPhotoUrl(student, url) {
  if (student?.photo_path) return `/public${String(student.photo_path).replace(/^\/public/, "")}`;
  return student?.application_photo_path ? `${url}/photo` : "/public/img/avatar.png";
}

export async function publicVerification(req, res, next) {
  try {
    res.set({ "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow, noarchive" });
    const student = await getStudentCardByCode(req.params.code);
    if (!student) return res.status(404).render("pages/student-id-verification", { layout: false, title: "Student ID Verification", student: null, ...institutionDetails() });
    const url = verificationUrl(req, student.public_code);
    return res.render("pages/student-id-verification", { layout: false, title: "Student ID Verification", student, photoUrl: studentPhotoUrl(student, url), ...institutionDetails() });
  } catch (error) { return next(error); }
}

export async function publicPhoto(req, res, next) {
  try {
    const student = await getStudentCardByCode(req.params.code);
    if (!student?.application_photo_path || student.photo_path) return res.status(404).send("Student photograph not found.");
    const root = path.resolve("app/uploads/applications");
    const file = path.resolve(student.application_photo_path);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) return res.status(403).send("Photograph path is not permitted.");
    res.set({ "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow, noarchive" });
    return res.sendFile(file);
  } catch (error) { return next(error); }
}

export async function adminList(req, res, next) {
  try {
    const page = positiveInt(req.query.page, 1);
    const pageSize = 50;
    const search = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim().toUpperCase();
    const { rows, total } = await listStudentCards({ search, status, limit: pageSize, offset: (page - 1) * pageSize });
    return res.render("pages/staff/student-id-cards", { layout: "layouts/adminlte", title: "Student ID Cards", pageTitle: "Student ID Cards", rows, total, page, pages: Math.max(1, Math.ceil(total / pageSize)), q: search, status });
  } catch (error) { return next(error); }
}

export async function adminCard(req, res, next) {
  try {
    const student = await getStudentCardById(req.params.id);
    if (!student) return res.status(404).send("Student ID card not found.");
    const url = verificationUrl(req, student.public_code);
    const qrDataUrl = await cardQrDataUrl(url);
    return res.render("pages/staff/student-id-card-detail", { layout: "layouts/adminlte", title: "Student ID Card", pageTitle: "Student ID Card", student, verificationUrl: url, photoUrl: studentPhotoUrl(student, url), qrDataUrl, ...institutionDetails() });
  } catch (error) { return next(error); }
}

export async function downloadQr(req, res, next) {
  try {
    const student = await getStudentCardById(req.params.id);
    if (!student) return res.status(404).send("Student ID card not found.");
    const svg = labelledQrSvg(verificationUrl(req, student.public_code), student.matric_number);
    const filename = `IDCARD_${safeFilenamePart(student.matric_number)}_QR.svg`;
    res.set({ "Content-Type": "image/svg+xml; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" });
    return res.send(svg);
  } catch (error) { return next(error); }
}

export async function exportExcel(req, res, next) {
  try {
    const search = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim().toUpperCase();
    const { allRows } = await listStudentCards({ search, status, limit: null, offset: 0 });
    const worksheet = XLSX.utils.json_to_sheet(exportRows(req, allRows));
    worksheet["!cols"] = [6, 22, 32, 28, 28, 30, 12, 15, 12, 58, 36].map((wch) => ({ wch }));
    worksheet["!autofilter"] = { ref: worksheet["!ref"] || "A1:K1" };
    worksheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Student ID Cards");
    workbook.Props = { Title: "Student ID Card QR Register", Subject: "Student verification URLs and QR filenames", Author: institutionDetails().schoolName, CreatedDate: new Date() };
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
    res.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=student-id-card-qr-register.xlsx", "Cache-Control": "private, no-store" });
    return res.send(buffer);
  } catch (error) { return next(error); }
}
