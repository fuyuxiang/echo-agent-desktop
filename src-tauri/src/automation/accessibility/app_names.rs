//! Application labels are observed OS metadata, never a hard-coded app table.
pub(super) fn windows_names(path: &str, descriptions: &[String]) -> (String, Vec<String>) {
    let basename = path
        .rsplit(['\\', '/'])
        .find(|s| !s.is_empty())
        .unwrap_or(path);
    let stem = if basename
        .get(basename.len().saturating_sub(4)..)
        .is_some_and(|s| s.eq_ignore_ascii_case(".exe"))
    {
        &basename[..basename.len() - 4]
    } else {
        basename
    };
    let mut aliases = Vec::<String>::new();
    for name in descriptions
        .iter()
        .map(String::as_str)
        .chain([basename, stem, path])
    {
        let name = name.trim();
        if !name.is_empty()
            && name.len() <= 4096
            && !name.chars().any(char::is_control)
            && !aliases
                .iter()
                .any(|a| a.to_lowercase() == name.to_lowercase())
        {
            aliases.push(name.to_owned());
        }
    }
    let name = descriptions
        .iter()
        .find(|s| !s.trim().is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control))
        .map(|s| s.trim())
        .unwrap_or(basename)
        .to_owned();
    (name, aliases)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn executable_alias_and_localized_labels_preserve_exact_identity() {
        let (name, aliases) = windows_names(
            r"C:\Windows\System32\notepad.exe",
            &["记事本".into(), "Notepad".into()],
        );
        assert_eq!(name, "记事本");
        for alias in [
            "记事本",
            "Notepad",
            "notepad.exe",
            r"C:\Windows\System32\notepad.exe",
        ] {
            assert!(aliases.iter().any(|a| a.eq_ignore_ascii_case(alias)));
        }
        let (name, aliases) = windows_names(r"C:\Apps\Example.EXE", &[]);
        assert_eq!(name, "Example.EXE");
        assert!(aliases.iter().any(|a| a == "Example"));
    }
}
