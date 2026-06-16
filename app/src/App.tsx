import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, PointerEvent } from 'react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import './App.css'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')

function apiUrl(path: string) {
  return `${API_BASE_URL}${path}`
}

type Selection = {
  x: number
  y: number
  width: number
  height: number
}

type FigureAnnotation = {
  label: string
  what: string
  howToRead: string
  meaning: string
  bbox: Selection
  confidence: number
  evidenceType: 'visible' | 'caption' | 'body' | 'inference' | 'uncertain'
}

type AnnotationDragState = {
  index: number
  mode: 'move' | 'resize'
  pointerId: number
  startClientX: number
  startClientY: number
  startBox: Selection
  imageWidth: number
  imageHeight: number
}

type AnalysisResult = {
  answer: string
  sources: string[]
  uncertainty: string
  annotations: FigureAnnotation[]
}

type PdfEvidence = {
  pageNumber: number
  text: string
  score?: number
  directReferences?: string[]
  matchedKeywords?: string[]
  matchReason?: 'direct_figure_reference' | 'caption_keyword_proximity' | 'near_caption_page'
  layoutMode?: string
  stopReason?: string
  region?: {
    topY: number
    bottomY: number
    startY: number
  }
}

type PdfInspectResult = {
  figureLabel: string | null
  captionCandidates: PdfEvidence[]
  bodyEvidence: PdfEvidence[]
  note: string
}

type FigureIndexEntry = {
  figureLabel: string
  captionCandidates: PdfEvidence[]
  bodyEvidence: PdfEvidence[]
  pages: number[]
  score: number
}

type PdfIndexResult = {
  figures: FigureIndexEntry[]
  currentFigureLabel: string | null
  note: string
  sourceHash?: string
}

type VisualSource = {
  name: string
  kind: 'image' | 'pdf'
  type: string
  dataUrl: string
  originalDataUrl?: string
}

type PdfState = {
  documentProxy: PDFDocumentProxy
  name: string
  totalPages: number
  currentPage: number
}

type AnalysisRecord = {
  id: string
  documentId: string | null
  figureId: string | null
  imageFingerprint: string | null
  imageUrl: string | null
  paper?: {
    title?: string
    doi?: string
    pmid?: string
    pmcid?: string
    arxivId?: string
    sourceUrl?: string
    pdfHash?: string
    pdfDataUrl?: string
    journal?: string
    year?: string
  }
  figure?: {
    figureLabel?: string
    captionText?: string
    captionSource?: string
    pageNumber?: number | null
    imageUrl?: string
    imageFingerprint?: string
    thumbnailDataUrl?: string
    imageDataUrl?: string
    locator?: {
      source?: string
      pageUrl?: string
      pdfPage?: number | null
      imageCssSelector?: string
      imageUrl?: string
      scrollY?: number | null
      bboxOnPage?: Selection | null
    }
  }
  pageUrl: string
  source: string
  model: string
  answer: string
  uncertainty: string
  sources: string[]
  annotations: FigureAnnotation[]
  context: unknown
  version: number
  createdAt: string
  updatedAt: string
}

type SettingsPayload = {
  ok: boolean
  apiKeyConfigured: boolean
  apiKeyMasked: string
  baseUrl: string
  model: string
  source: 'local-settings' | 'environment'
  settingsStore: string
}

const quickQuestions = [
  '这张图主要说明什么？',
  '请解释每个 panel 的含义',
  '图中有哪些关键证据？',
  '哪些地方需要结合图注或正文确认？',
]

function normalizeSelection(startX: number, startY: number, endX: number, endY: number): Selection {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  }
}

function buildFigureContext(
  caption: string,
  selectedFigure: FigureIndexEntry | null,
  bodyEvidenceList: PdfEvidence[],
) {
  const contextParts = []

  if (selectedFigure) {
    contextParts.push(`Selected figure: Figure ${selectedFigure.figureLabel}`)
  }

  const captionText = caption.trim() || selectedFigure?.captionCandidates[0]?.text.trim()
  if (captionText) {
    contextParts.push(`Caption:\n${captionText}`)
  }

  const bodyEvidenceText = bodyEvidenceList
    .slice(0, 5)
    .map((evidence, index) => `${index + 1}. Page ${evidence.pageNumber}: ${evidence.text}`)
    .join('\n')

  if (bodyEvidenceText) {
    contextParts.push(`Related body evidence:\n${bodyEvidenceText}`)
  }

  return contextParts.join('\n\n')
}

function getEvidenceReasonLabel(evidence: PdfEvidence) {
  if (evidence.matchReason === 'direct_figure_reference') return '直接引用当前 Figure'
  if (evidence.matchReason === 'caption_keyword_proximity') return 'caption 关键词 + 邻近页匹配'
  if (evidence.matchReason === 'near_caption_page') return '邻近 caption 页候选'
  return '旧版候选'
}

function renderBodyEvidenceMeta(evidence: PdfEvidence) {
  const directReferences = evidence.directReferences?.join(', ')
  const keywords = evidence.matchedKeywords?.slice(0, 5).join(', ')

  return (
    <>
      <p>匹配规则：{getEvidenceReasonLabel(evidence)}</p>
      {directReferences ? <p>命中引用：{directReferences}</p> : <p>命中引用：未检测到明确 Fig./Figure 引用</p>}
      {keywords ? <p>关键词：{keywords}</p> : null}
    </>
  )
}

function clampAnnotationBox(box?: Selection) {
  const source = box ?? { x: 0, y: 0, width: 1, height: 1 }
  const x = Math.max(0, Math.min(1000, Number(source.x) || 0))
  const y = Math.max(0, Math.min(1000, Number(source.y) || 0))
  const width = Math.max(1, Math.min(1000 - x, Number(source.width) || 1))
  const height = Math.max(1, Math.min(1000 - y, Number(source.height) || 1))

  return { x, y, width, height }
}

function adjustAnnotationBox(
  box: Selection,
  dragState: AnnotationDragState,
  clientX: number,
  clientY: number,
) {
  const dx = ((clientX - dragState.startClientX) / dragState.imageWidth) * 1000
  const dy = ((clientY - dragState.startClientY) / dragState.imageHeight) * 1000

  if (dragState.mode === 'move') {
    return clampAnnotationBox({
      ...box,
      x: dragState.startBox.x + dx,
      y: dragState.startBox.y + dy,
    })
  }

  return clampAnnotationBox({
    ...box,
    width: dragState.startBox.width + dx,
    height: dragState.startBox.height + dy,
  })
}

function loadImageDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取选区图像'))
    image.src = dataUrl
  })
}

async function cropImageSelection(
  imageDataUrl: string,
  selection: Selection,
  displayedImage: HTMLImageElement,
) {
  const displayRect = displayedImage.getBoundingClientRect()
  const sourceImage = await loadImageDataUrl(imageDataUrl)
  const scaleX = sourceImage.naturalWidth / displayRect.width
  const scaleY = sourceImage.naturalHeight / displayRect.height
  const sourceX = Math.max(0, Math.round(selection.x * scaleX))
  const sourceY = Math.max(0, Math.round(selection.y * scaleY))
  const sourceWidth = Math.max(1, Math.round(selection.width * scaleX))
  const sourceHeight = Math.max(1, Math.round(selection.height * scaleY))
  const canvas = window.document.createElement('canvas')
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('无法创建选区裁剪画布')
  }

  canvas.width = Math.min(sourceWidth, sourceImage.naturalWidth - sourceX)
  canvas.height = Math.min(sourceHeight, sourceImage.naturalHeight - sourceY)
  context.drawImage(
    sourceImage,
    sourceX,
    sourceY,
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  )

  return {
    dataUrl: canvas.toDataURL('image/png'),
    normalizedSelection: {
      x: (selection.x / displayRect.width) * 1000,
      y: (selection.y / displayRect.height) * 1000,
      width: (selection.width / displayRect.width) * 1000,
      height: (selection.height / displayRect.height) * 1000,
    },
  }
}

