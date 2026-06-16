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
  buildModelHeaders,
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

test('model endpoint detects Gemini generateContent API', () => {
  const endpoint = buildModelEndpoint({
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash',
    purpose: 'image-analysis',
  })

  assert.equal(endpoint.mode, 'gemini-generate-content')
  assert.equal(
    endpoint.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  )
})

test('model endpoint detects Claude Messages API', () => {
  const endpoint = buildModelEndpoint({
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    purpose: 'image-analysis',
  })

  assert.equal(endpoint.mode, 'claude-messages')
  assert.equal(endpoint.url, 'https://api.anthropic.com/v1/messages')
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

test('gemini image request uses inline image data', () => {
  const request = buildModelRequest({
    mode: 'gemini-generate-content',
    model: 'gemini-2.5-flash',
    prompt: 'Analyze this image.',
    image: 'data:image/png;base64,AAA',
    structured: true,
  })

  assert.equal(request.contents[0].parts[0].text, 'Analyze this image.')
  assert.deepEqual(request.contents[0].parts[1], {
    inline_data: {
      mime_type: 'image/png',
      data: 'AAA',
    },
  })
  assert.equal(request.generationConfig.responseMimeType, 'application/json')
})

test('claude image request uses base64 image source', () => {
  const request = buildModelRequest({
    mode: 'claude-messages',
    model: 'claude-sonnet-4-5',
    prompt: 'Analyze this image.',
    image: 'data:image/jpeg;base64,BBB',
    structured: false,
  })

  assert.equal(request.model, 'claude-sonnet-4-5')
  assert.equal(request.max_tokens, 4096)
  assert.deepEqual(request.messages[0].content[0], { type: 'text', text: 'Analyze this image.' })
  assert.deepEqual(request.messages[0].content[1], {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: 'BBB',
    },
  })
})

test('model headers use provider-specific authentication', () => {
  assert.deepEqual(buildModelHeaders({ mode: 'gemini-generate-content', apiKey: 'gemini-key' }), {
    'x-goog-api-key': 'gemini-key',
    'Content-Type': 'application/json',
  })
  assert.deepEqual(buildModelHeaders({ mode: 'claude-messages', apiKey: 'claude-key' }), {
    'x-api-key': 'claude-key',
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  })
})

test('extract output payload reads Gemini and Claude text content', () => {
  assert.equal(
    extractOutputPayload({
      candidates: [{ content: { parts: [{ text: '{"answer":"gemini"}' }] } }],
    }),
    '{"answer":"gemini"}',
  )
  assert.equal(
    extractOutputPayload({
      content: [{ type: 'text', text: '{"answer":"claude"}' }],
    }),
    '{"answer":"claude"}',
  )
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

test('single-column caption stops before body text in adjacent column', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      {
        id: 'body-left-1',
        text: 'The task of carrying out transcription in the eukaryotic nucleus is divided among RNA Pol I, II and III.',
        x: 45,
        xMax: 275,
        y: 210,
        height: 9,
      },
      {
        id: 'body-left-2',
        text: 'We confirmed that inhibition of Pol III extended lifespan and altered physiology.',
        x: 45,
        xMax: 275,
        y: 198,
        height: 9,
      },
      {
        id: 'caption-start',
        text: 'Figure 1 | Inhibition of Pol III extends lifespan. a, Treatment of the RPC160-AID-myc strain with IAA',
        x: 315,
        xMax: 560,
        y: 170,
        height: 8,
      },
      {
        id: 'caption-2',
        text: 'triggers degradation of C160-AID-myc and extends chronological lifespan (b).',
        x: 315,
        xMax: 560,
        y: 159,
        height: 8,
      },
      {
        id: 'body-right-1',
        text: 'The central position of TORC1 in the control of fundamental cellular processes has been reviewed extensively.',
        x: 315,
        xMax: 560,
        y: 138,
        height: 9,
      },
    ],
  }

  const block = buildCaptionBlockFromStart(page, page.lines[2])

  assert.match(block.text, /Figure 1/)
  assert.match(block.text, /chronological lifespan/)
  assert.doesNotMatch(block.text, /central position of TORC1/i)
  assert.equal(block.stopReason, 'body-paragraph-boundary')
})

