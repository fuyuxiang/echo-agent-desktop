//! End-to-end reads through the shipped tool and real ZIP/XML/PDF parsers.
use std::io::{Cursor, Write};
use std::path::Path;
use std::sync::Arc;

use echo_agent_tool_runtime::Tool;
use echo_agent_tools::computer::local::LocalFs;
use echo_agent_tools::implementations::echo_agent_build::read_file::{ReadFileInput, ReadFileTool};
use echo_agent_tools::implementations::read_file::document::{
    self, DocumentMode, DocumentOptions, DocumentReadBudget,
};
use echo_agent_tools::types::output::{FileContent, ReadFileOutput};
use echo_agent_tools::types::resources::{
    Cwd, FileSystem, Resources, SessionFolder, SharedResources,
};
use echo_agent_tools::types::tool_metadata::test_ctx;

fn resources(root: &Path) -> SharedResources {
    let mut res = Resources::new();
    res.insert(Cwd(root.to_path_buf()));
    res.insert(FileSystem(Arc::new(LocalFs)));
    res.insert(SessionFolder(root.join("session")));
    res.into_shared()
}

fn zip(entries: &[(&str, String)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, text) in entries {
        writer
            .start_file(*path, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(text.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn workbook(rows: usize) -> Vec<u8> {
    let mut sheet = String::from("<worksheet><sheetData>");
    for i in 1..=rows {
        sheet.push_str(&format!("<row r=\"{i}\"><c r=\"A{i}\" t=\"inlineStr\"><is><t>选手{i}</t></is></c><c r=\"B{i}\" t=\"inlineStr\"><is><t>数据集{}：{}</t></is></c></row>", i % 2, "中文代码🙂 ".repeat(40)));
    }
    sheet.push_str("</sheetData></worksheet>");
    zip(&[
        ("xl/workbook.xml", "<workbook xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"往年参考\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"今年选手\" sheetId=\"2\" r:id=\"rId2\"/></sheets></workbook>".into()),
        ("xl/_rels/workbook.xml.rels", "<Relationships><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet2.xml\"/></Relationships>".into()),
        ("xl/worksheets/sheet1.xml", "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>参考问题与分级答案</t></is></c></row></sheetData></worksheet>".into()),
        ("xl/worksheets/sheet2.xml", sheet),
    ])
}

async fn read(
    res: &SharedResources,
    path: &Path,
    offset: Option<i64>,
    options: Option<DocumentOptions>,
) -> FileContent {
    let result = ReadFileTool
        .run(
            test_ctx(res.clone()),
            ReadFileInput {
                path: path.to_string_lossy().to_string(),
                offset,
                limit: None,
                pages: None,
                format: None,
                document: options,
            },
        )
        .await
        .unwrap();
    match result {
        ReadFileOutput::FileContent(fc) => fc,
        other => panic!("Unexpected read result: {other:?}"),
    }
}

#[tokio::test]
async fn large_workbook_reads_through_last_contestant_without_overflow_or_gaps() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("比赛.xlsx");
    std::fs::write(&path, workbook(2000)).unwrap();
    document::begin_task(&res, "每位选手生成两道来自不同数据集的问题")
        .await
        .unwrap();
    let mut offset = None;
    let mut returned = 0;
    let mut saw_last = false;
    let mut pages = 0;
    loop {
        let fc = read(&res, &path, offset, None).await;
        let wire = serde_json::to_value(echo_agent_tools::types::output::ToolOutput::ReadFile(
            ReadFileOutput::FileContent(fc.clone()),
        ))
        .unwrap();
        assert_eq!(wire["type"], "ReadFile");
        assert!(wire["FileContent"]["document_progress"]["readRecords"].is_number());
        assert!(fc.content.len() < 20 * 1024, "Unbounded document page");
        saw_last |= fc.content.contains("选手2000");
        let p = fc.document_progress.unwrap();
        returned += p["returnedRecords"].as_u64().unwrap();
        pages += 1;
        offset = p["nextOffset"].as_i64();
        if offset.is_none() {
            assert_eq!(returned, p["totalRecords"].as_u64().unwrap());
            break;
        }
        assert!(pages < 1000);
    }
    assert!(pages > 10 && saw_last);
    assert!(document::task_snapshot(&res)
        .await
        .pending_feedback()
        .is_none());
}

#[tokio::test]
async fn sections_and_search_use_stable_source_cells_and_do_not_fake_full_coverage() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("比赛.xlsx");
    std::fs::write(&path, workbook(300)).unwrap();
    document::begin_task(&res, "每位选手都要分析")
        .await
        .unwrap();
    let overview = read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            mode: DocumentMode::Overview,
            ..Default::default()
        }),
    )
    .await;
    assert!(overview.content.contains("往年参考") && overview.content.contains("今年选手"));
    assert_eq!(overview.document_progress.unwrap()["readRecords"], 0);
    let fc = read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            mode: DocumentMode::Search,
            section: Some("今年选手".into()),
            query: Some("选手300".into()),
            ..Default::default()
        }),
    )
    .await;
    assert!(fc.content.contains("'今年选手'!A300"));
    assert!(!fc.content.contains("参考问题与分级答案"));
    assert_eq!(fc.document_progress.unwrap()["readRecords"], 1);
    assert!(document::task_snapshot(&res)
        .await
        .pending_feedback()
        .is_some());
}

