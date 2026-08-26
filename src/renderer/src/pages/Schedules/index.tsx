import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentManagement } from '@/services/agent/management'
import styles from './schedules.module.scss'

interface CronJob {
  id: string
  name: string
  cron_expr: string
  enabled: boolean
  status: string
  last_run_ms: number | null
  next_run_ms: number | null
  last_status: string
  payload: { command?: string; message?: string }
  authorization: Record<string, unknown> | null
  authorization_valid: boolean
}

interface CronRun {
  id?: string
  status?: string
  started_at?: string | number
  finished_at?: string | number
  error?: string
  result?: string
}

function formatTime(value: number | string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(typeof value === 'number' ? value : value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

export default function SchedulesPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [cronExpr, setCronExpr] = useState('0 9 * * 1-5')
  const [command, setCommand] = useState('')
  const [authorize, setAuthorize] = useState(false)
  const [runsFor, setRunsFor] = useState<string | null>(null)
  const [runs, setRuns] = useState<CronRun[]>([])

  const fetchJobs = useCallback(async (): Promise<CronJob[]> => {
    const result = await agentManagement<{ jobs: CronJob[] }>({ method: 'GET', path: '/cron' })
    return result.jobs
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setJobs(await fetchJobs())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [fetchJobs])

  useEffect(() => {
    let active = true
    void fetchJobs()
      .then((next) => { if (active) setJobs(next) })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [fetchJobs])

  const create = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    try {
      await agentManagement({
        method: 'POST',
        path: '/cron',
        body: {
          name: name.trim() || command.trim().slice(0, 40),
          cron_expr: cronExpr.trim(),
          payload: { command: command.trim() },
          authorize_unattended: authorize
        }
      })
      setName('')
      setCommand('')
      setAuthorize(false)
      setShowForm(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const mutate = async (request: Parameters<typeof agentManagement>[0]): Promise<void> => {
    setError('')
    try {
      await agentManagement(request)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const showRuns = async (id: string): Promise<void> => {
    if (runsFor === id) {
      setRunsFor(null)
      return
    }
    setError('')
    try {
      const result = await agentManagement<{ runs: CronRun[] }>({
        method: 'GET', path: `/cron/${encodeURIComponent(id)}/runs?limit=20`
      })
      setRuns(result.runs)
      setRunsFor(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>{t('schedules.title')}</h1>
          <p>{t('schedules.description')}</p>
        </div>
        <button type="button" className={styles.primary} onClick={() => setShowForm(!showForm)}>
          {showForm ? t('common.cancel') : t('schedules.add')}
        </button>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {showForm && (
        <form className={styles.form} onSubmit={(event) => void create(event)}>
          <label>
            {t('schedules.name')}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
          <label>
            {t('schedules.cron')}
            <input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} required />
          </label>
          <label className={styles.wide}>
            {t('schedules.command')}
            <textarea value={command} onChange={(e) => setCommand(e.target.value)} required rows={4} />
          </label>
          <label className={`${styles.check} ${styles.wide}`}>
            <input type="checkbox" checked={authorize} onChange={(e) => setAuthorize(e.target.checked)} />
            <span>{t('schedules.authorize')}</span>
          </label>
          <button className={styles.primary} type="submit">{t('schedules.create')}</button>
        </form>
      )}

      {loading ? (
        <div className={styles.empty}>{t('common.loading')}</div>
      ) : jobs.length === 0 ? (
        <div className={styles.empty}>{t('schedules.empty')}</div>
      ) : (
        <div className={styles.list}>
          {jobs.map((job) => (
            <article className={styles.card} key={job.id}>
              <div className={styles.cardMain}>
                <div className={styles.cardTitle}>
                  <strong>{job.name || job.id}</strong>
                  <span className={job.enabled ? styles.enabled : styles.disabled}>
                    {job.enabled ? t('schedules.enabled') : t('schedules.disabled')}
                  </span>
                  {job.authorization && !job.authorization_valid && (
                    <span className={styles.warning}>{t('schedules.reauthorize')}</span>
                  )}
                </div>
                <code>{job.cron_expr}</code>
                <p>{job.payload.command ?? job.payload.message}</p>
                <div className={styles.meta}>
                  <span>{t('schedules.next')}: {formatTime(job.next_run_ms)}</span>
                  <span>{t('schedules.last')}: {formatTime(job.last_run_ms)}</span>
                  {job.last_status && <span>{job.last_status}</span>}
                </div>
              </div>
              <div className={styles.actions}>
                <button onClick={() => void mutate({ method: 'PUT', path: `/cron/${encodeURIComponent(job.id)}`, body: { enabled: !job.enabled } })}>
                  {job.enabled ? t('schedules.pause') : t('schedules.resume')}
                </button>
                <button onClick={() => void mutate({ method: 'POST', path: `/cron/${encodeURIComponent(job.id)}/trigger`, body: {} })}>
                  {t('schedules.runNow')}
                </button>
                <button onClick={() => void showRuns(job.id)}>{t('schedules.history')}</button>
                <button className={styles.danger} onClick={() => {
                  if (window.confirm(t('schedules.deleteConfirm'))) {
                    void mutate({ method: 'DELETE', path: `/cron/${encodeURIComponent(job.id)}` })
                  }
                }}>{t('common.delete')}</button>
              </div>
              {runsFor === job.id && (
                <div className={styles.runs}>
                  {runs.length === 0 ? t('schedules.noRuns') : runs.map((run, index) => (
                    <div key={run.id ?? index}>
                      <span>{run.status ?? '—'}</span>
                      <span>{formatTime(run.started_at)}</span>
                      <span>{run.error || run.result || ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
