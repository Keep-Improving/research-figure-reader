# 科研图片理解工具 PRD

## 1. 项目目标

构建一个面向文献阅读场景的 AI 图片理解工具，帮助用户在阅读论文时直接理解 figure，并把图片、figure caption 和正文证据联系起来。

核心目标不是只给图片生成概括，而是在图片原位提供结构化解析：识别 panel、坐标轴、标注、实验对象、关键趋势、统计符号和图注对应关系，并支持追问“这个 panel 说明了什么”“正文哪里解释了这个结果”“这张图支持论文的哪个结论”。

产品入口应贴近真实阅读环境。大部分文献阅读发生在浏览器、浏览器 PDF 阅读器、本地 PDF 阅读器或 Zotero 等文献管理工具中，因此工具不应只依赖“进入独立网站后重新上传论文”的单一路径。

## 2. 目标用户

- 需要阅读大量科研论文的研究者、学生和科研助理。
- 对跨学科论文图像不熟悉，需要快速理解图中实验设计和结果的人。
- 需要从图像中提取证据、整理文献笔记或做综述的人。

## 3. 核心使用场景

### 3.1 最简使用路径

1. 用户拖入一篇 PDF 或一张论文截图。
2. 系统自动定位图片、图注和可能相关的正文。
3. 用户直接点击图片、框选区域或输入问题。
4. 系统在图片旁边给出解释，并显示解释依据。

用户不应该先理解复杂项目结构、选择模型参数、手动拆分图片、复制图注或手动粘贴正文。系统可以允许用户修正自动识别结果，但不应把修正作为使用前提。

### 3.2 阅读环境入口

需要按优先级考虑多种入口，而不是只做独立网页应用：

- 本地 Web 应用：适合作为 MVP，支持用户拖入 PDF 或图片。
- 浏览器扩展：适合网页论文、HTML full text、浏览器 PDF、出版社网页、bioRxiv、PubMed Central 等场景。
- Zotero 集成：适合重度文献管理用户，可通过 Zotero plugin 或 companion app 读取当前条目 PDF。
- 截图 / 剪贴板入口：适合任何 PDF 阅读器或不易集成的环境。
- 系统分享入口：后续可支持从浏览器、PDF 阅读器或文件管理器分享 PDF / 图片到工具。

架构上需要抽象统一的 `DocumentSource`，避免把“上传文件”写死为唯一入口：

- `UploadedPdfSource`
- `ImageSource`
- `BrowserPageSource`
- `ZoteroItemSource`

## 4. 核心功能

### 4.1 论文图片原位解析

用户上传或导入论文 PDF 后，系统识别文中的 figures，并在图上叠加可交互的解析层。用户可以点击图中的 panel、曲线、柱状图、显微图区域、统计标记或图例，查看 AI 对该区域的解释。

### 4.2 图注与图片联动

系统需要在全文范围内查找对应 figure caption，而不是只看当前页。因为 PDF 中图和图注经常跨页、分栏或分离排版。

最低要求：

- 如果当前锁定的是 `Figure 2`，系统要检索 `Figure 2`, `Fig. 2`, `Fig 2` 等模式。
- 如果图注不在当前页，系统仍要返回最可能匹配的 caption 片段和所在页码。
- 返回结果需要标记 caption 的来源页码、匹配置信度和文本锚点。
- 图注抽取不能依赖 “caption” 这个词。真实论文图注通常以 `Fig. 1 |`、`Fig. 1.`、`Figure 1.` 等结构开头。
- 对 Nature 等双栏排版，caption 可能位于页面底部并横跨两栏。系统必须按页面几何布局识别底部图注区域，再按左栏从上到下、右栏从上到下拼接，避免只取到 `(g)` 前后的半段。
- 图注区域需要和正文区域隔离，不能把上方正文、DOI、页脚、期刊名混进 caption。

### 4.3 正文证据回链

系统在正文中检索与某张图或某个 panel 相关的段落，展示作者如何解释该图，并区分：

