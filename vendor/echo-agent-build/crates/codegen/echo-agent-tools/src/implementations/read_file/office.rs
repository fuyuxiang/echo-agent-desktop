//! Bounded text extraction for modern ZIP/XML document formats.

use std::io::{Cursor, Read};

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use zip::ZipArchive;

const MAX_XML_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_BYTES: usize = 16 * 1024 * 1024;

fn archive<'a>(bytes: &'a [u8], label: &str) -> Result<ZipArchive<Cursor<&'a [u8]>>, String> {
    ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("Failed to open {label}: {error}"))
}

fn read_entry(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    name: &str,
) -> Result<Option<String>, String> {
    let file = match archive.by_name(name) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(format!("Failed to open {name}: {error}")),
    };
    if file.size() > MAX_XML_ENTRY_BYTES {
        return Err(format!("{name} exceeds the decompressed size limit"));
    }
    let mut content = String::new();
    file.take(MAX_XML_ENTRY_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|error| format!("Failed to read {name}: {error}"))?;
    if content.len() as u64 > MAX_XML_ENTRY_BYTES {
        return Err(format!("{name} exceeds the decompressed size limit"));
    }
    Ok(Some(content))
}

fn push_text(output: &mut String, event: &quick_xml::events::BytesText<'_>) -> Result<(), String> {
    let text = event.xml_content().map_err(|error| error.to_string())?;
    bounded_push(output, &text)
}

fn push_reference(
    output: &mut String,
    event: &quick_xml::events::BytesRef<'_>,
) -> Result<(), String> {
    if let Some(ch) = event
        .resolve_char_ref()
        .map_err(|error| error.to_string())?
    {
        bounded_push(output, &ch.to_string())?;
    } else {
        let name = event.decode().map_err(|error| error.to_string())?;
        if let Some(resolved) = quick_xml::escape::resolve_predefined_entity(&name) {
            bounded_push(output, resolved)?;
        }
    }
    Ok(())
}

fn bounded_push(output: &mut String, value: &str) -> Result<(), String> {
    if output.len().saturating_add(value.len()) > MAX_EXTRACTED_TEXT_BYTES {
        return Err("Extracted document text exceeds the 16MB limit".to_string());
    }
    output.push_str(value);
    Ok(())
}

fn attribute(reader: &Reader<&[u8]>, start: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    start.attributes().flatten().find_map(|attribute| {
        (attribute.key.local_name().as_ref() == name)
            .then(|| attribute.decode_and_unescape_value(reader.decoder()).ok())
            .flatten()
            .map(|value| value.into_owned())
    })
}

pub(crate) fn extract_docx_text(bytes: &[u8]) -> Result<String, String> {
    let mut zip = archive(bytes, "DOCX archive")?;
    let xml = read_entry(&mut zip, "word/document.xml")?
        .ok_or_else(|| "DOCX has no word/document.xml".to_string())?;
    let mut reader = Reader::from_str(&xml);
    let mut output = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"t" => in_text = true,
            Ok(Event::Empty(event)) if event.local_name().as_ref() == b"tab" => {
                bounded_push(&mut output, "\t")?;
            }
            Ok(Event::Empty(event)) if matches!(event.local_name().as_ref(), b"br" | b"cr") => {
                bounded_push(&mut output, "\n")?;
            }
            Ok(Event::Text(event)) if in_text => push_text(&mut output, &event)?,
            Ok(Event::GeneralRef(event)) if in_text => push_reference(&mut output, &event)?,
            Ok(Event::End(event)) => match event.local_name().as_ref() {
                b"t" => in_text = false,
                b"p" if !output.ends_with('\n') => bounded_push(&mut output, "\n")?,
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("Failed to parse DOCX XML: {error}")),
            _ => {}
        }
    }
    let text = output.trim().to_string();
    if text.is_empty() {
        Err("DOCX contains no readable text".to_string())
    } else {
        Ok(text)
    }
}

