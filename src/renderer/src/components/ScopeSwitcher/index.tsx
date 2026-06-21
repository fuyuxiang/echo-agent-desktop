import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useAgentScopeStore } from '@/stores/agentScopeStore'
import { useChatStore } from '@/stores/chatStore'
import { toast } from '@/components/Toast'
import type { AccessScope } from '@shared/types'
import styles from './scope-switcher.module.scss'

export function ScopeSwitcher(): React.JSX.Element {
  const { t } = useTranslation()
  const scope = useAgentScopeStore((s) => s.scope)
  const workspaceDir = useAgentScopeStore((s) => s.workspaceDir)
  const switching = useAgentScopeStore((s) => s.switching)
  const applyScope = useAgentScopeStore((s) => s.applyScope)
  const isGenerating = useChatStore((s) => s.isGenerating)

  const [open, setOpen] = useState(false)
  const [draftScope, setDraftScope] = useState<AccessScope>(scope)
  const [draftDir, setDraftDir] = useState(workspaceDir)

  const folderName = workspaceDir ? workspaceDir.split(/[\\/]/).pop() : ''
  const canApply = draftScope === 'full' || (draftScope === 'restricted' && !!draftDir)

  const openPanel = (): void => {
    setDraftScope(scope)
    setDraftDir(workspaceDir)
    setOpen(true)
  }

  const chooseFolder = async (): Promise<void> => {
    const paths = await window.api.system.showOpenDialog({ properties: ['openDirectory'] })
    if (paths.length > 0) setDraftDir(paths[0])
  }

  const apply = async (): Promise<void> => {
    if (!canApply) return
    if (draftScope === 'full' && !window.confirm(t('scope.confirmFull'))) return
    if (isGenerating && !window.confirm(t('scope.confirmInterrupt'))) return
    setOpen(false)
    const result = await applyScope(draftScope, draftScope === 'full' ? '' : draftDir)
    if (result.success) toast.success(t('scope.switched'))
    else toast.error(`${t('scope.switchFailed')}: ${result.error ?? ''}`)
  }

  return (
    <div className={styles.wrap}>
      <button
        className={clsx(styles.bar, switching && styles.switching)}
        onClick={openPanel}
        title={scope === 'restricted' ? workspaceDir : t('scope.full')}
        disabled={switching}
      >
        <span className={styles.icon}>{scope === 'restricted' ? '🛡' : '🌐'}</span>
        <span className={styles.barText}>
          <span className={styles.scopeName}>
            {switching ? t('scope.switching') : t(`scope.${scope}`)}
          </span>
          {scope === 'restricted' && folderName && (
            <span className={styles.folder}>{folderName}</span>
          )}
        </span>
      </button>
      {open && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} />
          <div className={styles.panel}>
            <div className={styles.panelTitle}>{t('scope.title')}</div>

            <label className={styles.option}>
              <input
                type="radio"
                checked={draftScope === 'restricted'}
                onChange={() => setDraftScope('restricted')}
              />
              <span>
                <span className={styles.optName}>🛡 {t('scope.restricted')}</span>
                <span className={styles.optDesc}>{t('scope.restrictedDesc')}</span>
                {draftScope === 'restricted' && (
                  <span className={styles.folderRow}>
                    <button className={styles.chooseBtn} onClick={chooseFolder}>
                      {t('scope.chooseFolder')}
                    </button>
                    {draftDir && (
                      <span className={styles.currentDir} title={draftDir}>
                        {t('scope.current')}: {draftDir}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </label>

            <label className={styles.option}>
              <input
                type="radio"
                checked={draftScope === 'full'}
                onChange={() => setDraftScope('full')}
              />
              <span>
                <span className={styles.optName}>🌐 {t('scope.full')}</span>
                <span className={styles.optDesc}>{t('scope.fullDesc')}</span>
                {draftScope === 'full' && (
                  <span className={styles.warning}>⚠ {t('scope.fullWarning')}</span>
                )}
              </span>
            </label>

            <div className={styles.actions}>
              <button className={styles.cancel} onClick={() => setOpen(false)}>
                {t('scope.cancel')}
              </button>
              <button className={styles.applyBtn} disabled={!canApply} onClick={apply}>
                {t('scope.apply')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
