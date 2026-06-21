import { useEffect, useState, useMemo } from 'react'
import { useSkillStore } from '@/stores/skillStore'
import { skillsAPI, type Skill } from '@/services/agent/skills'
import { useSkillImport } from '@/hooks/useSkillImport'
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
  const { importing, handleImport } = useSkillImport()

  useEffect(() => {
    skillsAPI
      .list()
      .then((data) => setSkills(data.skills ?? data))
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

  const handleDelete = async (_name: string): Promise<void> => {
    setSelectedSkill(null)
    setDetail(null)
    const updated = await skillsAPI.list()
    setSkills(updated.skills ?? updated)
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
            <button className={styles.deleteBtn} onClick={() => handleDelete(selectedSkill)}>
              删除
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
