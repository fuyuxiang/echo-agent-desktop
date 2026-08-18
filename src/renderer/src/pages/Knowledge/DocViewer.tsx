import { useEffect, useRef, useState } from 'react'
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
  useEffect(() => {
    if (!id) return
    queueMicrotask(() => {
      setBusy(true)
      setError(null)
    })
    const qs = pageFromUrl > 0 ? `?page=${pageFromUrl}` : ''
    void fetch(`/api/v1/docs/${encodeURIComponent(id)}/content${qs}`, {
      credentials: 'include'
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
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
        // 二进制类型:再拉 /raw 拼 blob url,给 pdfjs 用
        const isBinary = ['pdf', 'docx', 'pptx', 'xlsx', 'image', 'audio', 'video'].includes(
          d.sourceType ?? ''
        )
        if (isBinary && d.rawUrl) {
          void fetch(d.rawUrl, { credentials: 'include' })
            .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`raw ${r.status}`))))
            .then((b) => setPdfUrl(URL.createObjectURL(b)))
            .catch((e: Error) => setError(`原始文件拉取失败: ${e.message}`))
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }, [id, pageFromUrl])

  // PDF 渲染:加载文档后渲染指定页
  useEffect(() => {
    if (!pdfUrl || !canvasRef.current) return
    if (meta && meta.sourceType !== 'pdf' && meta.sourceType !== 'image') return
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
        <p>缺少文档 id。</p>
        <button type="button" onClick={() => navigate(-1)}>
          返回
        </button>
      </div>
    )
  }

  if (error) {
    return (
      <div className={styles.docViewerEmpty}>
        <h3>{meta?.title ?? '查看器错误'}</h3>
        <p>{error}</p>
        <button type="button" onClick={() => navigate(-1)}>
          返回
        </button>
      </div>
    )
  }

  return (
    <div className={styles.docViewer}>
      <header className={styles.docViewerHead}>
        <h3>{meta?.title ?? (busy ? '加载中...' : id)}</h3>
        <div className={styles.docViewerMeta}>
          {meta && <span className={styles.tag}>{meta.sourceType}</span>}
          {pageFromUrl > 0 && <span className={styles.loc}>第 {pageFromUrl} 页</span>}
          {startMs > 0 && <span className={styles.loc}>从 {Math.floor(startMs / 1000)}s 起</span>}
          <button type="button" onClick={() => navigate(-1)}>
            返回
          </button>
        </div>
      </header>

      {/* PDF / 图片:canvas 渲染当前页 */}
      {meta && (meta.sourceType === 'pdf' || meta.sourceType === 'image') && (
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
            <pre>{meta.text || '(无内容)'}</pre>
          )}
          {meta.note && <p className={styles.note}>{meta.note}</p>}
        </article>
      )}

      {/* 媒体类型:引导到外部播放器;此处只显示链接 */}
      {meta && (meta.sourceType === 'audio' || meta.sourceType === 'video') && (
        <div className={styles.docViewerMedia}>
          <p>媒体查看器尚未接入,请通过主进程 OS 播放器打开:</p>
          <button
            type="button"
            onClick={() => {
              const url = `/api/v1/docs/${encodeURIComponent(id)}/raw`
              void window.api.system.openExternal(`echo-agent://manual?open=${encodeURIComponent(url)}`)
            }}
          >
            打开原始文件
          </button>
        </div>
      )}

      {!meta && !busy && <div className={styles.docViewerEmpty}>未找到内容</div>}
    </div>
  )
}