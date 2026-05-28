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

type AnalysisResult = {
  answer: string
  sources: string[]
  uncertainty: string
}

type PdfEvidence = {
  pageNumber: number
  text: string
  score?: number
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

  await page.render({
    canvas,
    canvasContext: context,
    viewport,
  }).promise

  return canvas.toDataURL('image/png')
}

async function parseApiResponse(response: Response) {
  const rawText = await response.text()
  const contentType = response.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')

  if (isJson) {
    try {
      return {
        ok: response.ok,
        status: response.status,
        payload: rawText ? JSON.parse(rawText) : null,
      }
    } catch {
      return {
        ok: false,
        status: response.status,
        payload: {
          error: '接口返回了 JSON 响应头，但内容不是合法 JSON。',
        },
      }
    }
  }

  return {
    ok: false,
    status: response.status,
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
  const [errorMessage, setErrorMessage] = useState('')
  const [status, setStatus] = useState('等待导入图片、PDF，或直接粘贴截图')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [isInspectingPdf, setIsInspectingPdf] = useState(false)
  const [pageInput, setPageInput] = useState('1')

  const resetView = () => {
    setSelection(null)
    setDraftSelection(null)
    setResult(null)
    setErrorMessage('')
    setPdfInspect(null)
  }

  const setImageVisual = async (file: File) => {
    const dataUrl = await fileToDataUrl(file)
    setPdfState(null)
    setPageInput('1')
    setCaption('')
    lastInspectedRef.current = ''
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
    setCaption('')
    lastInspectedRef.current = ''
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
        setCaption(payload.captionCandidates?.[0]?.text ?? '')
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
  }, [pdfState, visual])

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
    setErrorMessage('')
    setStatus('正在调用真实多模态解析接口')

    try {
      const response = await fetch('/api/analyze-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: visual.dataUrl,
          imageName: pdfState ? `${visual.name} page ${pdfState.currentPage}` : visual.name,
          caption,
          question,
          selection,
        }),
      })

      const { ok, payload } = await parseApiResponse(response)
      if (!ok) {
        throw new Error(payload?.error || '解析失败')
      }

      setResult(payload)
      setStatus('解析完成')
    } catch (error) {
      const message = error instanceof Error ? error.message : '解析失败'
      setErrorMessage(message)
      setStatus(message)
    } finally {
      setIsAnalyzing(false)
    }
  }

  const activeSelection = draftSelection ?? selection
  const topCaption = pdfInspect?.captionCandidates[0]
  const topBodyEvidence = pdfInspect?.bodyEvidence[0]

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
              <>
                <img ref={imageRef} src={visual.dataUrl} alt={visual.name} draggable={false} />
                {pdfState ? <div className="source-chip">PDF 第 {pdfState.currentPage} 页预览</div> : null}
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
              </>
            ) : (
              <div className="empty-state">
                <strong>上传图片、上传 PDF，或直接粘贴论文截图</strong>
                <span>PDF 会在后台自动匹配当前页相关的 figure caption。</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <aside className="inspector">
        {pdfState ? (
          <div className="panel">
            <h2>自动证据</h2>
            {isInspectingPdf ? <p className="muted">正在自动匹配图注和正文引用。</p> : null}
            {pdfInspect ? (
              <div className="evidence-list">
                <p className="muted">Figure：{pdfInspect.figureLabel ?? '未识别'}</p>
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
                    <p>{topBodyEvidence.text}</p>
                  </div>
                ) : null}
                {pdfInspect.bodyEvidence.length > 1 ? (
                  <div className="evidence-list">
                    {pdfInspect.bodyEvidence.slice(1).map((item) => (
                      <div key={`${item.pageNumber}-${item.text.slice(0, 24)}`} className="evidence-card">
                        <strong>更多正文引用</strong>
                        <p>
                          页码：{item.pageNumber}
                          {typeof item.score === 'number' ? `；置信分：${item.score}` : ''}
                        </p>
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
              placeholder="自动匹配到的 figure caption 会出现在这里，也可以手动补充正文"
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
