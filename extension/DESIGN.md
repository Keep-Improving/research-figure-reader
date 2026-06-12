# 浏览器插件设计文档

## 1. 目标

浏览器插件的目标是在真实文献网页里直接使用图片解析能力。用户不需要把论文 PDF 或图片重新上传到独立网站，而是在 Nature、PMC、期刊 HTML 页面等阅读环境中，点击某张图旁边的“解析图”，即可得到：

- 图上的 panel 标注框。
- 右侧解释面板中的总解释。
- 与该图对应的 figure caption、附近正文或可识别证据来源。
- 可保存、可再次打开、可管理的解析记录。

插件不是独立网站的替代品。插件负责从网页现场采集当前图、图注候选、网页上下文和用户交互；本地后端负责融合 HTML/PDF 的 figure context、模型调用、PDF/文本解析、结果持久化和跨入口同步。

## 2. 当前实现状态

当前 MVP 已实现：

- 在网页 `<img>` 候选图片左上角插入“解析图”按钮。
- 点击后获取图片资源，调用本地 `http://127.0.0.1:8787/api/analyze-image`。
- 将模型返回的 annotation bbox 覆盖回网页图片。
- 右侧显示解释面板。
- 对 Springer Nature 图片资源，优先尝试把 `lw685` 升级为 `lw1200` 高分辨率图做分析。
- annotation 覆盖层绑定到网页 `<img>`，滚动和缩放后重新计算位置。
- 网页图片解析前会调用 `/api/browser/figure-context`，把插件提取的 caption 候选交给后端统一选择。
- 浏览器 PDF / PDF.js / 嵌入式 PDF 已有第一版检测和截图 fallback；能读取 PDF bytes 时走后端 PDF caption/body evidence 管线。

当前仍未完成：

- 图注提取仍依赖当前网页 DOM 和后端规则，复杂出版社页面需要继续补 site adapter。
- 正文引用没有和插件点击的具体 figure 建立稳定关联。
- 解析结果没有持久化保存。
- 插件和独立网站之间没有统一的结果库。
- Zotero、网页 canvas/svg 图还没有完整适配。

## 3. 用户流程

### 3.1 网页图像解析

1. 用户打开论文 HTML 页面。
2. 插件扫描页面中的候选 figure 图片。
3. 每张候选图左上角显示“解析图”按钮。
4. 用户点击按钮。
5. 插件锁定目标图片元素，提取图片资源、图注、页面 URL、标题、DOI/PMCID 等元数据。
6. 插件调用本地后端分析接口。
7. 后端返回总解释、来源、uncertainty 和 annotation bbox。
8. 插件把 annotation bbox 映射到当前网页图片元素上，并展示右侧解释面板。
9. 如果结果已保存，用户下次打开同一篇文章和同一张图时可直接加载历史结果。

### 3.2 结果复用

1. 用户再次进入同一篇文章。
2. 插件根据 `documentId + figureId + imageFingerprint` 查询本地结果库。
3. 如果找到结果，在按钮旁显示“已有解析”状态。
4. 用户点击后直接打开历史解析，不必重新调用模型。
5. 用户可以选择重新解析，生成新版本。

## 4. 数据流

### 4.1 输入数据

插件点击“解析图”时应构造一个 `FigureAnalysisRequest`：

```ts
type FigureAnalysisRequest = {
  source: 'browser-extension'
  pageUrl: string
  pageTitle: string
  documentId: string | null
  figureId: string | null
  imageUrl: string | null
  imageFingerprint: string | null
  analysisImage: string
  analysisImageMode: 'source-image' | 'upscaled-source-image' | 'visible-screenshot'
  captionText: string
  captionSource: 'figcaption' | 'site-adapter' | 'nearby-text' | 'alt' | 'none'
  captionConfidence: number
  captionIsComplete: boolean
  nearbyBodyText: string
  selectedRegion?: NormalizedBox
}
```

字段说明：

- `documentId` 优先使用 DOI、PMCID、PMID、arXiv ID；没有时使用规范化 URL hash。
- `figureId` 优先来自 caption 中的 `Fig. 1` / `Figure 1` / `Extended Data Fig. 2`。
- `imageFingerprint` 用于跨 URL、跨入口识别同一张图，不能只依赖网页图片 URL。
- `analysisImage` 是 data URL 或后端可读取的资源 URL。
- `captionText` 必须尽量是完整 figure caption，而不是只取 `alt` 或图片标题。
- `captionSource`、`captionConfidence`、`captionIsComplete` 必须传给后端和 UI；如果只拿到 `alt` 或附近短文本，界面和 prompt 都要明确标记为弱证据。
- `nearbyBodyText` 用作辅助，不能替代 caption。

