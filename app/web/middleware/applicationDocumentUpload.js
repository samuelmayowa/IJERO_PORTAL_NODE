import multer from "multer";
import path from "path";

const DOCUMENT_CONFIGURATION = Object.freeze({
  passport: {
    databaseType: "PASSPORT",
    label: "Passport Photograph",
    mimeTypes: new Set([
      "image/jpeg",
      "image/png",
    ]),
    extensions: new Set([
      ".jpg",
      ".jpeg",
      ".png",
    ]),
  },

  "jamb-result": {
    databaseType: "JAMB_RESULT",
    label: "JAMB Result or Registration Slip",
    mimeTypes: new Set([
      "application/pdf",
      "image/jpeg",
      "image/png",
    ]),
    extensions: new Set([
      ".pdf",
      ".jpg",
      ".jpeg",
      ".png",
    ]),
  },

  "olevel-result": {
    databaseType: "OLEVEL_RESULT",
    label: "O'Level Result",
    mimeTypes: new Set([
      "application/pdf",
      "image/jpeg",
      "image/png",
    ]),
    extensions: new Set([
      ".pdf",
      ".jpg",
      ".jpeg",
      ".png",
    ]),
  },

  "birth-certificate": {
    databaseType: "BIRTH_CERTIFICATE",
    label: "Birth Certificate or Declaration of Age",
    mimeTypes: new Set([
      "application/pdf",
      "image/jpeg",
      "image/png",
    ]),
    extensions: new Set([
      ".pdf",
      ".jpg",
      ".jpeg",
      ".png",
    ]),
  },

  "lga-identification": {
    databaseType: "LGA_IDENTIFICATION",
    label: "LGA or State Identification",
    mimeTypes: new Set([
      "application/pdf",
      "image/jpeg",
      "image/png",
    ]),
    extensions: new Set([
      ".pdf",
      ".jpg",
      ".jpeg",
      ".png",
    ]),
  },

  other: {
    databaseType: "OTHER",
    label: "Additional Supporting Document",
    mimeTypes: new Set([
      "application/pdf",
      "image/jpeg",
      "image/png",
    ]),
    extensions: new Set([
      ".pdf",
      ".jpg",
      ".jpeg",
      ".png",
    ]),
  },
});

export function getApplicationDocumentConfiguration(
  routeDocumentType,
) {
  const key = String(routeDocumentType || "")
    .trim()
    .toLowerCase();

  return DOCUMENT_CONFIGURATION[key] || null;
}

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },

  fileFilter(req, file, callback) {
    const configuration =
      getApplicationDocumentConfiguration(
        req.params.documentType,
      );

    if (!configuration) {
      return callback(
        new Error(
          "Unsupported application document type.",
        ),
      );
    }

    const extension = path
      .extname(file.originalname || "")
      .toLowerCase();

    const mimeAllowed =
      configuration.mimeTypes.has(file.mimetype);

    const extensionAllowed =
      configuration.extensions.has(extension);

    if (!mimeAllowed || !extensionAllowed) {
      const message =
        configuration.databaseType === "PASSPORT"
          ? "Passport photograph must be a JPG or PNG image."
          : "Document must be a PDF, JPG or PNG file.";

      return callback(new Error(message));
    }

    return callback(null, true);
  },
});

export function uploadApplicationDocumentFile(
  req,
  res,
  next,
) {
  upload.single("document")(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (
      error instanceof multer.MulterError &&
      error.code === "LIMIT_FILE_SIZE"
    ) {
      return res.status(400).json({
        ok: false,
        message:
          "The selected file exceeds the maximum size of 5 MB.",
      });
    }

    return res.status(400).json({
      ok: false,
      message:
        error.message ||
        "The application document could not be uploaded.",
    });
  });
}