async function cropPdfFigureRegion(imageDataUrl: string) {
  const sourceImage = await loadImageDataUrl(imageDataUrl)
  const canvas = window.document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) {
    return null
  }

  canvas.width = sourceImage.naturalWidth
  canvas.height = sourceImage.naturalHeight
  context.drawImage(sourceImage, 0, 0)

  const { width, height } = canvas
  const imageData = context.getImageData(0, 0, width, height)
  const data = imageData.data
  const rowDensity = new Array<number>(height).fill(0)
  const minXByRow = new Array<number>(height).fill(width)
  const maxXByRow = new Array<number>(height).fill(0)
  const pageMarginX = Math.round(width * 0.07)
  const topGuard = Math.round(height * 0.11)
  const bottomGuard = Math.round(height * 0.06)

  for (let y = topGuard; y < height - bottomGuard; y += 1) {
    let count = 0
    for (let x = pageMarginX; x < width - pageMarginX; x += 2) {
      const index = (y * width + x) * 4
      const r = data[index]
      const g = data[index + 1]
      const b = data[index + 2]
      const darkness = 255 - Math.max(r, g, b)
      const saturation = Math.max(r, g, b) - Math.min(r, g, b)

      if (darkness > 32 || saturation > 36) {
        count += 1
        minXByRow[y] = Math.min(minXByRow[y], x)
        maxXByRow[y] = Math.max(maxXByRow[y], x)
      }
    }
    rowDensity[y] = count
  }

  const minRowPixels = Math.max(8, Math.round((width - pageMarginX * 2) * 0.018))
  const segments: Array<{ start: number; end: number; ink: number; minX: number; maxX: number }> = []
  let current: { start: number; end: number; ink: number; minX: number; maxX: number } | null = null
  let gap = 0
  const maxGap = Math.round(height * 0.035)

  for (let y = topGuard; y < height - bottomGuard; y += 1) {
    if (rowDensity[y] >= minRowPixels) {
      if (!current) {
        current = { start: y, end: y, ink: 0, minX: width, maxX: 0 }
      }
      current.end = y
      current.ink += rowDensity[y]
      current.minX = Math.min(current.minX, minXByRow[y])
      current.maxX = Math.max(current.maxX, maxXByRow[y])
      gap = 0
    } else if (current) {
      gap += 1
      if (gap > maxGap) {
        current.end -= gap
        segments.push(current)
        current = null
        gap = 0
      }
    }
  }

  if (current) {
    current.end -= gap
    segments.push(current)
  }

  const candidates = segments
    .filter((segment) => segment.end - segment.start > height * 0.16)
    .sort((a, b) => b.ink - a.ink)

  const best = candidates[0]
  if (!best) {
    return null
  }

  const padX = Math.round(width * 0.025)
  const padY = Math.round(height * 0.02)
  const cropX = Math.max(0, best.minX - padX)
  const cropY = Math.max(0, best.start - padY)
  const cropWidth = Math.min(width - cropX, best.maxX - best.minX + padX * 2)
  const cropHeight = Math.min(height - cropY, best.end - best.start + padY * 2)

  if (cropWidth < width * 0.35 || cropHeight < height * 0.22) {
    return null
  }

  const cropCanvas = window.document.createElement('canvas')
  const cropContext = cropCanvas.getContext('2d')
  if (!cropContext) {
    return null
  }

  cropCanvas.width = cropWidth
  cropCanvas.height = cropHeight
  cropContext.drawImage(
    sourceImage,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  )

  return {
    dataUrl: cropCanvas.toDataURL('image/png'),
    normalizedSelection: {
      x: (cropX / width) * 1000,
      y: (cropY / height) * 1000,
      width: (cropWidth / width) * 1000,
      height: (cropHeight / height) * 1000,
    },
  }
}

function mapCroppedResultToFullImage(
  result: AnalysisResult,
  normalizedSelection: Selection | null,
) {
  if (!normalizedSelection) return result

  return {
    ...result,
    annotations: result.annotations.map((annotation) => {
      const box = clampAnnotationBox(annotation.bbox)
      return {
        ...annotation,
        bbox: clampAnnotationBox({
          x: normalizedSelection.x + (box.x / 1000) * normalizedSelection.width,
          y: normalizedSelection.y + (box.y / 1000) * normalizedSelection.height,
          width: (box.width / 1000) * normalizedSelection.width,
          height: (box.height / 1000) * normalizedSelection.height,
        }),
      }
    }),
  }
}

function ensureSelectedRegionAnnotation(
  result: AnalysisResult,
  normalizedSelection: Selection | null,
) {
  if (!normalizedSelection || result.annotations.length > 0) return result

  return {
    ...result,
    annotations: [
      {
        label: '选中区域',
        what: '用户红框选中的图像区域',
        howToRead: '后续解释应只对应这个红框范围',
        meaning: '该框来自用户选择，不是模型自动定位',
        bbox: clampAnnotationBox(normalizedSelection),
        confidence: 1,
        evidenceType: 'visible' as const,
      },
    ],
  }
}

function buildSelectedRegionFallbackResult(normalizedSelection: Selection): AnalysisResult {
  return {
    answer: '模型没有返回可解析的区域分析结果；已保留你框选的区域，请重试或调整问题。',
    sources: ['用户红框选区'],
    uncertainty: '这不是 AI 对图像内容的解释，只是保留选区，避免结果跳到红框外的 panel。',
    annotations: [
      {
        label: '选中区域',
        what: '用户红框选中的图像区域',
        howToRead: '只应围绕这个区域继续提问或重试解析',
        meaning: '该框来自用户选择，不代表模型已经完成内容判断',
        bbox: clampAnnotationBox(normalizedSelection),
        confidence: 1,
        evidenceType: 'visible',
      },
    ],
  }
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

async function renderPdfPage(documentProxy: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await documentProxy.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1.6 })
  const canvas = window.document.createElement('canvas')
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('无法创建 PDF 预览画布')
  }

  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)

  try {
    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PDF page render failed'
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.strokeStyle = '#dce3e7'
    context.lineWidth = 2
    context.strokeRect(24, 24, canvas.width - 48, canvas.height - 48)
    context.fillStyle = '#172026'
    context.font = 'bold 28px sans-serif'
    context.fillText(`PDF 第 ${pageNumber} 页预览失败`, 56, 90)
    context.fillStyle = '#64717a'
    context.font = '18px sans-serif'
    context.fillText('该页可能触发了 PDF 渲染兼容问题，但全文索引和翻页仍可继续。', 56, 130)
    context.fillText(message.slice(0, 90), 56, 165)
  }

  return canvas.toDataURL('image/png')
}

async function parseApiResponse(response: Response) {
  const rawText = await response.text()
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    try {
      return {
        ok: response.ok,
        payload: rawText ? JSON.parse(rawText) : null,
      }
    } catch {
      return {
        ok: false,
        payload: { error: '接口返回了 JSON 响应头，但内容不是合法 JSON。' },
      }
    }
  }

  return {
    ok: false,
    payload: {
      error: rawText.trim().startsWith('<!DOCTYPE')
        ? `接口返回了 HTML 页面，不是 JSON。状态码 ${response.status}。`
        : rawText.slice(0, 500) || `接口返回了非 JSON 内容。状态码 ${response.status}。`,
    },
  }
}

function formatApiError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback
  if (
    message === 'Failed to fetch' ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    message.includes('接口返回了 HTML 页面') ||
    message.includes('接口返回了非 JSON 内容') ||
    message.includes('状态码 502') ||
    message.includes('状态码 404')
  ) {
    return [
      '连接不到本地后端。请确认已经在 app 目录运行 npm run start:local，或至少运行 npm run server。',
      '默认后端地址应为 http://127.0.0.1:8787。',
      `原始错误：${message}`,
    ].join('\n')
  }
  return message
}

function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 8000) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => window.clearTimeout(timeoutId))
}

