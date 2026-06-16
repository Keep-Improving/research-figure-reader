import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.PORT = '0'
process.env.NODE_ENV = 'test'

const {
  buildHealthPayload,
  buildEffectiveModelConfig,
  buildSettingsPayload,
  buildModelEndpoint,
  buildModelRequest,
  extractOutputPayload,
  buildBrowserFigureContextFromHtmlPayload,
  buildBrowserPdfFallbackContext,
  createAnalysisStore,
  createSettingsStore,
  buildCaptionBlockFromStart,
  maskApiKey,
} = await import('./server.js')

test('health payload reports model and API key configuration without exposing the key', () => {
  const payload = buildHealthPayload({
    model: 'gpt-test',
    baseUrl: 'https://api.example.com',
    hasApiKey: true,
    analysisStorePath: 'data/analysis-store.json',
  })

  assert.equal(payload.ok, true)
  assert.equal(payload.model, 'gpt-test')
  assert.equal(payload.baseUrl, 'https://api.example.com')
  assert.equal(payload.hasApiKey, true)
  assert.equal(payload.analysisStore, 'json-file')
  assert.equal('apiKey' in payload, false)
})

test('settings payload masks API key and reports local override source', () => {
  const payload = buildSettingsPayload({
    env: {
      OPENAI_API_KEY: 'env-api-key-secret',
      OPENAI_BASE_URL: 'https://env.example.com/',
      OPENAI_MODEL: 'gpt-env',
    },
    settings: {
      apiKey: 'local-api-key-secret-1234',
      baseUrl: 'https://local.example.com/',
      model: 'gpt-local',
    },
    settingsPath: 'data/local-settings.json',
  })

  assert.equal(payload.apiKeyConfigured, true)
  assert.equal(payload.apiKeyMasked, 'loc...1234')
  assert.equal(payload.baseUrl, 'https://local.example.com')
  assert.equal(payload.model, 'gpt-local')
  assert.equal(payload.source, 'local-settings')
  assert.equal(payload.settingsStore, 'json-file')
  assert.equal('apiKey' in payload, false)
})

test('effective model config prefers local settings over environment', () => {
  const config = buildEffectiveModelConfig({
    env: {
      OPENAI_API_KEY: 'env-api-key',
      OPENAI_BASE_URL: 'https://env.example.com/',
      OPENAI_MODEL: 'gpt-env',
    },
    settings: {
      apiKey: 'local-api-key',
      baseUrl: 'https://local.example.com/',
      model: 'gpt-local',
    },
  })

  assert.equal(config.apiKey, 'local-api-key')
  assert.equal(config.baseUrl, 'https://local.example.com')
  assert.equal(config.model, 'gpt-local')
})

test('model endpoint uses chat completions for DeepSeek settings tests', () => {
  const endpoint = buildModelEndpoint({
    baseUrl: 'https://api.deepseek.com',
    purpose: 'settings-test',
  })

  assert.equal(endpoint.mode, 'chat-completions')
  assert.equal(endpoint.url, 'https://api.deepseek.com/chat/completions')
})

test('model endpoint keeps responses API for default multimodal analysis', () => {
  const endpoint = buildModelEndpoint({
    baseUrl: 'https://api.openai.com',
    purpose: 'image-analysis',
  })

  assert.equal(endpoint.mode, 'responses')
  assert.equal(endpoint.url, 'https://api.openai.com/v1/responses')
})

test('chat completions image request uses OpenAI-compatible vision content blocks', () => {
  const request = buildModelRequest({
    mode: 'chat-completions',
    model: 'qwen-vl-plus',
    prompt: 'Analyze this image.',
    image: 'data:image/png;base64,AAA',
    structured: true,
  })

  assert.equal(request.model, 'qwen-vl-plus')
  assert.equal(request.messages[0].role, 'user')
  assert.deepEqual(request.messages[0].content[0], { type: 'text', text: 'Analyze this image.' })
  assert.deepEqual(request.messages[0].content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AAA' },
  })
  assert.equal(request.response_format.type, 'json_object')
})

test('extract output payload reads chat completions text content', () => {
  const output = extractOutputPayload({
    choices: [
      {
        message: {
          content: '{"answer":"ok","sources":[],"uncertainty":"","annotations":[]}',
        },
      },
    ],
  })

  assert.equal(output, '{"answer":"ok","sources":[],"uncertainty":"","annotations":[]}')
})

test('settings store persists local configuration without leaking raw key in payload', async () => {
  const store = createSettingsStore()
  const saved = await store.save({
    apiKey: ' local-test-api-key-secret ',
    baseUrl: ' https://api.test.example.com/ ',
    model: ' gpt-test ',
  })
  const loaded = await store.read()

  assert.equal(saved.apiKey, 'local-test-api-key-secret')
  assert.equal(saved.baseUrl, 'https://api.test.example.com')
  assert.equal(saved.model, 'gpt-test')
  assert.deepEqual(loaded, saved)
  assert.equal(maskApiKey(loaded.apiKey), 'loc...cret')
})