#[tokio::test]
async fn checkpoint_and_missing_ranges_survive_restart_and_new_source_resets_coverage() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("比赛.xlsx");
    std::fs::write(&path, workbook(300)).unwrap();
    document::begin_task(&res, "每位选手都要分析")
        .await
        .unwrap();
    let first = read(&res, &path, None, None).await;
    let completed = first.document_progress.unwrap()["readRecords"]
        .as_u64()
        .unwrap();
    read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            mode: DocumentMode::Checkpoint,
            checkpoint: Some("选手1：问题依据 '今年选手'!B1，已完成一题。".into()),
            ..Default::default()
        }),
    )
    .await;
    let restored = resources(root.path());
    document::begin_task(&restored, "继续处理剩下的选手")
        .await
        .unwrap();
    let task = document::task_snapshot(&restored).await;
    let coverage = task.documents.values().next().unwrap();
    assert_eq!(coverage.covered() as u64, completed);
    assert_eq!(coverage.checkpoints.len(), 1);
    assert!(task
        .pending_feedback()
        .unwrap()
        .contains(&format!("offset={}", completed + 1)));
    std::fs::write(&path, workbook(400)).unwrap();
    let fc = read(
        &restored,
        &path,
        None,
        Some(DocumentOptions {
            mode: DocumentMode::Overview,
            ..Default::default()
        }),
    )
    .await;
    assert_eq!(fc.document_progress.unwrap()["readRecords"], 0);
}

#[tokio::test]
async fn long_plain_line_is_losslessly_addressable_with_a_small_budget() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    res.lock().await.insert(DocumentReadBudget(2048));
    let path = root.path().join("代码.txt");
    let source = "中文代码🙂".repeat(10_000);
    std::fs::write(&path, &source).unwrap();
    let mut offset = None;
    let mut actual = String::new();
    loop {
        let fc = read(&res, &path, offset, Some(DocumentOptions::default())).await;
        assert!(fc.content.len() < 4096);
        actual.push_str(fc.raw_output.strip_suffix('\n').unwrap());
        offset = fc.document_progress.unwrap()["nextOffset"].as_i64();
        if offset.is_none() {
            break;
        }
    }
    assert_eq!(actual, source);
}

#[tokio::test]
async fn long_pdf_text_has_page_locators_and_automatic_continuation() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("long.pdf");
    let labels: Vec<String> = (1..=30).map(|i| format!("page-{i}")).collect();
    let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
    std::fs::write(
        &path,
        echo_agent_tools::implementations::read_file::make_test_pdf(&refs),
    )
    .unwrap();
    let fc = read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            mode: DocumentMode::Overview,
            ..Default::default()
        }),
    )
    .await;
    assert!(fc.content.contains("Page 30"));
    let fc = read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            section: Some("Page 30".into()),
            ..Default::default()
        }),
    )
    .await;
    assert!(fc.content.contains("page-30") && fc.content.contains("Page 30, line"));
}