fn shared_strings(zip: &mut ZipArchive<Cursor<&[u8]>>) -> Result<Vec<String>, String> {
    let Some(xml) = read_entry(zip, "xl/sharedStrings.xml")? else {
        return Ok(Vec::new());
    };
    let mut reader = Reader::from_str(&xml);
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_item = false;
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"si" => {
                current.clear();
                in_item = true;
            }
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"t" && in_item => {
                in_text = true;
            }
            Ok(Event::Text(event)) if in_text => push_text(&mut current, &event)?,
            Ok(Event::GeneralRef(event)) if in_text => push_reference(&mut current, &event)?,
            Ok(Event::End(event)) if event.local_name().as_ref() == b"t" => in_text = false,
            Ok(Event::End(event)) if event.local_name().as_ref() == b"si" => {
                strings.push(std::mem::take(&mut current));
                in_item = false;
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("Failed to parse XLSX shared strings: {error}")),
            _ => {}
        }
    }
    Ok(strings)
}

fn extract_sheet(xml: &str, shared: &[String]) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut output = String::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut cell_type = String::new();
    let mut in_cell = false;
    let mut in_value = false;
    let mut cell_column = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"row" => row.clear(),
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"c" => {
                in_cell = true;
                cell.clear();
                cell_type = attribute(&reader, &event, b"t").unwrap_or_default();
                cell_column = attribute(&reader, &event, b"r")
                    .as_deref()
                    .and_then(xlsx_column_index);
            }
            Ok(Event::Empty(event)) if event.local_name().as_ref() == b"c" => {
                let column = attribute(&reader, &event, b"r")
                    .as_deref()
                    .and_then(xlsx_column_index);
                push_xlsx_cell(&mut row, column, String::new());
            }
            Ok(Event::Start(event))
                if in_cell && matches!(event.local_name().as_ref(), b"v" | b"t") =>
            {
                in_value = true;
            }
            Ok(Event::Text(event)) if in_value => push_text(&mut cell, &event)?,
            Ok(Event::GeneralRef(event)) if in_value => push_reference(&mut cell, &event)?,
            Ok(Event::End(event)) if matches!(event.local_name().as_ref(), b"v" | b"t") => {
                in_value = false;
            }
            Ok(Event::End(event)) if event.local_name().as_ref() == b"c" => {
                let value = if cell_type == "s" {
                    cell.parse::<usize>()
                        .ok()
                        .and_then(|index| shared.get(index))
                        .cloned()
                        .unwrap_or_else(|| cell.clone())
                } else {
                    cell.clone()
                };
                push_xlsx_cell(&mut row, cell_column, value);
                in_cell = false;
            }
            Ok(Event::End(event)) if event.local_name().as_ref() == b"row" => {
                bounded_push(&mut output, &row.join("\t"))?;
                bounded_push(&mut output, "\n")?;
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("Failed to parse XLSX worksheet: {error}")),
            _ => {}
        }
    }
    Ok(output.trim().to_string())
}

fn xlsx_column_index(reference: &str) -> Option<usize> {
    let mut column = 0_usize;
    let mut letters = 0_usize;
    for byte in reference.bytes() {
        if !byte.is_ascii_alphabetic() {
            break;
        }
        column = column
            .checked_mul(26)?
            .checked_add((byte.to_ascii_uppercase() - b'A' + 1) as usize)?;
        letters += 1;
    }
    (letters > 0 && column > 0).then_some(column - 1)
}

fn push_xlsx_cell(row: &mut Vec<String>, column: Option<usize>, value: String) {
    if let Some(column) = column {
        while row.len() < column {
            row.push(String::new());
        }
    }
    row.push(value);
}

