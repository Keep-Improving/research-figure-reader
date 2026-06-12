# Browser Figure Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browser extension request unified figure context from the backend, including HTML pages and browser-rendered PDFs, before image analysis.

**Architecture:** Add a backend `/api/browser/figure-context` route that normalizes HTML/PDF context into one structure. Add plugin page-type detection and PDF fallback metadata collection, then pass the returned caption/body evidence into `/api/analyze-image`.

**Tech Stack:** Express server, Chrome MV3 extension content/background scripts, pdfjs-dist existing PDF extraction helpers, Node test runner.

---

### Task 1: Backend Figure Context Route

**Files:**
- Modify: `app/server.js`
- Create: `app/server.test.mjs`

- [ ] Add route helpers for normalizing caption candidates and body evidence.
- [ ] Add `POST /api/browser/figure-context` with HTML and PDF branches.
- [ ] PDF branch accepts `pdf` data URL when available and reuses existing `loadPdfTextPagesFromDataUrl`, `buildPaperFigureIndex`, `findBestFigureForPage`, and `findBodyEvidence` helpers.
- [ ] HTML branch scores plugin-provided caption candidates and nearby text without pretending weak evidence is complete.
- [ ] Add minimal Node tests for PDF detection payload normalization and HTML candidate selection.

### Task 2: Extension Context Collection

**Files:**
- Modify: `extension/content.js`
- Modify: `extension/background.js`

- [ ] Add browser PDF detection for `.pdf` URLs, PDF.js viewer, embed/object PDFs, and canvas/page-layer PDF viewers.
- [ ] Add PDF data URL fetch in background script where URL is readable.
- [ ] Add `request-figure-context` background message that calls `/api/browser/figure-context`.
- [ ] Content script sends page metadata, caption candidates, page text, PDF status, current page, and image metadata.

### Task 3: Analysis Prompt Integration

**Files:**
- Modify: `extension/content.js`
- Modify: `extension/DESIGN.md`
- Modify: `PRD.md`

- [ ] Build analysis context text from backend `selectedCaption`, `bodyEvidence`, and context notes.
- [ ] Render context provenance in the plugin panel so the user can see whether caption/body evidence came from HTML, PDF text, or fallback screenshot.
- [ ] Update PRD completion status for plugin unified context and browser PDF detection.

### Task 4: Verification

**Files:**
- No production files expected.

- [ ] Run backend route tests.
- [ ] Run `npm run lint` and `npm run build` in `app`.
- [ ] Start/reuse local backend and Vite server.
- [ ] Use browser automation to open the site and check no console errors after website code changes.
- [ ] Inspect extension-facing route with curl using sample HTML payload and, if practical, a local PDF data URL.