test('HTML browser context prefers structured figure caption over weak alt text', () => {
  const context = buildBrowserFigureContextFromHtmlPayload({
    pageUrl: 'https://example.org/article',
    title: 'Example paper',
    captionCandidates: [
      {
        text: 'Alt text: microscopy panel',
        source: 'alt',
        confidence: 0.2,
        isComplete: false,
      },
      {
        text: 'Fig. 2 | METTL1 depletion increases senescence markers in human fibroblasts.',
        source: 'html-figcaption',
        confidence: 0.8,
        isComplete: true,
      },
    ],
    nearbyBodyText: 'Cells showed increased p16 expression (Fig. 2).',
  })

  assert.equal(context.sourceType, 'html')
  assert.equal(context.figureLabel, '2')
  assert.equal(
    context.selectedCaption,
    'Fig. 2 | METTL1 depletion increases senescence markers in human fibroblasts.',
  )
  assert.equal(context.captionCandidates[0].source, 'html-figcaption')
  assert.deepEqual(context.bodyEvidence[0].directReferences, ['Fig. 2'])
})

test('PDF fallback context does not pretend PDF text was read', () => {
  const context = buildBrowserPdfFallbackContext({
    pageUrl: 'blob:https://example.org/abc',
    currentPage: 4,
    title: 'Browser PDF',
  })

  assert.equal(context.sourceType, 'pdf-fallback')
  assert.equal(context.captionIsComplete, false)
  assert.equal(context.selectedCaption, '')
  assert.match(context.note, /未读取到 PDF 文本层/)
  assert.deepEqual(context.bodyEvidence, [])
})

test('analysis store saves and looks up records by document, figure, and fingerprint', async () => {
  const store = createAnalysisStore()
  const saved = await store.create({
    documentId: 'paper-1',
    figureId: 'Fig. 2',
    imageFingerprint: 'abc123',
    paper: {
      title: 'Aging paper',
      doi: '10.1234/example',
      pdfDataUrl: 'data:application/pdf;base64,PDF',
    },
    figure: {
      figureLabel: 'Fig. 2',
      captionText: 'Fig. 2 | Test caption.',
      imageDataUrl: 'data:image/png;base64,AAA',
      thumbnailDataUrl: 'data:image/png;base64,BBB',
      locator: {
        source: 'web-html',
        pageUrl: 'https://example.org/paper',
      },
    },
    source: 'browser-extension',
    answer: '图像显示处理组降低。',
    annotations: [{ label: 'a', bbox: { x: 10, y: 10, width: 100, height: 100 } }],
  })

  const found = await store.lookup({
    documentId: 'paper-1',
    figureId: 'Fig. 2',
    imageFingerprint: 'abc123',
  })

  assert.equal(found.id, saved.id)
  assert.equal(found.version, 1)
  assert.equal(found.answer, '图像显示处理组降低。')
  assert.equal(found.annotations[0].label, 'a')
  assert.equal(found.paper.title, 'Aging paper')
  assert.equal(found.paper.pdfDataUrl, 'data:application/pdf;base64,PDF')
  assert.equal(found.figure.figureLabel, 'Fig. 2')
  assert.equal(found.figure.imageDataUrl, 'data:image/png;base64,AAA')
  assert.equal(found.figure.locator.source, 'web-html')
})

test('analysis store deletes one record without deleting other records', async () => {
  const store = createAnalysisStore()
  const first = await store.create({
    documentId: 'paper-delete',
    figureId: 'Fig. 1',
    imageFingerprint: 'delete-1',
    answer: 'first',
  })
  const second = await store.create({
    documentId: 'paper-delete',
    figureId: 'Fig. 2',
    imageFingerprint: 'delete-2',
    answer: 'second',
  })

  const deleted = await store.delete(first.id)
  const records = await store.list({ documentId: 'paper-delete' })

  assert.equal(deleted.id, first.id)
  assert.equal(records.length, 1)
  assert.equal(records[0].id, second.id)
})

test('analysis store gets a record by id', async () => {
  const store = createAnalysisStore()
  const saved = await store.create({
    documentId: 'paper-get',
    figureId: 'Fig. 4',
    imageFingerprint: 'get-1',
    answer: 'saved answer',
  })

  const found = await store.get(saved.id)

  assert.equal(found.id, saved.id)
  assert.equal(found.figureId, 'Fig. 4')
})

test('caption extraction stops before following body paragraphs with figure mentions', () => {
  const page = {
    pageNumber: 3,
    width: 600,
    height: 800,
    lines: [
      {
        id: 'caption-start',
        text: 'Figure 1a). On the contrary, no specific enrichment was observed in subtelomeric regions for the downregulated DEGs (Figure 1a).',
        x: 50,
        xMax: 560,
        y: 720,
        height: 10,
      },
      {
        id: 'body-1',
        text: 'We hypothesized that the DEG upregulation could result from a senescence-associated process of either derepression or specific transactivation.',
        x: 50,
        xMax: 560,
        y: 704,
        height: 10,
      },
      {
        id: 'body-2',
        text: 'To decipher between these two possibilities, we compared the expression levels of the DEGs and non-DEGs in young and senescent cells.',
        x: 50,
        xMax: 560,
        y: 688,
        height: 10,
      },
    ],
  }

  const block = buildCaptionBlockFromStart(page, page.lines[0])
  assert.equal(block.text, page.lines[0].text)
})
