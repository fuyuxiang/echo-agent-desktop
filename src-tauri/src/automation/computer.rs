use base64::Engine;
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::Serialize;
use std::io::Cursor;
use std::time::Duration;

const MAX_SCREENSHOT_WIDTH: u32 = 1920;
const MAX_SCREENSHOT_HEIGHT: u32 = 1200;
const MAX_FRAME_AGE_MS: u64 = 2 * 60 * 1_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerCapability {
    pub available: bool,
    pub platform: String,
    pub screen_capture: bool,
    pub input_control: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub name: String,
    pub primary: bool,
    pub origin_x: f64,
    pub origin_y: f64,
    pub logical_width: f64,
    pub logical_height: f64,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMeta {
    pub frame_id: String,
    pub display_id: String,
    pub image_width: u32,
    pub image_height: u32,
    pub origin_x: f64,
    pub origin_y: f64,
    pub logical_width: f64,
    pub logical_height: f64,
    pub scale_factor: f64,
    pub captured_at_ms: u64,
}

#[derive(Debug)]
pub struct ScreenshotFrame {
    pub png_base64: String,
    pub meta: FrameMeta,
}

#[derive(Debug, Default)]
pub struct ComputerController {
    last_frame: Option<FrameMeta>,
}

impl ComputerController {
    pub fn capability() -> ComputerCapability {
        platform::capability()
    }

    pub fn request_permissions() -> Result<ComputerCapability, String> {
        platform::request_permissions()?;
        Ok(platform::capability())
    }

    pub fn displays() -> Result<Vec<DisplayInfo>, String> {
        platform::displays()
    }

    pub fn screenshot(&mut self, display_id: Option<&str>) -> Result<ScreenshotFrame, String> {
        let captured = platform::capture(display_id)?;
        if captured.width == 0 || captured.height == 0 {
            return Err("屏幕截图尺寸无效".into());
        }
        let image = RgbaImage::from_raw(captured.width, captured.height, captured.rgba)
            .ok_or_else(|| "屏幕截图像素数据不完整".to_string())?;
        let mut dynamic = DynamicImage::ImageRgba8(image);
        if dynamic.width() > MAX_SCREENSHOT_WIDTH || dynamic.height() > MAX_SCREENSHOT_HEIGHT {
            dynamic = dynamic.resize(
                MAX_SCREENSHOT_WIDTH,
                MAX_SCREENSHOT_HEIGHT,
                image::imageops::FilterType::Triangle,
            );
        }
        let image_width = dynamic.width();
        let image_height = dynamic.height();
        let mut png = Cursor::new(Vec::new());
        dynamic
            .write_to(&mut png, ImageFormat::Png)
            .map_err(|error| format!("编码屏幕截图失败：{error}"))?;
        let scale_factor = if captured.logical_width > 0.0 {
            f64::from(image_width) / captured.logical_width
        } else {
            1.0
        };
        let meta = FrameMeta {
            frame_id: uuid::Uuid::now_v7().to_string(),
            display_id: captured.display_id,
            image_width,
            image_height,
            origin_x: captured.origin_x,
            origin_y: captured.origin_y,
            logical_width: captured.logical_width,
            logical_height: captured.logical_height,
            scale_factor,
            captured_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        };
        self.last_frame = Some(meta.clone());
        Ok(ScreenshotFrame {
            png_base64: base64::engine::general_purpose::STANDARD.encode(png.into_inner()),
            meta,
        })
    }

    pub fn move_pointer(&mut self, frame_id: &str, x: f64, y: f64) -> Result<(f64, f64), String> {
        let (desktop_x, desktop_y) = self.resolve_point(frame_id, x, y)?;
        platform::move_pointer(desktop_x, desktop_y)?;
        // Hover effects, menus and tooltips can change the visual target even
        // when the pointer only moves. Require a fresh observation afterwards.
        self.last_frame = None;
        Ok((desktop_x, desktop_y))
    }

    pub fn click(
        &mut self,
        frame_id: &str,
        x: f64,
        y: f64,
        button: &str,
        count: u32,
    ) -> Result<(f64, f64), String> {
        let (desktop_x, desktop_y) = self.resolve_point(frame_id, x, y)?;
        platform::click(desktop_x, desktop_y, button, count.clamp(1, 3))?;
        self.last_frame = None;
        Ok((desktop_x, desktop_y))
    }

    pub fn drag(
        &mut self,
        frame_id: &str,
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
        duration_ms: u64,
    ) -> Result<(), String> {
        let (desktop_from_x, desktop_from_y) = self.resolve_point(frame_id, from_x, from_y)?;
        let (desktop_to_x, desktop_to_y) = self.resolve_point(frame_id, to_x, to_y)?;
        platform::drag(
            desktop_from_x,
            desktop_from_y,
            desktop_to_x,
            desktop_to_y,
            duration_ms.clamp(100, 5_000),
        )?;
        self.last_frame = None;
        Ok(())
    }

    pub fn scroll(&mut self, frame_id: &str, delta_x: i32, delta_y: i32) -> Result<(), String> {
        self.require_frame(frame_id)?;
        platform::scroll(
            delta_x.clamp(-10_000, 10_000),
            delta_y.clamp(-10_000, 10_000),
        )?;
        self.last_frame = None;
        Ok(())
    }

    pub fn type_text(&mut self, frame_id: &str, text: &str) -> Result<(), String> {
        self.require_frame(frame_id)?;
        if text.len() > 64 * 1024 {
            return Err("单次输入不能超过 64KB".into());
        }
        platform::type_text(text)?;
        self.last_frame = None;
        Ok(())
    }

    pub fn key(&mut self, frame_id: &str, key: &str, modifiers: &[String]) -> Result<(), String> {
        self.require_frame(frame_id)?;
        if key.is_empty() || key.chars().count() > 64 || modifiers.len() > 4 {
            return Err("按键参数无效".into());
        }
        platform::key(key, modifiers)?;
        self.last_frame = None;
        Ok(())
    }

    fn resolve_point(&self, frame_id: &str, x: f64, y: f64) -> Result<(f64, f64), String> {
        let frame = self.require_frame(frame_id)?;
        if !x.is_finite()
            || !y.is_finite()
            || x < 0.0
            || y < 0.0
            || x > f64::from(frame.image_width)
            || y > f64::from(frame.image_height)
        {
            return Err("操作坐标超出截图范围".into());
        }
        let desktop_x = frame.origin_x + x * frame.logical_width / f64::from(frame.image_width);
        let desktop_y = frame.origin_y + y * frame.logical_height / f64::from(frame.image_height);
        Ok((desktop_x, desktop_y))
    }

    pub fn invalidate_frame(&mut self) {
        self.last_frame = None;
    }

    fn require_frame(&self, frame_id: &str) -> Result<&FrameMeta, String> {
        let frame = self
            .last_frame
            .as_ref()
            .filter(|frame| frame.frame_id == frame_id)
            .ok_or_else(|| "截图已过期，请先重新调用 computer_screenshot".to_string())?;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        if now_ms.saturating_sub(frame.captured_at_ms) > MAX_FRAME_AGE_MS {
            return Err("截图已超过两分钟，为避免错位操作，请重新截图".into());
        }
        Ok(frame)
    }
}

#[derive(Debug)]
struct CapturedDisplay {
    display_id: String,
    origin_x: f64,
    origin_y: f64,
    logical_width: f64,
    logical_height: f64,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use core_graphics::access::ScreenCaptureAccess;
    use core_graphics::display::CGDisplay;
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, KeyCode,
        ScrollEventUnit,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    fn input_allowed() -> bool {
        // SAFETY: AXIsProcessTrusted takes no arguments and has no ownership
        // transfer. It is available on every supported macOS target.
        unsafe { AXIsProcessTrusted() }
    }

    pub fn capability() -> ComputerCapability {
        let screen_capture = ScreenCaptureAccess.preflight();
        let input_control = input_allowed();
        let reason = match (screen_capture, input_control) {
            (true, true) => None,
            (false, false) => Some(
                "需要在“系统设置 > 隐私与安全性”中授予 EchoAgent 屏幕录制和辅助功能权限。".into(),
            ),
            (false, true) => Some("需要授予 EchoAgent 屏幕录制权限。".into()),
            (true, false) => Some("需要授予 EchoAgent 辅助功能权限。".into()),
        };
        ComputerCapability {
            // Platform support and live user consent are separate. Keep the
            // mode selectable so the UI can guide first-time permission setup.
            available: true,
            platform: "macOS".into(),
            screen_capture,
            input_control,
            reason,
        }
    }

    pub fn request_permissions() -> Result<(), String> {
        if !ScreenCaptureAccess.preflight() {
            let _ = ScreenCaptureAccess.request();
        }
        if !input_allowed() {
            open::that(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            )
            .map_err(|error| format!("打开 macOS 辅助功能设置失败：{error}"))?;
        }
        Ok(())
    }

    pub fn displays() -> Result<Vec<DisplayInfo>, String> {
        let ids = CGDisplay::active_displays()
            .map_err(|code| format!("枚举显示器失败（CoreGraphics {code}）"))?;
        let main = CGDisplay::main();
        Ok(ids
            .into_iter()
            .enumerate()
            .map(|(index, id)| {
                let display = CGDisplay::new(id);
                let bounds = display.bounds();
                let pixel_width = display.pixels_wide().min(u64::from(u32::MAX)) as u32;
                let pixel_height = display.pixels_high().min(u64::from(u32::MAX)) as u32;
                let logical_width = bounds.size.width;
                DisplayInfo {
                    id: id.to_string(),
                    name: format!("显示器 {}", index + 1),
                    primary: id == main.id,
                    origin_x: bounds.origin.x,
                    origin_y: bounds.origin.y,
                    logical_width,
                    logical_height: bounds.size.height,
                    pixel_width,
                    pixel_height,
                    scale_factor: if logical_width > 0.0 {
                        f64::from(pixel_width) / logical_width
                    } else {
                        1.0
                    },
                }
            })
            .collect())
    }

    pub fn capture(display_id: Option<&str>) -> Result<CapturedDisplay, String> {
        if !ScreenCaptureAccess.preflight() {
            return Err("尚未授予屏幕录制权限，请在自动化面板中完成授权".into());
        }
        let infos = displays()?;
        let selected = match display_id {
            Some(id) => infos.into_iter().find(|display| display.id == id),
            None => infos
                .iter()
                .find(|display| display.primary)
                .cloned()
                .or_else(|| infos.into_iter().next()),
        }
        .ok_or_else(|| "指定的显示器不存在".to_string())?;
        let id = selected
            .id
            .parse::<u32>()
            .map_err(|_| "显示器 ID 无效".to_string())?;
        let image = CGDisplay::new(id)
            .image()
            .ok_or_else(|| "截取显示器画面失败，请检查屏幕录制权限".to_string())?;
        let width = u32::try_from(image.width()).map_err(|_| "截图宽度超出上限")?;
        let height = u32::try_from(image.height()).map_err(|_| "截图高度超出上限")?;
        if image.bits_per_pixel() != 32 {
            return Err(format!(
                "不支持的屏幕像素格式：{} bpp",
                image.bits_per_pixel()
            ));
        }
        let bytes_per_row = image.bytes_per_row();
        let data = image.data();
        let raw = data.bytes();
        let required = bytes_per_row
            .checked_mul(height as usize)
            .ok_or_else(|| "截图尺寸溢出".to_string())?;
        if raw.len() < required {
            return Err("屏幕截图像素数据不完整".into());
        }
        let mut rgba = vec![0_u8; width as usize * height as usize * 4];
        for y in 0..height as usize {
            let src = &raw[y * bytes_per_row..y * bytes_per_row + width as usize * 4];
            let dst = &mut rgba[y * width as usize * 4..(y + 1) * width as usize * 4];
            for (source, target) in src.chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
                // CGDisplayCreateImage returns native-endian premultiplied BGRA
                // on supported macOS displays.
                target[0] = source[2];
                target[1] = source[1];
                target[2] = source[0];
                target[3] = source[3];
            }
        }
        Ok(CapturedDisplay {
            display_id: selected.id,
            origin_x: selected.origin_x,
            origin_y: selected.origin_y,
            logical_width: selected.logical_width,
            logical_height: selected.logical_height,
            width,
            height,
            rgba,
        })
    }

    fn source() -> Result<CGEventSource, String> {
        if !input_allowed() {
            return Err("尚未授予辅助功能权限，请在自动化面板中完成授权".into());
        }
        CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "创建 macOS 输入事件源失败".to_string())
    }

    fn point(x: f64, y: f64) -> core_graphics::geometry::CGPoint {
        core_graphics::geometry::CGPoint::new(x, y)
    }

    pub fn move_pointer(x: f64, y: f64) -> Result<(), String> {
        CGEvent::new_mouse_event(
            source()?,
            CGEventType::MouseMoved,
            point(x, y),
            CGMouseButton::Left,
        )
        .map_err(|_| "创建鼠标移动事件失败".to_string())?
        .post(CGEventTapLocation::HID);
        Ok(())
    }

    pub fn click(x: f64, y: f64, button: &str, count: u32) -> Result<(), String> {
        let (mouse_button, down, up) = match button {
            "left" => (
                CGMouseButton::Left,
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
            ),
            "right" => (
                CGMouseButton::Right,
                CGEventType::RightMouseDown,
                CGEventType::RightMouseUp,
            ),
            "middle" => (
                CGMouseButton::Center,
                CGEventType::OtherMouseDown,
                CGEventType::OtherMouseUp,
            ),
            _ => return Err("鼠标按键只能是 left、right 或 middle".into()),
        };
        move_pointer(x, y)?;
        for _ in 0..count {
            CGEvent::new_mouse_event(source()?, down, point(x, y), mouse_button)
                .map_err(|_| "创建鼠标按下事件失败".to_string())?
                .post(CGEventTapLocation::HID);
            CGEvent::new_mouse_event(source()?, up, point(x, y), mouse_button)
                .map_err(|_| "创建鼠标释放事件失败".to_string())?
                .post(CGEventTapLocation::HID);
            std::thread::sleep(Duration::from_millis(60));
        }
        Ok(())
    }

    pub fn drag(
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
        duration_ms: u64,
    ) -> Result<(), String> {
        move_pointer(from_x, from_y)?;
        CGEvent::new_mouse_event(
            source()?,
            CGEventType::LeftMouseDown,
            point(from_x, from_y),
            CGMouseButton::Left,
        )
        .map_err(|_| "创建拖拽按下事件失败".to_string())?
        .post(CGEventTapLocation::HID);
        let steps = (duration_ms / 16).clamp(4, 120);
        for step in 1..=steps {
            let ratio = step as f64 / steps as f64;
            let x = from_x + (to_x - from_x) * ratio;
            let y = from_y + (to_y - from_y) * ratio;
            CGEvent::new_mouse_event(
                source()?,
                CGEventType::LeftMouseDragged,
                point(x, y),
                CGMouseButton::Left,
            )
            .map_err(|_| "创建拖拽移动事件失败".to_string())?
            .post(CGEventTapLocation::HID);
            std::thread::sleep(Duration::from_millis(16));
        }
        CGEvent::new_mouse_event(
            source()?,
            CGEventType::LeftMouseUp,
            point(to_x, to_y),
            CGMouseButton::Left,
        )
        .map_err(|_| "创建拖拽释放事件失败".to_string())?
        .post(CGEventTapLocation::HID);
        Ok(())
    }

    pub fn scroll(delta_x: i32, delta_y: i32) -> Result<(), String> {
        CGEvent::new_scroll_event(source()?, ScrollEventUnit::PIXEL, 2, -delta_y, -delta_x, 0)
            .map_err(|_| "创建滚动事件失败".to_string())?
            .post(CGEventTapLocation::HID);
        Ok(())
    }

    pub fn type_text(text: &str) -> Result<(), String> {
        let down = CGEvent::new_keyboard_event(source()?, 0, true)
            .map_err(|_| "创建键盘输入事件失败".to_string())?;
        down.set_string(text);
        down.post(CGEventTapLocation::HID);
        let up = CGEvent::new_keyboard_event(source()?, 0, false)
            .map_err(|_| "创建键盘释放事件失败".to_string())?;
        up.post(CGEventTapLocation::HID);
        Ok(())
    }

    pub fn key(key: &str, modifiers: &[String]) -> Result<(), String> {
        let keycode = keycode(key)?;
        let flags = modifier_flags(modifiers)?;
        let down = CGEvent::new_keyboard_event(source()?, keycode, true)
            .map_err(|_| "创建按键事件失败".to_string())?;
        down.set_flags(flags);
        down.post(CGEventTapLocation::HID);
        let up = CGEvent::new_keyboard_event(source()?, keycode, false)
            .map_err(|_| "创建按键释放事件失败".to_string())?;
        up.set_flags(flags);
        up.post(CGEventTapLocation::HID);
        Ok(())
    }

    fn modifier_flags(modifiers: &[String]) -> Result<CGEventFlags, String> {
        let mut flags = CGEventFlags::CGEventFlagNull;
        for modifier in modifiers {
            flags |= match modifier.to_ascii_lowercase().as_str() {
                "shift" => CGEventFlags::CGEventFlagShift,
                "control" | "ctrl" => CGEventFlags::CGEventFlagControl,
                "alt" | "option" => CGEventFlags::CGEventFlagAlternate,
                "meta" | "command" | "cmd" => CGEventFlags::CGEventFlagCommand,
                other => return Err(format!("不支持的修饰键：{other}")),
            };
        }
        Ok(flags)
    }

    fn keycode(key: &str) -> Result<u16, String> {
        let code = match key.to_ascii_lowercase().as_str() {
            "a" => KeyCode::ANSI_A,
            "b" => KeyCode::ANSI_B,
            "c" => KeyCode::ANSI_C,
            "d" => KeyCode::ANSI_D,
            "e" => KeyCode::ANSI_E,
            "f" => KeyCode::ANSI_F,
            "g" => KeyCode::ANSI_G,
            "h" => KeyCode::ANSI_H,
            "i" => KeyCode::ANSI_I,
            "j" => KeyCode::ANSI_J,
            "k" => KeyCode::ANSI_K,
            "l" => KeyCode::ANSI_L,
            "m" => KeyCode::ANSI_M,
            "n" => KeyCode::ANSI_N,
            "o" => KeyCode::ANSI_O,
            "p" => KeyCode::ANSI_P,
            "q" => KeyCode::ANSI_Q,
            "r" => KeyCode::ANSI_R,
            "s" => KeyCode::ANSI_S,
            "t" => KeyCode::ANSI_T,
            "u" => KeyCode::ANSI_U,
            "v" => KeyCode::ANSI_V,
            "w" => KeyCode::ANSI_W,
            "x" => KeyCode::ANSI_X,
            "y" => KeyCode::ANSI_Y,
            "z" => KeyCode::ANSI_Z,
            "0" => KeyCode::ANSI_0,
            "1" => KeyCode::ANSI_1,
            "2" => KeyCode::ANSI_2,
            "3" => KeyCode::ANSI_3,
            "4" => KeyCode::ANSI_4,
            "5" => KeyCode::ANSI_5,
            "6" => KeyCode::ANSI_6,
            "7" => KeyCode::ANSI_7,
            "8" => KeyCode::ANSI_8,
            "9" => KeyCode::ANSI_9,
            "enter" | "return" => KeyCode::RETURN,
            "tab" => KeyCode::TAB,
            "space" => KeyCode::SPACE,
            "backspace" | "deletebackward" => KeyCode::DELETE,
            "delete" | "deleteforward" => KeyCode::FORWARD_DELETE,
            "escape" | "esc" => KeyCode::ESCAPE,
            "left" | "arrowleft" => KeyCode::LEFT_ARROW,
            "right" | "arrowright" => KeyCode::RIGHT_ARROW,
            "up" | "arrowup" => KeyCode::UP_ARROW,
            "down" | "arrowdown" => KeyCode::DOWN_ARROW,
            "home" => KeyCode::HOME,
            "end" => KeyCode::END,
            "pageup" => KeyCode::PAGE_UP,
            "pagedown" => KeyCode::PAGE_DOWN,
            other => return Err(format!("不支持的按键：{other}")),
        };
        Ok(code)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::mem::{size_of, zeroed};
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    pub fn capability() -> ComputerCapability {
        ComputerCapability {
            available: true,
            platform: "Windows".into(),
            screen_capture: true,
            input_control: true,
            reason: None,
        }
    }

    pub fn request_permissions() -> Result<(), String> {
        Ok(())
    }

    fn virtual_bounds() -> (i32, i32, i32, i32) {
        unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        }
    }

    pub fn displays() -> Result<Vec<DisplayInfo>, String> {
        let (x, y, width, height) = virtual_bounds();
        if width <= 0 || height <= 0 {
            return Err("无法获取 Windows 虚拟桌面尺寸".into());
        }
        Ok(vec![DisplayInfo {
            id: "virtual-desktop".into(),
            name: "Windows 虚拟桌面".into(),
            primary: true,
            origin_x: f64::from(x),
            origin_y: f64::from(y),
            logical_width: f64::from(width),
            logical_height: f64::from(height),
            pixel_width: width as u32,
            pixel_height: height as u32,
            scale_factor: 1.0,
        }])
    }

    pub fn capture(display_id: Option<&str>) -> Result<CapturedDisplay, String> {
        if display_id.is_some_and(|id| id != "virtual-desktop") {
            return Err("指定的显示器不存在".into());
        }
        let (x, y, width, height) = virtual_bounds();
        if width <= 0 || height <= 0 {
            return Err("无法获取 Windows 虚拟桌面尺寸".into());
        }
        unsafe {
            let screen_dc = GetDC(null_mut());
            if screen_dc.is_null() {
                return Err("获取 Windows 屏幕 DC 失败".into());
            }
            let memory_dc = CreateCompatibleDC(screen_dc);
            let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
            if memory_dc.is_null() || bitmap.is_null() {
                if !bitmap.is_null() {
                    DeleteObject(bitmap);
                }
                if !memory_dc.is_null() {
                    DeleteDC(memory_dc);
                }
                ReleaseDC(null_mut(), screen_dc);
                return Err("创建 Windows 截图缓冲区失败".into());
            }
            let old = SelectObject(memory_dc, bitmap);
            let copied = BitBlt(
                memory_dc,
                0,
                0,
                width,
                height,
                screen_dc,
                x,
                y,
                SRCCOPY | CAPTUREBLT,
            );
            let mut info: BITMAPINFO = zeroed();
            info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = width;
            info.bmiHeader.biHeight = -height;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB;
            let mut bgra = vec![0_u8; width as usize * height as usize * 4];
            let lines = if copied != 0 {
                GetDIBits(
                    memory_dc,
                    bitmap,
                    0,
                    height as u32,
                    bgra.as_mut_ptr().cast(),
                    &mut info,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            };
            SelectObject(memory_dc, old);
            DeleteObject(bitmap);
            DeleteDC(memory_dc);
            ReleaseDC(null_mut(), screen_dc);
            if lines != height {
                return Err("读取 Windows 屏幕像素失败".into());
            }
            for pixel in bgra.chunks_exact_mut(4) {
                pixel.swap(0, 2);
                pixel[3] = 255;
            }
            Ok(CapturedDisplay {
                display_id: "virtual-desktop".into(),
                origin_x: f64::from(x),
                origin_y: f64::from(y),
                logical_width: f64::from(width),
                logical_height: f64::from(height),
                width: width as u32,
                height: height as u32,
                rgba: bgra,
            })
        }
    }

    pub fn move_pointer(x: f64, y: f64) -> Result<(), String> {
        let ok = unsafe { SetCursorPos(x.round() as i32, y.round() as i32) };
        if ok == 0 {
            Err("移动 Windows 鼠标失败".into())
        } else {
            Ok(())
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, data: u32) -> Result<(), String> {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: data,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let sent = unsafe { SendInput(1, &input, size_of::<INPUT>() as i32) };
        if sent == 1 {
            Ok(())
        } else {
            Err("发送 Windows 鼠标事件失败".into())
        }
    }

    pub fn click(x: f64, y: f64, button: &str, count: u32) -> Result<(), String> {
        move_pointer(x, y)?;
        let (down, up) = match button {
            "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _ => return Err("鼠标按键只能是 left、right 或 middle".into()),
        };
        for _ in 0..count {
            mouse(down, 0)?;
            mouse(up, 0)?;
            std::thread::sleep(Duration::from_millis(60));
        }
        Ok(())
    }

    pub fn drag(
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
        duration_ms: u64,
    ) -> Result<(), String> {
        move_pointer(from_x, from_y)?;
        mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
        let steps = (duration_ms / 16).clamp(4, 120);
        for step in 1..=steps {
            let ratio = step as f64 / steps as f64;
            move_pointer(
                from_x + (to_x - from_x) * ratio,
                from_y + (to_y - from_y) * ratio,
            )?;
            std::thread::sleep(Duration::from_millis(16));
        }
        mouse(MOUSEEVENTF_LEFTUP, 0)
    }

    pub fn scroll(delta_x: i32, delta_y: i32) -> Result<(), String> {
        if delta_y != 0 {
            mouse(MOUSEEVENTF_WHEEL, (-delta_y) as u32)?;
        }
        if delta_x != 0 {
            mouse(MOUSEEVENTF_HWHEEL, delta_x as u32)?;
        }
        Ok(())
    }

    fn keyboard(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> Result<(), String> {
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        if unsafe { SendInput(1, &input, size_of::<INPUT>() as i32) } == 1 {
            Ok(())
        } else {
            Err("发送 Windows 键盘事件失败".into())
        }
    }

    pub fn type_text(text: &str) -> Result<(), String> {
        for unit in text.encode_utf16() {
            keyboard(0, unit, KEYEVENTF_UNICODE)?;
            keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)?;
        }
        Ok(())
    }

    pub fn key(key: &str, modifiers: &[String]) -> Result<(), String> {
        let mut mods = Vec::new();
        for modifier in modifiers {
            let vk = match modifier.to_ascii_lowercase().as_str() {
                "shift" => VK_SHIFT,
                "control" | "ctrl" => VK_CONTROL,
                "alt" | "option" => VK_MENU,
                "meta" | "command" | "cmd" => VK_LWIN,
                other => return Err(format!("不支持的修饰键：{other}")),
            };
            keyboard(vk, 0, 0)?;
            mods.push(vk);
        }
        let vk = virtual_key(key)?;
        keyboard(vk, 0, 0)?;
        keyboard(vk, 0, KEYEVENTF_KEYUP)?;
        for vk in mods.into_iter().rev() {
            keyboard(vk, 0, KEYEVENTF_KEYUP)?;
        }
        Ok(())
    }

    fn virtual_key(key: &str) -> Result<u16, String> {
        Ok(match key.to_ascii_lowercase().as_str() {
            "enter" | "return" => VK_RETURN,
            "tab" => VK_TAB,
            "space" => VK_SPACE,
            "backspace" => VK_BACK,
            "delete" => VK_DELETE,
            "escape" | "esc" => VK_ESCAPE,
            "left" | "arrowleft" => VK_LEFT,
            "right" | "arrowright" => VK_RIGHT,
            "up" | "arrowup" => VK_UP,
            "down" | "arrowdown" => VK_DOWN,
            "home" => VK_HOME,
            "end" => VK_END,
            "pageup" => VK_PRIOR,
            "pagedown" => VK_NEXT,
            value if value.len() == 1 => value.as_bytes()[0].to_ascii_uppercase() as u16,
            other => return Err(format!("不支持的按键：{other}")),
        })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;
    fn unavailable() -> String {
        "当前项目的 Linux 桌面版尚在适配中，Computer Use 仅在已发布的 macOS 和 Windows 平台可用。"
            .into()
    }
    pub fn capability() -> ComputerCapability {
        ComputerCapability {
            available: false,
            platform: std::env::consts::OS.into(),
            screen_capture: false,
            input_control: false,
            reason: Some(unavailable()),
        }
    }
    pub fn request_permissions() -> Result<(), String> {
        Err(unavailable())
    }
    pub fn displays() -> Result<Vec<DisplayInfo>, String> {
        Err(unavailable())
    }
    pub fn capture(_: Option<&str>) -> Result<CapturedDisplay, String> {
        Err(unavailable())
    }
    pub fn move_pointer(_: f64, _: f64) -> Result<(), String> {
        Err(unavailable())
    }
    pub fn click(_: f64, _: f64, _: &str, _: u32) -> Result<(), String> {
        Err(unavailable())
    }
    pub fn drag(_: f64, _: f64, _: f64, _: f64, _: u64) -> Result<(), String> {
        Err(unavailable())
    }
    pub fn scroll(_: i32, _: i32) -> Result<(), String> {
        Err(unavailable())
    }
    pub fn type_text(_: &str) -> Result<(), String> {
        Err(unavailable())
    }
    pub fn key(_: &str, _: &[String]) -> Result<(), String> {
        Err(unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_frames_are_rejected() {
        let controller = ComputerController {
            last_frame: Some(FrameMeta {
                frame_id: "current".into(),
                display_id: "d".into(),
                image_width: 100,
                image_height: 50,
                origin_x: -20.0,
                origin_y: 10.0,
                logical_width: 200.0,
                logical_height: 100.0,
                scale_factor: 0.5,
                captured_at_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
            }),
        };
        assert!(controller.resolve_point("old", 10.0, 10.0).is_err());
        assert_eq!(
            controller.resolve_point("current", 50.0, 25.0).unwrap(),
            (80.0, 60.0)
        );
        assert!(controller.resolve_point("current", 101.0, 0.0).is_err());
    }
}
