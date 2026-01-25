import express from "express";
import {
  reportsHome,

  viewMasterMarkSheet,
  apiMasterMarkSheet,
  exportMasterMarkSheetCsv,
  exportMasterMarkSheetExcel,
  printMasterMarkSheet,

  viewSemesterResult,
  apiSemesterResult,
  exportSemesterResultCsv,
  exportSemesterResultExcel,
  printSemesterResult,

  viewGraduatingList,
  apiGraduatingList,
  exportGraduatingListCsv,
  exportGraduatingListExcel,
  printGraduatingList,
} from "../../controllers/results-reports.controller.js";

const router = express.Router();

router.get("/", reportsHome);

// A) Master Mark Sheet
router.get("/master-mark-sheet", viewMasterMarkSheet);
router.get("/master-mark-sheet/api", apiMasterMarkSheet);
router.get("/master-mark-sheet/export.csv", exportMasterMarkSheetCsv);
router.get("/master-mark-sheet/export.xlsx", exportMasterMarkSheetExcel);
router.get("/master-mark-sheet/print", printMasterMarkSheet);

// B) Semester Result
router.get("/semester-result", viewSemesterResult);
router.get("/semester-result/api", apiSemesterResult);
router.get("/semester-result/export.csv", exportSemesterResultCsv);
router.get("/semester-result/export.xlsx", exportSemesterResultExcel);
router.get("/semester-result/print", printSemesterResult);

// C) Graduating List
router.get("/graduating-list", viewGraduatingList);
router.get("/graduating-list/api", apiGraduatingList);
router.get("/graduating-list/export.csv", exportGraduatingListCsv);
router.get("/graduating-list/export.xlsx", exportGraduatingListExcel);
router.get("/graduating-list/print", printGraduatingList);

export default router;