#[tokio::test]
async fn office_formats_use_the_shared_bounded_reader() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let text = "chapter ".repeat(10_000);
    let fixtures = [
        (
            "docx",
            "word/document.xml",
            format!(
                "<w:document xmlns:w=\"w\"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"
            ),
        ),
        (
            "pptx",
            "ppt/slides/slide1.xml",
            format!("<p:sld xmlns:p=\"p\" xmlns:a=\"a\"><a:t>{text}</a:t></p:sld>"),
        ),
        (
            "odt",
            "content.xml",
            format!(
                "<office:document-content xmlns:office=\"o\" xmlns:text=\"t\"><text:p>{text}</text:p></office:document-content>"
            ),
        ),
    ];
    for (ext, entry, xml) in fixtures {
        let path = root.path().join(format!("large.{ext}"));
        std::fs::write(&path, zip(&[(entry, xml)])).unwrap();
        let fc = read(&res, &path, None, None).await;
        assert!(fc.content.len() < 20 * 1024);
        assert!(fc.document_progress.unwrap()["nextOffset"].is_number());
    }
}

#[tokio::test]
async fn reading_checkpoint_journal_does_not_change_its_own_source_or_add_obligations() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("book.xlsx");
    std::fs::write(&path, workbook(100)).unwrap();
    document::begin_task(&res, "每位选手都要分析")
        .await
        .unwrap();
    read(&res, &path, None, None).await;
    let journal = root.path().join("session/documents/task.json");
    let before = std::fs::read(&journal).unwrap();
    let fc = read(&res, &journal, None, Some(DocumentOptions::default())).await;
    assert!(fc.document_progress.is_none());
    assert_eq!(before, std::fs::read(&journal).unwrap());
    assert_eq!(document::task_snapshot(&res).await.documents.len(), 1);
}

#[tokio::test]
async fn unread_attachment_and_corrupt_resume_are_not_reported_as_complete() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    document::begin_task(&res, "每位选手生成问题")
        .await
        .unwrap();
    document::expect_sources(
        &res,
        vec![root
            .path()
            .join("unread.xlsx")
            .to_string_lossy()
            .into_owned()],
    )
    .await
    .unwrap();
    assert!(document::task_snapshot(&res)
        .await
        .pending_feedback()
        .unwrap()
        .contains("not been inspected"));
    let journal = root.path().join("session/documents/task.json");
    std::fs::write(&journal, "broken JSON").unwrap();
    let restored = resources(root.path());
    assert!(document::begin_task(&restored, "继续")
        .await
        .unwrap_err()
        .contains("无法恢复"));
    assert_eq!(std::fs::read_to_string(journal).unwrap(), "broken JSON");
}

#[tokio::test]
async fn reference_scope_policy_survives_subsequent_reads() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("reference.xlsx");
    std::fs::write(&path, workbook(300)).unwrap();
    document::begin_task(&res, "每位选手都要分析")
        .await
        .unwrap();
    read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            exhaustive: Some(false),
            ..Default::default()
        }),
    )
    .await;
    read(&res, &path, None, None).await;
    assert!(document::task_snapshot(&res)
        .await
        .pending_feedback()
        .is_none());
    read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            mode: DocumentMode::Overview,
            section: Some("今年选手".into()),
            exhaustive: Some(true),
            ..Default::default()
        }),
    )
    .await;
    assert!(document::task_snapshot(&res)
        .await
        .pending_feedback()
        .is_some());
}

#[tokio::test]
async fn scanned_pdf_text_does_not_claim_visual_pages_were_read() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("scanned.pdf");
    std::fs::write(
        &path,
        echo_agent_tools::implementations::read_file::make_test_pdf(&["", ""]),
    )
    .unwrap();
    document::begin_task(&res, "全文分析").await.unwrap();
    document::expect_sources(&res, vec![path.to_string_lossy().to_string()])
        .await
        .unwrap();
    let fc = read(&res, &path, None, None).await;
    assert!(fc.content.contains("Inspect this page visually"));
    assert_eq!(fc.document_progress.unwrap()["readRecords"], 0);
    assert!(document::task_snapshot(&res)
        .await
        .pending_feedback()
        .is_some());
    let image = ReadFileTool
        .run(
            test_ctx(res.clone()),
            ReadFileInput {
                path: path.to_string_lossy().to_string(),
                offset: None,
                limit: None,
                pages: Some("1".into()),
                format: Some("image".into()),
                document: None,
            },
        )
        .await
        .unwrap();
    assert!(matches!(image, ReadFileOutput::PdfPageImages(_)));
    if let ReadFileOutput::PdfPageImages(pdf) = &image {
        let progress = pdf
            .document_progress
            .as_ref()
            .expect("visual progress reaches ACP rawOutput");
        assert_eq!(progress["readPages"], 1);
        assert_eq!(progress["totalPages"], 2);
    }
    assert_eq!(
        document::task_snapshot(&res)
            .await
            .documents
            .values()
            .next()
            .unwrap()
            .covered(),
        1
    );
    assert!(document::task_snapshot(&res)
        .await
        .pending_feedback()
        .is_some());
}

