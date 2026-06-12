const MIN_FIGURE_WIDTH = 180
const MIN_FIGURE_HEIGHT = 120
const BUTTON_CLASS = 'litfig-button'
const OVERLAY_CLASS = 'litfig-overlay'
const PANEL_ID = 'litfig-panel'

const state = {
  buttons: new WeakMap(),
  pdfButton: null,
  activeOverlay: null,
  activeAnchor: null,
  raf: 0,
}

function removeExistingExtensionUi() {
  document
    .querySelectorAll(`.${BUTTON_CLASS}, .${OVERLAY_CLASS}, #${PANEL_ID}`)
    .forEach((element) => element.remove())
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve)
  })
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function viewportRectForElement(element) {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  }
}

function visibleRectForElement(element) {
  const rect = viewportRectForElement(element)
  if (!rect) return null

  const left = Math.max(0, rect.left)
  const top = Math.max(0, rect.top)
  const right = Math.min(window.innerWidth, rect.right)
  const bottom = Math.min(window.innerHeight, rect.bottom)

  if (right <= left || bottom <= top) return null
  return { left, top, width: right - left, height: bottom - top, right, bottom }
}

function toPageRect(rect) {
  return {
    left: rect.left + window.scrollX,
    top: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height,
    right: rect.left + window.scrollX + rect.width,
    bottom: rect.top + window.scrollY + rect.height,
  }
}

function getImageSourceUrl(image) {
  const source = image.currentSrc || image.src || ''
  if (!source || source.startsWith('blob:')) return ''
  if (source.startsWith('data:image/')) return source

  try {
    return new URL(source, document.baseURI).href
  } catch {
    return ''
  }
}

