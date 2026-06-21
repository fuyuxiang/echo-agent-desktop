import { app } from 'electron'
import path from 'path'

const HOME = app.getPath('home')

/**
 * 运行时资源目录 (随包分发的 Python 压缩包等):
 * - 打包后: process.resourcesPath (app.asar 同级 Resources)
 * - 开发期: 项目根的 resources/ (process.resourcesPath 此时指向 Electron 自带 Resources, 不可用)
 */
export const RUNTIME_RESOURCES_DIR = app.isPackaged
  ? process.resourcesPath
  : path.join(app.getAppPath(), 'resources')

/** 桌面端数据根目录 */
export const DESKTOP_DATA_DIR = path.join(HOME, '.echo-agent-desktop')

/** 内嵌 Python 解压目录 */
export const PYTHON_DIR = path.join(DESKTOP_DATA_DIR, 'python')

/** 虚拟环境目录 */
export const VENV_DIR = path.join(DESKTOP_DATA_DIR, 'venv')

/** Agent 工作空间（echo-agent 数据目录） */
export const AGENT_WORKSPACE = path.join(DESKTOP_DATA_DIR, 'agent-data')

/** 配置文件路径 */
export const AGENT_CONFIG_PATH = path.join(AGENT_WORKSPACE, 'echo-agent.yaml')

/** 日志目录 */
export const LOGS_DIR = path.join(DESKTOP_DATA_DIR, 'logs')

/** Python 可执行文件路径 */
export const PYTHON_BIN =
  process.platform === 'win32'
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python3')

/** pip 可执行文件路径 */
export const PIP_BIN =
  process.platform === 'win32'
    ? path.join(VENV_DIR, 'Scripts', 'pip.exe')
    : path.join(VENV_DIR, 'bin', 'pip')

/** 内嵌 Python 解压后的可执行文件 */
export const EMBEDDED_PYTHON_BIN =
  process.platform === 'win32'
    ? path.join(PYTHON_DIR, 'python.exe')
    : path.join(PYTHON_DIR, 'bin', 'python3')

/** 默认 pip 镜像源 */
export const DEFAULT_PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'

/** 就绪信号前缀（从 Agent stdout 解析） */
export const READY_SIGNAL_PREFIX = 'ECHO_AGENT_READY'

/** Health check 最大等待时间 (ms) */
export const HEALTH_CHECK_TIMEOUT = 30_000

/** Health check 轮询间隔 (ms) */
export const HEALTH_CHECK_INTERVAL = 500

/** Agent 崩溃自动重启最大次数 */
export const MAX_RESTART_ATTEMPTS = 3

/** 关闭等待超时 (ms) */
export const SHUTDOWN_TIMEOUT = 15_000
