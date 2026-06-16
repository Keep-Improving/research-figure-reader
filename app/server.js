import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const app = express()
const port = Number(process.env.PORT || 8787)
const dataDir = path.resolve('data')
const analysisStorePath = process.env.ANALYSIS_STORE_PATH || path.join(dataDir, 'analysis-store.json')
const settingsStorePath = process.env.LOCAL_SETTINGS_PATH || path.join(dataDir, 'local-settings.json')

app.use(cors())
app.use(express.json({ limit: '80mb' }))

function buildHealthPayload({
  model,
  baseUrl,
  hasApiKey,
  analysisStorePath,
}) {
  return {
    ok: true,
    service: 'research-figure-reader-api',
    model,
    baseUrl,
    hasApiKey,
    analysisStore: analysisStorePath ? 'json-file' : 'memory',
  }
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function normalizeSettings(settings = {}) {
  const normalized = {}
  if (typeof settings.apiKey === 'string') normalized.apiKey = settings.apiKey.trim()
  if (typeof settings.baseUrl === 'string') normalized.baseUrl = normalizeBaseUrl(settings.baseUrl)
  if (typeof settings.model === 'string') normalized.model = settings.model.trim()
  return normalized
}

function maskApiKey(apiKey) {
  const value = String(apiKey || '').trim()
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 3)}...${value.slice(-4)}`
}

function buildEffectiveModelConfig({
  env = process.env,
  settings = {},
} = {}) {
  const normalizedSettings = normalizeSettings(settings)
  const apiKey = normalizedSettings.apiKey || env.OPENAI_API_KEY || ''
  const baseUrl = normalizeBaseUrl(
    normalizedSettings.baseUrl || env.OPENAI_BASE_URL || 'https://api.openai.com',
  )
  const model = normalizedSettings.model || env.OPENAI_MODEL || 'gpt-5.4'

  return {
    apiKey,
    baseUrl,
    model,
    source: normalizedSettings.apiKey || normalizedSettings.baseUrl || normalizedSettings.model
      ? 'local-settings'
      : 'environment',
  }
}

function buildSettingsPayload({
  env = process.env,
  settings = {},
  settingsPath = settingsStorePath,
} = {}) {
  const config = buildEffectiveModelConfig({ env, settings })
  return {
    ok: true,
    apiKeyConfigured: Boolean(config.apiKey),
    apiKeyMasked: maskApiKey(config.apiKey),
    baseUrl: config.baseUrl,
    model: config.model,
    source: config.source,
    settingsStore: settingsPath ? 'json-file' : 'memory',
  }
}

function buildModelEndpoint({ baseUrl, model, purpose = 'image-analysis' }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl || 'https://api.openai.com')
  const lowerBaseUrl = normalizedBaseUrl.toLowerCase()
  if (lowerBaseUrl.includes('generativelanguage.googleapis.com') || lowerBaseUrl.includes('gemini')) {
    const base = lowerBaseUrl.includes(':generatecontent')
      ? normalizedBaseUrl
      : `${normalizedBaseUrl}/v1beta/models/${encodeURIComponent(model || 'gemini-2.5-flash')}:generateContent`
    return { mode: 'gemini-generate-content', url: base }
  }

  if (lowerBaseUrl.includes('api.anthropic.com') || lowerBaseUrl.includes('anthropic')) {
    const url = lowerBaseUrl.endsWith('/v1/messages') ? normalizedBaseUrl : `${normalizedBaseUrl}/v1/messages`
    return { mode: 'claude-messages', url }
  }

  const isChatCompletionsProvider =
    lowerBaseUrl.includes('api.deepseek.com') ||
    lowerBaseUrl.includes('dashscope') ||
    lowerBaseUrl.includes('aliyuncs.com') ||
    lowerBaseUrl.includes('bigmodel.cn') ||
    lowerBaseUrl.includes('api.z.ai') ||
    lowerBaseUrl.includes('openrouter.ai') ||
    lowerBaseUrl.includes('siliconflow') ||
    lowerBaseUrl.endsWith('/chat/completions') ||
    lowerBaseUrl.endsWith('/v1/chat/completions')

  if (isChatCompletionsProvider) {
    const url = lowerBaseUrl.endsWith('/chat/completions') || lowerBaseUrl.endsWith('/v1/chat/completions')
      ? normalizedBaseUrl
      : `${normalizedBaseUrl}/chat/completions`
    return { mode: 'chat-completions', url }
  }

  return { mode: 'responses', url: `${normalizedBaseUrl}/v1/responses` }
}

function getFigureAnalysisSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['answer', 'sources', 'uncertainty', 'annotations'],
    properties: {
      answer: { type: 'string' },
      sources: { type: 'array', items: { type: 'string' } },
      uncertainty: { type: 'string' },
      annotations: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'label',
            'what',
            'howToRead',
            'meaning',
            'bbox',
            'confidence',
            'evidenceType',
          ],
          properties: {
            label: { type: 'string' },
            what: { type: 'string' },
            howToRead: { type: 'string' },
            meaning: { type: 'string' },
            bbox: {
              type: 'object',
              additionalProperties: false,
              required: ['x', 'y', 'width', 'height'],
              properties: {
                x: { type: 'number', minimum: 0, maximum: 1000 },
                y: { type: 'number', minimum: 0, maximum: 1000 },
                width: { type: 'number', minimum: 1, maximum: 1000 },
                height: { type: 'number', minimum: 1, maximum: 1000 },
              },
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidenceType: {
              type: 'string',
              enum: ['visible', 'caption', 'body', 'inference', 'uncertain'],
            },
          },
        },
      },
    },
  }
}

function buildModelRequest({
  mode,
  model,
  prompt,
  image,
  structured = false,
}) {
  const dataUrlMatch = typeof image === 'string'
    ? image.match(/^data:([^;,]+);base64,(.+)$/)
    : null
  const imageMimeType = dataUrlMatch?.[1] || 'image/png'
  const imageBase64 = dataUrlMatch?.[2] || image

  if (mode === 'gemini-generate-content') {
    const request = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: imageMimeType,
                data: imageBase64,
              },
            },
          ],
        },
      ],
    }
    if (structured) request.generationConfig = { responseMimeType: 'application/json' }
    return request
  }

  if (mode === 'claude-messages') {
    return {
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: imageMimeType,
                data: imageBase64,
              },
            },
          ],
        },
      ],
    }
  }

  if (mode === 'chat-completions') {
    const request = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
    }
    if (structured) request.response_format = { type: 'json_object' }
    return request
  }

  const request = {
    model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: image },
        ],
      },
    ],
  }

  if (structured) {
    request.text = {
      format: {
        type: 'json_schema',
        name: 'figure_analysis',
        schema: getFigureAnalysisSchema(),
        strict: true,
      },
    }
  }

  return request
}

function buildModelHeaders({ mode, apiKey }) {
  if (mode === 'gemini-generate-content') {
    return {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    }
  }

  if (mode === 'claude-messages') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

function createSettingsStore(filePath = null) {
  let memorySettings = {}

  async function read() {
    if (!filePath) return { ...memorySettings }

    try {
      const raw = await fs.readFile(filePath, 'utf8')
      return normalizeSettings(JSON.parse(raw.replace(/^\uFEFF/, '')))
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      throw error
    }
  }

  async function save(settings) {
    const current = await read()
    const incoming = normalizeSettings(settings)
    const next = {
      ...current,
      ...Object.fromEntries(
        Object.entries(incoming).filter(([, value]) => typeof value === 'string' && value.length > 0),
      ),
    }

    if (!filePath) {
      memorySettings = next
      return { ...memorySettings }
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
  }

  return { read, save }
}

function sendJsonError(res, status, message, extra = {}) {
  return res.status(status).json({
    error: message,
    ...extra,
  })
}

function formatNetworkError(error, endpointBaseUrl = 'model endpoint') {
  if (!(error instanceof Error)) {
    return `Model request failed: ${endpointBaseUrl}`
  }

  const causeMessage =
    typeof error.cause === 'object' && error.cause && 'message' in error.cause
      ? String(error.cause.message)
      : ''

  if (causeMessage.includes('Connect Timeout') || causeMessage.includes('ETIMEDOUT')) {
    return `Connection to model endpoint timed out: ${endpointBaseUrl}`
  }

  return causeMessage || error.message || `Model request failed: ${endpointBaseUrl}`
}

function extractOutputPayload(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text
  }

  const contentItems = payload?.output?.flatMap((item) => item?.content ?? []) ?? []
  const messageText = contentItems.find(
    (content) => content?.type === 'output_text' && typeof content.text === 'string',
  )?.text
  if (typeof messageText === 'string' && messageText.trim()) {
    return messageText
  }

  const parsed = contentItems.find((content) => content?.parsed)?.parsed
  if (parsed && typeof parsed === 'object') {
    return parsed
  }

  const json = contentItems.find((content) => content?.json)?.json
  if (json && typeof json === 'object') {
    return json
  }

  const choiceMessageContent = payload?.choices?.[0]?.message?.content
  if (typeof choiceMessageContent === 'string' && choiceMessageContent.trim()) {
    return choiceMessageContent
  }
  if (Array.isArray(choiceMessageContent)) {
    const textContent = choiceMessageContent.find(
      (content) => content?.type === 'text' && typeof content.text === 'string',
    )?.text
    if (typeof textContent === 'string' && textContent.trim()) return textContent
  }

  const geminiText = payload?.candidates?.[0]?.content?.parts?.find(
    (part) => typeof part?.text === 'string',
  )?.text
  if (typeof geminiText === 'string' && geminiText.trim()) return geminiText

  const claudeText = payload?.content?.find(
    (content) => content?.type === 'text' && typeof content.text === 'string',
  )?.text
  if (typeof claudeText === 'string' && claudeText.trim()) return claudeText

  return null
}

function parseModelJson(output) {
  if (output && typeof output === 'object') return output
  if (typeof output !== 'string') return null

  const cleaned = output
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')

  try {
    return JSON.parse(cleaned)
  } catch {
    const jsonObjectText = extractFirstJsonObject(cleaned)
    if (jsonObjectText) {
      return JSON.parse(jsonObjectText)
    }
    throw new Error('Model returned text that is not valid JSON.')
  }
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return text.slice(start, index + 1)
      }
    }
  }

  return null
}

function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
}

function normalizeFigureLabel(label) {
  const match = String(label ?? '').match(/^(\d+)/)
  return match?.[1] ?? null
}

function extractFigureReferenceText(text, figureNumber) {
  if (!figureNumber) return []
  const normalized = String(text ?? '')
  const pattern = new RegExp(`\\b(?:Figure|Fig\\.?)\\s*${figureNumber}[A-Za-z]?\\b`, 'gi')
  return [...new Set([...normalized.matchAll(pattern)].map((match) => match[0]))]
}

function inferFigureLabelFromText(text) {
  const captionStart = getCaptionStart(text)
  if (captionStart?.figureNumber) return captionStart.figureNumber
  return getFigureMentions(text)[0]?.figureNumber ?? null
}

function normalizeBrowserCaptionCandidate(candidate) {
  const text = normalizeWhitespace(candidate?.text)
  if (!text) return null

  const source = String(candidate?.source || 'nearby-text')
  const sourceScore =
    source === 'site-adapter'
      ? 0.9
      : source === 'html-figcaption'
        ? 0.82
        : source === 'nearby-text'
          ? 0.48
          : source === 'alt'
            ? 0.28
            : 0.35
  const confidence = Number.isFinite(Number(candidate?.confidence))
    ? Number(candidate.confidence)
    : sourceScore
  const isComplete =
    typeof candidate?.isComplete === 'boolean'
      ? candidate.isComplete
      : /^(?:Figure|Fig\.?|FIG\.?)\s*\d+/i.test(text) && text.length > 80
  const figureLabel = inferFigureLabelFromText(text)

  return {
    text,
    source,
    confidence: Math.max(0, Math.min(1, confidence)),
    isComplete,
    evidence: Array.isArray(candidate?.evidence) ? candidate.evidence.map(normalizeWhitespace) : [],
    figureLabel,
    score:
      Math.max(0, Math.min(1, confidence)) * 100 +
      (isComplete ? 25 : 0) +
      (figureLabel ? 20 : 0) +
      Math.min(text.length / 80, 20),
  }
}

function normalizeBrowserBodyEvidence(text, figureNumber, source = 'html-body') {
  const normalized = normalizeWhitespace(text).slice(0, 1600)
  if (!normalized) return null

  const directReferences = extractFigureReferenceText(normalized, figureNumber)
  return {
    text: normalized,
    source,
    confidence: directReferences.length > 0 ? 0.82 : 0.36,
    directReferences,
  }
}

function buildBrowserFigureContextFromHtmlPayload(payload = {}) {
  const captionCandidates = (Array.isArray(payload.captionCandidates) ? payload.captionCandidates : [])
    .map(normalizeBrowserCaptionCandidate)
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)

  const selectedCaption = captionCandidates[0]?.text ?? ''
  const figureLabel =
    captionCandidates.find((candidate) => candidate.figureLabel)?.figureLabel ??
    inferFigureLabelFromText(payload.figureLabel) ??
    null
  const bodyEvidence = [
    normalizeBrowserBodyEvidence(payload.nearbyBodyText, figureLabel),
    normalizeBrowserBodyEvidence(payload.pageText, figureLabel),
  ].filter(Boolean)

  return {
    sourceType: 'html',
    documentId: payload.documentId ?? null,
    pageUrl: payload.pageUrl ?? '',
    title: payload.title ?? '',
    figureLabel,
    selectedCaption,
    captionCandidates: captionCandidates.slice(0, 5),
    captionSource: captionCandidates[0]?.source ?? 'none',
    captionConfidence: captionCandidates[0]?.confidence ?? 0,
    captionIsComplete: Boolean(captionCandidates[0]?.isComplete),
    bodyEvidence: bodyEvidence.slice(0, 5),
    note:
      selectedCaption.length > 0
        ? '已从网页 DOM 候选中选择最可信的图注。'
        : '未从网页 DOM 中找到可靠图注。',
  }
}

function buildBrowserPdfFallbackContext(payload = {}) {
  return {
    sourceType: 'pdf-fallback',
    documentId: payload.documentId ?? null,
    pageUrl: payload.pageUrl ?? '',
    title: payload.title ?? '',
    currentPage: Number(payload.currentPage) || null,
    figureLabel: null,
    selectedCaption: '',
    captionCandidates: [],
    captionSource: 'none',
    captionConfidence: 0,
    captionIsComplete: false,
    bodyEvidence: [],
    note: '未读取到 PDF 文本层，当前只能使用截图和用户选区作为图像依据。',
  }
}

function buildBrowserFigureContextFromPdfPages(pages, payload = {}) {
  const pageNumber = Number(payload.currentPage) || 1
  const index = buildPaperFigureIndex(pages)
  const currentFigure =
    (payload.figureLabel &&
      index.find((entry) => entry.figureLabel === normalizeFigureLabel(payload.figureLabel))) ||
    findBestFigureForPage(index, pageNumber)

  if (!currentFigure) {
    return {
      ...buildBrowserPdfFallbackContext(payload),
      sourceType: 'pdf',
      currentPage: pageNumber,
      note: '已读取 PDF 文本层，但没有识别到当前页对应的主图图注。',
    }
  }

  return {
    sourceType: 'pdf',
    documentId: payload.documentId ?? null,
    pageUrl: payload.pageUrl ?? '',
    title: payload.title ?? '',
    currentPage: pageNumber,
    figureLabel: currentFigure.figureLabel,
    selectedCaption: currentFigure.captionCandidates[0]?.text ?? '',
    captionCandidates: currentFigure.captionCandidates.map((candidate) => ({
      ...candidate,
      source: 'pdf-caption',
      confidence: Math.max(0, Math.min(1, (candidate.score ?? 0) / 100)),
      isComplete: true,
    })),
    captionSource: currentFigure.captionCandidates[0] ? 'pdf-caption' : 'none',
    captionConfidence: currentFigure.captionCandidates[0]
      ? Math.max(0, Math.min(1, (currentFigure.captionCandidates[0].score ?? 0) / 100))
      : 0,
    captionIsComplete: Boolean(currentFigure.captionCandidates[0]),
    bodyEvidence: currentFigure.bodyEvidence.map((evidence) => ({
      ...evidence,
      source: 'pdf-body',
      confidence: evidence.directReferences?.length > 0 ? 0.86 : 0.5,
    })),
    note: '已复用网站 PDF 全文解析管线匹配图注和正文引用。',
  }
}

function createAnalysisStore(filePath = null) {
  const memoryRecords = []

  async function readRecords() {
    if (!filePath) return memoryRecords
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed.records) ? parsed.records : []
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  async function writeRecords(records) {
    if (!filePath) {
      memoryRecords.splice(0, memoryRecords.length, ...records)
      return
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, `${JSON.stringify({ records }, null, 2)}\n`, 'utf8')
  }

  function normalizePaperSnapshot(input = {}) {
    return {
      title: input.title || '',
      doi: input.doi || '',
      pmid: input.pmid || '',
      pmcid: input.pmcid || '',
      arxivId: input.arxivId || '',
      sourceUrl: input.sourceUrl || '',
      pdfHash: input.pdfHash || '',
      pdfDataUrl: input.pdfDataUrl || '',
      journal: input.journal || '',
      year: input.year || '',
    }
  }

  function normalizeFigureSnapshot(input = {}) {
    return {
      figureLabel: input.figureLabel || '',
      captionText: input.captionText || '',
      captionSource: input.captionSource || '',
      pageNumber: Number.isFinite(Number(input.pageNumber)) ? Number(input.pageNumber) : null,
      imageUrl: input.imageUrl || '',
      imageFingerprint: input.imageFingerprint || '',
      thumbnailDataUrl: input.thumbnailDataUrl || '',
      imageDataUrl: input.imageDataUrl || '',
      locator: {
        source: input.locator?.source || 'web-app-image',
        pageUrl: input.locator?.pageUrl || '',
        pdfPage: Number.isFinite(Number(input.locator?.pdfPage)) ? Number(input.locator.pdfPage) : null,
        imageCssSelector: input.locator?.imageCssSelector || '',
        imageUrl: input.locator?.imageUrl || '',
        scrollY: Number.isFinite(Number(input.locator?.scrollY)) ? Number(input.locator.scrollY) : null,
        bboxOnPage: input.locator?.bboxOnPage || null,
      },
    }
  }

  return {
    async create(input = {}) {
      const records = await readRecords()
      const now = new Date().toISOString()
      const version =
        records.filter(
          (record) =>
            record.documentId === input.documentId &&
            record.figureId === input.figureId &&
            record.imageFingerprint === input.imageFingerprint,
        ).length + 1
      const record = {
        id: `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        documentId: input.documentId || null,
        figureId: input.figureId || null,
        imageFingerprint: input.imageFingerprint || null,
        imageUrl: input.imageUrl || null,
        paper: normalizePaperSnapshot(input.paper),
        figure: normalizeFigureSnapshot(input.figure),
        pageUrl: input.pageUrl || '',
        source: input.source || 'web-app',
        model: input.model || process.env.OPENAI_MODEL || 'gpt-5.4',
        answer: input.answer || '',
        uncertainty: input.uncertainty || '',
        sources: Array.isArray(input.sources) ? input.sources : [],
        annotations: Array.isArray(input.annotations) ? input.annotations : [],
        context: input.context || null,
        version,
        createdAt: now,
        updatedAt: now,
      }
      records.push(record)
      await writeRecords(records)
      return record
    },

    async lookup(query = {}) {
      const records = await readRecords()
      return (
        records
          .filter((record) => {
            if (query.documentId && record.documentId !== query.documentId) return false
            if (query.figureId && record.figureId !== query.figureId) return false
            if (query.imageFingerprint && record.imageFingerprint !== query.imageFingerprint) return false
            return true
          })
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null
      )
    },

    async list(query = {}) {
      const records = await readRecords()
      return records
        .filter((record) => {
          if (query.documentId && record.documentId !== query.documentId) return false
          if (query.figureId && record.figureId !== query.figureId) return false
          return true
        })
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    },

    async get(id) {
      const records = await readRecords()
      return records.find((record) => record.id === id) || null
    },

    async delete(id) {
      const records = await readRecords()
      const index = records.findIndex((record) => record.id === id)
      if (index < 0) return null
      const [deleted] = records.splice(index, 1)
      await writeRecords(records)
      return deleted
    },
  }
}

