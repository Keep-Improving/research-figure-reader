import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const app = express()
const port = Number(process.env.PORT || 8787)
const model = process.env.OPENAI_MODEL || 'gpt-5.4'
const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')

app.use(cors())
app.use(express.json({ limit: '80mb' }))

function sendJsonError(res, status, message, extra = {}) {
  return res.status(status).json({
    error: message,
    ...extra,
  })
}

function formatNetworkError(error) {
  if (!(error instanceof Error)) {
    return `Model request failed: ${baseUrl}`
  }

  const causeMessage =
    typeof error.cause === 'object' && error.cause && 'message' in error.cause
      ? String(error.cause.message)
      : ''

  if (causeMessage.includes('Connect Timeout') || causeMessage.includes('ETIMEDOUT')) {
    return `Connection to model endpoint timed out: ${baseUrl}`
  }

  return causeMessage || error.message || `Model request failed: ${baseUrl}`
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
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1))
    }
    throw new Error('Model returned text that is not valid JSON.')
  }
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

function getCaptionFlowMode(page, startLine) {
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

  for (let index = startRowIndex; index < orderedRows.length; index += 1) {
    const row = orderedRows[index]
    const gap = previousY - row.y

    if (index > startRowIndex && gap > Math.max(13.5, startLine.height * 1.8 + 4)) {
      break
    }

    const rowText = normalizeWhitespace(row.lines.map((line) => line.text).join(' '))
    if (index > startRowIndex && looksLikeSectionBoundary(rowText)) break
    if (index > startRowIndex && getCaptionStart(rowText)) break

    captionRows.push(row)
    previousY = row.y
  }

  return captionRows.flatMap((row) => row.lines.sort((a, b) => a.x - b.x))
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

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]
    const gap = previous.y - line.y

    if (index > startIndex && gap > Math.max(15, Math.max(previous.height, line.height) * 1.45 + 3)) {
      break
    }

    if (index > startIndex && getCaptionStart(line.text)) break

    captionLines.push(line)
    previous = line
  }

  return captionLines
}

function buildMultiColumnCaptionLines(page, startLine) {
  const startColumn = lineColumn(startLine, page)
  const otherColumn = startColumn === 0 ? 1 : 0
  const startColumnLines = buildCaptionColumnLines(page, startLine, startColumn)
  const companionLines = buildCaptionColumnLines(page, startLine, otherColumn)

  if (companionLines.length === 0) return startColumnLines

  const startColumnBottom = Math.min(...startColumnLines.map((line) => line.y))
  const companionTop = Math.max(...companionLines.map((line) => line.y))
  const companionStartsNearCaption =
    companionTop <= startLine.y + 3 &&
    companionTop >= startLine.y - Math.max(32, startLine.height * 3)
  const companionNotBodyBelow = companionTop >= startColumnBottom - Math.max(12, startLine.height * 1.4)

  if (!companionStartsNearCaption || !companionNotBodyBelow) {
    return startColumnLines
  }

  return startColumn === 0
    ? [...startColumnLines, ...companionLines]
    : [...companionLines, ...startColumnLines]
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
  const captionLines =
    layoutMode === 'single-flow'
      ? buildSingleFlowCaptionLines(page, startLine)
      : buildMultiColumnCaptionLines(page, startLine)
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

app.post('/api/analyze-image', async (req, res) => {
  const { image, imageName, caption, question, selection } = req.body ?? {}

  if (!image || typeof image !== 'string') {
    return sendJsonError(res, 400, 'Missing image payload. Upload an image or import a PDF first.')
  }

  if (!process.env.OPENAI_API_KEY) {
    return sendJsonError(
      res,
      503,
      'OPENAI_API_KEY is not configured. The app does not use mock responses.',
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
    'One annotation should correspond to exactly one panel or one visual element inside a panel. Do not merge multiple panels into one annotation box.',
    'For panel-level annotations, the box should enclose the full panel content including axes, labels, legends, blot lanes, microscopy tiles, and panel letter when that letter is visually part of the panel. Put the box edges in the white gutter or outside margin around the panel; do not place edges over data marks, axis labels, blot bands, microscopy content, or nearby panels.',
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
            },
            strict: true,
          },
        },
      }),
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
        `Multimodal request failed: ${baseUrl}`

      return sendJsonError(res, response.status, upstreamMessage)
    }

    if (!payload) {
      return sendJsonError(res, 502, 'Upstream service returned a non-JSON success response.')
    }

    let output = extractOutputPayload(payload)
    if (!output) {
      const retryResponse = await fetch(`${baseUrl}/v1/responses`, {
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
                {
                  type: 'input_text',
                  text: `${prompt}\n\nReturn only a valid JSON object. Do not wrap it in markdown.`,
                },
                { type: 'input_image', image_url: image },
              ],
            },
          ],
        }),
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
    return sendJsonError(res, 500, formatNetworkError(error))
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

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`)
  console.log(`Model endpoint: ${baseUrl}/v1/responses`)
})