pub(crate) fn extract_xlsx_text(bytes: &[u8]) -> Result<String, String> {
    let mut zip = archive(bytes, "XLSX archive")?;
    let shared = shared_strings(&mut zip)?;
    let mut sheets: Vec<u32> = zip
        .file_names()
        .filter_map(|name| {
            name.strip_prefix("xl/worksheets/sheet")?
                .strip_suffix(".xml")?
                .parse()
                .ok()
        })
        .collect();
    sheets.sort_unstable();
    if sheets.is_empty() {
        return Err("XLSX contains no worksheets".to_string());
    }
    let mut output = String::new();
    for number in sheets {
        let name = format!("xl/worksheets/sheet{number}.xml");
        let xml = read_entry(&mut zip, &name)?.ok_or_else(|| format!("Missing {name}"))?;
        let sheet = extract_sheet(&xml, &shared)?;
        if !output.is_empty() {
            bounded_push(&mut output, "\n\n")?;
        }
        bounded_push(&mut output, &format!("--- Sheet {number} ---\n"))?;
        bounded_push(&mut output, &sheet)?;
    }
    Ok(output)
}

fn extract_paragraph_xml(xml: &str, label: &str) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut output = String::new();
    let mut paragraph_depth = 0_u32;
    let mut table_cell_depth = 0_u32;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if matches!(event.local_name().as_ref(), b"p" | b"h") => {
                paragraph_depth = paragraph_depth.saturating_add(1);
            }
            Ok(Event::Start(event))
                if matches!(
                    event.local_name().as_ref(),
                    b"table-cell" | b"covered-table-cell"
                ) =>
            {
                table_cell_depth = table_cell_depth.saturating_add(1);
            }
            Ok(Event::Empty(event))
                if matches!(
                    event.local_name().as_ref(),
                    b"table-cell" | b"covered-table-cell"
                ) =>
            {
                bounded_push(&mut output, "\t")?;
            }
            Ok(Event::Empty(event))
                if event.local_name().as_ref() == b"s" && paragraph_depth > 0 =>
            {
                let count = attribute(&reader, &event, b"c")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(1)
                    .min(10_000);
                bounded_push(&mut output, &" ".repeat(count))?;
            }
            Ok(Event::Empty(event))
                if event.local_name().as_ref() == b"tab" && paragraph_depth > 0 =>
            {
                bounded_push(&mut output, "\t")?;
            }
            Ok(Event::Empty(event))
                if event.local_name().as_ref() == b"line-break" && paragraph_depth > 0 =>
            {
                bounded_push(&mut output, "\n")?;
            }
            Ok(Event::Text(event)) if paragraph_depth > 0 => push_text(&mut output, &event)?,
            Ok(Event::GeneralRef(event)) if paragraph_depth > 0 => {
                push_reference(&mut output, &event)?
            }
            Ok(Event::End(event)) if matches!(event.local_name().as_ref(), b"p" | b"h") => {
                paragraph_depth = paragraph_depth.saturating_sub(1);
                if paragraph_depth == 0 {
                    if table_cell_depth > 0 {
                        if !output.ends_with([' ', '\t', '\n']) {
                            bounded_push(&mut output, " ")?;
                        }
                    } else if !output.ends_with('\n') {
                        bounded_push(&mut output, "\n")?;
                    }
                }
            }
            Ok(Event::End(event))
                if matches!(
                    event.local_name().as_ref(),
                    b"table-cell" | b"covered-table-cell"
                ) =>
            {
                table_cell_depth = table_cell_depth.saturating_sub(1);
                while matches!(output.as_bytes().last(), Some(b' ' | b'\t')) {
                    output.pop();
                }
                bounded_push(&mut output, "\t")?;
            }
            Ok(Event::End(event)) if event.local_name().as_ref() == b"table-row" => {
                while matches!(output.as_bytes().last(), Some(b' ' | b'\t')) {
                    output.pop();
                }
                if !output.ends_with('\n') {
                    bounded_push(&mut output, "\n")?;
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("Failed to parse {label}: {error}")),
            _ => {}
        }
    }
    Ok(output.trim().to_string())
}

pub(crate) fn extract_open_document_text(bytes: &[u8]) -> Result<String, String> {
    let mut zip = archive(bytes, "OpenDocument archive")?;
    let xml = read_entry(&mut zip, "content.xml")?
        .ok_or_else(|| "OpenDocument has no content.xml".to_string())?;
    let text = extract_paragraph_xml(&xml, "OpenDocument XML")?;
    if text.is_empty() {
        Err("OpenDocument contains no readable text".to_string())
    } else {
        Ok(text)
    }
}

