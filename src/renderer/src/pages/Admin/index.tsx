import { useTranslation } from 'react-i18next'
import { useRequest } from 'ahooks'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from '@/components/Toast'
import {
  adminListUsers,
  adminListGroups,
  adminCreateGroup,
  adminCreateUser,
  adminUpdateUser,
  type ServerUser,
  type ServerGroup
} from '@/services/server'
import styles from './admin.module.scss'

/**
 * 管理页(仅管理员)
 *
 * - useRequest 拉用户/组列表
 * - 建组、建用户表单走 react-hook-form + zod 校验
 * - 改组 / 启用禁用即时调用 adminUpdateUser 后刷新
 * - 错误已由 request 拦截器统一 toast,这里只处理成功反馈与刷新
 */
export default function AdminPage(): React.JSX.Element {
  const { t } = useTranslation()

  const groupsReq = useRequest(adminListGroups)
  const usersReq = useRequest(adminListUsers)
  const groups = groupsReq.data ?? []
  const users = usersReq.data ?? []

  return (
    <div className={styles.page}>
      <div className={styles.main}>
        <div className={styles.pageHeader}>
          <span>{t('admin.subtitle')}</span>
          <strong>{t('admin.title')}</strong>
        </div>

        <GroupSection
          groups={groups}
          loading={groupsReq.loading}
          onCreated={() => groupsReq.refresh()}
        />

        <UserSection
          users={users}
          groups={groups}
          loading={usersReq.loading}
          onChanged={() => usersReq.refresh()}
        />
      </div>
    </div>
  )
}

// ===== 用户组区:列表 + 建组表单 =====

interface GroupSectionProps {
  groups: ServerGroup[]
  loading: boolean
  onCreated: () => void
}

function GroupSection({ groups, loading, onCreated }: GroupSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const schema = z.object({ name: z.string().trim().min(1, t('admin.errGroupNameRequired')) })
  type FormValues = z.infer<typeof schema>
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: '' } })

  const onSubmit = handleSubmit(async (values) => {
    await adminCreateGroup(values.name)
    toast.success(t('admin.groupCreated'))
    reset()
    onCreated()
  })

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{t('admin.groups')}</h2>

      <form className={styles.inlineForm} onSubmit={onSubmit}>
        <div className={styles.field}>
          <input
            className={styles.input}
            placeholder={t('admin.groupNamePlaceholder')}
            {...register('name')}
          />
          {errors.name && <span className={styles.error}>{errors.name.message}</span>}
        </div>
        <button className={styles.primaryBtn} type="submit" disabled={isSubmitting}>
          {t('admin.createGroup')}
        </button>
      </form>

      <div className={styles.chips}>
        {loading && <span className={styles.muted}>{t('admin.loading')}</span>}
        {!loading && groups.length === 0 && (
          <span className={styles.muted}>{t('admin.noGroups')}</span>
        )}
        {groups.map((g) => (
          <span key={g.id} className={styles.chip}>
            {g.name}
          </span>
        ))}
      </div>
    </section>
  )
}

// ===== 用户区:列表(含改组/启用禁用) + 建用户表单 =====

interface UserSectionProps {
  users: ServerUser[]
  groups: ServerGroup[]
  loading: boolean
  onChanged: () => void
}

function UserSection({ users, groups, loading, onChanged }: UserSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const schema = z.object({
    username: z.string().trim().min(1, t('admin.errUsernameRequired')),
    password: z.string().min(6, t('admin.errPasswordMin')),
    role: z.enum(['member', 'admin']),
    groupId: z.string()
  })
  type FormValues = z.infer<typeof schema>
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', password: '', role: 'member', groupId: '' }
  })

  const onSubmit = handleSubmit(async (values) => {
    await adminCreateUser({
      username: values.username,
      password: values.password,
      role: values.role,
      groupId: values.groupId || null
    })
    toast.success(t('admin.userCreated'))
    reset()
    onChanged()
  })

  const handleGroupChange = async (user: ServerUser, groupId: string): Promise<void> => {
    if (!groupId || groupId === user.groupId) return
    await adminUpdateUser(user.id, { groupId })
    toast.success(t('admin.userUpdated'))
    onChanged()
  }

  const handleToggleDisabled = async (user: ServerUser): Promise<void> => {
    await adminUpdateUser(user.id, { disabled: !user.disabled })
    toast.success(t('admin.userUpdated'))
    onChanged()
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{t('admin.users')}</h2>

      <form className={styles.userForm} onSubmit={onSubmit}>
        <div className={styles.field}>
          <input
            className={styles.input}
            placeholder={t('admin.username')}
            autoComplete="off"
            {...register('username')}
          />
          {errors.username && <span className={styles.error}>{errors.username.message}</span>}
        </div>
        <div className={styles.field}>
          <input
            className={styles.input}
            type="password"
            placeholder={t('admin.password')}
            autoComplete="new-password"
            {...register('password')}
          />
          {errors.password && <span className={styles.error}>{errors.password.message}</span>}
        </div>
        <select className={styles.select} {...register('role')}>
          <option value="member">{t('admin.roleMember')}</option>
          <option value="admin">{t('admin.roleAdmin')}</option>
        </select>
        <select className={styles.select} {...register('groupId')}>
          <option value="">{t('admin.noGroup')}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button className={styles.primaryBtn} type="submit" disabled={isSubmitting}>
          {t('admin.createUser')}
        </button>
      </form>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('admin.username')}</th>
              <th>{t('admin.role')}</th>
              <th>{t('admin.group')}</th>
              <th>{t('admin.status')}</th>
              <th>{t('admin.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className={styles.muted}>
                  {t('admin.loading')}
                </td>
              </tr>
            )}
            {!loading && users.length === 0 && (
              <tr>
                <td colSpan={5} className={styles.muted}>
                  {t('admin.noUsers')}
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr key={u.id} className={u.disabled ? styles.rowDisabled : undefined}>
                <td>{u.username}</td>
                <td>{u.role === 'admin' ? t('admin.roleAdmin') : t('admin.roleMember')}</td>
                <td>
                  <select
                    className={styles.selectSm}
                    value={u.groupId ?? ''}
                    onChange={(e) => handleGroupChange(u, e.target.value)}
                  >
                    <option value="">{t('admin.noGroup')}</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <span className={u.disabled ? styles.badgeOff : styles.badgeOn}>
                    {u.disabled ? t('admin.disabled') : t('admin.enabled')}
                  </span>
                </td>
                <td>
                  <button className={styles.ghostBtn} onClick={() => handleToggleDisabled(u)}>
                    {u.disabled ? t('admin.enable') : t('admin.disable')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
