import { Router } from 'express';
import * as applicant from '../controllers/applicant.controller.js';
import * as applicantSubmission from "../controllers/applicantSubmission.controller.js";
import { requireApplicant } from '../controllers/auth.controller.js';
import {
  uploadApplicationDocumentFile,
} from "../middleware/applicationDocumentUpload.js";

const router = Router();

// Every route below requires an authenticated applicant session.
router.use(requireApplicant);

// Dashboard
router.get('/dashboard', applicant.dashboard);

// Dynamic application details
router.get('/applications/:slug', applicant.applicationDetails);
router.post(
  '/applications/:slug/verify-prerequisite',
  applicant.verifyApplicationPrerequisite
);

router.post(
  '/applications/:slug/start',
  applicant.startApplication
);

router.get(
  '/applications/:slug/form',
  applicant.applicationForm
);

router.get(
  '/applications/:slug/preview',
  applicant.applicationPreview
);

router.post(
  "/applications/:slug/submit",
  applicantSubmission.submitApplication,
);

router.post(
  '/applications/:slug/form',
  applicant.saveApplicationForm
);

router.post(
  "/applications/:applicationId/documents/:documentType",
  uploadApplicationDocumentFile,
  applicant.uploadApplicationDocument,
);

router.get(
  "/applications/:applicationId/documents/:documentId/download",
  applicant.downloadApplicationDocument,
);

router.get(
  "/applications/:applicationId/print",
  applicantSubmission.printApplication,
);





// Applicant application and payment navigation
router.get(
  '/application/return',
  applicant.returnToApplication
);

router.get(
  '/payments/history',
  applicant.paymentHistory
);

router.get(
  '/payments/other',
  applicant.otherPayment
);


router.get(
  '/payments/acceptance',
  applicant.acceptanceFee
);

router.post(
  '/payments/acceptance/:applicationId/start',
  applicant.startAcceptanceFee
);


router.get(
  '/result/check',
  applicant.checkResult
);

router.get(
  '/result/check/:applicationId',
  applicant.checkResultDetail
);

router.get(
  '/exam-date/view',
  applicant.examDateView
);

router.get(
  '/exam-date/view/:applicationId',
  applicant.examDateDetail
);

// Uniform Measurement
router.get('/uniform', applicant.uniformForm);
router.post('/uniform', applicant.saveUniform);
router.get('/uniform/print', applicant.uniformPrint);


export default router;
