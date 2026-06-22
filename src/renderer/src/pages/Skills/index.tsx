import { useEffect, useState, useMemo, useCallback } from 'react'
import { useSkillStore } from '@/stores/skillStore'
import { skillsAPI, type Skill } from '@/services/agent/skills'
import { useSkillImport } from '@/hooks/useSkillImport'
import { useSkillDeps } from '@/hooks/useSkillDeps'
import { SkillDepsDialog } from '@/components/SkillDepsDialog'
import { toast } from '@/components/Toast'
import styles from './skills.module.scss'
import clsx from 'clsx'

function getInitialLetter(str: string): string {
  const first = str.charAt(0)
  if (/[a-zA-Z]/.test(first)) return first.toUpperCase()
  try {
    if (typeof Intl !== 'undefined' && Intl.Collator != null) {
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
      for (let i = 25; i >= 0; i--) {
        if (first.localeCompare(letters[i], 'zh-CN', { sensitivity: 'base' }) >= 0) {
          return letters[i]
        }
      }
    }
  } catch {
    // fallback
  }
  return '#'
}

interface SkillGroup {
  letter: string
  items: Skill[]
}

export default function SkillsPage(): React.JSX.Element {
  const { skills, selectedSkill, setSkills, setSelectedSkill } = useSkillStore()
  const [detail, setDetail] = useState<{ content: string; files: string[] } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const { importing, handleImport } = useSkillImport()

  const [depsPrompt, setDepsPrompt] = useState<{
    name: string
    missing: string[]
    resolve: (ok: boolean) => void
  } | null>(null)

  const requestConfirm = useCallback(
    (name: string, missing: string[]): Promise<boolean> =>
      new Promise<boolean>((resolve) => setDepsPrompt({ name, missing, resolve })),
    []
  )

  const { installing, ensureDeps } = useSkillDeps(requestConfirm)

  useEffect(() => {
    skillsAPI
      .list()
      .then((data) => setSkills(data.skills ?? []))
      .catch(() => {})
  }, [setSkills])

  useEffect(() => {
    if (!selectedSkill) {
      Promise.resolve().then(() => setDetail(null))
      return
    }
    skillsAPI
      .get(selectedSkill)
      .then(setDetail)
      .catch(() => setDetail(null))
  }, [selectedSkill])

  const groups = useMemo<SkillGroup[]>(() => {
    const sorted = [...skills].sort((a, b) =>
      a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' })
    )
    const map = new Map<string, Skill[]>()
    for (const s of sorted) {
      const letter = getInitialLetter(s.name)
      if (!map.has(letter)) map.set(letter, [])
      map.get(letter)!.push(s)
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)))
      .map(([letter, items]) => ({ letter, items }))
  }, [skills])

  const handleToggle = async (skill: Skill, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    const enabling = !skill.enabled
    if (enabling) {
      const ok = await ensureDeps(skill.name)
      // 关闭授权弹窗:确认后弹窗保持开启以显示"安装中",安装结束(此处)再关闭
      setDepsPrompt(null)
      if (!ok) return // 缺依赖未解决，不启用
    }
    try {
      await skillsAPI.toggle(skill.name)
      const updated = await skillsAPI.list()
      const list = updated.skills ?? updated
      if (Array.isArray(list) && list.length > 0) {
        setSkills(list)
      } else {
        // toggle 后列表为空，可能后端行为异常，先本地翻转状态
        setSkills(skills.map((s) => (s.name === skill.name ? { ...s, enabled: !s.enabled } : s)))
      }
    } catch {
      // 接口失败时本地翻转
      setSkills(skills.map((s) => (s.name === skill.name ? { ...s, enabled: !s.enabled } : s)))
    }
  }

  const handleDelete = async (name: string): Promise<void> => {
    if (deleting) return
    if (!window.confirm(`确定删除技能「${name}」？此操作不可撤销。`)) return
    setDeleting(true)
    try {
      await skillsAPI.remove(name)
      setSelectedSkill(null)
      setDetail(null)
      const updated = await skillsAPI.list()
      setSkills(updated.skills ?? updated)
      toast.success('技能已删除')
    } catch (e) {
      toast.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeleting(false)
    }
  }

  const handleClose = (): void => {
    setSelectedSkill(null)
    setDetail(null)
  }

  const currentSkill = skills.find((s) => s.name === selectedSkill)

  return (
    <div className={styles.page}>
      <div className={styles.main}>
        <div className={styles.pageHeader}>
          <div className={styles.pageHeaderText}>
            <span>Skills</span>
            <strong>技能库</strong>
          </div>
          <button className={styles.importBtn} onClick={handleImport} disabled={importing}>
            <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {importing ? '导入中…' : '导入技能'}
          </button>
        </div>
        <div className={styles.groupList}>
          {groups.map((group) => (
            <div key={group.letter} className={styles.group}>
              <div className={styles.letterBadge}>{group.letter}</div>
              <div className={styles.grid}>
                {group.items.map((s) => (
                  <div
                    key={s.name}
                    className={clsx(styles.card, selectedSkill === s.name && styles.active)}
                    onClick={() => setSelectedSkill(s.name)}
                  >
                    <div className={styles.cardIcon}>{s.name.charAt(0).toUpperCase()}</div>
                    <div className={styles.cardBody}>
                      <span className={styles.name}>{s.name}</span>
                      <p className={styles.desc}>{s.description}</p>
                    </div>
                    <span className={clsx(styles.status, s.enabled && styles.on)}>
                      {s.enabled ? '已启用' : '未启用'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {skills.length === 0 && <div className={styles.empty}>暂无技能</div>}
        </div>
      </div>

      {selectedSkill && detail && (
        <div className={styles.detailPanel}>
          <div className={styles.detailToolbar}>
            <button
              className={clsx(styles.toggleBtn, currentSkill?.enabled && styles.on)}
              onClick={(e) => currentSkill && handleToggle(currentSkill, e)}
            >
              {currentSkill?.enabled ? '禁用' : '启用'}
            </button>
            <button
              className={styles.deleteBtn}
              onClick={() => handleDelete(selectedSkill)}
              disabled={deleting}
            >
              {deleting ? '删除中…' : '删除'}
            </button>
            <button className={styles.closeBtn} onClick={handleClose}>
              ✕
            </button>
          </div>
          <div className={styles.detailHeader}>
            <h2>{selectedSkill}</h2>
            {currentSkill?.description && (
              <p className={styles.detailDesc}>{currentSkill.description}</p>
            )}
          </div>
          <pre className={styles.content}>{detail.content}</pre>
          {detail.files?.length > 0 && (
            <div className={styles.files}>
              <h3>支持文件</h3>
              <ul>
                {detail.files.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {depsPrompt && (
        <SkillDepsDialog
          skillName={depsPrompt.name}
          missing={depsPrompt.missing}
          installing={installing}
          onConfirm={() => {
            // 仅 resolve;弹窗保持开启展示"安装中",由 handleToggle 在 ensureDeps 结束后关闭
            depsPrompt.resolve(true)
          }}
          onCancel={() => {
            depsPrompt.resolve(false)
            setDepsPrompt(null)
          }}
        />
      )}
    </div>
  )
}