const analysisStore = createAnalysisStore(analysisStorePath)
const settingsStore = createSettingsStore(settingsStorePath)

async function getEffectiveModelConfig() {
  const settings = await settingsStore.read()
  return buildEffectiveModelConfig({ env: process.env, settings })
}

app.get('/api/health', async (_req, res) => {
  const config = await getEffectiveModelConfig()
  return res.json(
    buildHealthPayload({
      model: config.model,
      baseUrl: config.baseUrl,
      hasApiKey: Boolean(config.apiKey),
      analysisStorePath,
    }),
  )
})

app.get('/api/settings', async (_req, res) => {
  try {
    const settings = await settingsStore.read()
    return res.json(buildSettingsPayload({ env: process.env, settings, settingsPath: settingsStorePath }))
  } catch (error) {
    return sendJsonError(
      res,
      500,
      error instanceof Error ? error.message : 'Failed to read settings.',
    )
  }
})

app.post('/api/settings', async (req, res) => {
  try {
    const saved = await settingsStore.save(req.body ?? {})
    return res.json(buildSettingsPayload({ env: process.env, settings: saved, settingsPath: settingsStorePath }))
  } catch (error) {
    return sendJsonError(
      res,
      500,
      error instanceof Error ? error.message : 'Failed to save settings.',
    )
  }
})

