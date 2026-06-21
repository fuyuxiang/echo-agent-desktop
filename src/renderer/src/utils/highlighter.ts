import {
  createHighlighter,
  type Highlighter,
  type BundledLanguage,
  type BundledTheme
} from 'shiki'

/**
 * Shiki 高亮器单例
 *
 * - 懒加载:首次高亮时才创建,避免拖慢首屏
 * - 按需加载语言:遇到未加载的语言动态 loadLanguage,失败则回退纯文本
 * - 主题固定加载 github-light / github-dark,跟随 data-theme 选用
 */

const PRELOAD_THEMES: BundledTheme[] = ['github-light', 'github-dark']

let highlighterPromise: Promise<Highlighter> | null = null
const loadedLangs = new Set<string>()

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: PRELOAD_THEMES,
      langs: []
    })
  }
  return highlighterPromise
}

/** shiki 支持的语言别名集合,用于在高亮前判断是否值得尝试加载 */
function normalizeLang(lang: string): string {
  return lang.trim().toLowerCase()
}

/**
 * 把代码高亮为 HTML 字符串。语言不支持或加载失败时返回 null,调用方回退纯文本。
 */
export async function highlightCode(
  code: string,
  lang: string,
  theme: 'light' | 'dark'
): Promise<string | null> {
  const language = normalizeLang(lang)
  if (!language || language === 'text' || language === 'plaintext') return null

  try {
    const highlighter = await getHighlighter()
    if (!loadedLangs.has(language)) {
      await highlighter.loadLanguage(language as BundledLanguage)
      loadedLangs.add(language)
    }
    return highlighter.codeToHtml(code, {
      lang: language,
      theme: theme === 'dark' ? 'github-dark' : 'github-light'
    })
  } catch {
    // 未知语言或加载失败:回退纯文本渲染
    return null
  }
}
