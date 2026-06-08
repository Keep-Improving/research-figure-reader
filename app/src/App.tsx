import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, PointerEvent } from 'react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import './App.css'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

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

function App() {
  const imageRef = useRef<HTMLImageElement | null>(null)
  const lastInspectedRef = useRef('')
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

    const inspectionKey = `${visual.name}:${pdfState.currentPage}`
    if (lastInspectedRef.current === inspectionKey) return
    lastInspectedRef.current = inspectionKey

    const inspectPdfContext = async () => {
      setIsInspectingPdf(true)
      setPdfInspect(null)
      setErrorMessage('')
      setStatus('正在自动匹配当前页相关的 figure caption')

      try {
        const response = await fetch('/api/pdf-inspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdf: visual.originalDataUrl,
            currentPage: pdfState.currentPage,
          }),
        })

        const { ok, payload } = await parseApiResponse(response)
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
    if (!visual?.originalDataUrl || !pdfState || pdfIndex) return

    const indexPdf = async () => {
      setIsIndexingPdf(true)
      setStatus('正在建立全文 figure 图谱')

      try {
        const response = await fetch('/api/pdf-index', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdf: visual.originalDataUrl,
            currentPage: pdfState.currentPage,
          }),
        })

        const { ok, payload } = await parseApiResponse(response)
        if (!ok) {
          throw new Error(payload?.error || 'PDF 全文索引失败')
        }

        setPdfIndex(payload)
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
      const response = await fetch('/api/analyze-image', {
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

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>科研图片理解</h1>
            <p>{status}</p>
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
      </section>

      <aside className="inspector">
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
      </aside>
    </main>
  )
}

export default App