#[tokio::test]
async fn ordinary_followup_preserves_unfinished_scope_and_findings_across_restart() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("book.xlsx");
    std::fs::write(&path, workbook(300)).unwrap();
    document::begin_task(&res, "每位选手都要分析")
        .await
        .unwrap();
    read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            checkpoint: Some("选手1已完成，依据 '今年选手'!B1".into()),
            ..Default::default()
        }),
    )
    .await;
    let before = document::task_snapshot(&res).await;
    let restored = resources(root.path());
    document::begin_task(&restored, "把剩下的条目也补齐")
        .await
        .unwrap();
    let after = document::task_snapshot(&restored).await;
    let old = before.documents.values().next().unwrap();
    let new = after.documents.values().next().unwrap();
    assert_eq!(old.read, new.read);
    assert_eq!(old.checkpoints, new.checkpoints);
    assert_eq!(old.required, new.required);
    assert!(after.pending_feedback().is_some());
}

#[tokio::test]
async fn completed_scope_expires_without_deleting_evidence_and_findings_are_openable() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("small.txt");
    std::fs::write(&path, "one\ntwo").unwrap();
    document::begin_task(&res, "全文分析").await.unwrap();
    let first = read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            checkpoint: Some("已核对 one 和 two".into()),
            ..Default::default()
        }),
    )
    .await;
    let progress = first.document_progress.unwrap();
    let findings = std::fs::read_to_string(progress["checkpointPath"].as_str().unwrap()).unwrap();
    assert!(findings.contains("已核对 one 和 two") && findings.contains("small.txt"));
    document::finish_task(&res).await.unwrap();
    document::begin_task(&res, "解释其中的第一条")
        .await
        .unwrap();
    let task = document::task_snapshot(&res).await;
    let coverage = task.documents.values().next().unwrap();
    assert_eq!(coverage.covered(), 2);
    assert_eq!(coverage.checkpoints.len(), 1);
    assert!(!task.exhaustive && task.pending_feedback().is_none());
}

#[tokio::test]
async fn literal_search_crosses_unicode_chunk_boundaries_without_joining_unrelated_lines() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("long.txt");
    std::fs::write(
        &path,
        format!(
            "{}TARGET{}\nTAR\nGET",
            "x".repeat(2047),
            "中文🙂".repeat(1000)
        ),
    )
    .unwrap();
    let first = read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            mode: DocumentMode::Search,
            query: Some("target".into()),
            ..Default::default()
        }),
    )
    .await;
    assert_eq!(
        first.document_progress.as_ref().unwrap()["matchedRecords"],
        2
    );
    assert!(first.content.contains("bytes 1-2048") && first.content.contains("ARGET"));
    let unicode = read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            mode: DocumentMode::Search,
            query: Some("🙂中文🙂中文".into()),
            ..Default::default()
        }),
    )
    .await;
    assert!(
        unicode.document_progress.unwrap()["matchedRecords"]
            .as_u64()
            .unwrap()
            > 2
    );
}

#[tokio::test]
async fn paged_pdf_text_tracks_only_returned_pages_and_finishes_without_repeated_reads() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("pages.pdf");
    std::fs::write(
        &path,
        echo_agent_tools::implementations::read_file::make_test_pdf(&["first", "second"]),
    )
    .unwrap();
    document::begin_task(&res, "全文分析").await.unwrap();
    document::expect_sources(&res, vec![path.to_string_lossy().into_owned()])
        .await
        .unwrap();
    for (page, label) in [(1, "first"), (2, "second")] {
        let output = ReadFileTool
            .run(
                test_ctx(res.clone()),
                ReadFileInput {
                    path: path.to_string_lossy().into_owned(),
                    offset: None,
                    limit: None,
                    pages: Some(page.to_string()),
                    format: Some("text".into()),
                    document: None,
                },
            )
            .await
            .unwrap();
        let ReadFileOutput::FileContent(fc) = output else {
            panic!()
        };
        assert!(fc.content.contains(label));
        assert_eq!(fc.document_progress.unwrap()["readPages"], page);
        assert_eq!(
            document::task_snapshot(&res)
                .await
                .pending_feedback()
                .is_none(),
            page == 2
        );
    }
}

