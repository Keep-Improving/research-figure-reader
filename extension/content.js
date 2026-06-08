const MIN_FIGURE_WIDTH = 180
const MIN_FIGURE_HEIGHT = 120
const BUTTON_CLASS = 'litfig-button'
const OVERLAY_CLASS = 'litfig-overlay'
const PANEL_ID = 'litfig-panel'

const state = {
  buttons: new WeakMap(),
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
  await new Promise((resolve) => window.setTimeout(resolve, 40))
  const capture = await sendMessage({ type: 'capture-visible-tab' })
  document.documentElement.classList.remove('litfig-capturing')

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
  const sourceUrl = getImageSourceUrl(image)

  if (sourceUrl.startsWith('data:image/')) {
    return {
      dataUrl: sourceUrl,
      mode: 'image-source',
      naturalWidth: image.naturalWidth || null,
      naturalHeight: image.naturalHeight || null,
    }
  }

  if (sourceUrl) {
    const response = await sendMessage({ type: 'fetch-image-data-url', url: sourceUrl })
    if (response?.ok && response.dataUrl) {
      return {
        dataUrl: response.dataUrl,
        mode: 'image-source',
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
        ? visibleRectForElement(image)
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

function renderResultPanel(result, mode) {
  const sources = (result.sources || [])
    .slice(0, 4)
    .map((source) => `<li>${escapeHtml(source)}</li>`)
    .join('')
  const modeText =
    mode === 'image-source'
      ? '当前红框绑定在网页图片元素上，滚动或缩放页面时会重新对齐。'
      : '当前使用截图 fallback；如果网页图片资源可读取，原图模式会更清晰。'

  renderPanel(`
    <header>
      <h2>图片解析</h2>
      <button type="button" data-litfig-close>关闭</button>
    </header>
    <p>${escapeHtml(result.answer || '没有返回总解释。')}</p>
    ${sources ? `<strong>依据</strong><ul>${sources}</ul>` : ''}
    <strong>不确定点</strong>
    <p>${escapeHtml(result.uncertainty || '未说明。')}</p>
    <p class="litfig-status">图上红框可悬停查看每个 panel 的简短解释。${escapeHtml(modeText)}</p>
  `)
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
    const response = await sendMessage({
      type: 'analyze-figure',
      payload: {
        image: figureImage.dataUrl,
        imageName: image.currentSrc || image.src || document.title || 'webpage figure',
        caption,
        question:
          figureImage.mode === 'image-source'
            ? '请解释这张论文图片。输入是网页图片原图，标注框坐标必须相对于这张原图。请尽量给每个可见 panel 一个标注框；每个框必须刚好包住该 panel 的完整内容，边缘应落在 panel 之间的白色空隙或外侧留白中，不要压住本 panel 的数据、坐标轴、文字，也不要覆盖相邻 panel。不要把多个 panel 合并成一个框，并给出总解释。'
            : '请解释这张论文图片。输入是网页上当前显示的图片区域截图，不包含网页正文和扩展按钮；标注框坐标必须相对于这个截图区域。请尽量给每个可见 panel 一个标注框；每个框必须刚好包住该 panel 的完整内容，边缘应落在 panel 之间的白色空隙或外侧留白中，不要压住本 panel 的数据、坐标轴、文字，也不要覆盖相邻 panel。不要把多个 panel 合并成一个框，并给出总解释。',
        selection: null,
      },
    })

    if (!response?.ok) {
      throw new Error(response?.payload?.error || `解析失败，状态码 ${response?.status ?? 0}`)
    }

    const annotations = response.payload?.annotations || []
    renderAnnotations({
      image,
      annotations,
      mode: figureImage.mode,
      screenshotRect: figureImage.screenshotRect || null,
    })
    renderResultPanel(response.payload || {}, figureImage.mode)
  } catch (error) {
    renderErrorPanel(error instanceof Error ? error.message : '解析失败')
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