### 4.1.1 imageFingerprint

同一张 figure 可能以不同 URL 出现，例如 `lw685`、`lw1200`、`full`、`webp`、`png`。因此 `imageFingerprint` 应按以下顺序生成：

1. 规范化图片 URL：去掉临时 query、统一 Springer Nature 的 `lw685/lw1200/full` 变体。
2. 结合图片尺寸：`naturalWidth`、`naturalHeight`、分析图尺寸。
3. 后续增加 perceptual hash：用于识别同图不同压缩格式。

最小实现可以先用 `normalizedImageUrl + naturalWidth + naturalHeight` hash。后续如果发现同一 figure URL 不稳定，再加入感知哈希。

### 4.2 输出数据

后端返回结构保持和独立网站一致：

```ts
type FigureAnalysisResult = {
  answer: string
  sources: string[]
  uncertainty: string
  annotations: FigureAnnotation[]
}

type FigureAnnotation = {
  label: string
  what: string
  howToRead: string
  meaning: string
  bbox: NormalizedBox
  confidence: number
  evidenceType: 'visible' | 'caption' | 'body' | 'inference' | 'uncertain'
}
```

## 5. 图注提取设计

用户提出的问题是当前插件最关键的缺口：点击“解析图”时，模型应同时看到这张图的图解，而不是只看图片。

### 5.1 提取优先级

插件应按以下顺序提取 caption：

1. 最近的语义容器：`img.closest('figure')` 内的 `figcaption`。
2. 期刊站点结构化容器：Nature / Springer 的 `figure`、`c-article-section__figure`、`c-figure`、`c-article-figure-description` 等区域。
3. PMC / PubMed Central：`figcaption`、`.fig-caption`、`.caption`、`.fig-title`、`.fig-desc`。
4. 图片附近文本：图片父容器、紧邻后续兄弟节点中的 `Fig. X` 开头段落。
5. `alt` 和 `title`：只能作为 fallback，不能作为主 caption。

### 5.2 匹配规则

如果页面中有多张图，不能只取最近文本。应先识别目标图的 figure label：

- 从 `figcaption` 中提取 `Fig. 1`、`Figure 1`、`Extended Data Fig. 1`。
- 从图片 URL 提取 `Fig1`、`Fig2`、`MediaObjects/...Fig3...`。
- 从父容器 ID 或 anchor 提取 `Fig1`、`figure-1`。

提取到 `figureId` 后，在当前文章 DOM 中全文搜索同一 label 的 caption 容器。这样可以处理图片和 caption 不相邻、caption 折叠、响应式移动布局等情况。

如果多个来源给出的 figure label 不一致，例如 URL 指向 `Fig3` 但最近 caption 指向 `Fig2`，插件不能强行使用其中一个。此时应降级为 `captionConfidence < 0.5`，在面板中显示“图注未确认”，并把候选 caption 作为弱证据传给后端。模型回答也必须说明图注可能不匹配。

### 5.3 传给模型的上下文格式

插件不应直接把 DOM 中提取到的 caption 原样传给 `/api/analyze-image` 作为最终上下文。正确流程是：

1. 插件提取图片、URL、caption 候选、附近正文、页面元数据。
2. 插件调用 `/api/browser/figure-context`。
3. 后端融合 HTML adapter、PDF 解析能力、caption 清洗、figure label 匹配、正文引用搜索。
4. 后端返回统一的 `FigureContext`。
5. 插件再调用分析接口，或由后端在同一请求中完成分析。

后端 prompt 中应明确分段：

```text
Retrieved figure caption:
...

Nearby body text:
...

Visible image:
...
```

模型回答必须区分：

- `可见图像依据`
- `图注依据`
- `正文依据`
- `AI 推断`

如果未找到 caption，面板应显示“未找到完整图注”，不能让用户误以为已使用图注。

### 5.4 统一 FigureContext

网站和插件应共享同一套 context 结构，避免两套 caption 逻辑长期分叉：

