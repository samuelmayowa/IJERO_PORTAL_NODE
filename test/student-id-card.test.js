import test from "node:test";
import assert from "node:assert/strict";
import { labelledQrSvg, normaliseCardStatus, publicBaseUrl, safeFilenamePart } from "../app/services/studentIdCardService.js";
import { publicVerification } from "../app/web/controllers/studentIdCard.controller.js";

test("card status requires enabled active public and academic records", () => {
  assert.equal(normaliseCardStatus("ACTIVE", "ACTIVE", true), "ACTIVE");
  assert.equal(normaliseCardStatus("INACTIVE", "ACTIVE", true), "INACTIVE");
  assert.equal(normaliseCardStatus("ACTIVE", "GRADUATED", true), "INACTIVE");
  assert.equal(normaliseCardStatus("ACTIVE", "ACTIVE", false), "INACTIVE");
  assert.equal(normaliseCardStatus("", "ACTIVE", true), "INACTIVE");
  assert.equal(normaliseCardStatus("ACTIVE", null, true), "INACTIVE");
});

test("production verification URLs require a configured HTTPS base URL", () => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousBase = process.env.STUDENT_ID_PUBLIC_BASE_URL;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.STUDENT_ID_PUBLIC_BASE_URL;
    assert.throws(() => publicBaseUrl({ get: () => "untrusted.example", protocol: "https" }), /must be configured/);
    process.env.STUDENT_ID_PUBLIC_BASE_URL = "http://portal.example.edu";
    assert.throws(() => publicBaseUrl({ get: () => "ignored.example", protocol: "https" }), /must use HTTPS/);
    process.env.STUDENT_ID_PUBLIC_BASE_URL = "https://portal.example.edu";
    assert.equal(publicBaseUrl({ get: () => "ignored.example", protocol: "http" }), "https://portal.example.edu");
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment;
    if (previousBase === undefined) delete process.env.STUDENT_ID_PUBLIC_BASE_URL; else process.env.STUDENT_ID_PUBLIC_BASE_URL = previousBase;
  }
});

test("public verification responses prevent caching and indexing", async () => {
  const headers = {};
  let statusCode = 200;
  const req = { params: { code: "invalid" } };
  const res = {
    set(values) { Object.assign(headers, values); return this; },
    status(value) { statusCode = value; return this; },
    render(_view, locals) { assert.equal(locals.student, null); return this; },
  };
  await publicVerification(req, res, (error) => { throw error; });
  assert.equal(statusCode, 404);
  assert.match(headers["Cache-Control"], /no-store/);
  assert.match(headers["X-Robots-Tag"], /noindex/);
});

test("download filename parts are safe and retain matric identity", () => {
  assert.equal(safeFilenamePart("ND/CSC/2026/001"), "ND-CSC-2026-001");
});

test("labelled QR is an SVG carrying the URL and visible matric number", () => {
  const svg = labelledQrSvg("https://portal.example/verify/student/abc", "ND/CSC/2026/001");
  assert.match(svg, /^<svg/);
  assert.match(svg, /ND\/CSC\/2026\/001/);
  assert.ok((svg.match(/<rect /g) || []).length > 100);
});