function getAnalysisImageUrls(image) {
  const sourceUrl = getImageSourceUrl(image)
  if (!sourceUrl || sourceUrl.startsWith('data:image/')) return sourceUrl ? [sourceUrl] : []

  const urls = []
  try {
    const parsed = new URL(sourceUrl)
    if (parsed.hostname === 'media.springernature.com') {
      const highRes = new URL(parsed.href)
      highRes.pathname = highRes.pathname.replace(/^\/lw\d+\//, '/lw1200/')
      urls.push(highRes.href)
    }
  } catch {
    // Keep the original URL fallback below.
  }

  urls.push(sourceUrl)
  return [...new Set(urls)]
}

function isCandidateImage(image) {
  const rect = viewportRectForElement(image)
  if (!rect || rect.width < MIN_FIGURE_WIDTH || rect.height < MIN_FIGURE_HEIGHT) return false
  if (image.closest(`.${PANEL_ID}, .${BUTTON_CLASS}, .${OVERLAY_CLASS}`)) return false
  const source = image.currentSrc || image.src || ''
  if (!source || source.startsWith('data:image/svg')) return false
  return true
}

function findNearbyCaption(image) {
  const figure = image.closest('figure')
  const figcaption = figure?.querySelector('figcaption')
  const parts = []

  if (figcaption?.innerText) parts.push(figcaption.innerText)
  if (image.alt) parts.push(`Alt text: ${image.alt}`)
  if (image.title) parts.push(`Title: ${image.title}`)

  const parentText = image.parentElement?.innerText?.trim()
  if (parentText && parentText.length < 2000) parts.push(parentText)

  const nextText = image.closest('p, div, section, article')?.nextElementSibling?.innerText?.trim()
  if (nextText && nextText.length < 1600) parts.push(nextText)

  return [...new Set(parts.map((item) => item.trim()).filter(Boolean))].join('\n\n').slice(0, 5000)
}

function collectCaptionCandidates(image) {
  const candidates = []
  const push = (text, source, confidence, isComplete = false, evidence = []) => {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (!normalized) return
    candidates.push({ text: normalized, source, confidence, isComplete, evidence })
  }

  const figure = image.closest('figure')
  const figcaption = figure?.querySelector('figcaption')
  push(figcaption?.innerText, 'html-figcaption', 0.84, true, ['closest figure > figcaption'])
  push(image.alt ? `Alt text: ${image.alt}` : '', 'alt', 0.26, false, ['img alt'])
  push(image.title ? `Title: ${image.title}` : '', 'alt', 0.22, false, ['img title'])

  const parentText = image.parentElement?.innerText?.trim()
  if (parentText && parentText.length < 2000) {
    push(parentText, 'nearby-text', 0.42, /^Fig(?:ure)?\.?\s*\d+/i.test(parentText), ['parent text'])
  }

  const nextText = image.closest('p, div, section, article')?.nextElementSibling?.innerText?.trim()
  if (nextText && nextText.length < 1600) {
    push(nextText, 'nearby-text', 0.36, /^Fig(?:ure)?\.?\s*\d+/i.test(nextText), ['next sibling text'])
  }

  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = `${candidate.source}:${candidate.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function collectVisiblePageText(limit = 8000) {
  return String(document.body?.innerText || document.documentElement?.innerText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function hashString(value) {
  let hash = 2166136261
  const text = String(value ?? '')
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function buildDocumentId(context) {
  return context?.documentId || hashString(`${location.origin}${location.pathname}:${document.title}`)
}

function buildImageFingerprint(image, figureImage, context) {
  return hashString(
    [
      figureImage?.sourceUrl || image?.currentSrc || image?.src || '',
      context?.figureLabel || '',
      context?.selectedCaption || '',
      figureImage?.naturalWidth || '',
      figureImage?.naturalHeight || '',
    ].join('|'),
  )
}

function getPdfUrlFromPage() {
  const currentUrl = window.location.href
  if (/\.pdf(?:[?#].*)?$/i.test(currentUrl)) return currentUrl

  const embeddedPdf = document.querySelector(
    'embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"]',
  )
  const source = embeddedPdf?.getAttribute('src') || embeddedPdf?.getAttribute('data') || ''
  if (!source) return ''

  try {
    return new URL(source, document.baseURI).href
  } catch {
    return ''
  }
}

function getCurrentPdfPageNumber() {
  const hashMatch = window.location.hash.match(/(?:page=|#page=)(\d+)/i)
  if (hashMatch) return Number(hashMatch[1])

  const pages = [...document.querySelectorAll('.page[data-page-number], [data-page-number]')]
    .map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        page: Number(element.getAttribute('data-page-number')),
        distance: Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2),
      }
    })
    .filter((entry) => Number.isFinite(entry.page))
    .sort((a, b) => a.distance - b.distance)

  return pages[0]?.page || 1
}

function detectBrowserPdfPage() {
  const pdfUrl = getPdfUrlFromPage()
  const hasPdfViewer =
    Boolean(pdfUrl) ||
    Boolean(document.querySelector('pdf-viewer, embed[type="application/pdf"], object[type="application/pdf"]')) ||
    Boolean(document.querySelector('.pdfViewer, .textLayer, .annotationLayer')) ||
    /\/viewer\.html(?:[?#]|$)/i.test(window.location.href)
  const canvasPages = document.querySelectorAll('canvas').length >= 1 && collectVisiblePageText(1200).length < 1200

  return {
    isPdf: hasPdfViewer || canvasPages,
    pdfUrl,
    currentPage: getCurrentPdfPageNumber(),
    reason: hasPdfViewer ? 'pdf-viewer' : canvasPages ? 'canvas-page' : 'none',
  }
}

async function fetchPdfDataUrlIfReadable(pdfUrl) {
  if (!pdfUrl || pdfUrl.startsWith('blob:')) return ''
  const response = await sendMessage({ type: 'fetch-pdf-data-url', url: pdfUrl })
  return response?.ok && response.dataUrl ? response.dataUrl : ''
}

async function requestFigureContext(payload) {
  const response = await sendMessage({ type: 'request-figure-context', payload })
  if (!response?.ok) {
    throw new Error(response?.payload?.error || `上下文匹配失败，状态码 ${response?.status ?? 0}`)
  }
  return response.payload
}

function buildAnalysisContextText(context, fallbackCaption = '') {
  const parts = []
  const caption = String(context?.selectedCaption || fallbackCaption || '').trim()

  if (caption) {
    parts.push(`Caption (${context?.captionSource || 'unknown'}, confidence ${context?.captionConfidence ?? 0}):\n${caption}`)
  }

  const bodyEvidence = Array.isArray(context?.bodyEvidence) ? context.bodyEvidence : []
  if (bodyEvidence.length > 0) {
    parts.push(
      `Body evidence:\n${bodyEvidence
        .slice(0, 4)
        .map((item, index) => {
          const refs = item.directReferences?.length ? ` [direct refs: ${item.directReferences.join(', ')}]` : ''
          return `${index + 1}. ${item.text}${refs}`
        })
        .join('\n')}`,
    )
  }

  if (context?.note) parts.push(`Context note:\n${context.note}`)
  return parts.join('\n\n')
}

function loadDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取图片数据'))
    image.src = dataUrl
  })
}

async function cropVisibleFigureScreenshot(rect) {
  document.documentElement.classList.add('litfig-capturing')
  let capture
  try {
    await new Promise((resolve) => window.setTimeout(resolve, 40))
    capture = await sendMessage({ type: 'capture-visible-tab' })
  } finally {
    document.documentElement.classList.remove('litfig-capturing')
  }

  if (!capture?.ok || !capture.dataUrl) {
    throw new Error(capture?.error || '无法截取当前标签页')
  }

  const screenshot = await loadDataUrl(capture.dataUrl)
  const scaleX = screenshot.naturalWidth / window.innerWidth
  const scaleY = screenshot.naturalHeight / window.innerHeight
  const sourceX = Math.max(0, Math.round(rect.left * scaleX))
  const sourceY = Math.max(0, Math.round(rect.top * scaleY))
  const sourceWidth = Math.max(1, Math.round(rect.width * scaleX))
  const sourceHeight = Math.max(1, Math.round(rect.height * scaleY))
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')

  if (!context) throw new Error('无法创建图片裁剪画布')

  canvas.width = Math.min(sourceWidth, screenshot.naturalWidth - sourceX)
  canvas.height = Math.min(sourceHeight, screenshot.naturalHeight - sourceY)
  context.drawImage(
    screenshot,
    sourceX,
    sourceY,
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  )

  return canvas.toDataURL('image/png')
}

async function getImageForAnalysis(image, visibleRect) {
  const sourceUrls = getAnalysisImageUrls(image)
  const sourceUrl = sourceUrls[0] || ''

  if (sourceUrl.startsWith('data:image/')) {
    return {
      dataUrl: sourceUrl,
      mode: 'image-source',
      naturalWidth: image.naturalWidth || null,
      naturalHeight: image.naturalHeight || null,
    }
  }

  for (const candidateUrl of sourceUrls) {
    const response = await sendMessage({ type: 'fetch-image-data-url', url: candidateUrl })
    if (response?.ok && response.dataUrl) {
      return {
        dataUrl: response.dataUrl,
        mode: 'image-source',
        sourceUrl: candidateUrl,
        naturalWidth: image.naturalWidth || null,
        naturalHeight: image.naturalHeight || null,
      }
    }
  }

  return {
    dataUrl: await cropVisibleFigureScreenshot(visibleRect),
    mode: 'visible-screenshot',
    screenshotRect: visibleRect,
  }
}

function parseObjectPosition(value) {
  const tokens = String(value || '50% 50%').trim().split(/\s+/)
  const keywordToPercent = {
    left: 0,
    top: 0,
    center: 50,
    right: 100,
    bottom: 100,
  }

  const parseToken = (token, fallback) => {
    if (token in keywordToPercent) return keywordToPercent[token]
    const match = token.match(/^(-?\d+(?:\.\d+)?)%$/)
    return match ? Number(match[1]) : fallback
  }

  return {
    x: parseToken(tokens[0], 50),
    y: parseToken(tokens[1] ?? tokens[0], 50),
  }
}

function getImageContentRect(image) {
  const rect = viewportRectForElement(image)
  if (!rect) return null

  const style = getComputedStyle(image)
  const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0
  const borderRight = Number.parseFloat(style.borderRightWidth) || 0
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0
  const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
  const paddingRight = Number.parseFloat(style.paddingRight) || 0
  const paddingTop = Number.parseFloat(style.paddingTop) || 0
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0

  const content = {
    left: rect.left + borderLeft + paddingLeft,
    top: rect.top + borderTop + paddingTop,
    width: Math.max(1, rect.width - borderLeft - borderRight - paddingLeft - paddingRight),
    height: Math.max(1, rect.height - borderTop - borderBottom - paddingTop - paddingBottom),
  }

  const naturalWidth = image.naturalWidth || content.width
  const naturalHeight = image.naturalHeight || content.height
  const objectFit = style.objectFit || 'fill'
  const position = parseObjectPosition(style.objectPosition)

  if (objectFit === 'contain' || objectFit === 'scale-down') {
    const scale = Math.min(content.width / naturalWidth, content.height / naturalHeight)
    const renderedWidth = naturalWidth * scale
    const renderedHeight = naturalHeight * scale
    return {
      left: content.left + (content.width - renderedWidth) * (position.x / 100),
      top: content.top + (content.height - renderedHeight) * (position.y / 100),
      width: renderedWidth,
      height: renderedHeight,
      clipRect: content,
      objectFit,
    }
  }

  if (objectFit === 'cover') {
    const scale = Math.max(content.width / naturalWidth, content.height / naturalHeight)
    const renderedWidth = naturalWidth * scale
    const renderedHeight = naturalHeight * scale
    return {
      left: content.left + (content.width - renderedWidth) * (position.x / 100),
      top: content.top + (content.height - renderedHeight) * (position.y / 100),
      width: renderedWidth,
      height: renderedHeight,
      clipRect: content,
      objectFit,
    }
  }

  return {
    ...content,
    clipRect: content,
    objectFit,
  }
}

function clampBox(box = {}) {
  const x = Math.max(0, Math.min(1000, Number(box.x) || 0))
  const y = Math.max(0, Math.min(1000, Number(box.y) || 0))
  const width = Math.max(1, Math.min(1000 - x, Number(box.width) || 1))
  const height = Math.max(1, Math.min(1000 - y, Number(box.height) || 1))
  return { x, y, width, height }
}

function smoothDensities(values, radius = 2) {
  return values.map((_, index) => {
    let total = 0
    let count = 0
    for (let offset = -radius; offset <= radius; offset += 1) {
      const value = values[index + offset]
      if (typeof value === 'number') {
        total += value
        count += 1
      }
    }
    return count ? total / count : 0
  })
}

function buildDensitySegments(values, threshold, minLength) {
  const segments = []
  let start = null

  values.forEach((value, index) => {
    if (value >= threshold) {
      if (start === null) start = index
    } else if (start !== null) {
      if (index - start >= minLength) segments.push({ start, end: index - 1 })
      start = null
    }
  })

  if (start !== null && values.length - start >= minLength) {
    segments.push({ start, end: values.length - 1 })
  }

  return segments
}

function findNearestSegment(segments, center, tolerance) {
  let best = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const segment of segments) {
    const segmentCenter = (segment.start + segment.end) / 2
    const distance =
      center < segment.start ? segment.start - center : center > segment.end ? center - segment.end : 0
    const centerDistance = Math.abs(segmentCenter - center)
    const rank = distance * 10 + centerDistance

    if (distance <= tolerance && rank < bestDistance) {
      best = segment
      bestDistance = rank
    }
  }

  return best
}

function percentile(values, ratio) {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * ratio)))]
}

async function refineGridLikeAnnotations(imageDataUrl, annotations) {
  if (!annotations || annotations.length < 5) return annotations || []

  const narrowCount = annotations.filter((annotation) => {
    const box = clampBox(annotation.bbox)
    return box.width < 150 || box.height < 150
  }).length
  if (narrowCount < 4) return annotations

  const image = await loadDataUrl(imageDataUrl)
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return annotations

  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  context.drawImage(image, 0, 0)

  const { width, height } = canvas
  if (width < 80 || height < 80) return annotations

  const pixels = context.getImageData(0, 0, width, height).data
  const columnDensity = new Array(width).fill(0)
  const rowDensity = new Array(height).fill(0)

  for (let y = 0; y < height; y += 1) {
    let rowInk = 0
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const r = pixels[index]
      const g = pixels[index + 1]
      const b = pixels[index + 2]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const isInk = max < 245 || max - min > 24
      if (isInk) {
        columnDensity[x] += 1
        rowInk += 1
      }
    }
    rowDensity[y] = rowInk / width
  }

  for (let x = 0; x < width; x += 1) {
    columnDensity[x] /= height
  }

  const smoothedColumns = smoothDensities(columnDensity, 2)
  const smoothedRows = smoothDensities(rowDensity, 2)
  const columnThreshold = Math.max(0.035, percentile(smoothedColumns, 0.35) * 0.75)
  const rowThreshold = Math.max(0.035, percentile(smoothedRows, 0.35) * 0.75)
  const columnSegments = buildDensitySegments(smoothedColumns, columnThreshold, Math.max(8, width * 0.025))
  const rowSegments = buildDensitySegments(smoothedRows, rowThreshold, Math.max(8, height * 0.025))

  if (columnSegments.length < 2 || rowSegments.length < 2) return annotations

  return annotations.map((annotation) => {
    const box = clampBox(annotation.bbox)
    const pixelBox = {
      x: (box.x / 1000) * width,
      y: (box.y / 1000) * height,
      width: (box.width / 1000) * width,
      height: (box.height / 1000) * height,
    }
    const isSuspiciouslyNarrow = box.width < 170 || box.height < 170
    if (!isSuspiciouslyNarrow) return annotation

    const centerX = pixelBox.x + pixelBox.width / 2
    const centerY = pixelBox.y + pixelBox.height / 2
    const xSegment = findNearestSegment(columnSegments, centerX, width * 0.09)
    const ySegment = findNearestSegment(rowSegments, centerY, height * 0.09)
    if (!xSegment || !ySegment) return annotation

    const expandedWidth = xSegment.end - xSegment.start + 1
    const expandedHeight = ySegment.end - ySegment.start + 1
    if (expandedWidth < pixelBox.width * 1.15 && expandedHeight < pixelBox.height * 1.15) {
      return annotation
    }
    if (expandedWidth > width * 0.45 || expandedHeight > height * 0.45) {
      return annotation
    }

    const padX = Math.max(1, width * 0.006)
    const padY = Math.max(1, height * 0.006)
    const refined = {
      x: Math.max(0, xSegment.start - padX),
      y: Math.max(0, ySegment.start - padY),
      width: Math.min(width, xSegment.end - xSegment.start + 1 + padX * 2),
      height: Math.min(height, ySegment.end - ySegment.start + 1 + padY * 2),
    }

    return {
      ...annotation,
      bbox: clampBox({
        x: (refined.x / width) * 1000,
        y: (refined.y / height) * 1000,
        width: (refined.width / width) * 1000,
        height: (refined.height / height) * 1000,
      }),
    }
  })
}

function mapNormalizedBoxToViewport(box, imageRect) {
  const normalized = clampBox(box)
  const x = imageRect.left + (normalized.x / 1000) * imageRect.width
  const y = imageRect.top + (normalized.y / 1000) * imageRect.height
  const width = (normalized.width / 1000) * imageRect.width
  const height = (normalized.height / 1000) * imageRect.height

  if (!imageRect.clipRect) {
    return { left: x, top: y, width, height }
  }

  const clippedLeft = Math.max(x, imageRect.clipRect.left)
  const clippedTop = Math.max(y, imageRect.clipRect.top)
  const clippedRight = Math.min(x + width, imageRect.clipRect.left + imageRect.clipRect.width)
  const clippedBottom = Math.min(y + height, imageRect.clipRect.top + imageRect.clipRect.height)

  if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return null
  return {
    left: clippedLeft,
    top: clippedTop,
    width: clippedRight - clippedLeft,
    height: clippedBottom - clippedTop,
  }
}

function clearOverlay() {
  document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((element) => element.remove())
  state.activeOverlay = null
  state.activeAnchor = null
}

function ensureOverlay() {
  if (state.activeOverlay?.isConnected) return state.activeOverlay

  const overlay = document.createElement('div')
  overlay.className = OVERLAY_CLASS
  document.documentElement.append(overlay)
  state.activeOverlay = overlay
  return overlay
}

function updateActiveOverlay() {
  if (!state.activeAnchor) return

  const { image, annotations, mode, screenshotRect } = state.activeAnchor
  const overlay = ensureOverlay()
  const imageRect =
    mode === 'image-source'
      ? getImageContentRect(image)
      : screenshotRect
        ? screenshotRect
        : null

  if (!imageRect) {
    overlay.style.display = 'none'
    return
  }

  overlay.style.display = 'block'
  const pageBase = toPageRect(imageRect.clipRect || imageRect)
  overlay.style.left = `${pageBase.left}px`
  overlay.style.top = `${pageBase.top}px`
  overlay.style.width = `${pageBase.width}px`
  overlay.style.height = `${pageBase.height}px`

  const baseViewport = imageRect.clipRect || imageRect
  overlay.querySelectorAll('.litfig-box').forEach((element, index) => {
    const mapped = mapNormalizedBoxToViewport(annotations[index]?.bbox, imageRect)
    if (!mapped) {
      element.style.display = 'none'
      return
    }

    element.style.display = 'block'
    element.style.left = `${mapped.left - baseViewport.left}px`
    element.style.top = `${mapped.top - baseViewport.top}px`
    element.style.width = `${mapped.width}px`
    element.style.height = `${mapped.height}px`
    element.classList.toggle('tooltip-left', mapped.left + mapped.width + 280 > window.innerWidth)
    element.classList.toggle('tooltip-above', mapped.top + 190 > window.innerHeight)
  })
}

function scheduleOverlayUpdate() {
  window.cancelAnimationFrame(state.raf)
  state.raf = window.requestAnimationFrame(() => {
    updateActiveOverlay()
    scanImages()
  })
}

function renderAnnotations(anchor) {
  clearOverlay()

  state.activeAnchor = anchor
  const overlay = ensureOverlay()
  overlay.innerHTML = ''

  anchor.annotations.forEach((annotation, index) => {
    const element = document.createElement('div')
    element.className = 'litfig-box'
    element.innerHTML = `
      <span class="litfig-box-number">${index + 1}</span>
      <span class="litfig-tooltip">
        <strong>${escapeHtml(annotation.label || `Panel ${index + 1}`)}</strong>
        <span>看什么：${escapeHtml(annotation.what || '')}</span>
        <span>怎么看：${escapeHtml(annotation.howToRead || '')}</span>
        <span>说明：${escapeHtml(annotation.meaning || '')}</span>
      </span>
    `
    overlay.append(element)
  })

  updateActiveOverlay()
}

function renderPanel(content) {
  let panel = document.getElementById(PANEL_ID)
  if (!panel) {
    panel = document.createElement('aside')
    panel.id = PANEL_ID
    panel.className = 'litfig-panel'
    document.documentElement.append(panel)
  }
  panel.innerHTML = content
  panel.querySelector('[data-litfig-close]')?.addEventListener('click', () => panel.remove())
  return panel
}

function renderLoadingPanel(modeText = '正在获取图片并调用本地 AI 解析服务...') {
  renderPanel(`
    <header>
      <h2>图片解析</h2>
      <button type="button" data-litfig-close>关闭</button>
    </header>
    <p class="litfig-status">${escapeHtml(modeText)}</p>
  `)
}

async function saveAnalysisRecord(record) {
  const response = await sendMessage({ type: 'save-analysis', payload: record })
  if (!response?.ok) {
    throw new Error(response?.payload?.error || `保存失败，状态码 ${response?.status ?? 0}`)
  }
  return response.payload
}

function bindSaveButton(record) {
  const button = document.querySelector('[data-litfig-save]')
  const status = document.querySelector('[data-litfig-save-status]')
  if (!button) return

  button.addEventListener('click', async () => {
    button.disabled = true
    if (status) status.textContent = '正在保存...'
    try {
      const saved = await saveAnalysisRecord(record)
      if (status) status.textContent = `已保存：版本 ${saved.version || 1}`
    } catch (error) {
      if (status) status.textContent = error instanceof Error ? error.message : '保存失败'
      button.disabled = false
    }
  })
}

function renderResultPanel(result, mode, saveRecord = null) {
  const sources = (result.sources || [])
    .slice(0, 4)
    .map((source) => `<li>${escapeHtml(source)}</li>`)
    .join('')
  const modeText =
    mode === 'image-source'
      ? `当前红框绑定在网页图片元素上，滚动或缩放页面时会重新对齐。${result.__analysisSource ? `分析源：${result.__analysisSource}` : ''}`
      : '当前使用截图 fallback；如果网页图片资源可读取，原图模式会更清晰。'
  const contextText = result.__context
    ? `上下文：${result.__context.sourceType || 'unknown'}；图注来源：${result.__context.captionSource || 'none'}；${result.__context.note || ''}`
    : ''

  renderPanel(`
    <header>
      <h2>图片解析</h2>
      <button type="button" data-litfig-close>关闭</button>
    </header>
    <p>${escapeHtml(result.answer || '没有返回总解释。')}</p>
    ${sources ? `<strong>依据</strong><ul>${sources}</ul>` : ''}
    <strong>不确定点</strong>
    <p>${escapeHtml(result.uncertainty || '未说明。')}</p>
    ${contextText ? `<p class="litfig-status">${escapeHtml(contextText)}</p>` : ''}
    ${
      saveRecord
        ? '<button type="button" data-litfig-save>保存本次解读</button><p class="litfig-status" data-litfig-save-status>保存后可通过本地后端解析库找回。</p>'
        : ''
    }
    <p class="litfig-status">图上红框可悬停查看每个 panel 的简短解释。${escapeHtml(modeText)}</p>
  `)
  if (saveRecord) bindSaveButton(saveRecord)
}

function renderErrorPanel(message) {
  renderPanel(`
    <header>
      <h2>图片解析</h2>
      <button type="button" data-litfig-close>关闭</button>
    </header>
    <p class="litfig-error">${escapeHtml(message)}</p>
    <p class="litfig-status">请确认本地后端正在运行：<code>http://127.0.0.1:8787</code></p>
  `)
}

async function analyzeImage(image) {
  const rect = visibleRectForElement(image)
  if (!rect) return

  renderLoadingPanel()

  try {
    image.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    await new Promise((resolve) => window.setTimeout(resolve, 120))
    const freshRect = visibleRectForElement(image)
    if (!freshRect) throw new Error('图片不在当前可见区域内')

    const figureImage = await getImageForAnalysis(image, freshRect)
    const caption = findNearbyCaption(image)
    const pdfInfo = detectBrowserPdfPage()
    const context = await requestFigureContext({
      sourceType: pdfInfo.isPdf ? 'pdf' : 'html',
      pageUrl: window.location.href,
      title: document.title,
      currentPage: pdfInfo.currentPage,
      pdf: pdfInfo.isPdf ? await fetchPdfDataUrlIfReadable(pdfInfo.pdfUrl) : '',
      pdfUrl: pdfInfo.pdfUrl,
      imageUrl: image.currentSrc || image.src || '',
      imageRect: freshRect,
      captionCandidates: collectCaptionCandidates(image),
      nearbyBodyText: caption,
      pageText: collectVisiblePageText(),
      pdfDetectionReason: pdfInfo.reason,
    })
    const response = await sendMessage({
      type: 'analyze-figure',
      payload: {
        image: figureImage.dataUrl,
        imageName: image.currentSrc || image.src || document.title || 'webpage figure',
        caption: buildAnalysisContextText(context, caption),
        question:
          figureImage.mode === 'image-source'
            ? '请解释这张论文图片。输入是网页图片原图，标注框坐标必须相对于这张原图。只给主 panel 字母（例如 a,b,c 或 A,B,C）对应的可见 panel 画框；不要给 panel 内部的小图、单个网格格子、单条曲线、单组散点或局部元素单独画框。每个框必须包住该主 panel 的完整内容，边缘应落在 panel 之间的白色空隙或外侧留白中，不要压住本 panel 的数据、坐标轴、文字，也不要覆盖相邻 panel。'
            : '请解释这张论文图片。输入是网页上当前显示的图片区域截图，不包含网页正文和扩展按钮；标注框坐标必须相对于这个截图区域。只给主 panel 字母（例如 a,b,c 或 A,B,C）对应的可见 panel 画框；不要给 panel 内部的小图、单个网格格子、单条曲线、单组散点或局部元素单独画框。每个框必须包住该主 panel 的完整内容，边缘应落在 panel 之间的白色空隙或外侧留白中，不要压住本 panel 的数据、坐标轴、文字，也不要覆盖相邻 panel。',
        selection: null,
      },
    })

    if (!response?.ok) {
      throw new Error(response?.payload?.error || `解析失败，状态码 ${response?.status ?? 0}`)
    }

    const annotations = await refineGridLikeAnnotations(
      figureImage.dataUrl,
      response.payload?.annotations || [],
    )
    const payload = response.payload || {}
    const saveRecord = {
      documentId: buildDocumentId(context),
      figureId: context.figureLabel ? `Fig. ${context.figureLabel}` : null,
      imageFingerprint: buildImageFingerprint(image, figureImage, context),
      imageUrl: figureImage.sourceUrl || image.currentSrc || image.src || '',
      pageUrl: window.location.href,
      source: 'browser-extension',
      answer: payload.answer || '',
      uncertainty: payload.uncertainty || '',
      sources: payload.sources || [],
      annotations,
      context,
    }
    renderAnnotations({
      image,
      annotations,
      mode: figureImage.mode,
      screenshotRect: figureImage.screenshotRect || null,
    })
    renderResultPanel(
      {
        ...(response.payload || {}),
        __analysisSource: figureImage.sourceUrl || '',
        __context: context,
      },
      figureImage.mode,
      saveRecord,
    )
  } catch (error) {
    renderErrorPanel(error instanceof Error ? error.message : '解析失败')
  }
}

async function analyzeVisiblePdfPage() {
  renderLoadingPanel('正在截取当前 PDF 页面并匹配全文图注/正文证据...')

  try {
    const pdfInfo = detectBrowserPdfPage()
    if (!pdfInfo.isPdf) throw new Error('当前页面没有检测到 PDF 阅读器')

    const rect = {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      right: window.innerWidth,
      bottom: window.innerHeight,
    }
    const imageDataUrl = await cropVisibleFigureScreenshot(rect)
    const pdfDataUrl = await fetchPdfDataUrlIfReadable(pdfInfo.pdfUrl)
    const context = await requestFigureContext({
      sourceType: 'pdf',
      pageUrl: window.location.href,
      title: document.title,
      currentPage: pdfInfo.currentPage,
      pdf: pdfDataUrl,
      pdfUrl: pdfInfo.pdfUrl,
      pageText: collectVisiblePageText(),
      pdfDetectionReason: pdfInfo.reason,
    })
    const response = await sendMessage({
      type: 'analyze-figure',
      payload: {
        image: imageDataUrl,
        imageName: `${document.title || 'browser PDF'} page ${pdfInfo.currentPage}`,
        caption: buildAnalysisContextText(context),
        question:
          '请解释当前浏览器 PDF 可见区域中的论文图片。输入是当前可见页面截图，标注框坐标必须相对于这个截图区域。优先解释用户当前正在看的主 figure 或可见 panel；只给主 panel 字母对应的可见 panel 画框。每个框必须包住该主 panel 的完整内容，边缘应落在 panel 之间的白色空隙或外侧留白中。',
        selection: null,
      },
    })

    if (!response?.ok) {
      throw new Error(response?.payload?.error || `解析失败，状态码 ${response?.status ?? 0}`)
    }

    const annotations = await refineGridLikeAnnotations(imageDataUrl, response.payload?.annotations || [])
    const payload = response.payload || {}
    const saveRecord = {
      documentId: buildDocumentId(context),
      figureId: context.figureLabel ? `Fig. ${context.figureLabel}` : `PDF page ${pdfInfo.currentPage}`,
      imageFingerprint: hashString(`${window.location.href}|${pdfInfo.currentPage}|${context.selectedCaption || ''}`),
      imageUrl: pdfInfo.pdfUrl || '',
      pageUrl: window.location.href,
      source: 'browser-extension',
      answer: payload.answer || '',
      uncertainty: payload.uncertainty || '',
      sources: payload.sources || [],
      annotations,
      context,
    }
    renderAnnotations({
      image: null,
      annotations,
      mode: 'visible-screenshot',
      screenshotRect: rect,
    })
    renderResultPanel(
      {
        ...(response.payload || {}),
        __analysisSource: pdfInfo.pdfUrl || 'visible PDF screenshot',
        __context: context,
      },
      'visible-screenshot',
      saveRecord,
    )
  } catch (error) {
    renderErrorPanel(error instanceof Error ? error.message : 'PDF 解析失败')
  }
}

function placeButton(image) {
  if (!isCandidateImage(image)) return

  let button = state.buttons.get(image)
  if (!button) {
    button = document.createElement('button')
    button.type = 'button'
    button.className = BUTTON_CLASS
    button.textContent = '解析图'
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void analyzeImage(image)
    })
    document.documentElement.append(button)
    state.buttons.set(image, button)
  }

  const rect = viewportRectForElement(image)
  if (!rect) {
    button.style.display = 'none'
    return
  }

  button.style.left = `${window.scrollX + rect.left + 8}px`
  button.style.top = `${window.scrollY + rect.top + 8}px`
  button.style.display = 'block'
}

function scanImages() {
  document.querySelectorAll('img').forEach(placeButton)
  placePdfButton()
}

function placePdfButton() {
  const pdfInfo = detectBrowserPdfPage()
  if (!pdfInfo.isPdf) {
    state.pdfButton?.remove()
    state.pdfButton = null
    return
  }

  if (!state.pdfButton?.isConnected) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `${BUTTON_CLASS} litfig-pdf-button`
    button.textContent = '解析当前PDF'
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void analyzeVisiblePdfPage()
    })
    document.documentElement.append(button)
    state.pdfButton = button
  }

  state.pdfButton.style.left = '16px'
  state.pdfButton.style.top = '16px'
  state.pdfButton.style.display = 'block'
}

function scheduleScan() {
  window.cancelAnimationFrame(state.raf)
  state.raf = window.requestAnimationFrame(scanImages)
}

removeExistingExtensionUi()
scanImages()
window.addEventListener('scroll', scheduleOverlayUpdate, { passive: true })
window.addEventListener('resize', scheduleOverlayUpdate)

const resizeObserver = new ResizeObserver(scheduleOverlayUpdate)
document.querySelectorAll('img').forEach((image) => resizeObserver.observe(image))

const observer = new MutationObserver(() => {
  document.querySelectorAll('img').forEach((image) => resizeObserver.observe(image))
  scheduleScan()
  scheduleOverlayUpdate()
})
observer.observe(document.documentElement, { childList: true, subtree: true })