#[tokio::test]
async fn visually_reading_reference_pdf_preserves_document_and_page_policies() {
    let root = tempfile::tempdir().unwrap();
    let res = resources(root.path());
    let path = root.path().join("reference.pdf");
    std::fs::write(
        &path,
        echo_agent_tools::implementations::read_file::make_test_pdf(&["reference", "required"]),
    )
    .unwrap();
    document::begin_task(&res, "每位选手都要分析")
        .await
        .unwrap();
    read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            mode: DocumentMode::Overview,
            exhaustive: Some(false),
            ..Default::default()
        }),
    )
    .await;
    let image = ReadFileTool
        .run(
            test_ctx(res.clone()),
            ReadFileInput {
                path: path.to_string_lossy().into_owned(),
                offset: None,
                limit: None,
                pages: Some("1".into()),
                format: Some("image".into()),
                document: None,
            },
        )
        .await
        .unwrap();
    let wire =
        serde_json::to_value(echo_agent_tools::types::output::ToolOutput::ReadFile(image)).unwrap();
    assert_eq!(wire["PdfPageImages"]["document_progress"]["readPages"], 1);
    assert!(document::task_snapshot(&res)
        .await
        .pending_feedback()
        .is_none());
    read(
        &res,
        &path,
        None,
        Some(DocumentOptions {
            mode: DocumentMode::Overview,
            section: Some("Page 2".into()),
            exhaustive: Some(true),
            ..Default::default()
        }),
    )
    .await;
    assert!(document::task_snapshot(&res)
        .await
        .pending_feedback()
        .is_some());
    let image = ReadFileTool
        .run(
            test_ctx(res.clone()),
            ReadFileInput {
                path: path.to_string_lossy().into_owned(),
                offset: None,
                limit: None,
                pages: Some("2".into()),
                format: Some("image".into()),
                document: None,
            },
        )
        .await
        .unwrap();
    assert!(matches!(image, ReadFileOutput::PdfPageImages(_)));
    assert!(document::task_snapshot(&res)
        .await
        .pending_feedback()
        .is_none());
}

#[test]
fn request_budget_counts_chinese_schemas_and_tool_args_without_counting_image_base64() {
    use echo_agent_runtime::sampling::{
        estimate_request_tokens, ContentPart, ConversationItem, ConversationRequest, ToolSpec,
    };
    let mut request = ConversationRequest {
        items: vec![ConversationItem::user("中文".repeat(1000))],
        ..Default::default()
    };
    let plain = estimate_request_tokens(&request);
    assert!(plain >= 4000);
    if let ConversationItem::User(u) = &mut request.items[0] {
        u.content.push(ContentPart::Image {
            url: format!("data:image/png;base64,{}", "a".repeat(1_000_000)).into(),
        });
    }
    assert_eq!(estimate_request_tokens(&request) - plain, 1600);
    request.tools.push(ToolSpec {
        name: "read_file".into(),
        description: Some("description".repeat(1000)),
        parameters: serde_json::json!({"type":"object"}),
    });
    request.json_schema = Some(serde_json::json!({"description":"结果".repeat(1000)}));
    assert!(estimate_request_tokens(&request) > plain + 6000);
}

#[test]
fn provider_context_overflow_is_recognized_without_model_metadata_and_is_not_blindly_retried() {
    use echo_agent_runtime::sampling::SamplingError;
    let error = SamplingError::Api {
        status: reqwest::StatusCode::BAD_REQUEST,
        message: "bad_request_error: invalid params, context window exceeds limit (2013)".into(),
        model_metadata: None,
        retry_after_secs: None,
        should_retry: None,
        error_code: None,
    };
    assert!(error.is_context_length_error());
    assert!(error.is_retry_vetoed());
    let other = SamplingError::Api {
        status: reqwest::StatusCode::BAD_REQUEST,
        message: "invalid function arguments (2013)".into(),
        model_metadata: None,
        retry_after_secs: None,
        should_retry: None,
        error_code: None,
    };
    assert!(!other.is_context_length_error());
}
