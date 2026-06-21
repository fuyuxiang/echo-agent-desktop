import type { OpenDialogOptions, SaveDialogOptions } from '@shared/types'

/**
 * 文件对话框门面
 *
 * 用法:
 *   const [file] = await fileDialog.open({ filters: [{ name: '图片', extensions: ['png', 'jpg'] }] })
 *   const savePath = await fileDialog.save({ defaultPath: 'export.json' })
 */
export const fileDialog = {
  /** 打开文件选择对话框,返回选中路径数组(取消返回空数组) */
  open(options: OpenDialogOptions = {}): Promise<string[]> {
    return window.api.system.showOpenDialog({
      properties: ['openFile'],
      ...options
    })
  },
  /** 打开保存对话框,返回保存路径(取消返回 null) */
  save(options: SaveDialogOptions = {}): Promise<string | null> {
    return window.api.system.showSaveDialog(options)
  }
}