```ts
type FigureContext = {
  documentId: string | null
  figureId: string | null
  captionCandidates: Array<{
    text: string
    source: 'html-figcaption' | 'site-adapter' | 'pdf-caption' | 'nearby-text' | 'alt'
    confidence: number
    isComplete: boolean
    evidence: string[]
  }>
  selectedCaption: string
  bodyEvidence: Array<{
    text: string
    source: 'html-body' | 'pdf-body'
    confidence: number
    directReferences: string[]
  }>
}
```

PDF 上传网站已经有更强的 caption 几何抽取能力；插件的 HTML 提取能力应作为候选来源之一，由后端统一评分。对于网页 HTML，优先使用 site adapter 和 DOM 语义；对于浏览器 PDF，优先复用后端 PDF 全文解析逻辑。

## 6. 坐标系统设计

插件涉及两个坐标系：

- `analysisImage` 坐标系：模型看到的图，bbox 归一化到 0-1000。
- `displayImage` 坐标系：网页中当前显示的 `<img>` 元素。

实现原则：

- bbox 永远以 `analysisImage` 为准保存。
- 显示时每次读取 `img.getBoundingClientRect()`。
- 根据 `naturalWidth / naturalHeight`、CSS `object-fit`、`object-position` 计算映射。
- 页面滚动、缩放、图片 resize 后重新映射，不保存绝对屏幕坐标。

对于 Springer Nature：

- 页面显示常用 `lw685` 低分辨率图。
- 插件应优先用 `lw1200` 或可用 full-size image 分析。
- 因为 `lw685` 和 `lw1200` 是同一图像比例，归一化 bbox 可以映射回页面显示图。

如果原图和网页图不是同一比例，必须退回截图模式或计算裁切偏移，否则红框会漂移。

## 7. 浏览器 PDF 场景

插件必须判断当前网页是否实际是在显示 PDF。原因是很多文献页面不是 HTML full text，而是浏览器内置 PDF 阅读器、出版社 PDF iframe、PDF.js viewer，或用户直接把本地 PDF 拖进浏览器打开。

### 7.1 PDF 判断规则

1. 当前 URL 路径或 content type 指向 PDF：`.pdf`、`application/pdf`、`blob:` PDF。
2. 页面中存在浏览器 PDF viewer 标记：`embed[type="application/pdf"]`、`object[type="application/pdf"]`、Chrome PDF viewer 的 `pdf-viewer`、PDF.js 的 `.pdfViewer` / `viewer.html`。
3. 页面主要内容是 canvas page 或 PDF page layer，而不是普通 HTML figure。
4. 用户在扩展按钮中手动选择“按 PDF 解析当前页面”。

### 7.2 PDF 处理路径

1. 获取 PDF 文件 URL 或当前 PDF data/blob。
2. 如果插件能读取 PDF bytes，则发送给后端 `/api/pdf-index` 或新的 `/api/browser/figure-context`。
3. 后端复用网站已有 PDF 解析能力：全文 caption 检索、双栏 caption 几何抽取、正文引用搜索。
4. 插件根据用户当前页码和选中的图像区域锁定 figure。
5. 分析时传入 PDF 提取到的 caption 和 body evidence，而不是只传页面截图。

### 7.3 PDF 获取限制

浏览器内置 PDF viewer 可能因为权限、blob URL 或跨域限制导致插件拿不到 PDF bytes。此时 fallback：

- 用当前可见页截图作为图像输入。
- 让用户手动画框选中 figure。
- 面板明确显示“未读取到 PDF 文本层，caption/body evidence 不完整”。
- 提供“在网站中打开/上传 PDF”入口，让用户把同一 PDF 交给独立网站处理。

### 7.4 PDF 与网站同步

浏览器 PDF 和独立网站上传同一 PDF 时应识别为同一文献：

- 优先使用 DOI / PMID / PMCID。
- PDF bytes 可用时计算文件 hash。
- 无法读取 bytes 时使用 URL + 标题 + 页数推断，置信度较低。

同一文献识别成功后，插件中的解析结果和网站中的解析库应读写同一个 `PaperRecord` / `FigureRecord`。

## 8. 结果保存与同步

用户提出的第二个问题是产品必须解决的：解析结果不能每次重新生成，需要保存、打开、管理，并在插件和网站之间同步。

