import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const app = express()
const port = Number(process.env.PORT || 8787)
const model = process.env.OPENAI_MODEL || 'gpt-5.4'
const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')

app.use(cors())
app.use(express.json({ limit: '35mb' }))

function formatNetworkError(error) {
  if (!(error instanceof Error)) {
    return `调用模型接口失败：${baseUrl}`
  }

  const causeMessage =
    typeof error.cause === 'object' && error.cause && 'message' in error.cause
      ? String(error.cause.message)
      : ''

  if (causeMessage.includes('Connect Timeout') || causeMessage.includes('ETIMEDOUT')) {
    return `连接模型接口超时：${baseUrl}。请检查当前网络、代理或中转服务。`
  }

  return causeMessage || error.message || `调用模型接口失败：${baseUrl}`
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text
  }

  const messageText = payload?.output
    ?.flatMap((item) => item?.content ?? [])
    ?.find((content) => content?.type === 'output_text' && typeof content.text === 'string')
    ?.text

  return typeof messageText === 'string' && messageText.trim() ? messageText : null
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

function getCaptionStart(lineText) {
  const match = normalizeWhitespace(lineText).match(
    /^(?:Figure|Fig\.?|FIG\.?)\s*(\d+[A-Za-z]?)\s*(?:[|.:)]|\s\|)\s*(.+)?$/i,
  )
  if (!match) return null

  return {
    figureLabel: match[1],
    figureNumber: normalizeFigureLabel(match[1]),
  }
}

function getFigureMentions(text) {
  return [...String(text ?? '').matchAll(/\b(?:Figure|Fig\.?|FIG\.?)\s*(\d+[A-Za-z]?)\b/g)].map(
    (match) => ({
      label: match[1],
      figureNumber: normalizeFigureLabel(match[1]),
      index: match.index ?? 0,
    }),
  )
}

function splitRowIntoSegments(sortedItems, pageWidth) {
  const segments = []
  let current = []

  for (const item of sortedItems) {
    const previous = current[current.length - 1]
    const gap = previous ? item.x - (previous.x + previous.width) : 0
    const isLargeColumnGap = gap > Math.max(28, pageWidth * 0.08)
    const crossesPageMiddle =
      previous && previous.x < pageWidth / 2 && item.x >= pageWidth / 2

    if (previous && (isLargeColumnGap || crossesPageMiddle)) {
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
        startY: current[0].y,
        endY: current[current.length - 1].y,
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
      startY: current[0].y,
      endY: current[current.length - 1].y,
    })
  }

  return paragraphs.filter((paragraph) => paragraph.text)
}

function orderCaptionLines(lines, page) {
  const indexed = lines.map((line, index) => ({ ...line, originalIndex: index }))
  const left = indexed
    .filter((line) => lineColumn(line, page) === 0)
    .sort((a, b) => b.y - a.y || a.x - b.x)
  const right = indexed
    .filter((line) => lineColumn(line, page) === 1)
    .sort((a, b) => b.y - a.y || a.x - b.x)

  return [...left, ...right]
}

function buildCaptionBlockFromStart(page, startLine) {
  const start = getCaptionStart(startLine.text)
  if (!start) return null

  const topSlack = Math.max(12, page.height * 0.025)
  const bottomLimit = page.height * 0.035
  const maxCaptionTop = Math.min(startLine.y + topSlack, page.height * 0.42)
  const minLineWidth = page.width * 0.08

  const regionLines = page.lines.filter((line) => {
    if (looksLikeFooter(line, page)) return false
    if (line.y < bottomLimit || line.y > maxCaptionTop) return false
    if (line.xMax - line.x < minLineWidth && !getCaptionStart(line.text)) return false
    if (line.y > startLine.y + topSlack && !getCaptionStart(line.text)) return false
    if (looksLikeSectionBoundary(line.text)) return false
    return true
  })

  const laterCaptionStarts = regionLines
    .filter((line) => line.y < startLine.y - 2 && getCaptionStart(line.text))
    .sort((a, b) => b.y - a.y)
  const nextStartY = laterCaptionStarts[0]?.y ?? -Infinity

  const captionLines = regionLines.filter((line) => line.y > nextStartY + 1)
  const orderedLines = orderCaptionLines(captionLines, page)
  const seen = new Set()
  const text = normalizeWhitespace(
    orderedLines
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
    scoreRegion: {
      pageNumber: page.pageNumber,
      topY: maxCaptionTop,
      bottomY: bottomLimit,
      startY: startLine.y,
      lineIds: new Set(captionLines.map((line) => line.id)),
    },
  }
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
    .sort((a, b) => b.scoreRegion.startY - a.scoreRegion.startY)

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
      if (a.distance !== b.distance) return a.distance - b.distance
      if (a.isPrevious !== b.isPrevious) return a.isPrevious ? -1 : 1
      return b.scoreRegion.startY - a.scoreRegion.startY
    })

  if (nearbyCaptions[0]?.figureNumber) {
    return nearbyCaptions[0].figureNumber
  }

  const current = pages.find((page) => page.pageNumber === currentPage)
  const mentions = current ? getFigureMentions(current.text) : []
  return mentions[0]?.figureNumber ?? null
}

