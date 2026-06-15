# Local Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each local user configure their own model API key, base URL, and model from the web UI without editing `.env` or exposing the project owner's key.

**Architecture:** Add a backend runtime settings store at `app/data/local-settings.json`, ignored by git, that overrides environment variables for model calls. Expose safe settings endpoints for reading masked status, saving local settings, and testing the current model configuration. Add a compact settings view in the React app so first-time users can configure and test before analyzing figures.

**Tech Stack:** Express, Node fs/promises, React, TypeScript, CSS, Node test runner.

---

### Task 1: Backend Settings Store

**Files:**
- Modify: `app/server.js`
- Modify: `app/server.test.mjs`
- Modify: `app/.gitignore`

- [ ] **Step 1: Write failing tests**

Add tests for masking API keys, merging local settings over env defaults, and persisting settings without returning the raw key.

- [ ] **Step 2: Implement settings helpers**

Add helper functions:
- `maskApiKey(apiKey)`
- `createSettingsStore(filePath)`
- `buildEffectiveModelConfig({ env, settings })`
- `buildSettingsPayload({ env, settings, settingsPath })`

- [ ] **Step 3: Wire model calls**

Change `/api/analyze-image` to call `getEffectiveModelConfig()` at request time so new settings apply without restarting the server.

- [ ] **Step 4: Add endpoints**

Add:
- `GET /api/settings`
- `POST /api/settings`
- `POST /api/settings/test`

Settings test uses the real Responses API with a tiny text prompt. It does not mock the model.

### Task 2: Web Settings UI

**Files:**
- Modify: `app/src/App.tsx`
- Modify: `app/src/App.css`

- [ ] **Step 1: Add settings types and state**

Add a `settings` view alongside `reader` and `library`, plus state for form values, masked key, save status, and test status.

- [ ] **Step 2: Add settings API calls**

Load settings when opening the settings view. Save and test via the new backend endpoints.

- [ ] **Step 3: Add compact UI**

Add a utilitarian settings panel with fields for API key, base URL, and model. Show service status and a warning that keys are saved only on this computer.

### Task 3: Docs and PRD

**Files:**
- Modify: `PRD.md`
- Modify: `app/README.md`

- [ ] **Step 1: Document the local settings UI**

Update the local shareable version instructions so users can run the app first and then fill settings in the UI.

- [ ] **Step 2: Mark PRD implementation status**

Add a status note that the first local settings UI is implemented and public multi-user deployment still requires auth, database, and privacy work.

### Task 4: Verification

**Commands:**
- `node --test server.test.mjs`
- `npm run lint`
- `npm run build`
- `node --check ../extension/background.js`
- `node --check ../extension/options.js`

**Manual browser check:**
- Open `http://127.0.0.1:5173/`
- Click Settings
- Confirm current config loads
- Save a non-secret model/base URL change or existing values
- Test connection only against the real configured backend