### 8.1 保存位置

推荐采用“本地后端统一保存”的方案，而不是只保存在浏览器插件里。

原因：

- 插件、独立网站、后续 Zotero 集成都可以访问同一结果库。
- 结果可能包含较长文本、多个版本、图片 fingerprint 和用户批注，`chrome.storage` 不适合作为主库。
- 本地文件或 SQLite 更容易备份、迁移和导出。

建议存储：

- 开发期：`app/data/analysis-store.sqlite`
- 附件目录：`app/data/assets/`
- 后续可配置到用户目录：`%APPDATA%/ResearchFigureReader/`

插件侧只缓存少量索引：

- 最近打开的 `documentId`
- 最近解析的 `figureId`
- 后端连接状态

### 8.2 数据模型

```ts
type PaperRecord = {
  id: string
  doi?: string
  pmcid?: string
  pmid?: string
  title: string
  urls: string[]
  createdAt: string
  updatedAt: string
}

type FigureRecord = {
  id: string
  paperId: string
  figureLabel: string
  imageUrl?: string
  imageFingerprint: string
  captionText?: string
  pageUrl: string
  createdAt: string
  updatedAt: string
}

type AnalysisRecord = {
  id: string
  paperId: string
  figureId: string
  source: 'browser-extension' | 'web-app' | 'zotero'
  model: string
  answer: string
  sourcesJson: string
  uncertainty: string
  annotationsJson: string
  version: number
  createdAt: string
  updatedAt: string
}

type UserAnnotationRecord = {
  id: string
  analysisId: string
  figureId: string
  kind: 'note' | 'bbox-correction' | 'bookmark'
  text?: string
  annotationsJson?: string
  createdAt: string
  updatedAt: string
}
```

`AnalysisRecord` 应尽量不可变。重新解析生成新 `version`，不要覆盖旧结果。用户批注和用户修正 bbox 存在 `UserAnnotationRecord` 中，避免模型重新解析时覆盖用户编辑。

### 8.3 打开解析结果

插件中：

- “解析图”按钮旁显示已有状态，例如“已解析”。
- 点击图上的历史结果入口，打开右侧面板。
- 面板展示最近版本，并提供“历史版本”“重新解析”“添加批注”“删除”。

独立网站中：

- 增加“解析库”页面。
- 支持按文献、figure、日期、来源筛选。
- 打开某条结果时，显示图像、caption、正文证据、annotation 和用户批注。

### 8.4 管理解析结果

必须支持：

- 删除单条 analysis。
- 删除某篇 paper 的全部结果，删除前需要用户确认。
- 添加/编辑用户批注。
- 标记收藏。
- 重新解析并生成新版本，而不是覆盖旧版本。
- 拖拽修正 annotation bbox，并保存为用户修正版。
- 导出 Markdown / JSON。

删除策略：

- 默认软删除：`deletedAt` 标记。
- 提供“清理回收站”时才物理删除。
- 大规模删除必须二次确认，符合项目 AGENTS.md 约束。

### 8.5 插件和网站同步

同步核心是后端统一 API：

```text
POST /api/analysis
GET  /api/analysis?paperId=&figureId=
GET  /api/analysis/lookup?documentId=&figureId=&imageFingerprint=
GET  /api/papers/:id
PATCH /api/analysis/:id
DELETE /api/analysis/:id
```

插件点击“解析图”前先调用 `GET /api/analysis/lookup`。如果命中历史结果，默认直接展示历史结果，并提供“重新解析”入口。插件保存新结果时调用 `POST /api/analysis`。独立网站读取同一后端 API，因此不需要浏览器插件和网站直接互相通信。

如果本地后端不可用，插件默认不生成离线解析记录，只显示连接错误和启动后端提示。后续可以增加 `chrome.storage.local` 临时队列，但队列只保存待同步元数据和用户意图，不保存完整模型结果，避免插件和本地后端出现两套结果库。

同一篇文献的识别顺序：

1. DOI。
2. PMCID / PMID。
3. arXiv ID。
4. Canonical URL。
5. 标题 + 第一作者 + 年份 hash。

同一张图的识别顺序：

1. `paperId + figureLabel`。
2. `paperId + imageFingerprint`。
3. `pageUrl + imageUrl`。