async function createThumbnailDataUrl(dataUrl: string, maxWidth = 360): Promise<string> {
  const image = await loadImageDataUrl(dataUrl)
  const scale = Math.min(1, maxWidth / image.naturalWidth)
  const canvas = window.document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return dataUrl
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.78)
}

function inferPaperTitle(visual: VisualSource | null) {
  if (!visual) return ''
  return visual.kind === 'pdf' ? visual.name.replace(/\.pdf$/i, '') : visual.name
}

function hashString(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function formatSavedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function buildStableUrlWithScroll(url: string, scrollY?: number | null, analysisId?: string) {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const params = new URLSearchParams()
    if (Number.isFinite(Number(scrollY))) {
      params.set('litfig-scroll', String(Math.max(0, Math.round(Number(scrollY)))))
    }
    if (analysisId) {
      params.set('litfig-analysis', analysisId)
    }
    parsed.hash = params.toString()
    return parsed.href
  } catch {
    return url
  }
}

function analysisRecordToResult(record: AnalysisRecord): AnalysisResult {
  return {
    answer: record.answer || '',
    sources: Array.isArray(record.sources) ? record.sources : [],
    uncertainty: record.uncertainty || '',
    annotations: Array.isArray(record.annotations) ? record.annotations : [],
  }
}