- 图像本身可见的信息
- 图注提供的信息
- 正文解释或推论
- AI 基于上下文做出的推断

正文引用候选必须排除 caption 区域，避免把图注误放到正文证据里。

### 4.4 交互式问答

用户可以围绕整张图、某个 panel 或某个选中区域提问。回答必须带来源标记，避免把模型猜测伪装成论文事实。

示例问题：

- `Figure 2C 的 y 轴代表什么？`
- `这张图证明了作者的哪个结论？`
- `A panel 和 D panel 的实验条件有什么区别？`
- `这个显微图中箭头标出的结构是什么？`
- `正文哪里讨论了这组结果？`

### 4.5 文献笔记输出

用户可以把解析结果导出为结构化笔记，包括图片摘要、每个 panel 的解释、关键结论、相关正文段落和用户追问记录。

## 5. MVP 范围

- 上传 PDF 或单张图片。
- 从 PDF 中抽取页面文本和文本坐标。
- 展示 PDF 页面或图片，并支持用户在图片上框选区域。
- 使用真实多模态 AI 对整图或选区进行解释。
- 自动检索图注和正文中与图片相关的内容。
- 在回答中明确标记来源：图片、图注、正文、AI 推断。
- 不返回模拟 API 响应。

## 6. 非目标

- 不在 MVP 中伪造论文内容或模拟 API 响应。
- 不把 AI 解释当作事实来源，所有解释都需要区分来源。
- 不在没有用户授权的情况下批量删除论文、笔记或解析数据。
- 不承诺自动判断论文结论是否正确，只辅助理解图片与文本证据。

## 7. 技术架构

### 7.1 前端

- PDF / 图片查看器
- 图片标注和框选层
- 图注与正文证据面板
- 问答输入框和回答来源标记

前端交互优先级：

1. 打开文件后直接看到可分析的图片。
2. 点击图片区域即可询问，不需要先创建标注对象。
3. 解释面板默认显示“结论、依据、不确定点”。
4. 图注和正文证据默认自动匹配，用户不需要手动输入 figure 编号。
5. 高级面板、批量处理、导出、模型设置放在二级入口。

### 7.2 后端

- PDF 解析：页面、页面文本、文本坐标、figure 编号、caption 文本、正文证据。
- 图像预处理：裁剪、缩放、区域坐标映射。
- 多模态模型调用。
- 文本检索与引用定位。
- 文档来源适配层。

新增后端要求：

- 支持跨页 figure-caption 关联。
- 支持底部双栏 caption 几何抽取。
- 在锁定特定 figure 后，支持全文检索 caption 和正文引用。
- 返回结构化字段：`page`, `figure_label`, `caption_match_score`, `text_anchor`, `region`。

### 7.3 数据模型

核心实体：

- `Paper`
- `Figure`
- `Panel`
- `Region`
- `Evidence`
- `Conversation`
- `SourceAnchor`

建议字段：

- `Figure.figureLabel`
- `Figure.pageNumber`
- `Figure.captionText`
- `Figure.captionPageNumber`
- `Figure.captionMatchScore`
- `Evidence.sourceType`
- `Evidence.anchorText`
- `Evidence.region`

## 8. 当前实现与缺口

当前原型已具备：

- PDF 上传与翻页预览：已完成。
- 图片上传与截图粘贴：已完成。
- 区域框选：已完成。
- 真实多模态接口调用：已完成。
- 基础问答与结果展示：已完成。
- PDF 后台自动 caption 匹配：进行中。
- 网页 `<img>` 图片浏览器扩展入口：已完成 MVP，可在论文网页中点击图片旁的“解析图”并把标注框覆盖回网页图片。

当前仍未达到目标的关键点：

