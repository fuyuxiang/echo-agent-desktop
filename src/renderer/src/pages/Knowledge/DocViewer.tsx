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

  // 拉取文档详情 + 原始二进制。主进程使用企业 refresh/access token，
  // 渲染层只拿到已授权结果，不接受任意 URL 代理。
  useEffect(() => {
    if (!id) return
    let cancelled = false
    let objectUrl: string | null = null
    queueMicrotask(() => {
      setBusy(true)
      setError(null)
    })
    void (async () => {
      try {
        const d = await window.api.org.docContent(id, pageFromUrl > 0 ? pageFromUrl : undefined)
        if (cancelled) return
        setMeta({
          title: d.title,
          sourceType: d.sourceType,
          text: d.text ?? '',
          chunks: d.chunks ?? [],
          note: d.note
        })
        const isBinary = ['pdf', 'docx', 'pptx', 'xlsx', 'image', 'audio', 'video'].includes(
          d.sourceType
        )
        if (isBinary && d.rawUrl) {
          const bytes = await window.api.org.docRaw(id)
          if (cancelled) return
          const owned = new Uint8Array(bytes.byteLength)
          owned.set(bytes)
          objectUrl = URL.createObjectURL(new Blob([owned.buffer]))
          setPdfUrl(objectUrl)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id, pageFromUrl])

  // PDF 渲染:加载 PDF 文档后渲染指定页到 canvas
  // (image 类型不再走 PDF.js — 直接用 <img> 标签,见下方 render)
  useEffect(() => {
    if (!pdfUrl || !canvasRef.current) return
    if (!meta || meta.sourceType !== 'pdf') return
    void (async (): Promise<void> => {
      try {
        const doc = await pdfjsLib.getDocument({ url: pdfUrl }).promise
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

      {meta?.sourceType === 'audio' && pdfUrl && (
        <div className={styles.docViewerMedia}>
          <audio controls src={pdfUrl} />
        </div>
      )}
      {meta?.sourceType === 'video' && pdfUrl && (
        <div className={styles.docViewerMedia}>
          <video controls src={pdfUrl} style={{ maxWidth: '100%' }} />
        </div>
      )}

      {/* 主进程按文档 ID 鉴权下载；渲染层不能把任意路径交给 shell。 */}
      {meta && ['pdf', 'docx', 'pptx', 'xlsx', 'image', 'audio', 'video'].includes(meta.sourceType) && (
        <div className={styles.docViewerActions}>
          <button
            type="button"
            onClick={() => void window.api.org.openDoc(id).catch((e: unknown) => {
              setError(e instanceof Error ? e.message : String(e))
            })}
          >
            {t('docViewer.openWithDefault')}
          </button>
        </div>
      )}

      {!meta && !busy && (
        <div className={styles.docViewerEmpty}>{t('docViewer.notFound')}</div>
      )}
    </div>
  )
}
