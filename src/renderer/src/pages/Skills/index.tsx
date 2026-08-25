import { useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSkillStore } from '@/stores/skillStore'
import { skillsAPI, type Skill } from '@/services/agent/skills'
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
  const { t } = useTranslation()
  const { skills, selectedSkill, setSkills, setSelectedSkill } = useSkillStore()
  const [detail, setDetail] = useState<{ content: string; files: string[] } | null>(null)
  const [toggling, setToggling] = useState(false)

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
    if (toggling) return
    setToggling(true)
    try {
      if (skill.status === 'enabled') {
        await skillsAPI.deactivate('default', skill.id)
      } else {
        await skillsAPI.activate('default', skill.id)
      }
      const updated = await skillsAPI.list()
      setSkills(updated.skills ?? [])
    } catch (err) {
      toast.error(`切换失败:${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setToggling(false)
    }
  }

  const handleClose = (): void => {
    setSelectedSkill(null)
    setDetail(null)
  }

  const currentSkill = skills.find((s) => s.id === selectedSkill)
  const currentIsActive = currentSkill?.status === 'enabled'

  return (
    <div className={styles.page}>
      <div className={styles.main}>
        <div className={styles.pageHeader}>
          <div className={styles.pageHeaderText}>
            <span>Skills</span>
            <strong>{t('skills.title')}</strong>
          </div>
        </div>
        <div className={styles.groupList}>
          {groups.map((group) => (
            <div key={group.letter} className={styles.group}>
              <div className={styles.letterBadge}>{group.letter}</div>
              <div className={styles.grid}>
                {group.items.map((s) => {
                  const isActive = s.status === 'enabled'
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
                        {isActive ? t('skills.active') : t('skills.inactive')}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {skills.length === 0 && <div className={styles.empty}>{t('skills.empty')}</div>}
        </div>
      </div>

      {selectedSkill && detail && (
        <div className={styles.detailPanel}>
          <div className={styles.detailToolbar}>
            <button
              className={clsx(styles.toggleBtn, currentIsActive && styles.on)}
              onClick={(e) => currentSkill && handleToggle(currentSkill, e)}
              disabled={toggling}
            >
              {currentIsActive ? t('skills.disable') : t('skills.enable')}
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
              <h3>{t('skills.supportedFiles')}</h3>
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
