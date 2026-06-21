import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { setupGlobalErrorCapture } from '@/utils/logger'
import '@/i18n'
import '@/styles/global.scss'

// 渲染层全局异常捕获(汇入主进程日志)
setupGlobalErrorCapture()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