test('two-column caption merges panel continuations and stops before body paragraphs', () => {
  const page = {
    pageNumber: 2,
    width: 600,
    height: 800,
    lines: [
      {
        id: 'caption-left-1',
        text: 'Figure 2 | Gut-specific inhibition of Pol III extends lifespan, reduces protein synthesis and increases',
        x: 55,
        xMax: 280,
        y: 240,
        height: 8,
      },
      {
        id: 'caption-left-2',
        text: 'tolerance to proteostatic stress. a, Induction of RNAi against rpc-1 specifically in the worm gut',
        x: 55,
        xMax: 280,
        y: 229,
        height: 8,
      },
      {
        id: 'caption-left-3',
        text: 'extends C. elegans lifespan at 20 °C in the presence of FUDR.',
        x: 55,
        xMax: 280,
        y: 218,
        height: 8,
      },
      {
        id: 'caption-right-1',
        text: 'd–f, Inducing dC160 RNAi expression in the gut by feeding RU486 to female flies leads to reduced',
        x: 320,
        xMax: 560,
        y: 240,
        height: 8,
      },
      {
        id: 'caption-right-2',
        text: 'pre-tRNAs (d), reduced gut protein synthesis (e), and improved survival in response to tunicamycin (f).',
        x: 320,
        xMax: 560,
        y: 229,
        height: 8,
      },
      {
        id: 'body-left-1',
        text: 'IAA did not have substantial effect on the survival of a strain carrying the AID domain fused to the largest subunit.',
        x: 55,
        xMax: 280,
        y: 194,
        height: 9,
      },
      {
        id: 'body-right-1',
        text: 'The worm gut is composed of only post-mitotic cells and has been used to model adult-onset inhibition.',
        x: 320,
        xMax: 560,
        y: 194,
        height: 9,
      },
    ],
  }

  const block = buildCaptionBlockFromStart(page, page.lines[0])

  assert.match(block.text, /Figure 2/)
  assert.match(block.text, /d–f/)
  assert.doesNotMatch(block.text, /IAA did not/)
  assert.doesNotMatch(block.text, /worm gut is composed/)
  assert.equal(block.layoutMode, 'multi-column')
  assert.equal(block.stopReason, 'body-paragraph-boundary')
})

test('right-column caption does not merge same-height body text from left column', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      {
        id: 'body-left-1',
        text: 'The central position of TORC1 in the control of fundamental cellular processes is mirrored by the notable effect of its activity.',
        x: 55,
        xMax: 280,
        y: 154,
        height: 8,
      },
      {
        id: 'body-left-2',
        text: 'Following its initial discovery in worms, inhibition of TORC1 has been demonstrated to extend lifespan.',
        x: 55,
        xMax: 280,
        y: 143,
        height: 8,
      },
      {
        id: 'caption-right-1',
        text: 'Figure 1 | Inhibition of Pol III extends lifespan. a, Treatment of the RPC160-AID-myc strain with 0,',
        x: 320,
        xMax: 560,
        y: 154,
        height: 8,
      },
      {
        id: 'caption-right-2',
        text: '0.125 and 0.25 mM IAA triggers degradation of C160-AID-myc and extends chronological lifespan.',
        x: 320,
        xMax: 560,
        y: 143,
        height: 8,
      },
      {
        id: 'caption-right-3',
        text: 'b, Lifespan was measured as colony formation following tenfold serial dilution.',
        x: 320,
        xMax: 560,
        y: 132,
        height: 8,
      },
    ],
  }

  const block = buildCaptionBlockFromStart(page, page.lines[2])

  assert.match(block.text, /Figure 1/)
  assert.match(block.text, /colony formation/)
  assert.doesNotMatch(block.text, /central position of TORC1/i)
  assert.doesNotMatch(block.text, /initial discovery in worms/i)
  assert.equal(block.layoutMode, 'multi-column')
})