pub(crate) fn extract_epub_text(bytes: &[u8]) -> Result<String, String> {
    let mut zip = archive(bytes, "EPUB archive")?;
    let mut entries: Vec<String> = zip
        .file_names()
        .filter(|name| {
            let lower = name.to_ascii_lowercase();
            lower.ends_with(".xhtml") || lower.ends_with(".html") || lower.ends_with(".htm")
        })
        .map(str::to_string)
        .collect();
    entries.sort();
    if entries.is_empty() {
        return Err("EPUB contains no HTML content".to_string());
    }
    let mut output = String::new();
    for name in entries {
        let Some(xml) = read_entry(&mut zip, &name)? else {
            continue;
        };
        let chapter = extract_paragraph_xml(&xml, &name)?;
        if chapter.is_empty() {
            continue;
        }
        if !output.is_empty() {
            bounded_push(&mut output, "\n\n")?;
        }
        bounded_push(&mut output, &format!("--- {name} ---\n"))?;
        bounded_push(&mut output, &chapter)?;
    }
    if output.is_empty() {
        Err("EPUB contains no readable text".to_string())
    } else {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;

    fn build_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn extracts_docx_paragraphs_tabs_and_breaks() {
        let bytes = build_zip(&[(
            "word/document.xml",
            r#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:tab/><w:r><w:t>world</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r><w:br/><w:r><w:t>line</w:t></w:r></w:p></w:body></w:document>"#,
        )]);
        assert_eq!(
            extract_docx_text(&bytes).unwrap(),
            "Hello\tworld\nNext\nline"
        );
    }

    #[test]
    fn extracts_xlsx_shared_and_numeric_cells() {
        let bytes = build_zip(&[
            (
                "xl/sharedStrings.xml",
                r#"<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c></row></sheetData></worksheet>"#,
            ),
        ]);
        assert_eq!(
            extract_xlsx_text(&bytes).unwrap(),
            "--- Sheet 1 ---\nName\t42\nAlice"
        );
    }

    #[test]
    fn preserves_sparse_xlsx_columns() {
        let bytes = build_zip(&[(
            "xl/worksheets/sheet1.xml",
            r#"<worksheet><sheetData><row><c r="A1"><v>left</v></c><c r="C1"><v>right</v></c></row></sheetData></worksheet>"#,
        )]);
        assert_eq!(
            extract_xlsx_text(&bytes).unwrap(),
            "--- Sheet 1 ---\nleft\t\tright"
        );
    }

    #[test]
    fn extracts_open_document_and_epub_paragraphs() {
        let odt = build_zip(&[(
            "content.xml",
            r#"<office:document xmlns:office="o" xmlns:text="t"><text:p>Hello <text:span>ODT</text:span></text:p></office:document>"#,
        )]);
        assert_eq!(extract_open_document_text(&odt).unwrap(), "Hello ODT");
        let epub = build_zip(&[(
            "OEBPS/chapter1.xhtml",
            "<html><body><p>Hello EPUB</p></body></html>",
        )]);
        assert!(extract_epub_text(&epub).unwrap().contains("Hello EPUB"));
    }

    #[test]
    fn preserves_open_document_table_rows_columns_and_spaces() {
        let ods = build_zip(&[(
            "content.xml",
            r#"<office:document xmlns:office="o" xmlns:text="t" xmlns:table="tb"><table:table><table:table-row><table:table-cell><text:p>First<text:s text:c="2"/>Name</text:p></table:table-cell><table:table-cell><text:p>Score</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>Alice</text:p></table:table-cell><table:table-cell><text:p>42</text:p></table:table-cell></table:table-row></table:table></office:document>"#,
        )]);
        assert_eq!(
            extract_open_document_text(&ods).unwrap(),
            "First  Name\tScore\nAlice\t42"
        );
    }
}