- 独立 Web App 已支持图上标注解释，浏览器扩展 MVP 已支持网页图片上覆盖解释框；但 panel 级自动框选仍依赖模型定位，精度和完整覆盖还需要继续优化。
- 还没有自动锁定单个 figure，当前更多是 page 级解析。
- 正文证据回链已支持明确 `Fig./Figure X` 引用优先、完整句窗口和匹配规则展示；仍需要更细的来源高亮与 panel 级定位。
- 还没有结构化导出 `figure_label`, `caption_page`, `bbox`, `evidence_type` 等字段。
- 独立 Web App 已实现 PDF 页面主 figure 自动裁剪分析第一版；网页扩展已实现当前可见图片区域截图裁剪。
- 仅依赖 PDF 文本层仍可能失败，因为页面图像里的 figure 编号和 PDF 文本抽取顺序可能不一致。

## 9. 里程碑状态

### M0：极简阅读流程验证

状态：部分完成

- 图片上传：已完成
- 截图粘贴：已完成
- PDF 翻页预览：已完成
- 无配置直接提问：已完成
- 真实模型链路：已完成

### M1：单图解析原型

状态：部分完成

- 图片上传：已完成
- 图片展示：已完成
- 手动框选区域：已完成
- 调用多模态模型解释整图或选区：已完成
- 展示基础来源结构：已完成

### M2：PDF 图像与图注抽取

状态：进行中

- PDF 页面文本抽取：已完成基础接口
- figure 编号识别：部分完成，当前基于当前页 caption 优先推断，必要时回退到正文引用
- figure caption 检索：部分完成，已改为按 caption 起始结构和页面几何区域抽取
- 底部双栏 caption 抽取：已实现第一版，目标是处理 Nature 风格 `Fig. 1 |` 图注跨两栏排布
- 跨页 caption 匹配：部分完成，支持全文 caption 候选检索，尚未绑定具体图像区域

### M3：正文证据检索

状态：进行中

- 抽取正文文本：已完成基础能力
- 按 figure 编号检索相关正文：部分完成，当前优先检索明确 `Fig./Figure X` 引用，并返回命中引用、关键词和匹配规则
- 排除 caption 区域：已实现第一版，正文流会跳过已识别的 caption 行和页脚
- 句子级聚合：已完成第一版，正文引用卡片展示命中引用所在完整句，并最多补充下一句上下文
- 来源高亮与 panel 级正文定位：未完成

### M4：panel 级交互

状态：未完成

- 自动或半自动识别 panel
- panel 区域解释
- panel 与图注文本映射

### M5：文献笔记导出

状态：部分完成

- 保存解析结果：已完成 MVP，后端提供本地 JSON store 和 `/api/analysis` / `/api/analysis/lookup`，插件结果面板提供“保存本次解读”
- 网站端解析库：已完成 MVP。独立网站提供“当前解析/解析库”切换，能查看、搜索、打开和删除插件/网站保存的结果；新保存记录会保存文献信息、figure 信息、locator 和图片 data URL / 缩略图。
- 导出 Markdown
- 导出结构化 JSON

#### M5.1 网站端解析库设计

目标：用户不需要打开 JSON 文件，也不需要每次重新解析；在网站内可以查看、搜索、打开和删除已保存的图片解析结果。

入口：

- 顶部工具区增加分段切换：“当前解析 / 解析库”。
- 默认仍进入“当前解析”，不打断上传图片和 PDF 的主流程。
- “解析库”视图读取后端 `/api/analysis` 的真实记录，不显示模拟内容。

列表：

- 左侧或主区域显示保存记录列表，按 `createdAt` 倒序。
- 每条记录展示 figure、来源、模型、保存时间、回答摘要。
- 支持按 `figureId`、`answer`、`pageUrl`、caption/context 文本搜索。

详情：

- 打开记录后显示完整回答、不确定点、来源依据、caption/body context、annotation 列表。
- 如果记录里有 `imageUrl` 或页面 URL，显示可点击来源；如果只有历史文本，不伪造图片预览。
- annotation bbox 暂时以结构化 JSON/列表展示；后续再做历史图像重放。

管理：

