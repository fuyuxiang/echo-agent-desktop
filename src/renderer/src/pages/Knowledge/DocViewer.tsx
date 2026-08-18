import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams, useNavigate } from 'react-router-dom'
import * as pdfjsLib from 'pdfjs-dist'
// workerSrc 必须指向 pdfjs-dist 的 worker 入口;vite 在打包时会把它
// 作为 asset 自动复制到 dist。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore pdfjs-dist 提供 legacy build 路径
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import styles from './DocViewer.module.scss'

// pdfjsLib 类型在 CommonJS 形态下被推为 namespace;这里强制断言成 default。
// pdfjs-dist 的 default export 在 ESM build 下导出 getDocument。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfjs: any = (pdfjsLib as unknown as { default?: any }).default ?? pdfjsLib
;(pdfjs.GlobalWorkerOptions as { workerSrc: string }).workerSrc = workerSrc

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

/**
 * 文档查看器。
 *
 * 由 echo://doc/<id>/page/<n> 或 echo://doc/<id>/t/<ms> deep link 跳转而来:
 *   - /knowledge/doc?id=<docId>&page=<n>   → 文本类型按 page/range 切片,
 *     PDF 类型调用 /raw 拉 Blob 并用 pdfjs 渲染到第 n 页;
 *   - 媒体类型(音频/视频)→ 主进程 openExternal 打开外部播放器。
 *
 * 这里只做 PDF 与文本预览;真实音视频播放器按方案 7.4 后续接入。
 */
