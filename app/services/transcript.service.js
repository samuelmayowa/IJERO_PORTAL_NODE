
import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'; // install pdf-lib
import { pool } from '../core/db.js';
import { fetchStudentByMatric, fetchResults } from './results.service.js';

export async function generateTranscriptPDF({ matric, outDir }){
  const student = await fetchStudentByMatric(matric);
  const results = await fetchResults(matric);

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const { width, height } = page.getSize();

  let y = height - 50;
  page.drawText('Academic Transcript', { x: 50, y, size: 18, font, color: rgb(0,0,0) }); y -= 24;
  if(student){
    page.drawText(`Name: ${student.lastName || ''} ${student.firstName || ''}`.trim(), { x: 50, y, size: 12, font }); y -= 16;
    page.drawText(`Matric: ${student.matricNumber || matric}`, { x: 50, y, size: 12, font }); y -= 16;
    page.drawText(`Department: ${student.department || ''}`, { x: 50, y, size: 12, font }); y -= 24;
  }

  page.drawText('Session  Semester   Code     Units  Grade  Score  Remark', { x: 50, y, size: 10, font }); y -= 14;
  for(const r of results.slice(0, 40)){ // naive pagination
    const line = `${r.session||''}   ${r.semester||''}   ${r.course_code||''}   ${r.units||''}   ${r.grade||''}   ${r.score||''}   ${r.remark||''}`;
    page.drawText(line, { x: 50, y, size: 10, font }); y -= 12;
    if (y < 60){ y = height - 50; pdfDoc.addPage(); }
  }

  const bytes = await pdfDoc.save();
  const fileName = `transcript_${matric.replace(/[^A-Za-z0-9_-]/g,'_')}.pdf`;
  const absDir = path.resolve(outDir);
  fs.mkdirSync(absDir, { recursive: true });
  const outPath = path.join(absDir, fileName);
  fs.writeFileSync(outPath, bytes);
  return outPath;
}