app.post('/api/settings/test', async (_req, res) => {
  const config = await getEffectiveModelConfig()
  if (!config.apiKey) {
    return sendJsonError(res, 503, 'API key is not configured.')
  }

  try {
    const endpoint = buildModelEndpoint({ baseUrl: config.baseUrl, model: config.model, purpose: 'settings-test' })
    const body = endpoint.mode === 'gemini-generate-content'
      ? {
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Reply with OK.' }],
            },
          ],
        }
      : endpoint.mode === 'claude-messages'
        ? {
            model: config.model,
            max_tokens: 128,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
          }
        : endpoint.mode === 'chat-completions'
      ? {
          model: config.model,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
          stream: false,
        }
      : {
          model: config.model,
          input: 'Reply with OK.',
        }

    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: buildModelHeaders({ mode: endpoint.mode, apiKey: config.apiKey }),
      body: JSON.stringify(body),
    })

    const responseText = await response.text()
    let payload = null
    try {
      payload = responseText ? JSON.parse(responseText) : null
    } catch {
      payload = null
    }

    if (!response.ok) {
      return sendJsonError(
        res,
        response.status,
        payload?.error?.message || responseText?.slice(0, 500) || 'Settings test failed.',
      )
    }

    return res.json({
      ok: true,
      model: config.model,
      baseUrl: config.baseUrl,
      endpointMode: endpoint.mode,
      message: 'Settings test succeeded.',
    })
  } catch (error) {
    return sendJsonError(res, 502, formatNetworkError(error, config.baseUrl))
  }
})

function getCaptionStart(lineText) {
  const normalized = normalizeWhitespace(lineText)
  if (/^(?:supplementary|extended data)\s+(?:figure|fig\.?)/i.test(normalized)) {
    return null
  }

  const match = normalized.match(/^(?:Figure|Fig\.?|FIG\.?)\s*(\d+[A-Za-z]?)\s*(?:[|.:)]|\s\|)\s*(.+)?$/i)
  if (!match) return null

  return {
    figureLabel: match[1],
    figureNumber: normalizeFigureLabel(match[1]),
  }
}

function getFigureMentions(text) {
  const normalized = String(text ?? '')
  return [...normalized.matchAll(/\b(?:(Supplementary|Extended Data)\s+)?(?:Figure|Fig\.?|FIG\.?)\s*(\d+[A-Za-z]?)\b/g)]
    .map((match) => ({
      label: match[2],
      figureNumber: normalizeFigureLabel(match[2]),
      index: match.index ?? 0,
      isSupplementary: Boolean(match[1]),
    }))
    .filter((match) => !match.isSupplementary)
}

function splitRowIntoSegments(sortedItems, pageWidth) {
  const segments = []
  let current = []
  const columnBoundary = pageWidth / 2

  for (const item of sortedItems) {
    const previous = current[current.length - 1]
    const gap = previous ? item.x - (previous.x + previous.width) : 0
    const isLargeColumnGap = gap > Math.max(28, pageWidth * 0.08)
    const crossesPageMiddle =
      previous && previous.x < pageWidth / 2 && item.x >= pageWidth / 2
    const crossesColumnBoundary =
      previous &&
      previous.x + previous.width < columnBoundary &&
      item.x > columnBoundary &&
      previous.x + previous.width >= columnBoundary - Math.max(56, pageWidth * 0.08)

    if (previous && (isLargeColumnGap || crossesPageMiddle || crossesColumnBoundary)) {
      segments.push(current)
      current = [item]
    } else {
      current.push(item)
    }
  }

  if (current.length > 0) {
    segments.push(current)
  }

  return segments
}

function buildPageLines(items, pageWidth) {
  const rows = []

  for (const item of items) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 2.8)
    if (row) {
      row.items.push(item)
      row.y = (row.y * (row.items.length - 1) + item.y) / row.items.length
    } else {
      rows.push({ y: item.y, items: [item] })
    }
  }

  return rows
    .flatMap((row) => {
      const sortedItems = [...row.items].sort((a, b) => a.x - b.x)
      return splitRowIntoSegments(sortedItems, pageWidth).map((segmentItems) => {
        const text = normalizeWhitespace(segmentItems.map((item) => item.str).join(' '))
        const xMin = Math.min(...segmentItems.map((item) => item.x))
        const xMax = Math.max(...segmentItems.map((item) => item.x + item.width))
        const height = Math.max(...segmentItems.map((item) => item.height), 0)

        return {
          id: `${Math.round(row.y * 10)}:${Math.round(xMin * 10)}:${text.slice(0, 24)}`,
          text,
          x: xMin,
          xMax,
          y: row.y,
          height,
        }
      })
    })
    .filter((line) => line.text)
    .sort((a, b) => b.y - a.y || a.x - b.x)
}

