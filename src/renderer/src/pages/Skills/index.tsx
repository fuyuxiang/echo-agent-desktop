import { useEffect, useState, useMemo } from 'react'
import { useSkillStore } from '@/stores/skillStore'
import { skillsAPI, type Skill } from '@/services/agent/skills'
import { useChatStore } from '@/stores/chatStore'
import { useSkillImport } from '@/hooks/useSkillImport'
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
  const activeChatId = useChatStore((s) => s.activeChatId) || 'default'
  const [detail, setDetail] = useState<{ content: string; files: string[] } | null>(null)
  const [activeIds, setActiveIds] = useState<string[]>([])
  const [deleting, setDeleting] = useState(false)
  const { importing, handleImport } = useSkillImport()

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

  // 当前会话的激活技能(per chatId)
  useEffect(() => {
    window.api.agentSkill
      .active(activeChatId)
      .then((ids) => setActiveIds(ids as string[]))
      .catch(() => setActiveIds([]))
  }, [activeChatId, skills])

  const groups = useMemo<SkillGroup[]>(() => {
    const sorted = [...skills].sort((a, b) =>
      a.label.localeCompare(b.label, 'zh-CN', { sensitivity: 'base' })
    )
    const map = new Map<string, Skill[]>()
    for (const s of sorted) {
      const letter = getInitialLetter(s.label)
      if (!map.has(letter)) map.set(letter, [])
      map.get(letter)!.push(s)
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)))
      .map(([letter, items]) => ({ letter, items }))
  }, [skills])

  const handleToggle = async (skill: Skill, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    const isActive = activeIds.includes(skill.id)
    try {
      if (isActive) {
        await window.api.agentSkill.deactivate(activeChatId, skill.id)
        setActiveIds((prev) => prev.filter((id) => id !== skill.id))
      } else {
        await window.api.agentSkill.activate(activeChatId, skill.id)
        setActiveIds((prev) => [...prev, skill.id])
      }
    } catch (err) {
      toast.error(`切换失败:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleDelete = async (name: string): Promise<void> => {
    if (deleting) return
    if (!window.confirm(`确定删除技能「${name}」？此操作不可撤销。`)) return
    setDeleting(true)
    try {
      const res = await skillsAPI.remove(name)
      if (res.error) {
        toast.error(res.error)
      } else {
        setSelectedSkill(null)
        setDetail(null)
        const updated = await skillsAPI.list()
        setSkills(updated.skills ?? updated)
        toast.success('技能已删除')
      }
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

  const currentSkill = skills.find((s) => s.id === selectedSkill)
  const currentIsActive = currentSkill ? activeIds.includes(currentSkill.id) : false

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
                {group.items.map((s) => {
                  const isActive = activeIds.includes(s.id)
                  return (
                    <div
                      key={s.id}
                      className={clsx(styles.card, selectedSkill === s.id && styles.active)}
                      onClick={() => setSelectedSkill(s.id)}
                    >
                      <div className={styles.cardIcon}>{s.label.charAt(0).toUpperCase()}</div>
                      <div className={styles.cardBody}>
                        <span className={styles.name}>{s.label}</span>
                        <p className={styles.desc}>{s.description}</p>
                      </div>
                      <span className={clsx(styles.status, isActive && styles.on)}>
                        {isActive ? '已激活' : '未激活'}
                      </span>
                    </div>
                  )
                })}
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
              className={clsx(styles.toggleBtn, currentIsActive && styles.on)}
              onClick={(e) => currentSkill && handleToggle(currentSkill, e)}
            >
              {currentIsActive ? '禁用' : '启用'}
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
    </div>
  )
}