export default function DocViewer(): React.JSX.Element {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const id = params.get('id') ?? ''
  const pageParam = params.get('page')
  const startMsParam = params.get('startMs')
  const pageFromUrl = pageParam ? Math.max(1, Number(pageParam)) : 0
  const startMs = startMsParam ? Math.max(0, Number(startMsParam)) : 0

  const [meta, setMeta] = useState<{
    title: string
    sourceType: string
    text: string
    chunks: Array<Record<string, unknown>>
    note?: string
  } | null>(null)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 拉取文档详情 + 文本段
  // 2026-08 P1-3 修复:不再直接 fetch /api/v1/... (绕开统一鉴权),
  // 改走 window.api.system.httpProxy,由主进程代理,自动注入 org-token。
  useEffect(() => {
    if (!id) return
    queueMicrotask(() => {
      setBusy(true)
      setError(null)
    })
    const qs = pageFromUrl > 0 ? `?page=${pageFromUrl}` : ''
    void window.api.system
      .httpProxy({
        url: `/api/v1/docs/${encodeURIComponent(id)}/content${qs}`,
        method: 'GET',
        timeoutMs: 15000
      })
      .then((r) => {
        if (!r.ok) return Promise.reject(new Error(`HTTP ${r.status}`))
        try {
          return JSON.parse(r.body) as { data?: Record<string, unknown> }
        } catch (err) {
          return Promise.reject(new Error(`JSON 解析失败: ${(err as Error).message}`))
        }
      })
      .then((j) => {
        const d = (j.data ?? {}) as {
          title?: string
          sourceType?: string
          text?: string
          chunks?: unknown
          note?: string
          rawUrl?: string
        }
        setMeta({
          title: d.title ?? '未命名文档',
          sourceType: d.sourceType ?? 'unknown',
          text: d.text ?? '',
          chunks: (d.chunks as Array<Record<string, unknown>>) ?? [],
          note: d.note
        })
        // 二进制类型:拉 /raw 拼 blob url,给 pdfjs / <img> 用
        const isBinary = ['pdf', 'docx', 'pptx', 'xlsx', 'image', 'audio', 'video'].includes(
          d.sourceType ?? ''
        )
        if (isBinary && d.rawUrl) {
          void window.api.system
            .httpProxy({ url: d.rawUrl, method: 'GET', timeoutMs: 30000 })
            .then((r) => {
              if (!r.ok) return Promise.reject(new Error(`raw ${r.status}`))
              // 把代理拿到的 base64 文本转成 Blob 再 createObjectURL
              const bytes = Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0))
              return new Blob([bytes])
            })
            .then((b) => setPdfUrl(URL.createObjectURL(b)))
            .catch((e: Error) =>
              setError(t('docViewer.rawFetchFailed', { message: e.message }))
            )
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }, [id, pageFromUrl])

  // PDF 渲染:加载 PDF 文档后渲染指定页到 canvas
  // (image 类型不再走 PDF.js — 直接用 <img> 标签,见下方 render)
  useEffect(() => {
    if (!pdfUrl || !canvasRef.current) return
    if (!meta || meta.sourceType !== 'pdf') return
    void (async (): Promise<void> => {
      try {
        const doc = await pdfjs.getDocument({ url: pdfUrl }).promise
        const target = pageFromUrl > 0 ? pageFromUrl : 1
        const page = await doc.getPage(target)
        const viewport = page.getViewport({ scale: 1.2 })
        const canvas = canvasRef.current
        if (!canvas) return
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        await page.render({ canvasContext: ctx, viewport }).promise
      } catch (e) {
        setError(`PDF 渲染失败: ${(e as Error).message}`)
      }
    })()
  }, [pdfUrl, pageFromUrl, meta])

  if (!id) {
    return (
      <div className={styles.docViewerEmpty}>
        <p>{t('docViewer.missingId')}</p>
        <button type="button" onClick={() => navigate(-1)}>
          {t('docViewer.back')}
        </button>
      </div>
    )
  }

  if (error) {
    return (
      <div className={styles.docViewerEmpty}>
        <h3>{meta?.title ?? t('docViewer.viewerError')}</h3>
        <p>{error}</p>
        <button type="button" onClick={() => navigate(-1)}>
          {t('docViewer.back')}
        </button>
      </div>
    )
  }

  return (
    <div className={styles.docViewer}>
      <header className={styles.docViewerHead}>
        <h3>{meta?.title ?? (busy ? t('docViewer.loading') : id)}</h3>
        <div className={styles.docViewerMeta}>
          {meta && <span className={styles.tag}>{meta.sourceType}</span>}
          {pageFromUrl > 0 && (
            <span className={styles.loc}>
              {t('docViewer.pageLabel', { page: pageFromUrl })}
            </span>
          )}
          {startMs > 0 && (
            <span className={styles.loc}>
              {t('docViewer.fromLabel', { seconds: Math.floor(startMs / 1000) })}
            </span>
          )}
          <button type="button" onClick={() => navigate(-1)}>
            {t('docViewer.back')}
          </button>
        </div>
      </header>

      {/* PDF:canvas 渲染当前页 */}
      {meta && meta.sourceType === 'pdf' && (
        <div className={styles.docViewerCanvasWrap}>
          <canvas ref={canvasRef} />
          {pageFromUrl > 1 && (
            <div className={styles.docViewerNav}>
              <button
                type="button"
                onClick={() => {
                  const u = new URL(window.location.href)
                  u.searchParams.set('page', String(pageFromUrl - 1))
                  window.history.pushState({}, '', u.toString())
                  window.dispatchEvent(new PopStateEvent('popstate'))
                }}
              >
                上一页
              </button>
              <button
                type="button"
                onClick={() => {
                  const u = new URL(window.location.href)
                  u.searchParams.set('page', String(pageFromUrl + 1))
                  window.history.pushState({}, '', u.toString())
                  window.dispatchEvent(new PopStateEvent('popstate'))
                }}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      )}

      {/* 图片类型:走 <img> 标签,不再经 PDF.js 渲染(2026-08 P1-3 修复) */}
      {meta && meta.sourceType === 'image' && pdfUrl && (
        <div className={styles.docViewerCanvasWrap}>
          <img
            src={pdfUrl}
            alt={meta.title}
            style={{ maxWidth: '100%', height: 'auto', display: 'block', margin: '0 auto' }}
          />
        </div>
      )}

      {/* 文本类型:按 page / range 切片,直接展示 */}
      {meta && meta.sourceType !== 'pdf' && meta.sourceType !== 'image' && (
        <article className={styles.docViewerText}>
          {meta.chunks.length > 0 ? (
            meta.chunks.map((c, idx) => (
              <section key={idx} className={styles.docViewerChunk}>
                {c.heading ? <h4>{String(c.heading)}</h4> : null}
                <p>{String(c.text ?? '')}</p>
              </section>
            ))
          ) : (
            <pre>{meta.text || t('docViewer.noContent')}</pre>
          )}
          {meta.note && <p className={styles.note}>{meta.note}</p>}
        </article>
      )}

      {/* 媒体类型:引导到外部播放器;此处只显示链接 */}
      {meta && (meta.sourceType === 'audio' || meta.sourceType === 'video') && (
        <div className={styles.docViewerMedia}>
          <p>{t('docViewer.mediaNotReady')}</p>
          <button
            type="button"
            onClick={() => {
              // 2026-08 P1-3 修复:openExternal 不适合走 /api/v1/* (需要 token)。
              // 这里改用 showItemInFolder 提示用户在资源管理器中找到原始文件。
              // 真正"打开原始文件"留给 echo-agent-server 端提供 signed URL。
              void window.api.system.showItemInFolder('/api/v1/docs/...')
            }}
          >
            在文件管理器中查看
          </button>
        </div>
      )}

      {/* 通用"打开原始文件"按钮(PDF/图片/媒体都显示):走系统默认应用 */}
      {meta && (meta.sourceType === 'pdf' || meta.sourceType === 'image' ||
                meta.sourceType === 'audio' || meta.sourceType === 'video') && (
        <div className={styles.docViewerActions}>
          <button
            type="button"
            onClick={() => {
              // 通过 deep link 让 echo-agent 主进程解析原始文件路径并打开
              void window.api.system.openExternal(
                `echo-agent://open-doc?id=${encodeURIComponent(id)}`
              )
            }}
          >
            用默认应用打开
          </button>
        </div>
      )}

      {!meta && !busy && (
        <div className={styles.docViewerEmpty}>{t('docViewer.notFound')}</div>
      )}
    </div>
  )
}