function groupLinesIntoBlocks(lines, page) {
  const sorted = [...lines].sort((a, b) => {
    const columnDiff = lineColumn(a, page) - lineColumn(b, page)
    if (columnDiff !== 0) return columnDiff
    return b.y - a.y || a.x - b.x
  })

  const blocks = []
  let current = []

  for (const line of sorted) {
    const previous = current[current.length - 1]
    const sameColumn = !previous || lineColumn(previous, page) === lineColumn(line, page)
    const verticalGap = previous ? previous.y - line.y : 0
    const allowedGap = previous
      ? Math.max(previous.height, line.height) * 2.2 + 10
      : 0
    const indentShift = previous ? Math.abs(previous.x - line.x) : 0
    const shouldContinue =
      previous &&
      sameColumn &&
      verticalGap >= 0 &&
      verticalGap <= allowedGap &&
      indentShift <= Math.max(page.width * 0.08, 48)

    if (!shouldContinue && current.length > 0) {
      blocks.push(current)
      current = []
    }

    current.push(line)
  }

  if (current.length > 0) {
    blocks.push(current)
  }

  return blocks.map((blockLines) => ({
    lines: blockLines,
    text: normalizeWhitespace(blockLines.map((line) => line.text).join(' ')),
    topY: blockLines[0].y,
    bottomY: blockLines[blockLines.length - 1].y,
    column: lineColumn(blockLines[0], page),
  }))
}

function detectPageLayout(page) {
  const contentLines = page.lines.filter((line) => !looksLikeFooter(line, page))
  const leftCount = contentLines.filter((line) => lineColumn(line, page) === 0).length
  const rightCount = contentLines.filter((line) => lineColumn(line, page) === 1).length
  const balancedColumns =
    leftCount >= 12 &&
    rightCount >= 12 &&
    Math.min(leftCount, rightCount) / Math.max(leftCount, rightCount) >= 0.35

  return balancedColumns ? 'multi-column' : 'single-column'
}

function blocksVerticallyOverlap(a, b) {
  return Math.min(a.topY, b.topY) - Math.max(a.bottomY, b.bottomY)
}

function mergeCaptionCompanionBlocks(blocks, anchorBlock, page) {
  const candidates = blocks
    .filter((block) => block !== anchorBlock)
    .filter((block) => block.column !== anchorBlock.column)
    .filter((block) => !looksLikeSectionBoundary(block.lines[0]?.text ?? ''))
    .filter((block) => {
      const overlap = blocksVerticallyOverlap(anchorBlock, block)
      const topDelta = Math.abs(block.topY - anchorBlock.topY)
      const bottomDelta = Math.abs(block.bottomY - anchorBlock.bottomY)
      return (
        overlap >= -6 &&
        topDelta <= Math.max(28, page.height * 0.035) &&
        bottomDelta <= Math.max(42, page.height * 0.06)
      )
    })
    .sort((a, b) => {
      const overlapDiff = blocksVerticallyOverlap(b, anchorBlock) - blocksVerticallyOverlap(a, anchorBlock)
      if (overlapDiff !== 0) return overlapDiff
      return Math.abs(a.topY - anchorBlock.topY) - Math.abs(b.topY - anchorBlock.topY)
    })

  return [anchorBlock, ...candidates.slice(0, 1)]
}

function mergeCaptionVerticalBlocks(blocks, anchorBlock, page) {
  const candidates = blocks
    .filter((block) => block !== anchorBlock)
    .filter((block) => block.column === anchorBlock.column)
    .filter((block) => !looksLikeSectionBoundary(block.lines[0]?.text ?? ''))
    .filter((block) => {
      const verticalGap = anchorBlock.bottomY - block.topY
      const xDelta = Math.abs(anchorBlock.lines[0].x - block.lines[0].x)
      return (
        verticalGap >= -4 &&
        verticalGap <= Math.max(page.height * 0.04, 28) &&
        xDelta <= Math.max(page.width * 0.06, 36)
      )
    })
    .sort((a, b) => {
      const gapA = Math.abs(anchorBlock.bottomY - a.topY)
      const gapB = Math.abs(anchorBlock.bottomY - b.topY)
      return gapA - gapB
    })

  return [anchorBlock, ...candidates.slice(0, 1)]
}

function orderCaptionBlocks(blocks, layoutMode) {
  if (layoutMode === 'single-column') {
    return [...blocks].sort((a, b) => b.topY - a.topY || a.column - b.column)
  }

  return [...blocks].sort((a, b) => a.column - b.column || b.topY - a.topY)
}

function looksLikeStandaloneUrl(lineText) {
  return /^https?:\/\//i.test(normalizeWhitespace(lineText))
}

function looksLikeBodyParagraphContinuation(lineText) {
  const text = normalizeWhitespace(lineText)
  if (!text) return false
  if (/^(?:[a-z]\)|[A-Z]\)|\([a-z]\)|\([A-Z]\))/.test(text)) return false
  if (/^(?:Data|Error bars?|Scale bars?|Representative|Quantification|Western blot|Images?|Expression|Distribution)\b/i.test(text)) {
    return false
  }
  if (/^(?:We|To|Next|Then|Here|This|These|Those|The|Interestingly|Notably|Therefore|However|In both|After|By|For that)\b/i.test(text)) {
    return true
  }
  return text.length > 120 && /[.!?]$/.test(text) && !/[;,]$/.test(text)
}

function looksLikeCaptionContinuation(lineText) {
  const text = normalizeWhitespace(lineText)
  if (!text) return false
  if (getCaptionStart(text)) return true
  if (/^(?:[a-z](?:[,\u2013-][a-z])?|[a-z]\)|\([a-z]\))\s*[,.;:)]?/i.test(text)) return true
  if (/^(?:Data|Error bars?|Scale bars?|Representative|Quantification|Western blot|Images?|Expression|Distribution|Values|Bars)\b/i.test(text)) {
    return true
  }
  if (looksLikeBodyParagraphContinuation(text)) return false
  return false
}

function getCaptionFlowMode(page, startLine) {
  const hasSameRowLeftText = page.lines.some(
    (line) =>
      line.id !== startLine.id &&
      Math.abs(line.y - startLine.y) <= 2.8 &&
      line.x < startLine.x &&
      lineColumn(line, page) !== lineColumn(startLine, page),
  )

  if (lineColumn(startLine, page) === 1 && (detectPageLayout(page) === 'multi-column' || hasSameRowLeftText)) {
    return 'multi-column'
  }

  const nearbyBelow = page.lines.filter(
    (line) => line.y <= startLine.y + 2 && line.y >= startLine.y - Math.max(70, page.height * 0.09),
  )
  const hasWideContinuation = nearbyBelow.some(
    (line) =>
      line.id !== startLine.id &&
      line.x <= startLine.x + 12 &&
      line.xMax >= page.width * 0.78,
  )
  const hasSameRowContinuation = nearbyBelow.some(
    (line) =>
      line.id !== startLine.id &&
      Math.abs(line.y - startLine.y) <= 2 &&
      line.x >= startLine.xMax - 8 &&
      line.x - startLine.xMax <= 14 &&
      startLine.xMax >= page.width * 0.48,
  )

  return hasWideContinuation || hasSameRowContinuation ? 'single-flow' : 'multi-column'
}