function scoreCaptionBlock(block, figureNumber, currentPage) {
  let score = 0
  if (block.figureNumber === figureNumber) score += 30
  score += Math.max(0, 10 - Math.abs(block.pageNumber - currentPage) * 2)
  if (block.scoreRegion.startY < 320) score += 4
  if (block.text.length > 250) score += 3
  if (block.text.length > 700) score += 2
  if (block.text.includes('|')) score += 1
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

function isCaptionLine(line, captionBlocks) {
  return captionBlocks.some((block) => {
    if (block.pageNumber !== line.pageNumber) return false
    const region = block.scoreRegion
    if (line.y < region.bottomY || line.y > region.topY) return false
    return region.lineIds.has(line.id)
  })
}

function snippetAroundLine(lines, lineIndex, radius = 2) {
  const start = Math.max(0, lineIndex - radius)
  const end = Math.min(lines.length, lineIndex + radius + 1)
  return normalizeWhitespace(lines.slice(start, end).map((line) => line.text).join(' '))
}

function scoreBodyParagraph(paragraph, figureNumber, captionKeywords, captionPageNumbers) {
  const text = paragraph.text.toLowerCase()
  let score = 0

  if (new RegExp(`\\b(?:figure|fig\\.?)\\s*${figureNumber}[a-z]?\\b`, 'i').test(paragraph.text)) {
    score += 12
  }

  const matchedKeywords = captionKeywords.filter((keyword) => text.includes(keyword))
  score += Math.min(8, matchedKeywords.length * 2)
  if (matchedKeywords.length >= 2) score += 2

  if (
    /\b(as shown|shown in|we show|we found|we observed|these results|this suggests|suggests that|indicating|consistent with|in agreement with|supports the|therefore)\b/i.test(
      paragraph.text,
    )
  ) {
    score += 3
  }

  const nearestCaptionPage = captionPageNumbers.length
    ? Math.min(...captionPageNumbers.map((pageNumber) => Math.abs(pageNumber - paragraph.pageNumber)))
    : 99
  score += Math.max(0, 4 - nearestCaptionPage)

  if (paragraph.text.length > 240) score += 1
  if (paragraph.text.length > 600) score += 1

  return score
}

function findBodyEvidence(pages, figureNumber, captionBlocks) {
  const captionPageNumbers = [...new Set(captionBlocks.map((block) => block.pageNumber))]
  const captionKeywords = captionBlocks.length > 0 ? extractCaptionKeywords(captionBlocks[0].text) : []
  const evidence = []
  const seen = new Set()

  for (const page of pages) {
    const paragraphs = buildReadableParagraphs(page, captionBlocks)

    for (const paragraph of paragraphs) {
      const score = scoreBodyParagraph(paragraph, figureNumber, captionKeywords, captionPageNumbers)
      if (score < 3) continue

      const key = `${paragraph.pageNumber}:${paragraph.column}:${paragraph.text.slice(0, 140)}`
      if (seen.has(key)) continue
      seen.add(key)

      evidence.push({
        pageNumber: paragraph.pageNumber,
        text: paragraph.text.slice(0, 1200),
        score,
      })
    }
  }

  return evidence.sort((a, b) => b.score - a.score).slice(0, 8)
}

app.post('/api/pdf-inspect', async (req, res) => {
  const { pdf, currentPage } = req.body ?? {}

  if (!pdf || typeof pdf !== 'string') {
    return res.status(400).json({ error: '缺少 PDF 数据。' })
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
        note: '未自动识别到当前页相关的 figure 编号。',
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
          ? '已按页面几何结构自动匹配当前 figure caption。'
          : '已识别 figure 编号，但未找到明确 caption 候选。',
    })
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'PDF 检索失败。',
    })
  }
})

app.post('/api/analyze-image', async (req, res) => {
  const { image, imageName, caption, question, selection } = req.body ?? {}

  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: '缺少图片数据。请先上传图片、粘贴截图，或导入 PDF。' })
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: '未配置 OPENAI_API_KEY。当前不会返回模拟结果，请配置真实 API key 后重试。',
    })
  }

  const regionText = selection
    ? `用户选择了图片显示坐标区域：x=${Math.round(selection.x)}, y=${Math.round(selection.y)}, width=${Math.round(selection.width)}, height=${Math.round(selection.height)}。`
    : '用户没有选择局部区域，请先分析整张图。'

  const prompt = [
    '你是科研论文图片理解助手。请帮助用户理解论文 figure。',
    '回答必须严格区分：图片中可见信息、系统提供的图注或正文证据、以及你的推断。',
    '先给短结论，再给依据和不确定点。不要编造图注、正文或实验条件。',
    `图片名称：${imageName || '未命名图片'}`,
    regionText,
    caption ? `系统自动检索到的图注或正文证据：\n${caption}` : '系统未检索到图注或正文证据。',
    `用户问题：${question || '这张图主要说明什么？'}`,
    '请用 JSON 返回，格式为 {"answer":"短结论","sources":["依据1","依据2"],"uncertainty":"不确定点"}。',
  ].join('\n\n')

  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
        text: {
          format: {
            type: 'json_schema',
            name: 'figure_analysis',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['answer', 'sources', 'uncertainty'],
              properties: {
                answer: { type: 'string' },
                sources: {
                  type: 'array',
                  items: { type: 'string' },
                },
                uncertainty: { type: 'string' },
              },
            },
            strict: true,
          },
        },
      }),
    })

    const payload = await response.json()
    if (!response.ok) {
      return res.status(response.status).json({
        error: payload.error?.message || `多模态模型调用失败：${baseUrl}`,
      })
    }

    const text = extractOutputText(payload)
    if (!text) {
      return res.status(502).json({
        error: '模型返回成功，但没有可解析的文本内容。',
      })
    }

    return res.json(JSON.parse(text))
  } catch (error) {
    return res.status(500).json({
      error: formatNetworkError(error),
    })
  }
})

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`)
  console.log(`Model endpoint: ${baseUrl}/v1/responses`)
})