如果 `figureLabel`、`imageFingerprint` 和 `imageUrl` 指向不一致，不应强行合并结果。插件应把结果标记为“可能不同图”，并要求用户确认或重新解析。

## 9. 后端接口建议

当前 `/api/analyze-image` 只做即时分析。为了支持插件，应新增：

```text
POST /api/browser/figure-context
POST /api/analyze-image
POST /api/analysis
GET  /api/analysis
PATCH /api/analysis/:id
DELETE /api/analysis/:id
```

`/api/browser/figure-context` 用于把插件提取到的 URL、caption 候选、页面文本交给后端进一步规范化：

- 解析 DOI / PMCID。
- 检测当前来源是 HTML 还是 PDF。
- PDF 场景下复用 `/api/pdf-index` 和 `/api/pdf-inspect` 的 caption/body evidence 能力。
- 清洗 caption。
- 匹配 figure label。
- 查找正文引用。
- 返回统一上下文。

这样插件不需要把所有站点适配逻辑都写在 content script 里。

## 10. 站点适配策略

第一优先级：

- Nature / Springer。
- PMC。
- PubMed abstract page 中跳转到 PMC / publisher 的场景。
- bioRxiv / medRxiv。

适配方式：

- 优先使用语义 DOM。
- 对常见站点做 adapter。
- adapter 只负责提取，不负责解释。

```ts
type SiteAdapter = {
  name: string
  matches(location: Location): boolean
  findFigures(): WebFigureCandidate[]
  extractCaption(candidate: WebFigureCandidate): CaptionExtractionResult
  extractDocumentId(): DocumentId | null
}

type CaptionExtractionResult = {
  figureLabel: string | null
  captionText: string
  captionSource: 'figcaption' | 'site-adapter' | 'nearby-text' | 'alt' | 'none'
  captionConfidence: number
  captionIsComplete: boolean
  evidence: string[]
}
```

通用 fallback：

- 扫描 `<figure>` 和 `<img>`。
- 用图片尺寸过滤 logo、头像、图标。
- 从附近文本找 `Fig.` / `Figure` 开头的 caption。

## 11. 风险与解决方向

### 11.1 annotation bbox 仍不准

原因：

- 低分辨率网页图。
- 模型把 panel 内部元素误认为 panel。
- 原图和网页图比例不一致。

策略：

- 优先高分辨率原图。
- prompt 限制只标主 panel。
- 后续增加本地图像处理：检测 panel 字母、白色 gutter、图像连通区域。
- 允许用户拖拽修正，并把修正保存为用户编辑版本。

### 11.2 caption 找错或缺失

策略：

- 建立站点 adapter。
- 使用 figure label 在 DOM 全文反查。
- 对页面 JSON-LD、meta、publisher data attributes 做补充解析。
- 面板明确显示 caption 来源和是否完整。

### 11.3 用户滚动或页面布局变化

策略：

- overlay 绑定 DOM 元素，不绑定屏幕截图。
- 使用 `scroll`、`resize`、`ResizeObserver` 重新映射。
- 目标图片不可见时隐藏 overlay，回到视口后恢复。

### 11.4 结果隐私

策略：

- 默认本地保存。
- 不上传到第三方数据库。
- 模型调用时明确提示用户使用的是配置的模型服务。
- 后续增加“本地清除全部数据”和“导出备份”。

### 11.5 浏览器 PDF 读取失败

策略：

- 插件先区分 HTML 文献页、浏览器 PDF、嵌入式 PDF viewer。
- 能拿到 PDF bytes 时走后端 PDF 解析，不能拿到时走截图 + 手动画框 fallback。
- fallback 状态必须在 UI 中可见，不能把截图分析伪装成“已结合全文”。
- 提供跳转到独立网站上传 PDF 的入口，让用户用更完整的 PDF 管线补齐 caption 和正文证据。

## 12. 下一步实现顺序

1. 强化插件 caption 提取：优先补 Nature / Springer、PMC 的 site adapter。
2. 新增本地分析结果存储 API 和 SQLite 数据库。
3. 插件点击“解析图”后先查历史结果，有结果则直接展示。
4. 独立网站增加“解析库”页面，读取同一后端数据。
5. 支持用户批注、删除、重新解析和版本历史。
6. 增加站点 adapter 结构，逐步扩展到 bioRxiv、ScienceDirect、Cell、Zotero。