function buildSingleFlowCaptionLines(page, startLine) {
  const rows = []
  const candidateLines = page.lines
    .filter((line) => line.y <= startLine.y + 2)
    .filter((line) => !looksLikeFooter(line, page))
    .filter((line) => !looksLikeStandaloneUrl(line.text))
    .sort((a, b) => b.y - a.y || a.x - b.x)

  for (const line of candidateLines) {
    let row = rows.find((candidate) => Math.abs(candidate.y - line.y) <= 2.8)
    if (!row) {
      row = { y: line.y, lines: [] }
      rows.push(row)
    }
    row.lines.push(line)
  }

  const orderedRows = rows.sort((a, b) => b.y - a.y)
  const startRowIndex = orderedRows.findIndex((row) =>
    row.lines.some((line) => line.id === startLine.id),
  )
  if (startRowIndex < 0) return [startLine]

  const captionRows = []
  let previousY = orderedRows[startRowIndex].y
  let stopReason = 'page-or-candidate-end'

  for (let index = startRowIndex; index < orderedRows.length; index += 1) {
    const row = orderedRows[index]
    const gap = previousY - row.y
    const rowText = normalizeWhitespace(row.lines.map((line) => line.text).join(' '))

    if (index > startRowIndex && gap > Math.max(13.5, startLine.height * 1.8 + 4)) {
      stopReason = looksLikeBodyParagraphContinuation(rowText) ? 'body-paragraph-boundary' : 'vertical-gap-boundary'
      break
    }

    if (index > startRowIndex && looksLikeSectionBoundary(rowText)) {
      stopReason = 'section-boundary'
      break
    }
    if (index > startRowIndex && getCaptionStart(rowText)) {
      stopReason = 'next-caption-start'
      break
    }
    if (index > startRowIndex && captionRows.length <= 2 && looksLikeBodyParagraphContinuation(rowText)) {
      stopReason = 'body-paragraph-boundary'
      break
    }

    captionRows.push(row)
    previousY = row.y
  }

  return {
    lines: captionRows.flatMap((row) => row.lines.sort((a, b) => a.x - b.x)),
    stopReason,
  }
}

function buildCaptionColumnLines(page, startLine, column) {
  const lines = page.lines
    .filter((line) => lineColumn(line, page) === column)
    .filter((line) => line.y <= startLine.y + 2)
    .filter((line) => !looksLikeFooter(line, page))
    .filter((line) => !looksLikeStandaloneUrl(line.text))
    .filter((line) => !looksLikeSectionBoundary(line.text))
    .sort((a, b) => b.y - a.y || a.x - b.x)

  const startIndex =
    column === lineColumn(startLine, page)
      ? lines.findIndex((line) => line.id === startLine.id)
      : lines.findIndex(
          (line) =>
            line.y <= startLine.y + 2 &&
            line.y >= startLine.y - Math.max(24, startLine.height * 2.4),
        )

  if (startIndex < 0) return []

  const captionLines = []
  let previous = lines[startIndex]
  let stopReason = 'page-or-candidate-end'

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]
    const gap = previous.y - line.y

    if (index > startIndex && gap > Math.max(15, Math.max(previous.height, line.height) * 1.45 + 3)) {
      stopReason = looksLikeBodyParagraphContinuation(line.text) ? 'body-paragraph-boundary' : 'vertical-gap-boundary'
      break
    }

    if (index > startIndex && getCaptionStart(line.text)) {
      stopReason = 'next-caption-start'
      break
    }
    if (index > startIndex && captionLines.length <= 2 && looksLikeBodyParagraphContinuation(line.text)) {
      stopReason = 'body-paragraph-boundary'
      break
    }

    captionLines.push(line)
    previous = line
  }

  return { lines: captionLines, stopReason }
}

function buildMultiColumnCaptionLines(page, startLine) {
  const startColumn = lineColumn(startLine, page)
  const otherColumn = startColumn === 0 ? 1 : 0
  const startColumnResult = buildCaptionColumnLines(page, startLine, startColumn)
  const companionResult = buildCaptionColumnLines(page, startLine, otherColumn)
  const startColumnLines = startColumnResult.lines
  const companionLines = companionResult.lines

  if (companionLines.length === 0) return startColumnResult

  const startColumnBottom = Math.min(...startColumnLines.map((line) => line.y))
  const companionTop = Math.max(...companionLines.map((line) => line.y))
  const companionStartsNearCaption =
    companionTop <= startLine.y + 3 &&
    companionTop >= startLine.y - Math.max(32, startLine.height * 3)
  const companionNotBodyBelow = companionTop >= startColumnBottom - Math.max(12, startLine.height * 1.4)
  const companionFirstText = companionLines[0]?.text ?? ''
  const companionLooksLikeCaption =
    startColumn === 0 &&
    looksLikeCaptionContinuation(companionFirstText) &&
    !looksLikeBodyParagraphContinuation(companionFirstText)

  if (!companionStartsNearCaption || !companionNotBodyBelow || !companionLooksLikeCaption) {
    return startColumnResult
  }

  const stopReason =
    startColumnResult.stopReason === 'body-paragraph-boundary' ||
    companionResult.stopReason === 'body-paragraph-boundary'
      ? 'body-paragraph-boundary'
      : startColumnResult.stopReason

  return {
    lines: startColumn === 0
      ? [...startColumnLines, ...companionLines]
      : [...companionLines, ...startColumnLines],
    stopReason,
  }
}

async function loadPdfTextPagesFromDataUrl(pdfDataUrl) {
  const base64 = pdfDataUrl.split(',')[1]
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'))
  const documentProxy = await getDocument({ data: bytes, disableWorker: true }).promise
  const pages = []

  for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
    const page = await documentProxy.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const text = await page.getTextContent()
    const items = text.items
      .map((item) => {
        if (!('str' in item)) return null
        const transform = Array.isArray(item.transform) ? item.transform : []
        return {
          str: item.str,
          x: Number(transform[4] ?? 0),
          y: Number(transform[5] ?? 0),
          width: Number('width' in item ? item.width : 0),
          height: Number('height' in item ? item.height : 0),
        }
      })
      .filter((item) => item && item.str.trim())

    const lines = buildPageLines(items, viewport.width)
    const fullText = normalizeWhitespace(lines.map((line) => line.text).join(' '))

    pages.push({
      pageNumber,
      text: fullText,
      items,
      width: viewport.width,
      height: viewport.height,
      lines,
    })
  }

  return pages
}

function looksLikeFooter(line, page) {
  const text = line.text
  if (line.y < page.height * 0.035) return true
  if (/^\d+$/.test(text)) return true
  if (/^https?:\/\//i.test(text)) return true
  if (/^(www\.|nature aging|nature|science|cell|the lancet|jci|pnas)\b/i.test(text)) return true
  if (/^\|\s*vol(?:ume)?\b/i.test(text)) return true
  return false
}

function looksLikeSectionBoundary(lineText) {
  return /^(References|Methods|Data availability|Acknowledgements|Author contributions|Competing interests|Extended Data|Supplementary|Online content)\b/i.test(
    lineText,
  )
}

function lineColumn(line, page) {
  const center = (line.x + line.xMax) / 2
  return center < page.width / 2 ? 0 : 1
}

function normalizeToken(token) {
  return String(token ?? '')
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
}

function extractCaptionKeywords(captionText) {
  const stopwords = new Set([
    'figure',
    'fig',
    'the',
    'and',
    'for',
    'with',
    'that',
    'from',
    'this',
    'these',
    'those',
    'into',
    'through',
    'after',
    'before',
    'between',
    'during',
    'using',
    'used',
    'over',
    'under',
    'also',
    'were',
    'was',
    'are',
    'has',
    'have',
    'had',
    'may',
    'can',
    'will',
    'show',
    'shows',
    'shown',
    'data',
    'panel',
    'panels',
    'study',
    'result',
    'results',
    'analysis',
    'experiment',
    'experiments',
    'sample',
    'samples',
    'cell',
    'cells',
    'group',
    'groups',
    'value',
    'values',
    'figure.',
  ])

  const words = String(captionText ?? '')
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{3,}/g)

  return [...new Set((words ?? []).map(normalizeToken).filter((word) => word && !stopwords.has(word)))]
}

function isCaptionLine(line, captionBlocks) {
  return captionBlocks.some((block) => {
    if (block.pageNumber !== line.pageNumber) return false
    const region = block.scoreRegion
    if (line.y < region.bottomY || line.y > region.topY) return false
    return region.lineIds.has(line.id)
  })
}

function buildReadableParagraphs(page, captionBlocks) {
  const lines = page.lines
    .map((line) => ({ ...line, pageNumber: page.pageNumber }))
    .filter((line) => !isCaptionLine(line, captionBlocks))
    .filter((line) => !looksLikeFooter(line, page))
    .sort((a, b) => b.y - a.y || a.x - b.x)

  const paragraphs = []
  let current = []

  for (const line of lines) {
    const prev = current[current.length - 1]
    const sameColumn = !prev || lineColumn(prev, page) === lineColumn(line, page)
    const gap = prev ? prev.y - line.y : 0
    const shouldContinue = prev && sameColumn && gap >= 0 && gap <= 18

    if (!shouldContinue && current.length > 0) {
      paragraphs.push({
        pageNumber: page.pageNumber,
        column: lineColumn(current[0], page),
        lines: current,
        text: normalizeWhitespace(current.map((item) => item.text).join(' ')),
      })
      current = []
    }

    current.push(line)
  }

  if (current.length > 0) {
    paragraphs.push({
      pageNumber: page.pageNumber,
      column: lineColumn(current[0], page),
      lines: current,
      text: normalizeWhitespace(current.map((item) => item.text).join(' ')),
    })
  }

  return paragraphs.filter((paragraph) => paragraph.text)
}

