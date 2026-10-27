//! Recover the complete PCM frames that reached the recording file, even when
//! the process died before committing its manifest or updating RIFF lengths.
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

pub fn recover_pcm_wav(path: &Path, max_samples: u64) -> Result<u64, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("打开中断录音失败：{error}"))?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let mut header = [0u8; 44];
    file.read_exact(&mut header)
        .map_err(|error| format!("录音文件头不完整，已保留原文件：{error}"))?;
    // Size fields may have been torn during a crash; all format fields must
    // still identify the exact mono 16 kHz PCM16 format written by this app.
    if &header[..4] != b"RIFF"
        || &header[8..16] != b"WAVEfmt "
        || u32::from_le_bytes(header[16..20].try_into().unwrap()) != 16
        || u16::from_le_bytes(header[20..22].try_into().unwrap()) != 1
        || u16::from_le_bytes(header[22..24].try_into().unwrap()) != 1
        || u32::from_le_bytes(header[24..28].try_into().unwrap()) != 16_000
        || u32::from_le_bytes(header[28..32].try_into().unwrap()) != 32_000
        || u16::from_le_bytes(header[32..34].try_into().unwrap()) != 2
        || u16::from_le_bytes(header[34..36].try_into().unwrap()) != 16
        || &header[36..40] != b"data"
    {
        return Err("录音格式无法核实，已保留原文件，请手动核对".into());
    }
    let samples = (length - 44) / 2;
    if samples > max_samples {
        return Err("录音超过恢复范围，已保留原文件，请手动核对".into());
    }
    let bytes = u32::try_from(samples * 2).map_err(|_| "录音过大，已保留原文件")?;
    let riff_bytes = bytes.checked_add(36).ok_or("录音过大，已保留原文件")?;
    file.seek(SeekFrom::Start(4))
        .and_then(|_| file.write_all(&riff_bytes.to_le_bytes()))
        .and_then(|_| file.seek(SeekFrom::Start(40)))
        .and_then(|_| file.write_all(&bytes.to_le_bytes()))
        .and_then(|_| file.set_len(44 + u64::from(bytes)))
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("修复中断录音失败：{error}"))?;
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wav() -> Vec<u8> {
        let mut header = b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data\0\0\0\0".to_vec();
        header.extend_from_slice(&[1, 0, 254, 255, 3, 0]);
        header
    }
    #[test]
    fn recovers_frames_after_stale_or_torn_size_fields_and_discards_only_half_a_frame() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("中断 录音.wav");
        let mut bytes = wav();
        bytes.push(4);
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(recover_pcm_wav(&path, 100).unwrap(), 3);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 50);
        assert_eq!(&bytes[40..44], &6u32.to_le_bytes());
        assert_eq!(&bytes[44..], &[1, 0, 254, 255, 3, 0]);
        assert_eq!(recover_pcm_wav(&path, 100).unwrap(), 3);
    }
    #[test]
    fn preserves_invalid_or_oversized_files_without_rewriting_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("original.wav");
        for bytes in [b"partial header".to_vec(), vec![0; 50], wav()] {
            std::fs::write(&path, &bytes).unwrap();
            assert!(recover_pcm_wav(&path, 1).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }
    #[test]
    fn header_only_recording_is_empty() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty.wav");
        std::fs::write(&path, &wav()[..44]).unwrap();
        assert_eq!(recover_pcm_wav(&path, 100).unwrap(), 0);
    }
}