function buildPdfPageUrl(url: string, pageNumber?: number | null) {
  if (!url || url.startsWith('blob:')) return ''
  if (!/\.pdf(?:[?#].*)?$/i.test(url)) return ''
  if (!Number.isFinite(Number(pageNumber)) || Number(pageNumber) < 1) return ''
  try {
    const parsed = new URL(url)
    parsed.hash = `page=${Math.max(1, Math.round(Number(pageNumber)))}`
    return parsed.href
  } catch {
    return ''
  }
}

function App() {
  const imageRef = useRef<HTMLImageElement | null>(null)
  const lastInspectedRef = useRef('')
  const activePdfSourceRef = useRef('')
  const [visual, setVisual] = useState<VisualSource | null>(null)
  const [pdfState, setPdfState] = useState<PdfState | null>(null)
  const [caption, setCaption] = useState('')
  const [question, setQuestion] = useState(quickQuestions[0])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [draftSelection, setDraftSelection] = useState<Selection | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [pdfInspect, setPdfInspect] = useState<PdfInspectResult | null>(null)
  const [pdfIndex, setPdfIndex] = useState<PdfIndexResult | null>(null)
  const [figureQuery, setFigureQuery] = useState('')
  const [selectedFigureLabel, setSelectedFigureLabel] = useState<string | null>(null)
  const [activeAnnotationIndex, setActiveAnnotationIndex] = useState<number | null>(null)
  const [annotationDrag, setAnnotationDrag] = useState<AnnotationDragState | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [status, setStatus] = useState('等待导入图片、PDF，或直接粘贴截图')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [isInspectingPdf, setIsInspectingPdf] = useState(false)
  const [isIndexingPdf, setIsIndexingPdf] = useState(false)
  const [pageInput, setPageInput] = useState('1')
  const [viewMode, setViewMode] = useState<'reader' | 'library' | 'settings'>('reader')
  const [analysisRecords, setAnalysisRecords] = useState<AnalysisRecord[]>([])
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false)
  const [libraryStatus, setLibraryStatus] = useState('')
  const [saveStatus, setSaveStatus] = useState('')
  const [settings, setSettings] = useState<SettingsPayload | null>(null)
  const [settingsForm, setSettingsForm] = useState({
    apiKey: '',
    baseUrl: '',
    model: '',
  })
  const [settingsStatus, setSettingsStatus] = useState('')
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [isTestingSettings, setIsTestingSettings] = useState(false)

  const resetView = () => {
    setSelection(null)
    setDraftSelection(null)
    setResult(null)
    setActiveAnnotationIndex(null)
    setAnnotationDrag(null)
    setErrorMessage('')
    setPdfInspect(null)
  }

  const clearPdfContext = () => {
    setPdfIndex(null)
    setSelectedFigureLabel(null)
    setFigureQuery('')
    setCaption('')
    lastInspectedRef.current = ''
    activePdfSourceRef.current = ''
  }

  const loadAnalysisLibrary = async () => {
    setIsLoadingLibrary(true)
    setLibraryStatus('正在读取解析库')
    try {
      const response = await fetch(apiUrl('/api/analysis'))
      const { ok, payload } = await parseApiResponse(response)
      if (!ok) throw new Error(payload?.error || '读取解析库失败')
      const records = Array.isArray(payload?.records) ? payload.records : []
      setAnalysisRecords(records)
      setSelectedRecordId((current) => current ?? records[0]?.id ?? null)
      setLibraryStatus(records.length > 0 ? `已读取 ${records.length} 条解析记录` : '暂无已保存解析')
    } catch (error) {
      setLibraryStatus(error instanceof Error ? error.message : '读取解析库失败')
    } finally {
      setIsLoadingLibrary(false)
    }
  }

  const loadSettings = async () => {
    setSettingsStatus('正在读取设置')
    try {
      const response = await fetchWithTimeout(apiUrl('/api/settings'))
      const { ok, payload } = await parseApiResponse(response)
      if (!ok) throw new Error(payload?.error || '读取设置失败')
      setSettings(payload)
      setSettingsForm({
        apiKey: '',
        baseUrl: payload.baseUrl || '',
        model: payload.model || '',
      })
      setSettingsStatus(payload.apiKeyConfigured ? '已读取设置，API key 已配置' : '未配置 API key')
    } catch (error) {
      setSettingsStatus(formatApiError(error, '读取设置失败'))
    }
  }

  const saveSettings = async () => {
    setIsSavingSettings(true)
    setSettingsStatus('正在保存设置')
    try {
      const response = await fetchWithTimeout(apiUrl('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsForm),
      })
      const { ok, payload } = await parseApiResponse(response)
      if (!ok) throw new Error(payload?.error || '保存设置失败')
      setSettings(payload)
      setSettingsForm((current) => ({
        ...current,
        apiKey: '',
        baseUrl: payload.baseUrl || current.baseUrl,
        model: payload.model || current.model,
      }))
      setSettingsStatus('已保存。后续解析会使用这组本地设置。')
      return true
    } catch (error) {
      setSettingsStatus(formatApiError(error, '保存设置失败'))
      return false
    } finally {
      setIsSavingSettings(false)
    }
  }

  const testSettings = async () => {
    setIsTestingSettings(true)
    setSettingsStatus('正在测试模型连接')
    try {
      const saved = await saveSettings()
      if (!saved) return
      const response = await fetchWithTimeout(apiUrl('/api/settings/test'), { method: 'POST' }, 20000)
      const { ok, payload } = await parseApiResponse(response)
      if (!ok) throw new Error(payload?.error || '测试连接失败')
      setSettingsStatus(`测试成功：${payload.model} @ ${payload.baseUrl}${payload.endpointMode ? ` (${payload.endpointMode})` : ''}`)
    } catch (error) {
      setSettingsStatus(formatApiError(error, '测试连接失败'))
    } finally {
      setIsTestingSettings(false)
    }
  }

  const saveCurrentAnalysis = async () => {
    if (!result || !visual) return
    setSaveStatus('正在保存...')
    try {
      const imageDataUrl = visual.dataUrl
      const thumbnailDataUrl = await createThumbnailDataUrl(imageDataUrl)
      const figureId = selectedFigure?.figureLabel
        ? `Fig. ${selectedFigure.figureLabel}`
        : pdfInspect?.figureLabel
          ? `Fig. ${pdfInspect.figureLabel}`
          : pdfState
            ? `PDF page ${pdfState.currentPage}`
            : visual.name
      const captionText = caption || selectedFigure?.captionCandidates[0]?.text || pdfInspect?.captionCandidates[0]?.text || ''
      const body = {
        documentId: hashString(`${visual.name}:${visual.originalDataUrl?.slice(0, 80) || visual.dataUrl.slice(0, 80)}`),
        figureId,
        imageFingerprint: hashString(`${visual.name}:${figureId}:${caption}:${visual.dataUrl.slice(0, 120)}`),
        imageUrl: null,
        paper: {
          title: inferPaperTitle(visual),
          sourceUrl: '',
          pdfHash: visual.originalDataUrl ? hashString(visual.originalDataUrl.slice(0, 2000)) : '',
          pdfDataUrl: pdfState ? visual.originalDataUrl : '',
        },
        figure: {
          figureLabel: figureId,
          captionText,
          captionSource: selectedFigure ? 'pdf-index' : pdfInspect ? 'pdf-inspect' : caption ? 'manual' : '',
          pageNumber: pdfState?.currentPage ?? null,
          imageUrl: '',
          imageFingerprint: hashString(`${visual.name}:${figureId}:${imageDataUrl.slice(0, 180)}`),
          imageDataUrl,
          thumbnailDataUrl,
          locator: {
            source: pdfState ? 'web-app-pdf' : 'web-app-image',
            pdfPage: pdfState?.currentPage ?? null,
          },
        },
        pageUrl: '',
        source: 'web-app',
        answer: result.answer,
        uncertainty: result.uncertainty,
        sources: result.sources,
        annotations: result.annotations,
        context: {
          caption,
          selectedFigure,
          bodyEvidence: bodyEvidenceList,
          pdfPage: pdfState?.currentPage ?? null,
          visualName: visual.name,
        },
      }
      const response = await fetch(apiUrl('/api/analysis'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const { ok, payload } = await parseApiResponse(response)
      if (!ok) throw new Error(payload?.error || '保存失败')
      setSaveStatus(`已保存：版本 ${payload.version || 1}`)
      await loadAnalysisLibrary()
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : '保存失败')
    }
  }

  const deleteAnalysisRecord = async (record: AnalysisRecord) => {
    const confirmed = window.confirm(`删除这条解析记录？\n${record.figureId || record.id}`)
    if (!confirmed) return
    setLibraryStatus('正在删除记录')
    try {
      const response = await fetch(apiUrl(`/api/analysis/${encodeURIComponent(record.id)}`), { method: 'DELETE' })
      const { ok, payload } = await parseApiResponse(response)
      if (!ok) throw new Error(payload?.error || '删除失败')
      setAnalysisRecords((records) => records.filter((item) => item.id !== record.id))
      setSelectedRecordId((current) => (current === record.id ? null : current))
      setLibraryStatus('已删除记录')
    } catch (error) {
      setLibraryStatus(error instanceof Error ? error.message : '删除失败')
    }
  }

  const openSavedPdfInWorkspace = async (record: AnalysisRecord) => {
    const savedImageDataUrl = record.figure?.imageDataUrl || record.figure?.thumbnailDataUrl
    if (savedImageDataUrl) {
      setViewMode('reader')
      resetView()
      setPdfState(null)
      setPageInput('1')
      clearPdfContext()
      setVisual({
        name: `${record.paper?.title || record.figureId || 'saved analysis'} replay`,
        kind: 'image',
        type: 'image/png',
        dataUrl: savedImageDataUrl,
        originalDataUrl: record.paper?.pdfDataUrl || undefined,
      })
      setResult(analysisRecordToResult(record))
      setCaption(record.figure?.captionText || '')
      setStatus('已恢复保存的图像、红框和解析结果')
      return
    }

    const pdfDataUrl = record.paper?.pdfDataUrl
    if (!pdfDataUrl) return
    setViewMode('reader')
    setIsLoadingFile(true)
    resetView()
    try {
      const base64 = pdfDataUrl.split(',')[1]
      const binary = window.atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
      const loadingTask = getDocument({ data: bytes })
      const documentProxy = await loadingTask.promise
      clearPdfContext()
      await renderAndSetPdfPage(
        documentProxy,
        Math.max(1, Number(record.figure?.pageNumber ?? record.figure?.locator?.pdfPage ?? 1)),
        record.paper?.title || 'saved-paper.pdf',
        documentProxy.numPages,
        pdfDataUrl,
      )
      setResult(analysisRecordToResult(record))
      setCaption(record.figure?.captionText || '')
      setStatus('已打开历史 PDF，并恢复保存的解析结果')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '打开历史 PDF 失败')
    } finally {
      setIsLoadingFile(false)
    }
  }

  const setImageVisual = async (file: File) => {
    const dataUrl = await fileToDataUrl(file)
    setPdfState(null)
    setPageInput('1')
    clearPdfContext()
    setVisual({
      name: file.name || 'clipboard-image',
      kind: 'image',
      type: file.type,
      dataUrl,
    })
    setStatus('图片已载入，可以直接提问或框选区域')
  }

  const renderAndSetPdfPage = async (
    documentProxy: PDFDocumentProxy,
    pageNumber: number,
    name: string,
    totalPages: number,
    originalDataUrl: string,
  ) => {
    const preview = await renderPdfPage(documentProxy, pageNumber)
    activePdfSourceRef.current = hashString(originalDataUrl.slice(0, 2000))
    setVisual({
      name,
      kind: 'pdf',
      type: 'application/pdf',
      dataUrl: preview,
      originalDataUrl,
    })
    setPdfState({
      documentProxy,
      name,
      totalPages,
      currentPage: pageNumber,
    })
    setPageInput(String(pageNumber))
    setStatus(`PDF 已载入，当前显示第 ${pageNumber} 页，共 ${totalPages} 页。`)
  }

  const setPdfVisual = async (file: File) => {
    const originalDataUrl = await fileToDataUrl(file)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const loadingTask = getDocument({ data: bytes })
    const documentProxy = await loadingTask.promise
    clearPdfContext()
    await renderAndSetPdfPage(
      documentProxy,
      1,
      file.name || 'paper.pdf',
      documentProxy.numPages,
      originalDataUrl,
    )
  }

  const loadFile = async (file: File) => {
    setIsLoadingFile(true)
    resetView()
    clearPdfContext()

    try {
      if (file.type.startsWith('image/')) {
        await setImageVisual(file)
        return
      }

      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        await setPdfVisual(file)
        return
      }

      setStatus('当前只支持图片、截图和 PDF 文件。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '文件处理失败')
    } finally {
      setIsLoadingFile(false)
    }
  }

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
        item.type.startsWith('image/'),
      )
      if (file) {
        void loadFile(file)
      }
    }

    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  })

  useEffect(() => {
    if (!visual?.originalDataUrl || !pdfState) return

    const pdfSourceHash = hashString(visual.originalDataUrl.slice(0, 2000))
    const inspectionKey = `${pdfSourceHash}:${pdfState.currentPage}`
    if (lastInspectedRef.current === inspectionKey) return
    lastInspectedRef.current = inspectionKey

    const inspectPdfContext = async () => {
      setIsInspectingPdf(true)
      setPdfInspect(null)
      setErrorMessage('')
      setStatus('正在自动匹配当前页相关的 figure caption')

      try {
        const response = await fetch(apiUrl('/api/pdf-inspect'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdf: visual.originalDataUrl,
            currentPage: pdfState.currentPage,
          }),
        })

        const { ok, payload } = await parseApiResponse(response)
        if (activePdfSourceRef.current !== pdfSourceHash) return
        if (!ok) {
          throw new Error(payload?.error || 'PDF 检索失败')
        }

        setPdfInspect(payload)
        if (!selectedFigureLabel) {
          setCaption(payload.captionCandidates?.[0]?.text ?? '')
        }
        setStatus(payload.note || '已完成自动 caption 匹配')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'PDF 检索失败'
        setErrorMessage(message)
        setStatus(message)
      } finally {
        setIsInspectingPdf(false)
      }
    }

    void inspectPdfContext()
  }, [pdfState, selectedFigureLabel, visual])

  useEffect(() => {
    if (!visual?.originalDataUrl || !pdfState) return

    const pdfSourceHash = hashString(visual.originalDataUrl.slice(0, 2000))
    if (pdfIndex?.sourceHash === pdfSourceHash) return

    const indexPdf = async () => {
      setIsIndexingPdf(true)
      setStatus('正在建立全文 figure 图谱')

      try {
        const response = await fetch(apiUrl('/api/pdf-index'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdf: visual.originalDataUrl,
            currentPage: pdfState.currentPage,
          }),
        })

        const { ok, payload } = await parseApiResponse(response)
        if (activePdfSourceRef.current !== pdfSourceHash) return
        if (!ok) {
          throw new Error(payload?.error || 'PDF 全文索引失败')
        }

        setPdfIndex({ ...payload, sourceHash: pdfSourceHash })
        const initialLabel = payload.currentFigureLabel ?? payload.figures?.[0]?.figureLabel ?? null
        setSelectedFigureLabel(initialLabel)
        const initialFigure = payload.figures?.find((entry: FigureIndexEntry) => entry.figureLabel === initialLabel)
        setCaption(initialFigure?.captionCandidates?.[0]?.text ?? '')
        setStatus(payload.note || '已建立全文 figure 图谱')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'PDF 全文索引失败'
        setErrorMessage(message)
        setStatus(message)
      } finally {
        setIsIndexingPdf(false)
      }
    }

    void indexPdf()
  }, [pdfIndex, pdfState, visual?.originalDataUrl])

  const pointerToImagePosition = (event: PointerEvent<HTMLDivElement>) => {
    const img = imageRef.current
    if (!img) return null

    const rect = img.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(event.clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(event.clientY - rect.top, rect.height)),
    }
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!visual || isLoadingFile) return
    const point = pointerToImagePosition(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragStart(point)
    setDraftSelection({ ...point, width: 0, height: 0 })
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStart) return
    const point = pointerToImagePosition(event)
    if (!point) return
    setDraftSelection(normalizeSelection(dragStart.x, dragStart.y, point.x, point.y))
  }

  const handlePointerUp = () => {
    if (draftSelection && draftSelection.width > 8 && draftSelection.height > 8) {
      setSelection(draftSelection)
      setStatus('已选择图片区域，可以针对该区域提问')
    }
    setDragStart(null)
    setDraftSelection(null)
  }

  const updateAnnotationBox = (index: number, bbox: Selection) => {
    setResult((current) => {
      if (!current) return current

      return {
        ...current,
        annotations: current.annotations.map((annotation, annotationIndex) =>
          annotationIndex === index ? { ...annotation, bbox } : annotation,
        ),
      }
    })
  }

  const startAnnotationDrag = (
    event: PointerEvent<HTMLElement>,
    index: number,
    mode: 'move' | 'resize',
  ) => {
    const img = imageRef.current
    const annotation = annotations[index]
    if (!img || !annotation) return

    const rect = img.getBoundingClientRect()
    const startBox = clampAnnotationBox(annotation.bbox)

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setActiveAnnotationIndex(index)
    setAnnotationDrag({
      index,
      mode,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startBox,
      imageWidth: rect.width,
      imageHeight: rect.height,
    })
  }

  const moveAnnotationDrag = (event: PointerEvent<HTMLElement>) => {
    if (!annotationDrag || event.pointerId !== annotationDrag.pointerId) return
    const nextBox = adjustAnnotationBox(
      annotationDrag.startBox,
      annotationDrag,
      event.clientX,
      event.clientY,
    )
    updateAnnotationBox(annotationDrag.index, nextBox)
  }

  const endAnnotationDrag = (event: PointerEvent<HTMLElement>) => {
    if (!annotationDrag || event.pointerId !== annotationDrag.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    setAnnotationDrag(null)
  }

  const goToPdfPage = async (pageNumber: number) => {
    if (!pdfState || !visual?.originalDataUrl) return

    const nextPage = Math.max(1, Math.min(pageNumber, pdfState.totalPages))
    if (nextPage === pdfState.currentPage) {
      setPageInput(String(nextPage))
      return
    }

    setIsLoadingFile(true)
    setResult(null)
    setErrorMessage('')
    setPdfInspect(null)
    setCaption('')
    try {
      await renderAndSetPdfPage(
        pdfState.documentProxy,
        nextPage,
        pdfState.name,
        pdfState.totalPages,
        visual.originalDataUrl,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '翻页失败')
    } finally {
      setIsLoadingFile(false)
    }
  }

  const handlePageInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    setPageInput(event.target.value.replace(/[^\d]/g, ''))
  }

  const handlePageInputSubmit = async () => {
    if (!pdfState) return

    const requestedPage = Number(pageInput)
    if (!Number.isFinite(requestedPage) || requestedPage < 1) {
      setPageInput(String(pdfState.currentPage))
      return
    }

    await goToPdfPage(requestedPage)
  }

  const analyze = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!visual) {
      setStatus('请先上传图片、PDF，或粘贴一张截图')
      return
    }

    setIsAnalyzing(true)
    setResult(null)
    setActiveAnnotationIndex(null)
    setAnnotationDrag(null)
    setErrorMessage('')
    setStatus('正在调用真实多模态解析接口')

    try {
      const selectedRegionForAnalysis =
        selection && imageRef.current
          ? await cropImageSelection(visual.dataUrl, selection, imageRef.current)
          : null
      const pdfFigureRegionForAnalysis =
        !selectedRegionForAnalysis && pdfState ? await cropPdfFigureRegion(visual.dataUrl) : null
      const imageForAnalysis = selectedRegionForAnalysis ?? pdfFigureRegionForAnalysis
      const analysisQuestion = selectedRegionForAnalysis
        ? `请只分析用户红框选中的裁剪区域，不要解释裁剪区域之外的 panel。${question}`
        : pdfFigureRegionForAnalysis
          ? `当前输入已自动裁剪为 PDF 页面中的主 figure 区域；请尽量识别并解释每个可见 panel，不要解释裁剪区域之外的正文、页眉或页脚。${question}`
          : question
      const abortController = new AbortController()
      const timeoutId = window.setTimeout(
        () => abortController.abort(),
        selectedRegionForAnalysis ? 90000 : 120000,
      )
      const response = await fetch(apiUrl('/api/analyze-image'), {
        method: 'POST',
        signal: abortController.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageForAnalysis?.dataUrl ?? visual.dataUrl,
          imageName: pdfState
            ? `${visual.name} page ${pdfState.currentPage}${selectedRegionForAnalysis ? ' selected region' : pdfFigureRegionForAnalysis ? ' figure crop' : ''}`
            : `${visual.name}${imageForAnalysis ? ' selected region' : ''}`,
          caption: buildFigureContext(caption, selectedFigure, bodyEvidenceList),
          question: analysisQuestion,
          selection: imageForAnalysis ? null : selection,
        }),
      })
      window.clearTimeout(timeoutId)

      const { ok, payload } = await parseApiResponse(response)
      if (!ok) {
        throw new Error(payload?.error || '解析失败')
      }

      const normalizedSelection = imageForAnalysis?.normalizedSelection ?? null
      setResult(
        ensureSelectedRegionAnnotation(
          mapCroppedResultToFullImage(payload, normalizedSelection),
          normalizedSelection,
        ),
      )
      setStatus('解析完成')
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === 'AbortError'
          ? '选区解析超时，已保留红框选区；可以重试或调整问题。'
          : error instanceof Error
            ? error.message
            : '解析失败'
      if (selection && imageRef.current) {
        const imageRect = imageRef.current.getBoundingClientRect()
        setResult(
          buildSelectedRegionFallbackResult({
            x: (selection.x / imageRect.width) * 1000,
            y: (selection.y / imageRect.height) * 1000,
            width: (selection.width / imageRect.width) * 1000,
            height: (selection.height / imageRect.height) * 1000,
          }),
        )
      }
      setErrorMessage(message)
      setStatus(message)
    } finally {
      setIsAnalyzing(false)
    }
  }

  const activeSelection = draftSelection ?? selection
  const filteredFigures =
    pdfIndex?.figures.filter((item) => {
      const query = figureQuery.trim().toLowerCase()
      if (!query) return true
      return (
        item.figureLabel.toLowerCase().includes(query) ||
        item.captionCandidates.some((candidate) => candidate.text.toLowerCase().includes(query)) ||
        item.bodyEvidence.some((evidence) => evidence.text.toLowerCase().includes(query))
      )
    }) ?? []
  const selectedFigure =
    filteredFigures.find((item) => item.figureLabel === selectedFigureLabel) ??
    pdfIndex?.figures.find((item) => item.figureLabel === selectedFigureLabel) ??
    filteredFigures[0] ??
    null
  const topCaption = selectedFigure?.captionCandidates[0] ?? pdfInspect?.captionCandidates[0]
  const topBodyEvidence = selectedFigure?.bodyEvidence[0] ?? pdfInspect?.bodyEvidence[0]
  const bodyEvidenceList = selectedFigure?.bodyEvidence ?? pdfInspect?.bodyEvidence ?? []
  const annotations = result?.annotations ?? []
  const filteredRecords = analysisRecords.filter((record) => {
    const query = libraryQuery.trim().toLowerCase()
    if (!query) return true
    return [
      record.figureId,
      record.answer,
      record.uncertainty,
      record.pageUrl,
      record.source,
      record.model,
      JSON.stringify(record.context ?? ''),
    ]
      .join(' ')
      .toLowerCase()
      .includes(query)
  })
  const selectedRecord =
    filteredRecords.find((record) => record.id === selectedRecordId) ??
    analysisRecords.find((record) => record.id === selectedRecordId) ??
    filteredRecords[0] ??
    null
  const currentPdfHash = visual?.originalDataUrl ? hashString(visual.originalDataUrl.slice(0, 2000)) : ''
  const selectedRecordPdfPage =
    selectedRecord?.figure?.pageNumber ?? selectedRecord?.figure?.locator?.pdfPage ?? null
  const selectedRecordPageUrl =
    selectedRecord?.figure?.locator?.pageUrl || selectedRecord?.paper?.sourceUrl || selectedRecord?.pageUrl || ''
  const selectedRecordImageUrl =
    selectedRecord?.figure?.locator?.imageUrl || selectedRecord?.figure?.imageUrl || selectedRecord?.imageUrl || ''
  const selectedRecordWebUrl = buildStableUrlWithScroll(
    selectedRecordPageUrl,
    selectedRecord?.figure?.locator?.scrollY,
    selectedRecord?.id,
  )
  const selectedRecordPdfUrl = buildPdfPageUrl(selectedRecordImageUrl || selectedRecordPageUrl, selectedRecordPdfPage)
  const selectedRecordMatchesCurrentPdf =
    Boolean(selectedRecord?.paper?.pdfHash) && selectedRecord.paper?.pdfHash === currentPdfHash

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>科研图片理解</h1>
            <p>{status}</p>
          </div>
          <div className="view-switch" aria-label="工作区切换">
            <button
              type="button"
              className={viewMode === 'reader' ? 'active' : ''}
              onClick={() => setViewMode('reader')}
            >
              当前解析
            </button>
            <button
              type="button"
              className={viewMode === 'library' ? 'active' : ''}
              onClick={() => {
                setViewMode('library')
                if (analysisRecords.length === 0 && !isLoadingLibrary) {
                  void loadAnalysisLibrary()
                }
              }}
            >
              解析库
            </button>
            <button
              type="button"
              className={viewMode === 'settings' ? 'active' : ''}
              onClick={() => {
                setViewMode('settings')
                void loadSettings()
              }}
            >
              设置
            </button>
          </div>
          <div className="upload-actions">
            <label className="file-button">
              上传图片
              <input
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) {
                    void loadFile(file)
                  }
                }}
              />
            </label>
            <label className="file-button secondary-button">
              上传 PDF
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) {
                    void loadFile(file)
                  }
                }}
              />
            </label>
          </div>
        </header>

        {viewMode === 'reader' ? (
        <div className={`figure-stage ${visual ? 'has-image' : ''}`}>
          {pdfState ? (
            <div className="pdf-toolbar">
              <button
                type="button"
                className="nav-button"
                disabled={isLoadingFile || pdfState.currentPage <= 1}
                onClick={() => void goToPdfPage(pdfState.currentPage - 1)}
              >
                上一页
              </button>
              <div className="page-indicator">
                <input
                  value={pageInput}
                  onChange={handlePageInputChange}
                  onBlur={() => void handlePageInputSubmit()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void handlePageInputSubmit()
                    }
                  }}
                />
                <span>/ {pdfState.totalPages}</span>
              </div>
              <button
                type="button"
                className="nav-button"
                disabled={isLoadingFile || pdfState.currentPage >= pdfState.totalPages}
                onClick={() => void goToPdfPage(pdfState.currentPage + 1)}
              >
                下一页
              </button>
            </div>
          ) : null}

          <div
            className="figure-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            {visual ? (
              <div className="image-layer">
                <img ref={imageRef} src={visual.dataUrl} alt={visual.name} draggable={false} />
                {pdfState ? <div className="source-chip">PDF 第 {pdfState.currentPage} 页预览</div> : null}
                {annotations.map((annotation, index) => {
                  const box = clampAnnotationBox(annotation.bbox)
                  const isActive = activeAnnotationIndex === index

                  return (
                    <button
                      key={`${annotation.label}-${index}`}
                      type="button"
                      className={isActive ? 'annotation-box active' : 'annotation-box'}
                      style={{
                        left: `${box.x / 10}%`,
                        top: `${box.y / 10}%`,
                        width: `${box.width / 10}%`,
                        height: `${box.height / 10}%`,
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        setActiveAnnotationIndex(isActive ? null : index)
                      }}
                      onPointerDown={(event) => startAnnotationDrag(event, index, 'move')}
                      onPointerMove={moveAnnotationDrag}
                      onPointerUp={endAnnotationDrag}
                      onPointerCancel={endAnnotationDrag}
                    >
                      <span className="annotation-number">{index + 1}</span>
                      <span className="annotation-tooltip">
                        <strong>{annotation.label}</strong>
                        <span>看什么：{annotation.what}</span>
                        <span>怎么看：{annotation.howToRead}</span>
                        <span>说明：{annotation.meaning}</span>
                      </span>
                      <span
                        className="annotation-resize-handle"
                        onPointerDown={(event) => startAnnotationDrag(event, index, 'resize')}
                      />
                    </button>
                  )
                })}
                {activeSelection ? (
                  <div
                    className="selection-box"
                    style={{
                      left: activeSelection.x,
                      top: activeSelection.y,
                      width: activeSelection.width,
                      height: activeSelection.height,
                    }}
                  />
                ) : null}
              </div>
            ) : (
              <div className="empty-state">
                <strong>上传图片、上传 PDF，或直接粘贴论文截图</strong>
                <span>PDF 会先建立全文 figure 图谱，再把图注和正文证据用于分析。</span>
              </div>
            )}
          </div>
        </div>
        ) : viewMode === 'settings' ? (
          <div className="settings-stage">
            <div className="settings-card">
              <div>
                <h2>本地模型设置</h2>
                <p>这些设置只保存在这台电脑的本地后端，用来替代手动编辑 .env。不要把生成的本地配置文件发给别人。</p>
              </div>
              <div className="settings-status-grid">
                <div>
                  <span>API key</span>
                  <strong>{settings?.apiKeyConfigured ? settings.apiKeyMasked || '已配置' : '未配置'}</strong>
                </div>
                <div>
                  <span>来源</span>
                  <strong>{settings?.source === 'local-settings' ? '本地设置' : '环境变量'}</strong>
                </div>
                <div>
                  <span>存储</span>
                  <strong>{settings?.settingsStore === 'json-file' ? '本地 JSON' : '内存'}</strong>
                </div>
              </div>
              <form
                className="settings-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void saveSettings()
                }}
              >
                <label>
                  <span>API Key</span>
                  <input
                    type="password"
                    value={settingsForm.apiKey}
                    onChange={(event) => setSettingsForm((current) => ({ ...current, apiKey: event.target.value }))}
                    placeholder={settings?.apiKeyConfigured ? '留空表示不修改已保存的 key' : '填写自己的 API key'}
                    autoComplete="off"
                  />
                </label>
                <label>
                  <span>Base URL</span>
                  <input
                    value={settingsForm.baseUrl}
                    onChange={(event) => setSettingsForm((current) => ({ ...current, baseUrl: event.target.value }))}
                    placeholder="https://api.openai.com"
                  />
                </label>
                <label>
                  <span>Model</span>
                  <input
                    value={settingsForm.model}
                    onChange={(event) => setSettingsForm((current) => ({ ...current, model: event.target.value }))}
                    placeholder="gpt-5.4"
                  />
                </label>
                <div className="settings-actions">
                  <button type="submit" disabled={isSavingSettings || isTestingSettings}>
                    {isSavingSettings ? '保存中' : '保存设置'}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={isSavingSettings || isTestingSettings}
                    onClick={() => void testSettings()}
                  >
                    {isTestingSettings ? '测试中' : '保存并测试'}
                  </button>
                </div>
              </form>
              {settingsStatus ? <p className="settings-message">{settingsStatus}</p> : null}
            </div>
          </div>
        ) : (
          <div className="library-stage">
            <div className="library-toolbar">
              <div>
                <h2>解析库</h2>
                <p>{libraryStatus || '查看已保存的插件和网站解析结果'}</p>
              </div>
              <button type="button" className="nav-button" onClick={() => void loadAnalysisLibrary()}>
                {isLoadingLibrary ? '读取中' : '刷新'}
              </button>
            </div>
            <input
              className="figure-search"
              value={libraryQuery}
              onChange={(event) => setLibraryQuery(event.target.value)}
              placeholder="搜索 figure、回答、来源或上下文"
            />
            <div className="library-layout">
              <div className="record-list">
                {filteredRecords.length > 0 ? (
                  filteredRecords.map((record) => (
                    <button
                      key={record.id}
                      type="button"
                      className={record.id === selectedRecord?.id ? 'record-item active' : 'record-item'}
                      onClick={() => setSelectedRecordId(record.id)}
                    >
                      {record.figure?.thumbnailDataUrl ? (
                        <img className="record-thumb" src={record.figure.thumbnailDataUrl} alt="" />
                      ) : null}
                      <strong>
                        {record.paper?.title ? `${record.paper.title} · ` : ''}
                        {record.figure?.figureLabel || record.figureId || '待命名图'}
                      </strong>
                      {record.figure?.captionText ? <span>{record.figure.captionText.slice(0, 120)}</span> : null}
                      <span>{record.answer.slice(0, 120) || '无回答摘要'}</span>
                      <small>
                        {record.source} · {formatSavedAt(record.createdAt)}
                      </small>
                    </button>
                  ))
                ) : (
                  <p className="muted">没有匹配的保存记录。</p>
                )}
              </div>
              <div className="record-detail">
                {selectedRecord ? (
                  <>
                    <header>
                      <div>
                        <h2>{selectedRecord.figure?.figureLabel || selectedRecord.figureId || '待命名图'}</h2>
                        {selectedRecord.paper?.title ? <p>{selectedRecord.paper.title}</p> : null}
                        <p className="muted">
                          {selectedRecord.source} · {selectedRecord.model} · 版本 {selectedRecord.version}
                        </p>
                      </div>
                      <button type="button" className="danger-button" onClick={() => void deleteAnalysisRecord(selectedRecord)}>
                        删除
                      </button>
                    </header>
                    {selectedRecord.figure?.imageDataUrl || selectedRecord.figure?.thumbnailDataUrl ? (
                      <section>
                        <h3>保存的图片</h3>
                        <div className="saved-figure-replay">
                          <img
                            className="saved-figure-image"
                            src={selectedRecord.figure.imageDataUrl || selectedRecord.figure.thumbnailDataUrl}
                            alt={selectedRecord.figure.figureLabel || selectedRecord.figureId || 'saved figure'}
                          />
                          {selectedRecord.annotations.map((annotation, index) => {
                            const box = clampAnnotationBox(annotation.bbox)
                            return (
                              <button
                                key={`${selectedRecord.id}-replay-${index}`}
                                type="button"
                                className="saved-annotation-box"
                                style={{
                                  left: `${box.x / 10}%`,
                                  top: `${box.y / 10}%`,
                                  width: `${box.width / 10}%`,
                                  height: `${box.height / 10}%`,
                                }}
                              >
                                <span className="annotation-number">{index + 1}</span>
                                <span className="annotation-tooltip">
                                  <strong>{annotation.label}</strong>
                                  <span>看什么：{annotation.what}</span>
                                  <span>怎么看：{annotation.howToRead}</span>
                                  <span>说明：{annotation.meaning}</span>
                                  <small>
                                    {annotation.evidenceType} · {Math.round(annotation.confidence * 100)}%
                                  </small>
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      </section>
                    ) : null}
                    <section>
                      <h3>来源定位</h3>
                      <p className="muted">
                        文献：{selectedRecord.paper?.title || '未记录'}；
                        Figure：{selectedRecord.figure?.figureLabel || selectedRecord.figureId || '待命名'}；
                        页码：{selectedRecord.figure?.pageNumber ?? selectedRecord.figure?.locator?.pdfPage ?? '未记录'}；
                        来源：{selectedRecord.figure?.locator?.source || selectedRecord.source}
                      </p>
                      {selectedRecord.figure?.captionText ? <p>{selectedRecord.figure.captionText}</p> : null}
                      <div className="trace-actions">
                        {selectedRecordWebUrl ? (
                          <button type="button" onClick={() => window.open(selectedRecordWebUrl, '_blank', 'noopener,noreferrer')}>
                            打开原文网页
                          </button>
                        ) : null}
                        {selectedRecordImageUrl && !selectedRecordImageUrl.startsWith('blob:') ? (
                          <button type="button" onClick={() => window.open(selectedRecordImageUrl, '_blank', 'noopener,noreferrer')}>
                            打开原图/PDF
                          </button>
                        ) : null}
                        {selectedRecordPdfUrl ? (
                          <button type="button" onClick={() => window.open(selectedRecordPdfUrl, '_blank', 'noopener,noreferrer')}>
                            打开 PDF 第 {selectedRecordPdfPage ?? '?'} 页
                          </button>
                        ) : null}
                        {selectedRecordMatchesCurrentPdf && selectedRecordPdfPage ? (
                          <button
                            type="button"
                            onClick={() => {
                              setViewMode('reader')
                              void goToPdfPage(selectedRecordPdfPage)
                            }}
                          >
                            跳到当前 PDF 第 {selectedRecordPdfPage} 页
                          </button>
                        ) : selectedRecord?.paper?.pdfHash && !selectedRecord.paper?.pdfDataUrl ? (
                          <span className="muted">重新上传同一 PDF 后可跳到保存页码。</span>
                        ) : null}
                        {selectedRecord?.paper?.pdfDataUrl ||
                        selectedRecord?.figure?.imageDataUrl ||
                        selectedRecord?.figure?.thumbnailDataUrl ? (
                          <button type="button" onClick={() => void openSavedPdfInWorkspace(selectedRecord)}>
                            在工作台恢复保存的解析
                          </button>
                        ) : null}
                        {selectedRecordImageUrl.startsWith('blob:') ? (
                          <span className="muted">该 PDF 使用临时 blob URL，不能稳定回溯。</span>
                        ) : null}
                      </div>
                    </section>
                    <section>
                      <h3>短结论</h3>
                      <p>{selectedRecord.answer || '无回答内容'}</p>
                    </section>
                    <section>
                      <h3>不确定点</h3>
                      <p>{selectedRecord.uncertainty || '未记录'}</p>
                    </section>
                    <section>
                      <h3>依据</h3>
                      {selectedRecord.sources.length > 0 ? (
                        <ul>
                          {selectedRecord.sources.map((source) => (
                            <li key={source}>{source}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">未记录来源依据。</p>
                      )}
                    </section>
                    <section>
                      <h3>图上标注</h3>
                      {selectedRecord.annotations.length > 0 ? (
                        <div className="annotation-list">
                          {selectedRecord.annotations.map((annotation, index) => (
                            <div key={`${selectedRecord.id}-${index}`} className="annotation-detail">
                              <strong>
                                {index + 1}. {annotation.label}
                              </strong>
                              <span>看什么：{annotation.what}</span>
                              <span>怎么看：{annotation.howToRead}</span>
                              <span>说明：{annotation.meaning}</span>
                              <small>
                                bbox: {Math.round(annotation.bbox.x)}, {Math.round(annotation.bbox.y)},{' '}
                                {Math.round(annotation.bbox.width)} x {Math.round(annotation.bbox.height)}
                              </small>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="muted">未保存标注框。</p>
                      )}
                    </section>
                    <section>
                      <h3>上下文</h3>
                      <pre className="context-json">{JSON.stringify(selectedRecord.context, null, 2)}</pre>
                    </section>
                  </>
                ) : (
                  <p className="muted">选择一条记录查看详情。</p>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      <aside className="inspector">
        {viewMode === 'library' ? (
          <div className="panel">
            <h2>解析库说明</h2>
            <p className="muted">这里读取本地后端保存的真实记录。插件和网站保存的结果会合并显示。</p>
            <p className="muted">删除只作用于单条记录，需要确认；当前版本还没有批量删除和图片历史重放。</p>
          </div>
        ) : viewMode === 'settings' ? (
          <div className="panel">
            <h2>设置说明</h2>
            <p className="muted">API key 会保存在本机后端的 data/local-settings.json，不会写入前端代码或插件。</p>
            <p className="muted">浏览器插件只需要配置后端地址；模型 key 仍由这个本地后端读取。</p>
            <p className="muted">如果要发给别人使用，请发不包含 data/ 和 .env 的项目代码，让对方在设置页填自己的 key。</p>
          </div>
        ) : (
          <>
        {pdfIndex ? (
          <div className="panel">
            <h2>全文图谱</h2>
            {isIndexingPdf ? <p className="muted">正在索引全文。</p> : null}
            <input
              className="figure-search"
              value={figureQuery}
              onChange={(event) => setFigureQuery(event.target.value)}
              placeholder="搜索 figure、caption 或正文"
            />
            <div className="figure-index-list">
              {filteredFigures.map((item) => (
                <button
                  key={item.figureLabel}
                  type="button"
                  className={
                    item.figureLabel === selectedFigure?.figureLabel
                      ? 'figure-index-item active'
                      : 'figure-index-item'
                  }
                  onClick={() => {
                    setSelectedFigureLabel(item.figureLabel)
                    setCaption(item.captionCandidates[0]?.text ?? '')
                  }}
                >
                  <strong>Figure {item.figureLabel}</strong>
                  <span>{item.captionCandidates[0]?.text.slice(0, 130) || '未找到 caption'}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {pdfState ? (
          <div className="panel">
            <h2>自动证据</h2>
            {isInspectingPdf ? <p className="muted">正在自动匹配图注和正文引用。</p> : null}
            {selectedFigure || pdfInspect ? (
              <div className="evidence-list">
                <p className="muted">Figure：{selectedFigure?.figureLabel ?? pdfInspect?.figureLabel ?? '未识别'}</p>
                {topCaption ? (
                  <div className="evidence-card">
                    <strong>匹配到的 caption</strong>
                    <p>
                      页码：{topCaption.pageNumber}
                      {typeof topCaption.score === 'number' ? `；置信分：${topCaption.score}` : ''}
                    </p>
                    {topCaption.layoutMode || topCaption.stopReason ? (
                      <p>
                        {topCaption.layoutMode ? `版面：${topCaption.layoutMode}` : ''}
                        {topCaption.stopReason ? `；停止原因：${topCaption.stopReason}` : ''}
                      </p>
                    ) : null}
                    <p>{topCaption.text}</p>
                  </div>
                ) : null}
                {topBodyEvidence ? (
                  <div className="evidence-card">
                    <strong>正文引用候选</strong>
                    <p>
                      页码：{topBodyEvidence.pageNumber}
                      {typeof topBodyEvidence.score === 'number' ? `；置信分：${topBodyEvidence.score}` : ''}
                    </p>
                    {renderBodyEvidenceMeta(topBodyEvidence)}
                    <p>{topBodyEvidence.text}</p>
                  </div>
                ) : null}
                {bodyEvidenceList.length > 1 ? (
                  <div className="evidence-list">
                    {bodyEvidenceList.slice(1).map((item) => (
                      <div key={`${item.pageNumber}-${item.text.slice(0, 24)}`} className="evidence-card">
                        <strong>更多正文引用</strong>
                        <p>
                          页码：{item.pageNumber}
                          {typeof item.score === 'number' ? `；置信分：${item.score}` : ''}
                        </p>
                        {renderBodyEvidenceMeta(item)}
                        <p>{item.text}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="panel">
          <h2>提问</h2>
          <div className="quick-grid">
            {quickQuestions.map((item) => (
              <button key={item} type="button" onClick={() => setQuestion(item)}>
                {item}
              </button>
            ))}
          </div>
          <form onSubmit={analyze}>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="围绕整张图或选中区域提问"
            />
            <textarea
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              placeholder="选中 figure 的 caption 会出现在这里，也可以手动修正"
            />
            <button type="submit" disabled={isAnalyzing || isLoadingFile || !visual}>
              {isLoadingFile ? '加载中' : isAnalyzing ? '解析中' : '解析内容'}
            </button>
          </form>
        </div>

        <div className="panel result-panel">
          <h2>解释</h2>
          {result ? (
            <>
              <button type="button" onClick={() => void saveCurrentAnalysis()}>
                保存本次解读
              </button>
              {saveStatus ? <p className="muted">{saveStatus}</p> : null}
              <section>
                <h3>短结论</h3>
                <p>{result.answer}</p>
              </section>
              {annotations.length > 0 ? (
                <section>
                  <h3>图上标注</h3>
                  <div className="annotation-list">
                    {annotations.map((annotation, index) => (
                      <button
                        key={`${annotation.label}-detail-${index}`}
                        type="button"
                        className={
                          activeAnnotationIndex === index
                            ? 'annotation-detail active'
                            : 'annotation-detail'
                        }
                        onClick={() => setActiveAnnotationIndex(index)}
                      >
                        <strong>
                          {index + 1}. {annotation.label}
                        </strong>
                        <span>看什么：{annotation.what}</span>
                        <span>怎么看：{annotation.howToRead}</span>
                        <span>说明：{annotation.meaning}</span>
                        <small>
                          {annotation.evidenceType} · {Math.round(annotation.confidence * 100)}%
                        </small>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              <section>
                <h3>依据</h3>
                <ul>
                  {result.sources.map((source) => (
                    <li key={source}>{source}</li>
                  ))}
                </ul>
              </section>
              <section>
                <h3>不确定点</h3>
                <p>{result.uncertainty}</p>
              </section>
            </>
          ) : errorMessage ? (
            <div className="error-box">
              <h3>解析失败</h3>
              <p>{errorMessage}</p>
            </div>
          ) : (
            <p className="muted">结果会显示在这里。当前解析会调用真实模型，不再返回模拟响应。</p>
          )}
        </div>
          </>
        )}
      </aside>
    </main>
  )
}

export default App