function buildCaptionBlockFromStart(page, startLine) {
  const start = getCaptionStart(startLine.text)
  if (!start) return null

  const candidateLines = page.lines.filter((line) => {
    if (looksLikeFooter(line, page)) return false
    if (looksLikeSectionBoundary(line.text)) return false
    return true
  })

  const blocks = groupLinesIntoBlocks(candidateLines, page)
  const anchorBlock = blocks.find((block) => block.lines.some((line) => line.id === startLine.id))
  if (!anchorBlock) return null

  const layoutMode = getCaptionFlowMode(page, startLine)
  const mergedBlocks =
    layoutMode === 'multi-column' ? mergeCaptionCompanionBlocks(blocks, anchorBlock, page) : []
  const captionResult =
    layoutMode === 'single-flow'
      ? buildSingleFlowCaptionLines(page, startLine)
      : buildMultiColumnCaptionLines(page, startLine)
  const captionLines = captionResult.lines
  const seen = new Set()
  const text = normalizeWhitespace(
    captionLines
      .filter((line) => {
        const key = `${Math.round(line.y)}:${Math.round(line.x)}:${line.text}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((line) => line.text)
      .join(' '),
  )

  if (!text) return null

  return {
    figureLabel: start.figureLabel,
    figureNumber: start.figureNumber,
    pageNumber: page.pageNumber,
    text: text.slice(0, 5000),
    startLineText: startLine.text,
    lineCount: captionLines.length,
    layoutMode,
    stopReason: captionResult.stopReason,
    columnMode: layoutMode === 'multi-column' ? 'auto-detected' : 'single-flow',
    scoreRegion: {
      pageNumber: page.pageNumber,
      topY:
        layoutMode === 'single-flow'
          ? Math.max(...captionLines.map((line) => line.y))
          : Math.max(...captionLines.map((line) => line.y)),
      bottomY:
        layoutMode === 'single-flow'
          ? Math.min(...captionLines.map((line) => line.y))
          : Math.min(...captionLines.map((line) => line.y)),
      startY: startLine.y,
      lineIds: new Set(captionLines.map((line) => line.id)),
    },
  }
}

function scoreCaptionIntrinsic(block) {
  let score = 0
  const text = block.text

  if (/^(?:Figure|Fig\.?)\s*\d+[A-Za-z]?\s*(?:[|.:)]|\s\|)/i.test(block.startLineText)) {
    score += 20
  }

  const panelMatches = text.match(/\b[a-z],/g) ?? []
  score += Math.min(8, panelMatches.length)

  if (/\b(?:n\s*=|p\s*[<=>]|anova|tukey|scale bar|error bars|mean|s\.e\.m\.|95% ci)\b/i.test(text)) {
    score += 4
  }

  if (block.lineCount >= 3) score += 3
  if (text.length > 200) score += 3
  if (text.length > 600) score += 2

  if (/\b(?:supplementary|extended data)\s+(?:figure|fig\.?)/i.test(text)) {
    score -= 10
  }

  return score
}

function extractCaptionBlocks(pages) {
  const blocks = []

  for (const page of pages) {
    const startLines = page.lines
      .filter((line) => getCaptionStart(line.text))
      .sort((a, b) => b.y - a.y)

    for (const startLine of startLines) {
      const block = buildCaptionBlockFromStart(page, startLine)
      if (block && block.text.length >= startLine.text.length) {
        blocks.push(block)
      }
    }
  }

  return blocks
}

function inferFigureNumberFromPage(pages, currentPage) {
  const captions = extractCaptionBlocks(pages)
  const currentCaptions = captions
    .filter((caption) => caption.pageNumber === currentPage)
    .sort((a, b) => scoreCaptionIntrinsic(b) - scoreCaptionIntrinsic(a))

  if (currentCaptions[0]?.figureNumber) {
    return currentCaptions[0].figureNumber
  }

  const nearbyCaptions = captions
    .map((caption) => ({
      ...caption,
      distance: Math.abs(caption.pageNumber - currentPage),
      isPrevious: caption.pageNumber <= currentPage,
    }))
    .filter((caption) => caption.distance <= 2)
    .sort((a, b) => {
      const scoreDiff = scoreCaptionIntrinsic(b) - scoreCaptionIntrinsic(a)
      if (scoreDiff !== 0) return scoreDiff
      if (a.distance !== b.distance) return a.distance - b.distance
      if (a.isPrevious !== b.isPrevious) return a.isPrevious ? -1 : 1
      return 0
    })

  if (nearbyCaptions[0]?.figureNumber) {
    return nearbyCaptions[0].figureNumber
  }

  const current = pages.find((page) => page.pageNumber === currentPage)
  const mentions = current ? getFigureMentions(current.text) : []
  return mentions[0]?.figureNumber ?? null
}

function scoreCaptionBlock(block, figureNumber, currentPage) {
  let score = scoreCaptionIntrinsic(block)
  if (block.figureNumber === figureNumber) score += 30
  score += Math.max(0, 10 - Math.abs(block.pageNumber - currentPage) * 2)
  return score
}

function findCaptionCandidates(pages, figureNumber, currentPage) {
  return extractCaptionBlocks(pages)
    .filter((block) => block.figureNumber === figureNumber)
    .map((block) => ({
      pageNumber: block.pageNumber,
      text: block.text,
      score: scoreCaptionBlock(block, figureNumber, currentPage),
      region: {
        topY: Math.round(block.scoreRegion.topY),
        bottomY: Math.round(block.scoreRegion.bottomY),
        startY: Math.round(block.scoreRegion.startY),
      },
    }))
    .sort((a, b) => b.score - a.score)
}

function buildPaperFigureIndex(pages) {
  const captionBlocks = extractCaptionBlocks(pages)
  const figureNumbers = [
    ...new Set(
      captionBlocks
        .map((block) => block.figureNumber)
        .filter((figureNumber) => figureNumber && /^\d+$/.test(figureNumber)),
    ),
  ].sort((a, b) => Number(a) - Number(b))

  return figureNumbers.map((figureNumber) => {
    const captions = captionBlocks
      .filter((block) => block.figureNumber === figureNumber)
      .map((block) => ({
        pageNumber: block.pageNumber,
        text: block.text,
        score: scoreCaptionBlock(block, figureNumber, block.pageNumber),
        region: {
          topY: Math.round(block.scoreRegion.topY),
          bottomY: Math.round(block.scoreRegion.bottomY),
          startY: Math.round(block.scoreRegion.startY),
        },
      }))
      .sort((a, b) => b.score - a.score)

    const bodyEvidence = findBodyEvidence(
      pages,
      figureNumber,
      captionBlocks.filter((block) => block.figureNumber === figureNumber),
    )

    const pagesForFigure = [
      ...new Set([
        ...captions.map((caption) => caption.pageNumber),
        ...bodyEvidence.map((evidence) => evidence.pageNumber),
      ]),
    ].sort((a, b) => a - b)

    return {
      figureLabel: figureNumber,
      captionCandidates: captions.slice(0, 5),
      bodyEvidence,
      pages: pagesForFigure,
      score: (captions[0]?.score ?? 0) + Math.min(bodyEvidence.length, 5),
    }
  })
}

function findBestFigureForPage(index, currentPage) {
  const samePage = index
    .filter((entry) => entry.captionCandidates.some((caption) => caption.pageNumber === currentPage))
    .sort((a, b) => b.score - a.score)

  if (samePage[0]) return samePage[0]

  return [...index]
    .map((entry) => ({
      ...entry,
      distance: Math.min(...entry.pages.map((pageNumber) => Math.abs(pageNumber - currentPage))),
    }))
    .filter((entry) => Number.isFinite(entry.distance))
    .sort((a, b) => a.distance - b.distance || b.score - a.score)[0]
}

function getDirectFigureReferences(text, figureNumber) {
  const pattern = new RegExp(
    `\\b(?:Figure|Fig\\.?)\\s*${figureNumber}(?:[A-Za-z])?(?:\\s*[,;&and-]+\\s*(?:[A-Za-z]|${figureNumber}[A-Za-z]?))*\\b`,
    'gi',
  )

  return [...new Set([...String(text ?? '').matchAll(pattern)].map((match) => normalizeWhitespace(match[0])))]
}

function splitEvidenceSentences(text) {
  const normalized = normalizeWhitespace(text)
  const protectedText = normalized
    .replace(/\bFig\./g, 'Fig__DOT__')
    .replace(/\bDr\./g, 'Dr__DOT__')
    .replace(/\bet al\./g, 'et al__DOT__')
    .replace(/\be\.g\./g, 'e__DOT__g__DOT__')
    .replace(/\bi\.e\./g, 'i__DOT__e__DOT__')

  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((sentence) =>
      sentence
        .replace(/Fig__DOT__/g, 'Fig.')
        .replace(/Dr__DOT__/g, 'Dr.')
        .replace(/et al__DOT__/g, 'et al.')
        .replace(/e__DOT__g__DOT__/g, 'e.g.')
        .replace(/i__DOT__e__DOT__/g, 'i.e.'),
    )
    .map(normalizeWhitespace)
    .filter(Boolean)
}

function buildBodyTextStreams(page, captionBlocks) {
  const bodyLines = page.lines
    .map((line) => ({ ...line, pageNumber: page.pageNumber }))
    .filter((line) => !isCaptionLine(line, captionBlocks))
    .filter((line) => !looksLikeFooter(line, page))
    .filter((line) => !looksLikeSectionBoundary(line.text))

  const layoutMode = detectPageLayout(page)
  const streams =
    layoutMode === 'multi-column'
      ? [0, 1].map((column) => ({
          pageNumber: page.pageNumber,
          column,
          layoutMode,
          lines: bodyLines
            .filter((line) => lineColumn(line, page) === column)
            .sort((a, b) => b.y - a.y || a.x - b.x),
        }))
      : [
          {
            pageNumber: page.pageNumber,
            column: 0,
            layoutMode,
            lines: bodyLines.sort((a, b) => b.y - a.y || a.x - b.x),
          },
        ]

  return streams
    .map((stream) => ({
      ...stream,
      text: normalizeWhitespace(stream.lines.map((line) => line.text).join(' ')).replace(/-\s+/g, ''),
    }))
    .filter((stream) => stream.text)
}

function scoreEvidenceWindow(window, captionPageNumbers) {
  const nearestCaptionPage = captionPageNumbers.length
    ? Math.min(...captionPageNumbers.map((pageNumber) => Math.abs(pageNumber - window.pageNumber)))
    : 99
  const pageScore = Math.max(0, 4 - nearestCaptionPage)
  const referenceScore = window.directReferences.length > 0 ? 30 : 0
  const keywordScore = Math.min(8, window.matchedKeywords.length * 2)
  const explanationCueScore =
    /\b(as shown|shown in|we show|we found|we observed|these results|this suggests|suggests that|indicating|consistent with|supports the)\b/i.test(
      window.text,
    )
      ? 3
      : 0

  return referenceScore + keywordScore + explanationCueScore + pageScore
}

function buildEvidenceWindowsFromStream(stream, figureNumber, captionKeywords, captionPageNumbers) {
  const sentences = splitEvidenceSentences(stream.text)
  const windows = []
  const seen = new Set()

  sentences.forEach((sentence, index) => {
    const directReferences = getDirectFigureReferences(sentence, figureNumber)
    if (directReferences.length === 0) return

    const start = index
    const end = Math.min(sentences.length, index + 2)
    const text = normalizeWhitespace(sentences.slice(start, end).join(' '))
    const key = `direct:${directReferences.join('|').toLowerCase()}:${text.slice(0, 120).toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)

    const lower = text.toLowerCase()
    const matchedKeywords = captionKeywords.filter((keyword) => lower.includes(keyword)).slice(0, 8)
    const window = {
      pageNumber: stream.pageNumber,
      column: stream.column,
      text,
      directReferences,
      matchedKeywords,
      matchReason: 'direct_figure_reference',
    }
    windows.push({
      ...window,
      score: scoreEvidenceWindow(window, captionPageNumbers),
    })
  })

  sentences.forEach((sentence, index) => {
    const lower = sentence.toLowerCase()
    const matchedKeywords = captionKeywords.filter((keyword) => lower.includes(keyword)).slice(0, 8)
    if (matchedKeywords.length < 2) return

    const start = index
    const end = Math.min(sentences.length, index + 2)
    const text = normalizeWhitespace(sentences.slice(start, end).join(' '))
    const key = `keyword:${stream.pageNumber}:${stream.column}:${text.slice(0, 160).toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)

    const window = {
      pageNumber: stream.pageNumber,
      column: stream.column,
      text,
      directReferences: [],
      matchedKeywords,
      matchReason: 'caption_keyword_proximity',
    }
    windows.push({
      ...window,
      score: scoreEvidenceWindow(window, captionPageNumbers),
    })
  })

  return windows
}

function findBodyEvidence(pages, figureNumber, captionBlocks) {
  const captionPageNumbers = [...new Set(captionBlocks.map((block) => block.pageNumber))]
  const captionKeywords = captionBlocks.length > 0 ? extractCaptionKeywords(captionBlocks[0].text) : []
  const evidence = []
  const seen = new Set()

  for (const page of pages) {
    const streams = buildBodyTextStreams(page, captionBlocks)

    for (const window of streams.flatMap((stream) =>
      buildEvidenceWindowsFromStream(stream, figureNumber, captionKeywords, captionPageNumbers),
    )) {
      if (window.score < 8) continue

      const referenceKey =
        window.directReferences.length > 0
          ? window.directReferences.join('|').toLowerCase()
          : window.text.slice(0, 140).toLowerCase()
      const key = `${window.pageNumber}:${window.column}:${referenceKey}`
      if (seen.has(key)) continue
      seen.add(key)

      evidence.push({
        pageNumber: window.pageNumber,
        text: window.text.slice(0, 1600),
        score: window.score,
        directReferences: window.directReferences,
        matchedKeywords: window.matchedKeywords,
        matchReason: window.matchReason,
      })
    }
  }

  return evidence
    .sort((a, b) => {
      const directDiff = Number(b.directReferences.length > 0) - Number(a.directReferences.length > 0)
      if (directDiff !== 0) return directDiff
      return b.score - a.score
    })
    .slice(0, 8)
}

app.post('/api/pdf-inspect', async (req, res) => {
  const { pdf, currentPage } = req.body ?? {}

  if (!pdf || typeof pdf !== 'string') {
    return sendJsonError(res, 400, 'Missing PDF payload.')
  }

  try {
    const pages = await loadPdfTextPagesFromDataUrl(pdf)
    const pageNumber = Number(currentPage) || 1
    const captionBlocks = extractCaptionBlocks(pages)
    const figureNumber = inferFigureNumberFromPage(pages, pageNumber)

    if (!figureNumber) {
      return res.json({
        figureLabel: null,
        captionCandidates: [],
        bodyEvidence: [],
        note: 'No related figure number was detected for the current page.',
      })
    }

    const captionCandidates = findCaptionCandidates(pages, figureNumber, pageNumber)
    const bodyEvidence = findBodyEvidence(pages, figureNumber, captionBlocks)

    return res.json({
      figureLabel: figureNumber,
      captionCandidates: captionCandidates.slice(0, 5),
      bodyEvidence,
      note:
        captionCandidates.length > 0
          ? 'Caption candidates were matched from page geometry.'
          : 'A figure number was detected, but no clear caption candidate was found.',
    })
  } catch (error) {
    return sendJsonError(
      res,
      500,
      error instanceof Error ? error.message : 'PDF inspection failed.',
    )
  }
})

app.post('/api/pdf-index', async (req, res) => {
  const { pdf, currentPage } = req.body ?? {}

  if (!pdf || typeof pdf !== 'string') {
    return sendJsonError(res, 400, 'Missing PDF payload.')
  }

  try {
    const pages = await loadPdfTextPagesFromDataUrl(pdf)
    const pageNumber = Number(currentPage) || 1
    const figures = buildPaperFigureIndex(pages)
    const currentFigure = findBestFigureForPage(figures, pageNumber)

    return res.json({
      figures,
      currentFigureLabel: currentFigure?.figureLabel ?? null,
      note:
        figures.length > 0
          ? `Indexed ${figures.length} figures from the paper.`
          : 'No main figure captions were detected in the paper.',
    })
  } catch (error) {
    return sendJsonError(
      res,
      500,
      error instanceof Error ? error.message : 'PDF index failed.',
    )
  }
})

app.post('/api/browser/figure-context', async (req, res) => {
  const payload = req.body ?? {}
  const sourceType = payload.sourceType === 'pdf' ? 'pdf' : 'html'

  try {
    if (sourceType === 'pdf') {
      if (typeof payload.pdf === 'string' && payload.pdf.startsWith('data:application/pdf')) {
        const pages = await loadPdfTextPagesFromDataUrl(payload.pdf)
        return res.json(buildBrowserFigureContextFromPdfPages(pages, payload))
      }

      return res.json(buildBrowserPdfFallbackContext(payload))
    }

    return res.json(buildBrowserFigureContextFromHtmlPayload(payload))
  } catch (error) {
    return sendJsonError(
      res,
      500,
      error instanceof Error ? error.message : 'Browser figure context failed.',
    )
  }
})

app.post('/api/analysis', async (req, res) => {
  try {
    const record = await analysisStore.create(req.body ?? {})
    return res.status(201).json(record)
  } catch (error) {
    return sendJsonError(
      res,
      500,
      error instanceof Error ? error.message : 'Failed to save analysis record.',
    )
  }
})

app.get('/api/analysis/lookup', async (req, res) => {
  try {
    const record = await analysisStore.lookup(req.query ?? {})
    return res.json({ record })
  } catch (error) {
    return sendJsonError(
      res,
      500,
      error instanceof Error ? error.message : 'Failed to look up analysis record.',
    )
  }
})

app.get('/api/analysis', async (req, res) => {
  try {
    const records = await analysisStore.list(req.query ?? {})
    return res.json({ records })
  } catch (error) {
    return sendJsonError(
      res,
      500,
      error instanceof Error ? error.message : 'Failed to list analysis records.',
    )
  }
})

app.get('/api/analysis/:id', async (req, res) => {
  try {
    const record = await analysisStore.get(req.params.id)
    if (!record) return sendJsonError(res, 404, 'Analysis record not found.')
    return res.json({ record })
  } catch (error) {
    return sendJsonError(
      res,
      500,
      error instanceof Error ? error.message : 'Failed to get analysis record.',
    )
  }
})

app.delete('/api/analysis/:id', async (req, res) => {
  try {
    const deleted = await analysisStore.delete(req.params.id)
    if (!deleted) return sendJsonError(res, 404, 'Analysis record not found.')
    return res.json({ deleted })
  } catch (error) {
    return sendJsonError(
      res,
      500,
      error instanceof Error ? error.message : 'Failed to delete analysis record.',
    )
  }
})

app.post('/api/analyze-image', async (req, res) => {
  const { image, imageName, caption, question, selection } = req.body ?? {}

  if (!image || typeof image !== 'string') {
    return sendJsonError(res, 400, 'Missing image payload. Upload an image or import a PDF first.')
  }

  const config = await getEffectiveModelConfig()

  if (!config.apiKey) {
    return sendJsonError(
      res,
      503,
      'API key is not configured. Open Settings and add your own API key.',
    )
  }

  const analysisEndpoint = buildModelEndpoint({ baseUrl: config.baseUrl, model: config.model, purpose: 'image-analysis' })
  if (config.baseUrl.toLowerCase().includes('api.deepseek.com')) {
    return sendJsonError(
      res,
      400,
      'DeepSeek 的 Chat Completions 接口可以用于测试文本连接，但当前模型配置不支持本工具需要的图片输入。请换成支持 vision/input_image 的 OpenAI 兼容多模态模型后再解析图片。',
    )
  }

  const regionText = selection
    ? `User selected image coordinates: x=${Math.round(selection.x)}, y=${Math.round(selection.y)}, width=${Math.round(selection.width)}, height=${Math.round(selection.height)}.`
    : 'No local region was selected. Analyze the full figure.'

  const prompt = [
    'You are an assistant for understanding scientific paper figures.',
    'Write all user-facing output in Simplified Chinese. Keep established gene, protein, method, and statistical abbreviations in English when needed.',
    'Separate visible image evidence, provided caption or body evidence, and your own inference.',
    'Give a short conclusion first, then evidence and uncertainty. Do not invent caption details or experimental conditions.',
    'Also create concise on-image annotations that help a reader quickly understand the figure.',
    'Use normalized image coordinates from 0 to 1000 for each annotation box, where x=0,y=0 is the top-left of the visible image and x=1000,y=1000 is the bottom-right of the visible image.',
    'Annotation boxes must be tight. Do not cover neighboring panels, figure captions, body text, page headers, or blank margins unless the user explicitly asks about them.',
    'One annotation should correspond to exactly one main figure panel, usually indicated by panel letters such as a, b, c or A, B, C. Do not annotate individual subplots, grid cells, single curves, scatter groups, blot lanes, microscopy tiles, or other local elements as separate panels unless the user explicitly selected that local region.',
    'For panel-level annotations, the box should enclose the full main panel content including axes, labels, legends, blot lanes, microscopy grids, and panel letter when that letter is visually part of the panel. Put the box edges in the white gutter or outside margin around the panel; do not place edges over data marks, axis labels, blot bands, microscopy content, or nearby panels.',
    'If two panels are close together, choose a smaller box that stays inside the available gutter rather than crossing into the neighboring panel. If the exact boundary is unclear, prefer a conservative box around the visible data region and explain the uncertainty.',
    'If visible panel letters (a, b, c...) exist, return one annotation for each visible main panel letter whenever possible. For dense figures, cover up to 20 panels instead of only the most important panels.',
    'If you cannot localize a panel precisely, return a smaller box around the most relevant visible data region instead of a large approximate box.',
    'If the user selected a local region, place annotation boxes within that selected region coordinate space as visible in the provided image.',
    'Each annotation popup must be short Chinese text: what it is, how to read it, and what it means.',
    `Image name: ${imageName || 'unnamed-image'}`,
    regionText,
    caption
      ? `Retrieved caption or body evidence:\n${caption}`
      : 'No caption or body evidence was retrieved.',
    `User question: ${question || 'What does this figure mainly show?'}`,
    'Return JSON with {"answer":"中文短结论","sources":["中文依据"],"uncertainty":"中文不确定点","annotations":[...]}',
  ].join('\n\n')

  try {
    const response = await fetch(analysisEndpoint.url, {
      method: 'POST',
      headers: buildModelHeaders({ mode: analysisEndpoint.mode, apiKey: config.apiKey }),
      body: JSON.stringify(
        buildModelRequest({
          mode: analysisEndpoint.mode,
          model: config.model,
          prompt,
          image,
          structured: true,
        }),
      ),
    })

    const responseText = await response.text()
    let payload = null

    try {
      payload = responseText ? JSON.parse(responseText) : null
    } catch {
      payload = null
    }

    if (!response.ok) {
      const upstreamMessage =
        payload?.error?.message ||
        (responseText && responseText.trim().startsWith('<!DOCTYPE')
          ? `Upstream service returned HTML instead of JSON. Status ${response.status}.`
          : responseText?.slice(0, 500)) ||
        `Multimodal request failed: ${config.baseUrl}`

      return sendJsonError(res, response.status, upstreamMessage)
    }

    if (!payload) {
      return sendJsonError(res, 502, 'Upstream service returned a non-JSON success response.')
    }

    let output = extractOutputPayload(payload)
    if (!output) {
      const retryResponse = await fetch(analysisEndpoint.url, {
        method: 'POST',
        headers: buildModelHeaders({ mode: analysisEndpoint.mode, apiKey: config.apiKey }),
        body: JSON.stringify(
          buildModelRequest({
            mode: analysisEndpoint.mode,
            model: config.model,
            prompt: `${prompt}\n\nReturn only a valid JSON object. Do not wrap it in markdown.`,
            image,
            structured: false,
          }),
        ),
      })
      const retryText = await retryResponse.text()
      let retryPayload = null

      try {
        retryPayload = retryText ? JSON.parse(retryText) : null
      } catch {
        retryPayload = null
      }

      if (!retryResponse.ok) {
        return sendJsonError(
          res,
          retryResponse.status,
          retryPayload?.error?.message || retryText?.slice(0, 500) || 'Model retry failed.',
        )
      }

      output = retryPayload ? extractOutputPayload(retryPayload) : null
    }

    if (!output) {
      return sendJsonError(res, 502, 'Model returned success but no parsable text content.')
    }

    return res.json(parseModelJson(output))
  } catch (error) {
    return sendJsonError(res, 500, formatNetworkError(error, config?.baseUrl))
  }
})

app.use((error, _req, res, next) => {
  if (res.headersSent) {
    return next(error)
  }

  if (error?.type === 'entity.too.large') {
    return sendJsonError(
      res,
      413,
      'The uploaded request is too large. Try a smaller page image or reduce the PDF resolution.',
    )
  }

  if (error instanceof SyntaxError && 'body' in error) {
    return sendJsonError(res, 400, 'Invalid JSON request body.')
  }

  return sendJsonError(
    res,
    500,
    error instanceof Error ? error.message : 'Unexpected server error.',
  )
})

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`API server listening on http://localhost:${port}`)
    console.log('Model endpoint is configured by /api/settings and environment variables.')
  })
}

export {
  app,
  buildHealthPayload,
  buildSettingsPayload,
  buildEffectiveModelConfig,
  buildModelEndpoint,
  buildModelRequest,
  buildModelHeaders,
  extractOutputPayload,
  createSettingsStore,
  maskApiKey,
  buildCaptionBlockFromStart,
  createAnalysisStore,
  buildBrowserFigureContextFromHtmlPayload,
  buildBrowserPdfFallbackContext,
  buildBrowserFigureContextFromPdfPages,
}