- 支持单条删除，删除前必须确认。
- 暂不做批量删除，避免误删并符合 AGENTS.md 约束。
- 删除接口采用软删除或从本地 JSON store 中移除；第一版用真实 API，不做前端假删除。

保存：

- 网站端当前解析结果也应提供“保存本次解读”按钮，写入同一个 `/api/analysis`。
- 插件和网站保存的记录在解析库中合并展示，通过 `source` 区分来源。

#### M5.2 文献、图片与回溯定位设计

当前解析库不能只保存“解析文本”。每条记录必须能回答三个问题：

1. 这是哪篇文献？
2. 这是这篇文献里的哪张图？
3. 当时 AI 看的是哪张具体图片？

因此保存结构需要从单层 `AnalysisRecord` 扩展为逻辑上的三层，即使第一版仍存放在同一个 JSON 文件中：

```ts
type PaperSnapshot = {
  title: string
  doi?: string
  pmid?: string
  pmcid?: string
  arxivId?: string
  sourceUrl?: string
  pdfHash?: string
  journal?: string
  year?: string
}

type FigureSnapshot = {
  figureLabel?: string
  captionText?: string
  captionSource?: string
  pageNumber?: number
  imageUrl?: string
  imageFingerprint?: string
  thumbnailDataUrl?: string
  imageDataUrl?: string
  locator: {
    source: 'web-html' | 'browser-pdf' | 'web-app-pdf' | 'web-app-image'
    pageUrl?: string
    pdfPage?: number
    imageCssSelector?: string
    imageUrl?: string
    scrollY?: number
    bboxOnPage?: { x: number; y: number; width: number; height: number }
  }
}
```

第一版实现策略：

- 不立即拆成多张数据库表，先把 `paper` 和 `figure` 作为快照字段保存在 `AnalysisRecord` 里，后续迁移 SQLite 时再正规化。
- 保存图片本身：必须保存 `figure.imageDataUrl` 或至少 `figure.thumbnailDataUrl`，这样解析库不依赖原网页图片 URL 是否还可访问。
- 插件保存网页图片时保存实际分析用图片 `imageDataUrl`，同时保存原网页 `imageUrl`、`pageUrl`、滚动位置和 caption/context。
- 网站上传 PDF 时保存当前分析图像或裁剪图像 `imageDataUrl`，并保存 `pdfPage`、`figureLabel`、caption 和正文证据。
- 网站上传普通图片时保存上传图片 `imageDataUrl`，`locator.source = 'web-app-image'`。

解析库展示：

- 列表优先显示 `paper.title`，其次显示 `figure.figureLabel`，再显示保存时间和来源。
- 如果 figure label 缺失，不显示“未命名 figure”作为主要标题，而显示“待命名图”并展示缩略图、caption 摘要和文献标题。
- 详情页必须显示保存的图片/缩略图，作为回溯依据。
- 提供“来源”区：网页 URL、图片 URL、PDF 页码、caption 来源。
- 后续增加“重命名/关联 Figure”功能，把待命名图手动关联到 `Figure 1` 等标签。

### M6：真实阅读环境集成

状态：部分完成

- 浏览器扩展侧栏：已完成 MVP，网页图片点击“解析图”后显示右侧解释面板
- 从当前网页获取截图、图片区域和附近 caption 文本：已完成 MVP，插件会把 DOM caption 候选交给后端统一清洗和打分
- 浏览器内置 PDF 阅读器集成：部分完成，插件可检测浏览器 PDF / PDF.js / 嵌入式 PDF，能读取 PDF bytes 时复用后端 PDF caption/body evidence，不能读取时明确降级为截图 fallback
- Zotero 集成方案验证

## 10. 待确认问题

- 第一版是优先继续强化本地 Web 工具，还是尽快转向浏览器扩展？
- 浏览器扩展和 Zotero 插件哪个更优先？
- 是否需要把解析结果保存为本地项目历史？
- 是否需要把这个工作流封装成一个 Codex skill？
